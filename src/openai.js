// Endpoint tương thích OpenAI: dùng được với OpenAI SDK, LangChain, n8n, Dify, Cursor...
//   base_url = http://<server>/v1     api_key = sk-rnd-...   (tạo ở trang quản trị)
//   model = "auto" -> chọn ngẫu nhiên trong tất cả API; model cụ thể -> chỉ dùng key hỗ trợ model đó
import express from 'express';
import { config } from './config.js';
import * as store from './store.js';
import { callProvider, callTTS, TTS_TYPES, TTS_VOICES } from './providers/index.js';
import { dispatch, selectOptions } from './dispatch.js';
import { userAuth, rateLimit, sendError } from './middleware.js';
import { catalog } from './models.js';

const router = express.Router();
const MAX_INPUT = 200000;

// CORS: cho phép gọi từ trình duyệt / web app khác
router.use((req, res, next) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Api-Key, X-Provider, X-Strategy',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Expose-Headers': 'X-Request-Id, X-Provider',
  });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
router.use(userAuth);

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((err) => {
  console.error('[V1]', err.message);
  if (res.headersSent) {
    // Đang stream dở: gửi lỗi dạng SSE rồi đóng
    try {
      res.write(`data: ${JSON.stringify({ error: { message: err.message, type: 'api_error' } })}\n\n`);
      res.end('data: [DONE]\n\n');
    } catch {}
    return;
  }
  sendError(req, res, err.status >= 400 && err.status < 500 ? err.status : 500, err.message);
});

/** content của OpenAI có thể là chuỗi hoặc mảng [{type:'text', text}, {type:'image_url'...}] */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((c) => c && (c.type === 'text' || typeof c.text === 'string')).map((c) => c.text || '').join('\n');
  return '';
}

/** Tùy chọn chọn API: lấy từ body hoặc header X-Provider / X-Strategy (tiện cho tool không cho sửa body) */
function routeBody(req) {
  const b = req.body || {};
  return {
    model: b.model,
    provider: b.provider || req.headers['x-provider'] || undefined,
    strategy: b.strategy || req.headers['x-strategy'] || 'random',
    max_attempts: b.max_attempts,
  };
}

// ---------- GET /v1/models ----------
router.get('/models', wrap(async (req, res) => {
  const allowedProviders = req.client?.key?.allowed_providers || [];
  const allowedModels = req.client?.key?.allowed_models || [];
  const list = store.getProviders().filter((p) => p.enabled && (!allowedProviders.length || allowedProviders.includes(p.id)));
  const { models } = await catalog(list);
  const created = Math.floor(Date.now() / 1000);
  const data = [{ id: 'auto', object: 'model', created, owned_by: 'random-api-server' }];
  for (const m of models) {
    if (allowedModels.length && !allowedModels.includes(m.id) && !m.tts) continue;
    data.push({ id: m.id, object: 'model', created, owned_by: m.providers.join(',') });
  }
  res.json({ object: 'list', data });
}));

// ---------- POST /v1/chat/completions ----------
router.post('/chat/completions', rateLimit, wrap(async (req, res) => {
  const b = req.body || {};
  if (!Array.isArray(b.messages) || !b.messages.length) return sendError(req, res, 400, '"messages" phải là mảng không rỗng');

  const system = b.messages.filter((m) => m?.role === 'system' || m?.role === 'developer').map((m) => textOf(m.content)).filter(Boolean).join('\n\n');
  const messages = b.messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => ({ role: m.role, content: textOf(m.content) }))
    .filter((m) => m.content.trim());
  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    return sendError(req, res, 400, 'Tin nhắn cuối cùng phải là của "user"');
  }
  if (messages.reduce((n, m) => n + m.content.length, 0) > MAX_INPUT) return sendError(req, res, 400, `Nội dung quá dài (tối đa ${MAX_INPUT} ký tự)`);

  const params = { temperature: b.temperature, top_p: b.top_p, max_tokens: b.max_completion_tokens ?? b.max_tokens };
  const opts = selectOptions(routeBody(req), req.client);
  const created = Math.floor(Date.now() / 1000);
  const stream = b.stream === true;

  // Stream: mở kết nối SSE ngay, gửi "ping" giữ kết nối trong lúc chờ AI trả lời
  let ping = null;
  if (stream) {
    res.set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write(': connected\n\n');
    ping = setInterval(() => res.write(': ping\n\n'), 10000);
    req.on('close', () => clearInterval(ping));
  }

  let r;
  try {
    r = await dispatch({
      req, endpoint: '/v1/chat/completions', opts, logPrompt: messages[messages.length - 1].content,
      run: (p) => callProvider(p, { messages, system, params }),
    });
  } finally {
    clearInterval(ping);
  }

  if (!r.ok) {
    const msg = r.body.error + (r.body.errors?.length ? ': ' + r.body.errors.map((e) => `${e.provider}: ${e.error}`).join(' | ') : '');
    if (!stream) return sendError(req, res, r.httpStatus, msg);
    res.write(`data: ${JSON.stringify({ error: { message: msg, type: 'api_error', code: r.httpStatus } })}\n\n`);
    res.write('data: [DONE]\n\n');
    return res.end();
  }

  const id = 'chatcmpl-' + r.requestId;
  const model = r.result.model || r.provider.model;
  const text = r.result.text || '';
  const u = r.result.usage || { prompt_tokens: Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 4), completion_tokens: Math.ceil(text.length / 4) };
  const usage = { ...u, total_tokens: u.prompt_tokens + u.completion_tokens };
  if (!stream) {
    res.set({ 'X-Request-Id': r.requestId, 'X-Provider': r.provider.id });
    return res.json({
      id, object: 'chat.completion', created, model,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage,
      provider: r.provider.id,
    });
  }

  // Gửi nội dung thành nhiều mảnh để client hiển thị dần
  const chunk = (delta, finish = null, extra = {}) =>
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`);
  chunk({ role: 'assistant', content: '' });
  const pieces = text.match(/[\s\S]{1,60}/g) || [];
  for (const piece of pieces) chunk({ content: piece });
  chunk({}, 'stop');
  if (b.stream_options?.include_usage) {
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [], usage })}\n\n`);
  }
  res.write('data: [DONE]\n\n');
  res.end();
}));

// ---------- POST /v1/audio/speech (giọng đọc, trả file WAV) ----------
const OPENAI_VOICES = { alloy: 'Kore', echo: 'Charon', fable: 'Puck', onyx: 'Orus', nova: 'Aoede', shimmer: 'Leda', ash: 'Fenrir', coral: 'Sulafat', sage: 'Iapetus', ballad: 'Achird', verse: 'Zephyr' };

router.post('/audio/speech', rateLimit, wrap(async (req, res) => {
  const b = req.body || {};
  const text = typeof b.input === 'string' ? b.input.trim() : '';
  if (!text) return sendError(req, res, 400, 'Thiếu "input"');
  if (text.length > config.ttsMaxChars) return sendError(req, res, 400, `Văn bản quá dài (tối đa ${config.ttsMaxChars} ký tự)`);
  const v = String(b.voice || '');
  const voice = TTS_VOICES.find((x) => x.name.toLowerCase() === v.toLowerCase())?.name || OPENAI_VOICES[v.toLowerCase()] || 'Kore';
  const model = /tts/i.test(b.model || '') && !/^tts-1/.test(b.model) ? b.model : undefined;
  const r = await dispatch({
    req, endpoint: '/v1/audio/speech', opts: selectOptions({ ...routeBody(req), model: undefined }, req.client, { ignoreModelLimit: true }),
    onlyTypes: TTS_TYPES, logPrompt: `[${voice}${b.instructions ? ' | ' + b.instructions : ''}] ${text}`,
    run: (p) => callTTS(p, { text, voice, style: typeof b.instructions === 'string' ? b.instructions : '', model }),
    describe: (result) => `[audio WAV ${Math.round(result.audio.length / 1024)} KB]`,
  });
  if (!r.ok) return sendError(req, res, r.httpStatus, r.body.error + (r.body.errors?.length ? ': ' + r.body.errors.map((e) => e.error).join(' | ') : ''));
  res.set({ 'Content-Type': 'audio/wav', 'X-Request-Id': r.requestId, 'X-Provider': r.provider.id });
  res.send(r.result.audio);
}));

router.use((req, res) => sendError(req, res, 404, `Không có ${req.method} ${req.originalUrl}. Hỗ trợ: GET /v1/models, POST /v1/chat/completions, POST /v1/audio/speech`));

export default router;

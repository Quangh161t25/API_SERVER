import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, LOG_COLUMNS } from './config.js';
import { serviceAccountEmail, ensureSheet } from './sheets.js';
import * as keys from './keys.js';
import openaiRouter from './openai.js';
import * as store from './store.js';
import * as sessions from './sessions.js';
import { callProvider, callTTS, listModels, SUPPORTED_TYPES, TTS_TYPES, TTS_VOICES } from './providers/index.js';
import { candidatesFor, reportSuccess, reportFailure, stats, resetHealth } from './selector.js';
import { log, startLogger, stopLogger, readRecentLogs } from './logger.js';
import { dispatch, selectOptions, newRequestId, providerInfo } from './dispatch.js';
import { userAuth, adminAuth, rateLimit } from './middleware.js';
import * as P from './prompts.js';
import { catalog, modelsOf, supportsModel, clearModelCache } from './models.js';
import { isAvailable } from './selector.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/v1', openaiRouter);

const MAX_INPUT = 20000;
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (res, msg) => res.status(400).json({ error: msg });
const str = (v) => (typeof v === 'string' ? v.trim() : '');

/** Gọi AI dạng văn bản qua dispatch, trả về JSON chuẩn */
async function runText(req, res, endpoint, { messages, system, logPrompt, extra = {}, onSuccess }) {
  const r = await dispatch({
    req, endpoint, opts: selectOptions(req.body, req.client), logPrompt,
    run: (p) => callProvider(p, { messages, system }),
  });
  if (!r.ok) return res.status(r.httpStatus).json({ ...r.body, ...extra });
  if (onSuccess) onSuccess(r.result.text);
  const body = {
    request_id: r.requestId, ...extra,
    provider: providerInfo(r.provider, r.result),
    text: r.result.text, latency_ms: r.latency, attempts: r.attempts, errors: r.errors,
  };
  if (req.body.raw) body.raw = r.result.raw;
  res.json(body);
}

// ---------------- Công khai ----------------
app.get('/health', (req, res) => {
  res.json({ ok: true, time: new Date(), providers: store.storeStatus(), keys: keys.keysStatus(), sessions: sessions.count() });
});

// ---------------- Người dùng ----------------
const user = express.Router();
user.use(['/options', '/catalog', '/chat', '/sessions', '/translate', '/content', '/tts', '/compare'], userAuth);

/** Danh sách lựa chọn cho giao diện */
user.get('/options', (req, res) => {
  res.json({
    languages: P.LANGUAGES, translate_styles: P.TRANSLATE_STYLES,
    content_kinds: P.CONTENT_KINDS, content_tones: P.CONTENT_TONES, content_lengths: P.CONTENT_LENGTHS,
    voices: TTS_VOICES, strategies: ['weighted', 'random', 'roundrobin'],
    auth_required: config.userApiKeys.length > 0 || keys.hasKeys(),
  });
});

/**
 * Danh sách API + tất cả model mà các key dùng được (để chọn đích danh).
 * ?refresh=1 để hỏi lại hãng (bỏ qua cache 30 phút)
 */
user.get('/catalog', wrap(async (req, res) => {
  const list = store.getProviders().filter((p) => p.enabled);
  const { models, errors } = await catalog(list, req.query.refresh === '1');
  res.json({
    providers: store.getProviders().map((p) => ({
      id: p.id, name: p.name, type: p.type, model: p.model, enabled: p.enabled, available: isAvailable(p),
      tts: TTS_TYPES.includes(p.type), error: errors[p.id] || null,
    })),
    models,
    tts_model: config.ttsModel,
  });
}));

/**
 * Chat có lịch sử.
 * Body: { message, session_id?, system?, strategy?, provider?, type?, raw? }
 * Hoặc không lưu lịch sử: { messages: [{role, content}, ...], system? }
 */
user.post('/chat', rateLimit, wrap(async (req, res) => {
  const b = req.body || {};
  if (Array.isArray(b.messages)) {
    const messages = b.messages
      .filter((m) => m && typeof m.content === 'string' && m.content.trim())
      .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content.slice(0, MAX_INPUT) }));
    if (!messages.length || messages[messages.length - 1].role !== 'user') return bad(res, '"messages" phải kết thúc bằng tin của user');
    return runText(req, res, '/api/chat', { messages, system: str(b.system), logPrompt: messages[messages.length - 1].content });
  }

  const message = str(b.message || b.prompt);
  if (!message) return bad(res, 'Thiếu "message"');
  if (message.length > MAX_INPUT) return bad(res, `Tin nhắn quá dài (tối đa ${MAX_INPUT} ký tự)`);
  const s = sessions.getOrCreate(str(b.session_id));
  if (b.system !== undefined) s.system = str(b.system);
  const messages = [...s.messages.map(({ role, content }) => ({ role, content })), { role: 'user', content: message }];
  await runText(req, res, '/api/chat', {
    messages, system: s.system, logPrompt: message,
    extra: { session_id: s.id },
    onSuccess: (text) => sessions.append(s, { role: 'user', content: message }, { role: 'assistant', content: text }),
  });
}));

user.get('/sessions/:id', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Không tìm thấy hoặc đã hết hạn' });
  res.json({ session_id: s.id, system: s.system || '', messages: s.messages, created: s.created, updated: s.updated });
});

user.delete('/sessions/:id', (req, res) => {
  sessions.remove(req.params.id);
  res.json({ deleted: req.params.id });
});

/** Dịch. Body: { text, to?, from?, style? } */
user.post('/translate', rateLimit, wrap(async (req, res) => {
  const b = req.body || {};
  const text = str(b.text);
  if (!text) return bad(res, 'Thiếu "text"');
  if (text.length > MAX_INPUT) return bad(res, `Văn bản quá dài (tối đa ${MAX_INPUT} ký tự)`);
  const to = str(b.to) || 'vi';
  const from = str(b.from) || 'auto';
  const { system, prompt } = P.buildTranslate({ text, to, from, style: str(b.style) || 'natural' });
  await runText(req, res, '/api/translate', {
    messages: [{ role: 'user', content: prompt }], system, logPrompt: `[${from}->${to}] ${text}`, extra: { from, to },
  });
}));

/** Viết content. Body: { topic, kind?, tone?, length?, language?, keywords?, audience?, extra? } */
user.post('/content', rateLimit, wrap(async (req, res) => {
  const b = req.body || {};
  const topic = str(b.topic);
  if (!topic) return bad(res, 'Thiếu "topic"');
  if (topic.length > MAX_INPUT) return bad(res, `Nội dung quá dài (tối đa ${MAX_INPUT} ký tự)`);
  const params = {
    topic, kind: str(b.kind) || 'facebook', tone: str(b.tone) || 'friendly', length: str(b.length) || 'medium',
    language: str(b.language) || 'vi', keywords: str(b.keywords), audience: str(b.audience), extra: str(b.extra),
  };
  const { system, prompt } = P.buildContent(params);
  await runText(req, res, '/api/content', {
    messages: [{ role: 'user', content: prompt }], system,
    logPrompt: `[${params.kind}/${params.tone}/${params.length}] ${topic}`,
  });
}));

/**
 * Giọng đọc. Body: { text, voice?, style?, format?: "wav" | "json" }
 * Mặc định trả file WAV. format=json trả { audio_base64, ... }
 */
user.post('/tts', rateLimit, wrap(async (req, res) => {
  const b = req.body || {};
  const text = str(b.text);
  if (!text) return bad(res, 'Thiếu "text"');
  if (text.length > config.ttsMaxChars) return bad(res, `Văn bản quá dài (tối đa ${config.ttsMaxChars} ký tự)`);
  const voice = TTS_VOICES.some((v) => v.name === b.voice) ? b.voice : 'Kore';
  const style = str(b.style);
  const r = await dispatch({
    req, endpoint: '/api/tts', opts: selectOptions(b, req.client, { ignoreModelLimit: true }), onlyTypes: TTS_TYPES,
    logPrompt: `[${voice}${style ? ' | ' + style : ''}] ${text}`,
    run: (p) => callTTS(p, { text, voice, style, model: str(b.model) || undefined }),
    describe: (result) => `[audio WAV ${Math.round(result.audio.length / 1024)} KB, ~${Math.round((result.audio.length - 44) / 48000)}s]`,
  });
  if (!r.ok) return res.status(r.httpStatus).json(r.body);
  if (b.format === 'json') {
    return res.json({
      request_id: r.requestId, provider: providerInfo(r.provider, r.result), voice,
      mime_type: 'audio/wav', audio_base64: r.result.audio.toString('base64'),
      latency_ms: r.latency, attempts: r.attempts, errors: r.errors,
    });
  }
  res.set({
    'Content-Type': 'audio/wav',
    'Content-Disposition': `inline; filename="tts-${r.requestId}.wav"`,
    'X-Request-Id': r.requestId,
    'X-Provider': r.provider.id,
    'X-Latency-Ms': String(r.latency),
    'Access-Control-Expose-Headers': 'X-Request-Id, X-Provider, X-Latency-Ms',
  });
  res.send(r.result.audio);
}));

/** Gửi cùng 1 prompt tới NHIỀU provider một lúc để so sánh. Body: { prompt, system?, provider?, type? } */
user.post('/compare', rateLimit, wrap(async (req, res) => {
  const { provider, type } = req.body || {};
  const prompt = str(req.body?.prompt || req.body?.message);
  const system = str(req.body?.system);
  if (!prompt) return bad(res, 'Thiếu "prompt"');
  const o = selectOptions(req.body, req.client);
  const model = o.model;
  let list = candidatesFor(store.getProviders(), { provider: o.provider, type });
  if (model || o.allowedModels) await Promise.allSettled(list.map((p) => modelsOf(p)));
  if (model) list = list.filter((p) => supportsModel(p, model)).map((p) => ({ ...p, model }));
  else if (o.allowedModels) {
    list = list.filter((p) => o.allowedModels.some((m) => supportsModel(p, m)))
      .map((p) => (o.allowedModels.includes(p.model) ? p : { ...p, model: o.allowedModels.find((m) => supportsModel(p, m)) }));
  }
  const requestId = newRequestId();
  const messages = [{ role: 'user', content: prompt }];
  const results = await Promise.all(list.map(async (p) => {
    const start = Date.now();
    const base = { request_id: requestId, endpoint: '/api/compare', client_ip: req.ip, strategy: 'all', attempt: 1, client_key: req.client?.name,
                   provider_id: p.id, provider_name: p.name, type: p.type, model: p.model, prompt };
    try {
      const r = await callProvider(p, { messages, system });
      const latency = Date.now() - start;
      reportSuccess(p.id, latency);
      log({ ...base, url: r.url, status_code: r.status, success: true, latency_ms: latency, response: r.text });
      return { provider: p.id, model: r.model || p.model, ok: true, latency_ms: latency, text: r.text };
    } catch (err) {
      const latency = Date.now() - start;
      reportFailure(p.id, latency, err.message);
      log({ ...base, status_code: err.status || '', success: false, latency_ms: latency, error: err.message });
      return { provider: p.id, model: p.model, ok: false, latency_ms: latency, error: err.message };
    }
  }));
  res.json({ request_id: requestId, results });
}));

// ---------------- Quản trị ----------------
const admin = express.Router();
admin.use(['/providers', '/models', '/keys', '/reload', '/stats', '/logs'], adminAuth);

admin.get('/providers', (req, res) => {
  res.json({
    types: SUPPORTED_TYPES, ...store.storeStatus(),
    sheet_url: `https://docs.google.com/spreadsheets/d/${config.spreadsheetId}`,
    service_account: serviceAccountEmail(),
    providers: store.getProviders().map(store.publicView),
  });
});

admin.post('/providers', wrap(async (req, res) => {
  const p = await store.addProvider(req.body || {});
  res.status(201).json(store.publicView(p));
}));

admin.patch('/providers/:id', wrap(async (req, res) => {
  const p = await store.updateProvider(req.params.id, req.body || {});
  resetHealth(p.id);
  clearModelCache(p.id);
  res.json(store.publicView(p));
}));

/**
 * Lấy danh sách model mà key dùng được.
 * Body: { type, url?, api_key? , provider_id? } (không gửi api_key thì dùng key đang lưu của provider_id)
 */
admin.post('/models', wrap(async (req, res) => {
  const b = req.body || {};
  const saved = b.provider_id ? store.getProvider(b.provider_id) : null;
  const type = str(b.type) || saved?.type;
  const apiKey = str(b.api_key) && !/…/.test(b.api_key) ? str(b.api_key) : saved?.api_key;
  const url = b.url !== undefined ? str(b.url) : saved?.url;
  try {
    const models = await listModels({ type, url, api_key: apiKey });
    res.json({ type, count: models.length, models, tts_model: config.ttsModel });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

/** Thử 1 provider (không fallback, kể cả khi đang tắt). Body: { prompt?, tts? } */
admin.post('/providers/:id/test', wrap(async (req, res) => {
  const p = store.getProvider(req.params.id);
  if (!p) return res.status(404).json({ error: `Không tìm thấy provider "${req.params.id}"` });
  const tts = !!req.body?.tts;
  const prompt = str(req.body?.prompt) || 'Xin chào! Trả lời ngắn gọn: bạn là ai?';
  const start = Date.now();
  const base = { request_id: newRequestId(), endpoint: '/api/providers/test', client_ip: req.ip, strategy: 'test', attempt: 1, client_key: 'admin',
                 provider_id: p.id, provider_name: p.name, type: p.type, model: p.model, prompt };
  try {
    const r = tts ? await callTTS(p, { text: prompt, voice: 'Kore' }) : await callProvider(p, { messages: [{ role: 'user', content: prompt }] });
    const latency = Date.now() - start;
    reportSuccess(p.id, latency);
    const text = tts ? `[audio WAV ${Math.round(r.audio.length / 1024)} KB]` : r.text;
    log({ ...base, model: r.model || p.model, url: r.url, status_code: r.status, success: true, latency_ms: latency, response: text });
    res.json({ ok: true, provider: p.id, model: r.model || p.model, latency_ms: latency, text });
  } catch (err) {
    const latency = Date.now() - start;
    reportFailure(p.id, latency, err.message);
    log({ ...base, status_code: err.status || '', success: false, latency_ms: latency, error: err.message, response: err.raw });
    res.json({ ok: false, provider: p.id, latency_ms: latency, status: err.status || null, error: err.message });
  }
}));

admin.delete('/providers/:id', wrap(async (req, res) => {
  await store.removeProvider(req.params.id);
  resetHealth(req.params.id);
  res.json({ deleted: req.params.id });
}));

// ---------- API key do server cấp (tab KEYS) ----------
admin.get('/keys', (req, res) => {
  res.json({ ...keys.keysStatus(), base_url: `${req.protocol}://${req.get('host')}/v1`, keys: keys.getKeys().map(keys.publicKey) });
});

/** Tạo key. Body: { name, rate_per_min?, daily_limit?, allowed_models?, allowed_providers?, expires_at?, note? }. Key thật chỉ trả về 1 lần */
admin.post('/keys', wrap(async (req, res) => {
  const { key, record } = await keys.createKey(req.body || {});
  res.status(201).json({ key, ...keys.publicKey(record) });
}));

admin.patch('/keys/:id', wrap(async (req, res) => {
  const k = await keys.updateKey(req.params.id, req.body || {});
  res.json(keys.publicKey(k));
}));

admin.delete('/keys/:id', wrap(async (req, res) => {
  await keys.removeKey(req.params.id);
  res.json({ deleted: req.params.id });
}));

/** Đọc lại sheet API ngay (không chờ chu kỳ tự động) */
admin.post('/reload', wrap(async (req, res) => {
  await Promise.all([store.loadProviders(), keys.loadKeys()]);
  resetHealth();
  res.json(store.storeStatus());
}));

admin.get('/stats', (req, res) => res.json(stats(store.getProviders())));

admin.get('/logs', wrap(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  res.json(await readRecentLogs(limit));
}));

app.use('/api', user);
app.use('/api', admin);

app.use('/api', (req, res) => res.status(404).json({ error: `Không có ${req.method} ${req.originalUrl}` }));

// Bắt lỗi chung
app.use((err, req, res, next) => {
  if (res.headersSent) return res.end();
  if (err.type === 'entity.parse.failed') return bad(res, 'Body không phải JSON hợp lệ');
  console.error('[ERROR]', err.message);
  const msg = String(err.message || err);
  const status = err.status >= 400 && err.status < 500 ? err.status : /không tìm thấy/i.test(msg) ? 404 : /đã tồn tại|thiếu/i.test(msg) ? 400 : 500;
  res.status(status).json({ error: msg });
});

// ---------------- Khởi động ----------------
async function main() {
  console.log(`Service account: ${serviceAccountEmail()}`);
  console.log(`Spreadsheet: https://docs.google.com/spreadsheets/d/${config.spreadsheetId}`);
  try {
    await store.loadProviders();
    console.log(`Đã tải ${store.getProviders().length} provider từ sheet "${config.sheetApiName}"`);
  } catch {
    console.error('Không tải được provider. Hãy chạy "npm run init-sheet" và share sheet cho service account.');
  }
  setInterval(() => store.loadProviders().catch(() => {}), config.providerRefreshSec * 1000);
  try {
    await ensureSheet(config.sheetLogName, LOG_COLUMNS);
    await keys.loadKeys();
    console.log(`Đã tải ${keys.getKeys().length} API key từ sheet "${config.sheetKeysName}"`);
  } catch (err) {
    console.error('Không tải được tab KEYS / LOG:', err.message);
  }
  keys.startKeys();
  startLogger();
  sessions.start();

  if (!config.userApiKeys.length && !keys.hasKeys()) console.warn('⚠ Chưa có API key nào: ai cũng gọi được server. Tạo key ở trang quản trị.');
  if (!config.adminApiKey) console.warn('ℹ ADMIN_API_KEY trống: trang quản trị chỉ mở được từ chính máy này.');
  const server = app.listen(config.port, config.host, () => {
    console.log(`Server chạy tại http://localhost:${config.port}  (ứng dụng: /, quản trị: /admin.html, OpenAI API: /v1)`);
  });

  const shutdown = async () => {
    console.log('Đang tắt, ghi nốt log...');
    server.close();
    sessions.save();
    await Promise.all([stopLogger(), keys.flushUsage()]);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Không để 1 lỗi lẻ làm sập cả server
process.on('unhandledRejection', (err) => console.error('[UNHANDLED]', err?.message || err));
process.on('uncaughtException', (err) => console.error('[UNCAUGHT]', err?.message || err));

main();

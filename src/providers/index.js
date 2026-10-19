// Adapter cho từng loại API.
// Chat:  callProvider(p, { messages, system }) -> { text, status, raw, url, model }
//        messages = [{ role: 'user' | 'assistant', content: '...' }, ...] (tin cuối là của user)
// TTS:   callTTS(p, { text, voice, style })    -> { audio (Buffer WAV), status, url, model }
import { config } from '../config.js';

export class ProviderError extends Error {
  constructor(message, status, raw) {
    super(message);
    this.status = status;
    this.raw = raw;
  }
}

const DEFAULTS = {
  openai: { url: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini' },
  gemini: { url: 'https://generativelanguage.googleapis.com/v1beta/models/{{model}}:generateContent', model: 'gemini-3.8-flash' },
  claude: { url: 'https://api.anthropic.com/v1/messages', model: 'claude-haiku-5-5' },
};

function parseJSON(str, fallback, what) {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    throw new ProviderError(`Cột "${what}" không phải JSON hợp lệ`, 0);
  }
}

/** Lấy giá trị theo đường dẫn: "choices[0].message.content" hoặc "data.items.0.text" */
export function getByPath(obj, path) {
  if (!path) return obj;
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur = obj;
  for (const k of parts) {
    if (cur === undefined || cur === null) return undefined;
    cur = cur[k];
  }
  return cur;
}

/** Thay {{prompt}} {{model}} ... trong chuỗi. mode json = escape để nhét vào JSON, url = mã hóa URL */
function fill(template, vars, mode = 'raw') {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => {
    const v = vars[k] ?? '';
    if (mode === 'json') return JSON.stringify(String(v)).slice(1, -1);
    if (mode === 'url') return encodeURIComponent(String(v));
    return String(v);
  });
}

/** Tham số sinh văn bản tùy chọn: { temperature, max_tokens, top_p } -> chỉ giữ giá trị hợp lệ */
function genParams(params = {}) {
  const out = {};
  for (const k of ['temperature', 'max_tokens', 'top_p']) {
    const v = Number(params[k]);
    if (params[k] !== undefined && params[k] !== null && params[k] !== '' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

const lastUserText = (messages) => [...messages].reverse().find((m) => m.role === 'user')?.content || '';

/** Gộp các tin liên tiếp cùng vai trò và bảo đảm tin đầu tiên là của user (Claude/Gemini yêu cầu) */
function alternate(messages) {
  const out = [];
  for (const m of messages) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    if (out.length && out[out.length - 1].role === role) out[out.length - 1].content += '\n\n' + m.content;
    else out.push({ role, content: String(m.content) });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

async function httpCall(url, { method = 'POST', headers = {}, body, timeoutMs }) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : body,
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(t);
    if (err.name === 'AbortError') throw new ProviderError(`Timeout sau ${timeoutMs}ms`, 0);
    throw new ProviderError(`Lỗi kết nối: ${err.cause?.code || err.message}`, 0);
  }
  let text;
  try {
    text = await res.text();
  } catch (err) {
    throw new ProviderError(err.name === 'AbortError' ? `Timeout sau ${timeoutMs}ms` : `Lỗi đọc dữ liệu: ${err.message}`, 0);
  } finally {
    clearTimeout(t);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg =
      (typeof data === 'object' && (data.error?.message || data.error || data.message)) ||
      String(text).slice(0, 300);
    throw new ProviderError(`HTTP ${res.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`, res.status, data);
  }
  return { status: res.status, data };
}

/** Lấy tên model Google gợi ý trong lỗi 404, vd "... use models/gemini-3.8-flash for ..." */
export function suggestedModel(err) {
  if (err?.status !== 404) return null;
  const m = String(err.message).match(/use\s+models\/([\w.-]+)/i);
  return m ? m[1] : null;
}

/** Gemini đôi khi trả 200 nhưng bị chặn (safety) hoặc rỗng: coi là lỗi để chuyển provider khác */
function geminiCheck(data) {
  if (data?.promptFeedback?.blockReason) {
    throw new ProviderError(`Gemini chặn nội dung: ${data.promptFeedback.blockReason}`, 200, data);
  }
  const c = data?.candidates?.[0];
  if (!c) throw new ProviderError('Gemini không trả kết quả', 200, data);
  return c;
}

const adapters = {
  async openai(p, { messages, system, params }) {
    const model = p.model || DEFAULTS.openai.model;
    const url = p.url || DEFAULTS.openai.url;
    const msgs = [];
    if (system) msgs.push({ role: 'system', content: system });
    msgs.push(...messages.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })));
    const { status, data } = await httpCall(url, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${p.api_key}`,
        ...parseJSON(p.headers, {}, 'headers'),
      },
      body: JSON.stringify({ model, messages: msgs, ...genParams(params) }),
      timeoutMs: p.timeout_ms,
    });
    const u = data?.usage;
    return {
      text: data?.choices?.[0]?.message?.content ?? '', status, raw: data, url, model,
      usage: u ? { prompt_tokens: u.prompt_tokens || 0, completion_tokens: u.completion_tokens || 0 } : null,
    };
  },

  async gemini(p, { messages, system, params }, retried = false) {
    const model = p.model || DEFAULTS.gemini.model;
    const url = fill(p.url || DEFAULTS.gemini.url, { model }, 'url');
    const body = {
      contents: alternate(messages).map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    const g = genParams(params);
    if (Object.keys(g).length) {
      body.generationConfig = {};
      if ('temperature' in g) body.generationConfig.temperature = g.temperature;
      if ('max_tokens' in g) body.generationConfig.maxOutputTokens = g.max_tokens;
      if ('top_p' in g) body.generationConfig.topP = g.top_p;
    }
    let status, data;
    try {
      ({ status, data } = await httpCall(url, {
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': p.api_key,
          ...parseJSON(p.headers, {}, 'headers'),
        },
        body: JSON.stringify(body),
        timeoutMs: p.timeout_ms,
      }));
    } catch (err) {
      // Google ngừng model và gợi ý model mới: tự thử lại 1 lần với model đó
      const next = suggestedModel(err);
      if (!retried && next && next !== model && !p.url) {
        console.warn(`[GEMINI] ${p.id}: model "${model}" không dùng được, tự chuyển sang "${next}". Nên sửa cột model trong sheet.`);
        return adapters.gemini({ ...p, model: next }, { messages, system, params }, true);
      }
      throw err;
    }
    const c = geminiCheck(data);
    const text = (c.content?.parts || []).filter((x) => !x.thought).map((x) => x.text || '').join('');
    const u = data?.usageMetadata;
    return {
      text, status, raw: data, url, model,
      usage: u ? { prompt_tokens: u.promptTokenCount || 0, completion_tokens: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0) } : null,
    };
  },

  async claude(p, { messages, system, params }) {
    const model = p.model || DEFAULTS.claude.model;
    const url = p.url || DEFAULTS.claude.url;
    const g = genParams(params);
    const body = { model, max_tokens: g.max_tokens || 4096, messages: alternate(messages) };
    if ('temperature' in g) body.temperature = g.temperature;
    if ('top_p' in g) body.top_p = g.top_p;
    if (system) body.system = system;
    const { status, data } = await httpCall(url, {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': p.api_key,
        'anthropic-version': '2023-06-01',
        ...parseJSON(p.headers, {}, 'headers'),
      },
      body: JSON.stringify(body),
      timeoutMs: p.timeout_ms,
    });
    const text = (data?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const u = data?.usage;
    return {
      text, status, raw: data, url, model,
      usage: u ? { prompt_tokens: u.input_tokens || 0, completion_tokens: u.output_tokens || 0 } : null,
    };
  },

  // API bất kỳ: cấu hình bằng url / method / headers / body_template / response_path.
  // {{prompt}} = tin nhắn cuối của user, {{history}} = toàn bộ hội thoại dạng văn bản.
  async generic(p, { messages, system }) {
    if (!p.url) throw new ProviderError('Provider generic phải có url', 0);
    const vars = {
      prompt: lastUserText(messages),
      history: messages.map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`).join('\n'),
      system: system || '',
      model: p.model,
      api_key: p.api_key,
    };
    const url = fill(p.url, vars, 'url');
    const headers = parseJSON(fill(p.headers || '{}', vars, 'json'), {}, 'headers');
    let body;
    if (p.body_template) {
      body = fill(p.body_template, vars, 'json');
      if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
        headers['Content-Type'] = 'application/json';
      }
    }
    const { status, data } = await httpCall(url, { method: p.method || 'POST', headers, body, timeoutMs: p.timeout_ms });
    const val = getByPath(data, p.response_path);
    const text = val === undefined ? '' : typeof val === 'string' ? val : JSON.stringify(val);
    return { text, status, raw: data, url: p.url, model: p.model };
  },

  // Provider giả để test không cần key. api_key = "fail" thì luôn báo lỗi.
  async mock(p, { messages, system }) {
    await new Promise((r) => setTimeout(r, 50 + Math.random() * 200));
    if (p.api_key === 'fail') throw new ProviderError('Mock lỗi (api_key=fail)', 500);
    const turns = messages.filter((m) => m.role === 'user').length;
    const sys = system ? ` | system: ${system.slice(0, 60)}${system.length > 60 ? '…' : ''}` : '';
    return {
      text: `[${p.id}] (lượt ${turns}${sys}) Bạn vừa nói: ${lastUserText(messages)}`,
      status: 200, raw: { mock: true }, url: 'mock://', model: p.model || 'mock',
    };
  },
};

export const SUPPORTED_TYPES = Object.keys(adapters);
export const TTS_TYPES = ['gemini', 'mock'];

/** URL thực tế sẽ gọi (dùng cho log) */
export function resolveUrl(p) {
  const d = DEFAULTS[p.type];
  return p.url || (d ? d.url.replace('{{model}}', p.model || d.model) : p.type === 'mock' ? 'mock://' : '');
}

export async function callProvider(provider, input) {
  const fn = adapters[provider.type];
  if (!fn) throw new ProviderError(`Không hỗ trợ type "${provider.type}". Hỗ trợ: ${SUPPORTED_TYPES.join(', ')}`, 0);
  return fn(provider, input);
}

// ---------------- Text to speech ----------------

// Giọng có sẵn của Gemini TTS (tên: tính chất)
export const TTS_VOICES = [
  ['Kore', 'Chắc chắn'], ['Puck', 'Vui tươi'], ['Charon', 'Truyền đạt'], ['Zephyr', 'Sáng'], ['Fenrir', 'Hào hứng'],
  ['Leda', 'Trẻ trung'], ['Orus', 'Chắc chắn'], ['Aoede', 'Nhẹ nhàng'], ['Callirrhoe', 'Thoải mái'], ['Autonoe', 'Sáng'],
  ['Enceladus', 'Thì thầm'], ['Iapetus', 'Rõ ràng'], ['Umbriel', 'Thoải mái'], ['Algieba', 'Mượt'], ['Despina', 'Mượt'],
  ['Erinome', 'Rõ ràng'], ['Algenib', 'Khàn'], ['Rasalgethi', 'Truyền đạt'], ['Laomedeia', 'Vui tươi'], ['Achernar', 'Mềm'],
  ['Alnilam', 'Chắc chắn'], ['Schedar', 'Đều đặn'], ['Gacrux', 'Trưởng thành'], ['Pulcherrima', 'Mạnh mẽ'], ['Achird', 'Thân thiện'],
  ['Zubenelgenubi', 'Bình thường'], ['Vindemiatrix', 'Dịu dàng'], ['Sadachbia', 'Sống động'], ['Sadaltager', 'Hiểu biết'], ['Sulafat', 'Ấm áp'],
].map(([name, desc]) => ({ name, desc }));

/** Bọc dữ liệu PCM 16-bit thành file WAV */
export function pcmToWav(pcm, sampleRate = 24000, channels = 1, bits = 16) {
  const header = Buffer.alloc(44);
  const byteRate = (sampleRate * channels * bits) / 8;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE((channels * bits) / 8, 32);
  header.writeUInt16LE(bits, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

const ttsAdapters = {
  async gemini(p, { text, voice, style, model: m }) {
    const model = m || config.ttsModel;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const body = {
      contents: [{ parts: [{ text: style ? `${style}:\n${text}` : text }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice || 'Kore' } } },
      },
    };
    const { status, data } = await httpCall(url, {
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': p.api_key },
      body: JSON.stringify(body),
      timeoutMs: Math.max(p.timeout_ms, 120000),
    });
    const c = geminiCheck(data);
    const part = (c.content?.parts || []).find((x) => x.inlineData?.data);
    if (!part) throw new ProviderError('Gemini TTS không trả âm thanh', status, data);
    const mime = part.inlineData.mimeType || '';
    const pcm = Buffer.from(part.inlineData.data, 'base64');
    if (/wav/i.test(mime)) return { audio: pcm, status, url, model };
    const rate = Number((mime.match(/rate=(\d+)/) || [])[1]) || 24000;
    return { audio: pcmToWav(pcm, rate), status, url, model };
  },

  // Mock: tạo tiếng "bíp" dài theo độ dài văn bản, để test giao diện không cần key
  async mock(p, { text }) {
    await new Promise((r) => setTimeout(r, 100));
    if (p.api_key === 'fail') throw new ProviderError('Mock TTS lỗi (api_key=fail)', 500);
    const rate = 24000;
    const seconds = Math.min(5, 0.5 + text.length / 40);
    const n = Math.floor(rate * seconds);
    const pcm = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) {
      const env = Math.min(1, i / 2000, (n - i) / 2000);
      pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000 * env), i * 2);
    }
    return { audio: pcmToWav(pcm, rate), status: 200, url: 'mock://tts', model: 'mock-tts' };
  },
};

export async function callTTS(provider, input) {
  const fn = ttsAdapters[provider.type];
  if (!fn) throw new ProviderError(`Type "${provider.type}" không hỗ trợ giọng đọc`, 0);
  return fn(provider, input);
}

// ---------------- Danh sách model ----------------

/** Hỏi hãng xem key này dùng được những model nào. Trả về [{ id, tts }] */
export async function listModels({ type, url, api_key }) {
  const timeoutMs = 20000;
  if (!api_key) throw new ProviderError('Cần API key để lấy danh sách model', 0);
  if (type === 'gemini') {
    const { data } = await httpCall('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', {
      method: 'GET', headers: { 'x-goog-api-key': api_key }, timeoutMs,
    });
    return (data.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => ({ id: m.name.replace(/^models\//, ''), tts: /tts/i.test(m.name), name: m.displayName || '' }));
  }
  if (type === 'openai') {
    const base = (url || DEFAULTS.openai.url).replace(/\/chat\/completions\/?$/, '');
    const { data } = await httpCall(base + '/models', { method: 'GET', headers: { Authorization: `Bearer ${api_key}` }, timeoutMs });
    return (data.data || []).map((m) => ({ id: m.id, tts: false, name: '' }));
  }
  if (type === 'claude') {
    const { data } = await httpCall('https://api.anthropic.com/v1/models?limit=1000', {
      method: 'GET', headers: { 'x-api-key': api_key, 'anthropic-version': '2023-06-01' }, timeoutMs,
    });
    return (data.data || []).map((m) => ({ id: m.id, tts: false, name: m.display_name || '' }));
  }
  throw new ProviderError(`Type "${type}" không hỗ trợ lấy danh sách model`, 0);
}

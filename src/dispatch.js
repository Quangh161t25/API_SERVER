// Lõi: chọn ngẫu nhiên provider, gọi, nếu lỗi thì thử provider khác, ghi log mỗi lần thử
import crypto from 'node:crypto';
import { config } from './config.js';
import * as store from './store.js';
import { resolveUrl } from './providers/index.js';
import { pick, candidatesFor, reportSuccess, reportFailure } from './selector.js';
import { log } from './logger.js';
import { modelsOf, supportsModel } from './models.js';

export const STRATEGIES = ['random', 'weighted', 'roundrobin'];

export const newRequestId = () => crypto.randomUUID().slice(0, 8);

const forbidden = (msg) => Object.assign(new Error(msg), { status: 403 });
const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((s) => String(s).trim()).filter(Boolean);

/**
 * Lấy tùy chọn chọn provider từ body request, áp giới hạn của API key (nếu có).
 * client = req.client; ignoreModelLimit = true cho giọng đọc (model TTS khác model chat)
 */
export function selectOptions(body = {}, client = null, { ignoreModelLimit = false } = {}) {
  const opts = {
    strategy: STRATEGIES.includes(body.strategy) ? body.strategy : config.defaultStrategy,
    provider: body.provider,
    type: body.type,
    maxAttempts: Math.min(Number(body.max_attempts) || config.maxAttempts, 10),
    model: typeof body.model === 'string' && body.model.trim() !== 'auto' ? body.model.trim() : '',
    allowedModels: null,
  };
  const k = client?.key;
  if (k?.allowed_providers.length) {
    const wanted = asList(opts.provider);
    const bad = wanted.filter((id) => !k.allowed_providers.includes(id));
    if (bad.length) throw forbidden(`API key "${k.name}" không được dùng API: ${bad.join(', ')}`);
    opts.provider = wanted.length ? wanted : k.allowed_providers;
  }
  if (k?.allowed_models.length && !ignoreModelLimit) {
    if (opts.model && !k.allowed_models.includes(opts.model)) {
      throw forbidden(`API key "${k.name}" không được dùng model "${opts.model}". Được phép: ${k.allowed_models.join(', ')}`);
    }
    if (!opts.model) opts.allowedModels = k.allowed_models;
  }
  return opts;
}

/**
 * @param req        request express (lấy IP)
 * @param endpoint   tên endpoint ghi vào log
 * @param opts       { strategy, provider, type, maxAttempts, model }  model = chỉ dùng key hỗ trợ model này
 * @param onlyTypes  chỉ dùng các type này (vd TTS chỉ dùng gemini)
 * @param logPrompt  nội dung ghi vào cột prompt
 * @param run        async (provider) => result (phải có status, url, model)
 * @param describe   (result) => chuỗi ghi vào cột response
 * @returns { ok, requestId, provider, result, latency, attempts, errors } hoặc { ok:false, httpStatus, body }
 */
export async function dispatch({ req, endpoint, opts, onlyTypes, logPrompt, run, describe }) {
  const requestId = newRequestId();
  const tried = [];
  const errors = [];

  // Chỉ định model: hỏi trước (có cache) xem key nào dùng được model đó
  if (opts.model || opts.allowedModels) {
    const pool = candidatesFor(store.getProviders(), { provider: opts.provider, type: opts.type });
    await Promise.allSettled(pool.map((p) => modelsOf(p)));
  }

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    let candidates = candidatesFor(store.getProviders(), { provider: opts.provider, type: opts.type, exclude: tried });
    if (onlyTypes) candidates = candidates.filter((p) => onlyTypes.includes(p.type));
    if (opts.model) candidates = candidates.filter((p) => supportsModel(p, opts.model));
    if (opts.allowedModels) candidates = candidates.filter((p) => opts.allowedModels.some((m) => supportsModel(p, m)));
    const picked = pick(candidates, opts.strategy);
    if (!picked) break;
    let p = picked;
    if (opts.model) p = { ...picked, model: opts.model };
    else if (opts.allowedModels && !opts.allowedModels.includes(picked.model)) {
      // Model mặc định của API này không được phép: chọn ngẫu nhiên 1 model được phép mà key này hỗ trợ
      const ok = opts.allowedModels.filter((m) => supportsModel(picked, m));
      p = { ...picked, model: ok[Math.floor(Math.random() * ok.length)] };
    }
    tried.push(p.id);

    const start = Date.now();
    const base = {
      request_id: requestId, endpoint, client_ip: req.ip, strategy: opts.strategy, attempt, client_key: req.client?.name,
      provider_id: p.id, provider_name: p.name, type: p.type, model: p.model, prompt: logPrompt,
    };
    try {
      const result = await run(p);
      const latency = Date.now() - start;
      reportSuccess(p.id, latency);
      log({ ...base, model: result.model || p.model, url: result.url, status_code: result.status, success: true,
            latency_ms: latency, response: describe ? describe(result) : result.text });
      return { ok: true, requestId, provider: p, result, latency, attempts: attempt, errors };
    } catch (err) {
      const latency = Date.now() - start;
      reportFailure(p.id, latency, err.message);
      log({ ...base, url: resolveUrl(p), status_code: err.status || '', success: false, latency_ms: latency,
            error: err.message, response: err.raw });
      errors.push({ provider: p.id, status: err.status || null, error: err.message });
    }
  }

  const noProvider = tried.length === 0;
  if (noProvider) {
    log({ request_id: requestId, endpoint, client_ip: req.ip, strategy: opts.strategy, attempt: 0, success: false, prompt: logPrompt, client_key: req.client?.name,
          error: 'Không có provider nào khả dụng' + (opts.provider ? ` (provider=${opts.provider})` : '') +
                 (opts.type ? ` (type=${opts.type})` : '') + (opts.model ? ` (model=${opts.model}: không key nào dùng được)` : '') + (onlyTypes ? ` (chỉ ${onlyTypes.join('/')})` : '') });
  }
  return {
    ok: false,
    httpStatus: noProvider ? 503 : 502,
    body: {
      request_id: requestId,
      error: noProvider
        ? (opts.model ? `Không có key nào dùng được model "${opts.model}" (hoặc các key đó đang tắt / tạm loại)` : 'Không có provider nào khả dụng (kiểm tra sheet API: enabled, type, hoặc đang bị tạm loại)')
        : 'Tất cả provider đã thử đều lỗi',
      attempts: tried.length,
      errors,
    },
  };
}

/** Thông tin provider an toàn để trả cho client */
export const providerInfo = (p, result) => ({ id: p.id, name: p.name, type: p.type, model: result?.model || p.model });

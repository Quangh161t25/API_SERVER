import crypto from 'node:crypto';
import { config } from './config.js';
import * as keys from './keys.js';

const safeEqual = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function getKey(req) {
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return String(req.headers['x-api-key'] || bearer || '').trim();
}

/** Request đến trực tiếp từ chính máy này (không qua proxy/tunnel) */
export function isLocal(req) {
  const ip = req.socket.remoteAddress || '';
  const loopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  const forwarded = req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || req.headers.forwarded;
  return loopback && !forwarded;
}

const isEnvKey = (key) => !!key && config.userApiKeys.some((k) => safeEqual(key, k));

export function isAdmin(req) {
  const key = getKey(req);
  if (config.adminApiKey) return !!key && safeEqual(key, config.adminApiKey);
  // Chưa đặt ADMIN_API_KEY: chỉ máy chạy server (hoặc key trong .env) được quản trị
  return isLocal(req) || isEnvKey(key);
}

/** Lỗi theo đúng định dạng: /v1 dùng chuẩn OpenAI, còn lại { error } */
export function sendError(req, res, status, message) {
  if (req.baseUrl.startsWith('/v1')) {
    const type = status === 401 ? 'invalid_request_error' : status === 429 ? 'rate_limit_exceeded' : status === 403 ? 'permission_error' : 'api_error';
    return res.status(status).json({ error: { message, type, code: status === 401 ? 'invalid_api_key' : null } });
  }
  return res.status(status).json({ error: message });
}

/**
 * Endpoint cho người dùng (chat, dịch, content, giọng đọc, /v1).
 * Gắn req.client = { kind: 'admin' | 'env' | 'key' | 'open', name, key? }
 */
export function userAuth(req, res, next) {
  const key = getKey(req);
  if (config.adminApiKey && key && safeEqual(key, config.adminApiKey)) {
    req.client = { kind: 'admin', name: 'admin' };
    return next();
  }
  if (isEnvKey(key)) {
    req.client = { kind: 'env', name: 'env-key' };
    return next();
  }
  const found = keys.lookup(key);
  if (found?.error) return sendError(req, res, found.status, found.error);
  if (found?.key) {
    req.client = { kind: 'key', name: found.key.name, key: found.key };
    return next();
  }
  if (!config.adminApiKey && isLocal(req)) {
    req.client = { kind: 'admin', name: 'local' };
    return next();
  }
  // Chưa cấu hình key nào: mở cho tất cả
  if (!config.userApiKeys.length && !keys.hasKeys()) {
    req.client = { kind: 'open', name: '' };
    return next();
  }
  return sendError(req, res, 401, key ? 'API key không hợp lệ' : 'Thiếu API key (header Authorization: Bearer sk-rnd-... hoặc x-api-key)');
}

/** Endpoint quản trị: provider, key, log, thống kê */
export function adminAuth(req, res, next) {
  if (isAdmin(req)) return next();
  const msg = config.adminApiKey
    ? 'Cần key quản trị (ADMIN_API_KEY)'
    : 'Trang quản trị chỉ mở từ máy chạy server. Muốn quản trị từ xa, đặt ADMIN_API_KEY trong .env';
  return sendError(req, res, 403, msg);
}

// Giới hạn tốc độ: cửa sổ trượt 60 giây theo key (hoặc IP)
const hits = new Map();
setInterval(() => {
  const cutoff = Date.now() - 60000;
  for (const [k, arr] of hits) {
    const kept = arr.filter((t) => t > cutoff);
    if (kept.length) hits.set(k, kept);
    else hits.delete(k);
  }
}, 60000).unref();

/** Đặt sau userAuth ở các endpoint tốn quota: giới hạn/phút, giới hạn/ngày, đếm lượt dùng */
export function rateLimit(req, res, next) {
  const c = req.client || { kind: 'open' };
  if (c.kind === 'admin') return next();
  const perMin = c.key?.rate_per_min || config.rateLimitPerMin;
  if (perMin) {
    const raw = getKey(req);
    const id = c.key ? 'key:' + c.key.id : raw ? 'k:' + crypto.createHash('sha1').update(raw).digest('hex').slice(0, 12) : 'ip:' + req.ip;
    const now = Date.now();
    const arr = (hits.get(id) || []).filter((t) => t > now - 60000);
    if (arr.length >= perMin) {
      const retry = Math.ceil((arr[0] + 60000 - now) / 1000);
      res.set('Retry-After', String(retry));
      return sendError(req, res, 429, `Quá ${perMin} request/phút, thử lại sau ${retry}s`);
    }
    arr.push(now);
    hits.set(id, arr);
  }
  if (c.key) {
    const err = keys.consume(c.key);
    if (err) return sendError(req, res, err.status, err.error);
  }
  next();
}

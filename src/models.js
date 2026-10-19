// Bộ nhớ đệm: mỗi provider (key) dùng được những model nào. Hỏi hãng tối đa 1 lần / 30 phút.
import { listModels } from './providers/index.js';

const TTL = 30 * 60 * 1000;
const cache = new Map(); // id -> { key, models: [{id, tts, name}], at, error }
const pending = new Map();

const keyOf = (p) => `${p.type}|${p.url}|${p.api_key}`;

/** Danh sách model của provider (từ cache; hết hạn thì hỏi lại hãng) */
export async function modelsOf(p, force = false) {
  if (p.type === 'mock') return [{ id: p.model || 'mock', tts: false, name: 'Mock' }];
  if (p.type === 'generic') return p.model ? [{ id: p.model, tts: false, name: '' }] : [];
  const c = cache.get(p.id);
  if (!force && c && c.key === keyOf(p) && Date.now() - c.at < TTL) {
    if (c.error) throw new Error(c.error);
    return c.models;
  }
  if (pending.has(p.id)) return pending.get(p.id);
  const job = listModels(p)
    .then((models) => {
      cache.set(p.id, { key: keyOf(p), models, at: Date.now() });
      return models;
    })
    .catch((err) => {
      // Lỗi (key sai...) cũng lưu 5 phút để không hỏi liên tục
      cache.set(p.id, { key: keyOf(p), models: [], at: Date.now() - TTL + 5 * 60 * 1000, error: err.message });
      throw err;
    })
    .finally(() => pending.delete(p.id));
  pending.set(p.id, job);
  return job;
}

/** Bản đồng bộ: chỉ đọc cache, chưa có thì trả null */
export function cachedModels(p) {
  if (p.type === 'mock' || p.type === 'generic') return [p.model || (p.type === 'mock' ? 'mock' : '')].filter(Boolean);
  const c = cache.get(p.id);
  return c && c.key === keyOf(p) ? c.models.map((m) => m.id) : null;
}

/** Provider có dùng được model này không */
export function supportsModel(p, model) {
  if (!model) return true;
  if ((p.model || '') === model) return true;
  const list = cachedModels(p);
  return !!list && list.includes(model);
}

/**
 * Gom model của tất cả provider: [{ id, tts, providers: [id...] }]
 * Chạy song song, provider lỗi thì bỏ qua và báo trong errors.
 */
export async function catalog(providers, force = false) {
  const errors = {};
  const map = new Map();
  await Promise.all(providers.map(async (p) => {
    let models = [];
    try {
      models = await modelsOf(p, force);
    } catch (err) {
      errors[p.id] = err.message;
    }
    // Model đang cấu hình trong sheet luôn được tính
    if (p.model && !models.some((m) => m.id === p.model)) models = [...models, { id: p.model, tts: /tts/i.test(p.model), name: '' }];
    for (const m of models) {
      if (!map.has(m.id)) map.set(m.id, { id: m.id, name: m.name || '', tts: !!m.tts, providers: [] });
      map.get(m.id).providers.push(p.id);
    }
  }));
  const models = [...map.values()].sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
  return { models, errors };
}

export function clearModelCache(id) {
  if (id) cache.delete(id);
  else cache.clear();
}

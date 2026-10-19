import { config } from './config.js';

// Trạng thái sức khỏe + thống kê của từng provider (trong RAM, reset khi khởi động lại)
const health = new Map(); // id -> { fails, cooldownUntil, calls, ok, err, totalLatency, lastError, lastUsed }
let rrIndex = 0;

function h(id) {
  if (!health.has(id)) {
    health.set(id, { fails: 0, cooldownUntil: 0, calls: 0, ok: 0, err: 0, totalLatency: 0, lastError: '', lastUsed: null });
  }
  return health.get(id);
}

export function isAvailable(p) {
  return p.enabled && h(p.id).cooldownUntil <= Date.now();
}

export function reportSuccess(id, latency) {
  const s = h(id);
  s.fails = 0;
  s.calls++;
  s.ok++;
  s.totalLatency += latency;
  s.lastUsed = new Date();
}

/** Lỗi do phía client (400 sai request, 401/403 sai key) vẫn tính là lỗi provider vì cấu hình provider sai */
export function reportFailure(id, latency, error) {
  const s = h(id);
  s.fails++;
  s.calls++;
  s.err++;
  s.totalLatency += latency;
  s.lastError = error;
  s.lastUsed = new Date();
  if (s.fails >= config.failThreshold) {
    s.cooldownUntil = Date.now() + config.cooldownSec * 1000;
    console.warn(`[HEALTH] Tạm loại "${id}" ${config.cooldownSec}s sau ${s.fails} lỗi liên tiếp`);
    s.fails = 0;
  }
}

export function resetHealth(id) {
  if (id) health.delete(id);
  else health.clear();
}

export function stats(providers) {
  return providers.map((p) => {
    const s = h(p.id);
    return {
      id: p.id,
      name: p.name,
      type: p.type,
      enabled: p.enabled,
      available: isAvailable(p),
      cooldown_remaining_sec: Math.max(0, Math.ceil((s.cooldownUntil - Date.now()) / 1000)),
      calls: s.calls,
      success: s.ok,
      errors: s.err,
      success_rate: s.calls ? +(s.ok / s.calls * 100).toFixed(1) : null,
      avg_latency_ms: s.calls ? Math.round(s.totalLatency / s.calls) : null,
      last_error: s.lastError,
      last_used: s.lastUsed,
    };
  });
}

/**
 * Chọn 1 provider trong danh sách ứng viên.
 * strategy: random (đều nhau) | weighted (theo cột weight) | roundrobin (lần lượt)
 */
export function pick(candidates, strategy) {
  if (!candidates.length) return null;
  switch (strategy) {
    case 'random':
      return candidates[Math.floor(Math.random() * candidates.length)];
    case 'roundrobin': {
      const p = candidates[rrIndex % candidates.length];
      rrIndex++;
      return p;
    }
    case 'weighted':
    default: {
      const total = candidates.reduce((a, p) => a + p.weight, 0);
      let r = Math.random() * total;
      for (const p of candidates) {
        r -= p.weight;
        if (r <= 0) return p;
      }
      return candidates[candidates.length - 1];
    }
  }
}

/** Lọc ứng viên theo yêu cầu: chỉ định id, type, hoặc loại trừ */
export function candidatesFor(providers, { provider, type, exclude = [] }) {
  let list = providers.filter((p) => isAvailable(p) && !exclude.includes(p.id));
  if (provider) {
    const ids = Array.isArray(provider) ? provider : String(provider).split(',').map((s) => s.trim());
    list = list.filter((p) => ids.includes(p.id));
  }
  if (type) {
    const types = Array.isArray(type) ? type : String(type).split(',').map((s) => s.trim().toLowerCase());
    list = list.filter((p) => types.includes(p.type));
  }
  return list;
}

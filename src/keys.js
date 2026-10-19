// API key do server tự cấp cho client (server khác, app, tool...). Lưu ở tab KEYS của Google Sheet.
// Chỉ lưu mã băm SHA-256 của key, key thật chỉ hiện 1 lần lúc tạo.
import crypto from 'node:crypto';
import { config, KEY_COLUMNS } from './config.js';
import { readTable, appendRows, updateRow, deleteRow, ensureSheet, batchUpdateValues, colLetter } from './sheets.js';
import { nowVN } from './logger.js';

let keys = [];            // bản ghi trong RAM
let byHash = new Map();   // hash -> bản ghi
let headers = [...KEY_COLUMNS];
let lastLoaded = null;
let lastError = null;

export const KEY_PREFIX = 'sk-rnd-';
const truthy = (v) => v === true || ['true', '1', 'yes', 'x', 'on', 'có', 'bật'].includes(String(v).trim().toLowerCase());
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const num = (v) => (String(v).trim() !== '' && Number(v) > 0 ? Number(v) : 0);
export const hashKey = (k) => crypto.createHash('sha256').update(String(k)).digest('hex');
export const todayVN = () => nowVN().slice(0, 10);

const invalid = (msg, status = 400) => Object.assign(new Error(msg), { status });

function normalize(row) {
  const raw = Object.fromEntries(KEY_COLUMNS.map((c) => [c, row[c] === undefined ? '' : String(row[c])]));
  // Giữ lại số liệu đang đếm trong RAM (chưa kịp ghi xuống sheet)
  const old = keys.find((k) => k.id === raw.id);
  const k = {
    _row: row._row,
    id: raw.id.trim(),
    name: raw.name.trim() || raw.id.trim(),
    key_prefix: raw.key_prefix.trim(),
    key_hash: raw.key_hash.trim().toLowerCase(),
    enabled: raw.enabled.trim() === '' ? true : truthy(raw.enabled),
    rate_per_min: num(raw.rate_per_min),
    daily_limit: num(raw.daily_limit),
    allowed_models: list(raw.allowed_models),
    allowed_providers: list(raw.allowed_providers),
    expires_at: raw.expires_at.trim(),
    created_at: raw.created_at.trim(),
    total_requests: Number(raw.total_requests) || 0,
    today_date: raw.today_date.trim(),
    today_requests: Number(raw.today_requests) || 0,
    last_used: raw.last_used.trim(),
    note: raw.note,
    dirty: false,
  };
  if (old && old.dirty) {
    k.total_requests = Math.max(k.total_requests, old.total_requests);
    k.today_date = old.today_date;
    k.today_requests = old.today_date === k.today_date ? Math.max(k.today_requests, old.today_requests) : old.today_requests;
    k.last_used = old.last_used;
    k.dirty = true;
  }
  return k;
}

// Các thao tác ghi sheet chạy lần lượt (tránh lệch số dòng)
let queue = Promise.resolve();
const serial = (fn) => {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
};

async function readSheet() {
  let table;
  try {
    table = await readTable(config.sheetKeysName);
  } catch (err) {
    if (!/Unable to parse range/i.test(err.message)) throw err;
    await ensureSheet(config.sheetKeysName, KEY_COLUMNS);
    table = await readTable(config.sheetKeysName);
  }
  const lower = table.headers.map((h) => h.toLowerCase());
  if (!KEY_COLUMNS.every((c) => lower.includes(c))) {
    await ensureSheet(config.sheetKeysName, KEY_COLUMNS);
    table = await readTable(config.sheetKeysName);
  }
  headers = table.headers.map((h) => h.toLowerCase());
  return table.items.map((it) => {
    const o = { _row: it._row };
    table.headers.forEach((h) => (o[h.toLowerCase()] = it[h]));
    return o;
  });
}

export async function loadKeys() {
  try {
    const items = await readSheet();
    keys = items.map(normalize).filter((k) => k.id && k.key_hash);
    byHash = new Map(keys.map((k) => [k.key_hash, k]));
    lastLoaded = new Date();
    lastError = null;
    return keys;
  } catch (err) {
    lastError = err.message;
    console.error('[KEYS] Không đọc được sheet KEYS:', err.message);
    throw err;
  }
}

export const getKeys = () => keys;
export const getKey = (id) => keys.find((k) => k.id === id);
export const hasKeys = () => keys.length > 0;
export const keysStatus = () => ({ count: keys.length, lastLoaded, lastError });

/** Tìm key theo chuỗi client gửi lên. Trả { key } hoặc { error, status } */
export function lookup(rawKey) {
  if (!rawKey || !rawKey.startsWith(KEY_PREFIX)) return null;
  const k = byHash.get(hashKey(rawKey));
  if (!k) return null;
  if (!k.enabled) return { error: `API key "${k.name}" đã bị thu hồi / tắt`, status: 401 };
  if (k.expires_at && todayVN() > k.expires_at) return { error: `API key "${k.name}" đã hết hạn từ ${k.expires_at}`, status: 401 };
  return { key: k };
}

/** Đếm 1 lượt dùng. Trả lỗi nếu vượt giới hạn ngày */
export function consume(k) {
  const today = todayVN();
  if (k.today_date !== today) {
    k.today_date = today;
    k.today_requests = 0;
  }
  if (k.daily_limit && k.today_requests >= k.daily_limit) {
    return { error: `API key "${k.name}" đã dùng hết ${k.daily_limit} request hôm nay`, status: 429 };
  }
  k.today_requests++;
  k.total_requests++;
  k.last_used = nowVN();
  k.dirty = true;
  return null;
}

/** Ghi số liệu sử dụng xuống sheet (gọi định kỳ) */
export function flushUsage() {
  const dirty = keys.filter((k) => k.dirty);
  if (!dirty.length) return Promise.resolve();
  return serial(async () => {
    const cols = ['total_requests', 'today_date', 'today_requests', 'last_used'];
    const data = [];
    for (const k of dirty) {
      for (const c of cols) {
        const i = headers.indexOf(c);
        if (i < 0) continue;
        data.push({ range: `${config.sheetKeysName}!${colLetter(i)}${k._row}`, values: [[String(k[c] ?? '')]] });
      }
    }
    try {
      await batchUpdateValues(data);
      dirty.forEach((k) => (k.dirty = false));
    } catch (err) {
      console.error('[KEYS] Ghi số liệu sử dụng thất bại:', err.message);
    }
  });
}

// ---------- Tạo / sửa / xóa ----------

function validate(d) {
  if (!d.name) throw invalid('Thiếu tên key');
  if (d.name.length > 100) throw invalid('Tên key tối đa 100 ký tự');
  for (const f of ['rate_per_min', 'daily_limit']) {
    if (d[f] !== '' && !(Number(d[f]) > 0)) throw invalid(`${f} phải là số > 0 hoặc để trống`);
  }
  if (d.expires_at && !/^\d{4}-\d{2}-\d{2}$/.test(d.expires_at)) throw invalid('expires_at phải có dạng YYYY-MM-DD');
}

function toRow(d) {
  return headers.map((h) => {
    if (h === 'enabled') return d.enabled === '' || d.enabled === undefined ? 'TRUE' : truthy(d.enabled) ? 'TRUE' : 'FALSE';
    const v = d[h];
    if (Array.isArray(v)) return v.join(', ');
    return v === undefined || v === null ? '' : String(v);
  });
}

const clean = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).join(', ') : v === undefined || v === null ? '' : String(v).trim());
const EDITABLE = ['name', 'enabled', 'rate_per_min', 'daily_limit', 'allowed_models', 'allowed_providers', 'expires_at', 'note'];

/** Tạo key mới. Trả { key: 'sk-rnd-...', record } — key thật chỉ có ở đây */
export function createKey(data) {
  return serial(async () => {
    await loadKeys();
    const d = Object.fromEntries(EDITABLE.map((c) => [c, clean(data[c])]));
    if (d.enabled === '') d.enabled = 'TRUE';
    validate(d);
    const secret = KEY_PREFIX + crypto.randomBytes(24).toString('base64url');
    let id;
    do id = 'key-' + crypto.randomBytes(3).toString('hex'); while (getKey(id));
    const row = {
      ...d, id,
      key_prefix: secret.slice(0, KEY_PREFIX.length + 6) + '…',
      key_hash: hashKey(secret),
      created_at: nowVN(),
      total_requests: 0, today_date: '', today_requests: 0, last_used: '',
    };
    await appendRows(config.sheetKeysName, [toRow(row)]);
    await loadKeys();
    return { key: secret, record: getKey(id) };
  });
}

export function updateKey(id, patch) {
  return serial(async () => {
    await loadKeys();
    const cur = getKey(id);
    if (!cur) throw invalid(`Không tìm thấy key "${id}"`, 404);
    const d = { ...cur };
    for (const c of EDITABLE) if (c in patch) d[c] = clean(patch[c]);
    if (typeof d.enabled === 'boolean') d.enabled = d.enabled ? 'TRUE' : 'FALSE';
    for (const f of ['rate_per_min', 'daily_limit']) if (d[f] === 0) d[f] = '';
    validate({ ...d, name: String(d.name) });
    await updateRow(config.sheetKeysName, cur._row, toRow(d));
    cur.dirty = false;
    await loadKeys();
    return getKey(id);
  });
}

export function removeKey(id) {
  return serial(async () => {
    await loadKeys();
    const cur = getKey(id);
    if (!cur) throw invalid(`Không tìm thấy key "${id}"`, 404);
    await deleteRow(config.sheetKeysName, cur._row);
    await loadKeys();
  });
}

/** Bản trả ra ngoài (không có hash) */
export function publicKey(k) {
  const { _row, key_hash, dirty, ...rest } = k;
  const expired = !!(k.expires_at && todayVN() > k.expires_at);
  return { ...rest, today_requests: k.today_date === todayVN() ? k.today_requests : 0, expired };
}

export function startKeys() {
  setInterval(() => loadKeys().catch(() => {}), config.providerRefreshSec * 1000);
  setInterval(() => flushUsage(), 30 * 1000);
}

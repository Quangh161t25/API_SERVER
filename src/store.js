import { config, API_COLUMNS } from './config.js';
import { readTable, appendRows, updateRow, deleteRow, ensureSheet } from './sheets.js';
import { SUPPORTED_TYPES } from './providers/index.js';

// Danh sách provider đọc từ sheet API, lưu tạm trong RAM
let providers = [];
let sheetHeaders = [...API_COLUMNS];
let lastLoaded = null;
let lastError = null;

const truthy = (v) => v === true || ['true', '1', 'yes', 'x', 'on', 'có', 'bật'].includes(String(v).trim().toLowerCase());

function normalize(row) {
  // raw = giá trị đúng như trong sheet (để khi sửa không ghi đè ô trống bằng giá trị mặc định)
  const raw = Object.fromEntries(API_COLUMNS.map((c) => [c, row[c] === undefined ? '' : String(row[c])]));
  return {
    _row: row._row,
    _raw: raw,
    id: raw.id.trim(),
    name: (raw.name || raw.id).trim(),
    type: (raw.type || 'generic').trim().toLowerCase(),
    url: raw.url.trim(),
    method: (raw.method || 'POST').trim().toUpperCase(),
    api_key: raw.api_key.trim(),
    model: raw.model.trim(),
    headers: raw.headers.trim(),
    body_template: raw.body_template.trim(),
    response_path: raw.response_path.trim(),
    weight: Number(raw.weight) > 0 ? Number(raw.weight) : 1,
    enabled: raw.enabled.trim() === '' ? true : truthy(raw.enabled),
    timeout_ms: Number(raw.timeout_ms) > 0 ? Number(raw.timeout_ms) : config.defaultTimeoutMs,
    note: raw.note,
  };
}

async function readSheet() {
  let table;
  try {
    table = await readTable(config.sheetApiName);
  } catch (err) {
    // Tab bị xóa/đổi tên: tự tạo lại
    if (/Unable to parse range/i.test(err.message)) {
      console.warn(`[STORE] Không thấy tab "${config.sheetApiName}", đang tạo lại...`);
      await ensureSheet(config.sheetApiName, API_COLUMNS);
      table = await readTable(config.sheetApiName);
    } else throw err;
  }
  // Tiêu đề trống hoặc thiếu cột: ghi lại tiêu đề chuẩn
  const lower = table.headers.map((h) => h.toLowerCase());
  if (!API_COLUMNS.every((c) => lower.includes(c))) {
    console.warn(`[STORE] Tab "${config.sheetApiName}" thiếu cột tiêu đề, đang ghi lại...`);
    await ensureSheet(config.sheetApiName, API_COLUMNS);
    table = await readTable(config.sheetApiName);
  }
  // Cho phép tiêu đề viết hoa/thường tùy ý
  sheetHeaders = table.headers.map((h) => h.toLowerCase());
  const items = table.items.map((it) => {
    const o = { _row: it._row };
    table.headers.forEach((h) => (o[h.toLowerCase()] = it[h]));
    return o;
  });
  return items;
}

export async function loadProviders() {
  try {
    const items = await readSheet();
    providers = items.map(normalize).filter((p) => p.id);
    const ids = new Set();
    for (const p of providers) {
      if (ids.has(p.id)) console.warn(`[STORE] id "${p.id}" bị trùng trong sheet (dòng ${p._row}), chỉ dòng đầu được dùng khi sửa/xóa`);
      ids.add(p.id);
    }
    lastLoaded = new Date();
    lastError = null;
    return providers;
  } catch (err) {
    lastError = err.message;
    console.error('[STORE] Không đọc được sheet API:', err.message);
    throw err;
  }
}

export function getProviders() {
  return providers;
}

export function getProvider(id) {
  return providers.find((p) => p.id === id);
}

export function storeStatus() {
  return { count: providers.length, lastLoaded, lastError };
}

export function maskKey(k) {
  if (!k) return '';
  if (k.length <= 8) return '****';
  return k.slice(0, 4) + '…' + k.slice(-4);
}

/** Bản an toàn để trả ra ngoài (che key). raw = giá trị gốc trong sheet để hiển thị form sửa */
export function publicView(p) {
  const { _row, _raw, api_key, ...rest } = p;
  return { ...rest, row: _row, api_key: maskKey(api_key), has_key: !!api_key, raw: { ..._raw, api_key: maskKey(_raw.api_key) } };
}

// ---------- Ghi ----------

// Xếp hàng các thao tác ghi để không bị lệch số dòng khi nhiều người thao tác cùng lúc
let queue = Promise.resolve();
const serial = (fn) => {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
};

/** Lỗi dữ liệu nhập vào -> HTTP 400 */
const invalid = (msg) => Object.assign(new Error(msg), { status: 400 });

const clean = (v) => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v).trim());

function validate(d) {
  if (!/^[\w.-]{1,64}$/.test(d.id)) throw invalid('id chỉ gồm chữ không dấu, số, dấu - _ . (tối đa 64 ký tự)');
  const type = d.type.toLowerCase();
  if (!SUPPORTED_TYPES.includes(type)) throw invalid(`type phải là một trong: ${SUPPORTED_TYPES.join(', ')}`);
  if (type === 'generic' && !d.url) throw invalid('Provider generic phải có url');
  if (d.weight !== '' && !(Number(d.weight) > 0)) throw invalid('weight phải là số > 0');
  if (d.timeout_ms !== '' && !(Number(d.timeout_ms) > 0)) throw invalid('timeout_ms phải là số > 0');
  for (const f of ['headers']) {
    if (d[f]) {
      try { JSON.parse(d[f].replace(/\{\{\s*\w+\s*\}\}/g, 'x')); } catch { throw invalid(`${f} phải là JSON hợp lệ, vd {"X-Key":"abc"}`); }
    }
  }
}

function toRow(d) {
  return sheetHeaders.map((h) => {
    if (h === 'enabled') return d.enabled === '' ? 'TRUE' : truthy(d.enabled) ? 'TRUE' : 'FALSE';
    return d[h] === undefined ? '' : d[h];
  });
}

/** Tạo id tự động: gemini-1, gemini-2, ... */
function autoId(type) {
  const base = (type || 'api').toLowerCase().replace(/[^\w-]/g, '') || 'api';
  let n = 1;
  while (getProvider(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

export function addProvider(data) {
  return serial(async () => {
    await loadProviders();
    const d = Object.fromEntries(API_COLUMNS.map((c) => [c, clean(data[c])]));
    d.type = (d.type || 'generic').toLowerCase();
    if (!d.id) d.id = autoId(d.type);
    if (!d.name) d.name = d.id;
    if (d.enabled === '') d.enabled = 'TRUE';
    validate(d);
    if (getProvider(d.id)) throw invalid(`id "${d.id}" đã tồn tại`);
    await appendRows(config.sheetApiName, [toRow(d)]);
    await loadProviders();
    return getProvider(d.id);
  });
}

export function updateProvider(id, patch) {
  return serial(async () => {
    await loadProviders();
    const cur = getProvider(id);
    if (!cur) throw Object.assign(new Error(`Không tìm thấy provider "${id}"`), { status: 404 });
    const d = { ...cur._raw };
    for (const c of API_COLUMNS) {
      if (c === 'id' || !(c in patch)) continue;
      // api_key để trống hoặc là bản che (abcd…wxyz) = giữ key cũ
      if (c === 'api_key' && (clean(patch[c]) === '' || clean(patch[c]) === maskKey(cur.api_key))) continue;
      d[c] = clean(patch[c]);
    }
    if (patch.clear_api_key) d.api_key = '';
    d.id = cur.id;
    d.type = (d.type || 'generic').toLowerCase();
    validate(d);
    await updateRow(config.sheetApiName, cur._row, toRow(d));
    await loadProviders();
    return getProvider(id);
  });
}

export function removeProvider(id) {
  return serial(async () => {
    await loadProviders();
    const cur = getProvider(id);
    if (!cur) throw Object.assign(new Error(`Không tìm thấy provider "${id}"`), { status: 404 });
    await deleteRow(config.sheetApiName, cur._row);
    await loadProviders();
  });
}

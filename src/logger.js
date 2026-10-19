import { config, LOG_COLUMNS } from './config.js';
import { appendRows, readTable } from './sheets.js';

// Gom log vào hàng đợi rồi ghi theo lô (tránh vượt quota 60 request/phút của Google Sheets)
const queue = [];
let flushing = false;
let timer = null;

const cut = (v) => {
  if (v === undefined || v === null) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > config.logMaxChars ? s.slice(0, config.logMaxChars) + '…[cắt bớt]' : s;
};

/** Thời gian theo giờ Việt Nam, dạng 2026-10-18 21:47:05 */
export function nowVN() {
  return new Date()
    .toLocaleString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false })
    .replace('T', ' ');
}

export function log(entry) {
  const e = { timestamp: nowVN(), ...entry };
  const row = LOG_COLUMNS.map((c) => {
    if (c === 'prompt' || c === 'response' || c === 'error') return cut(e[c]);
    if (c === 'success') return e.success ? 'TRUE' : 'FALSE';
    return e[c] === undefined || e[c] === null ? '' : String(e[c]);
  });
  queue.push(row);

  const tag = e.success ? 'OK ' : 'ERR';
  console.log(
    `[${e.timestamp}] ${tag} ${e.request_id} #${e.attempt} ${e.provider_id || '-'} ` +
      `status=${e.status_code ?? '-'} ${e.latency_ms ?? '-'}ms ${e.error ? '| ' + String(e.error).slice(0, 150) : ''}`
  );
}

export async function flush() {
  if (flushing || queue.length === 0) return;
  flushing = true;
  const batch = queue.splice(0, queue.length);
  try {
    await appendRows(config.sheetLogName, batch);
  } catch (err) {
    console.error(`[LOG] Ghi sheet LOG thất bại (${batch.length} dòng), sẽ thử lại:`, err.message);
    queue.unshift(...batch);
    if (queue.length > 5000) queue.splice(0, queue.length - 5000); // tránh tràn bộ nhớ
  } finally {
    flushing = false;
  }
}

export function startLogger() {
  timer = setInterval(flush, config.logFlushSec * 1000);
}

export async function stopLogger() {
  clearInterval(timer);
  await flush();
}

export async function readRecentLogs(limit = 50) {
  const { items } = await readTable(config.sheetLogName);
  return items.slice(-limit).reverse().map(({ _row, ...rest }) => rest);
}

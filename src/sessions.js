// Lưu lịch sử hội thoại theo session_id (trong RAM, định kỳ ghi ra file để khởi động lại không mất)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

const sessions = new Map(); // id -> { id, messages, system, created, updated }
let dirty = false;

export function load() {
  try {
    const arr = JSON.parse(fs.readFileSync(config.sessionFile, 'utf8'));
    for (const s of arr) sessions.set(s.id, s);
    cleanup();
  } catch {
    // chưa có file: bỏ qua
  }
}

export function save() {
  if (!dirty) return;
  try {
    fs.mkdirSync(path.dirname(config.sessionFile), { recursive: true });
    fs.writeFileSync(config.sessionFile, JSON.stringify([...sessions.values()]));
    dirty = false;
  } catch (err) {
    console.error('[SESSION] Không ghi được file:', err.message);
  }
}

function cleanup() {
  const limit = Date.now() - config.sessionTtlHours * 3600 * 1000;
  for (const [id, s] of sessions) {
    if (s.updated < limit) {
      sessions.delete(id);
      dirty = true;
    }
  }
}

export function start() {
  load();
  setInterval(() => { cleanup(); save(); }, 30 * 1000);
}

export function get(id) {
  const s = sessions.get(id);
  if (!s) return null;
  if (s.updated < Date.now() - config.sessionTtlHours * 3600 * 1000) {
    sessions.delete(id);
    dirty = true;
    return null;
  }
  return s;
}

/** Lấy session có sẵn hoặc tạo mới (id không hợp lệ/hết hạn thì tạo mới với id đó) */
export function getOrCreate(id) {
  const existing = id && get(id);
  if (existing) return existing;
  const sid = id && /^[\w-]{6,64}$/.test(id) ? id : crypto.randomUUID();
  const s = { id: sid, messages: [], created: Date.now(), updated: Date.now() };
  sessions.set(sid, s);
  dirty = true;
  return s;
}

/** Thêm tin nhắn, chỉ giữ N tin gần nhất (tin đầu luôn là user) */
export function append(s, ...msgs) {
  s.messages.push(...msgs.map((m) => ({ role: m.role, content: m.content, at: Date.now() })));
  if (s.messages.length > config.sessionMaxMessages) {
    s.messages = s.messages.slice(-config.sessionMaxMessages);
    while (s.messages.length && s.messages[0].role !== 'user') s.messages.shift();
  }
  s.updated = Date.now();
  dirty = true;
}

export function remove(id) {
  dirty = sessions.delete(id) || dirty;
}

export function count() {
  return sessions.size;
}

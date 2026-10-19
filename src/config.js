import 'dotenv/config';
import path from 'node:path';

const num = (v, def) => (v === undefined || v === '' || isNaN(Number(v)) ? def : Number(v));

export const config = {
  port: num(process.env.PORT, 3000),
  // 0.0.0.0 = nhận kết nối từ mọi nơi; 127.0.0.1 = chỉ nhận từ chính máy (khi chạy sau Caddy/Nginx)
  host: process.env.HOST || '0.0.0.0',
  // Key cho người dùng (chat, dịch, content, giọng đọc). Nhiều key cách nhau dấu phẩy
  userApiKeys: (process.env.SERVER_API_KEY || '').split(',').map((s) => s.trim()).filter(Boolean),
  // Key quản trị (quản lý provider, xem log, thống kê). Trống = dùng chung key người dùng
  adminApiKey: process.env.ADMIN_API_KEY || '',

  // Giới hạn số request / phút cho mỗi key (hoặc IP nếu không có key). 0 = không giới hạn
  rateLimitPerMin: num(process.env.RATE_LIMIT_PER_MIN, 30),

  // Chat có lịch sử
  sessionMaxMessages: num(process.env.SESSION_MAX_MESSAGES, 30),
  sessionTtlHours: num(process.env.SESSION_TTL_HOURS, 24),
  sessionFile: path.resolve(process.env.SESSION_FILE || './data/sessions.json'),

  // Giọng đọc
  ttsModel: process.env.TTS_MODEL || 'gemini-3.8-flash-tts',
  ttsMaxChars: num(process.env.TTS_MAX_CHARS, 5000),

  spreadsheetId: process.env.SPREADSHEET_ID || '',
  credentialsFile: path.resolve(process.env.GOOGLE_CREDENTIALS_FILE || './credentials/service-account.json'),
  sheetApiName: process.env.SHEET_API_NAME || 'API',
  sheetLogName: process.env.SHEET_LOG_NAME || 'LOG',
  sheetKeysName: process.env.SHEET_KEYS_NAME || 'KEYS',

  providerRefreshSec: num(process.env.PROVIDER_REFRESH_SEC, 60),
  defaultStrategy: process.env.DEFAULT_STRATEGY || 'weighted',
  maxAttempts: num(process.env.MAX_ATTEMPTS, 3),
  defaultTimeoutMs: num(process.env.DEFAULT_TIMEOUT_MS, 30000),
  failThreshold: num(process.env.FAIL_THRESHOLD, 3),
  cooldownSec: num(process.env.COOLDOWN_SEC, 120),

  logFlushSec: num(process.env.LOG_FLUSH_SEC, 3),
  logMaxChars: num(process.env.LOG_MAX_CHARS, 2000),
};

// Cột của sheet API (thứ tự cột = thứ tự trong mảng)
export const API_COLUMNS = [
  'id',            // mã duy nhất, vd: openai-1
  'name',          // tên hiển thị
  'type',          // openai | gemini | claude | generic | mock
  'url',           // để trống = dùng URL mặc định theo type
  'method',        // GET/POST (chỉ dùng cho generic)
  'api_key',       // key của hãng
  'model',         // vd: gpt-4o-mini, gemini-2.0-flash, claude-sonnet-5-5
  'headers',       // JSON header thêm, vd: {"X-Foo":"bar"}
  'body_template', // (generic) JSON body, dùng {{prompt}} {{model}} {{api_key}} {{system}}
  'response_path', // (generic) đường dẫn lấy text, vd: data.result hoặc choices[0].message.content
  'weight',        // trọng số khi chọn weighted (số, mặc định 1)
  'enabled',       // TRUE/FALSE
  'timeout_ms',    // timeout riêng (ms), để trống = mặc định
  'note',          // ghi chú
];

// Cột của sheet LOG
export const LOG_COLUMNS = [
  'timestamp',
  'request_id',
  'endpoint',
  'client_ip',
  'strategy',
  'attempt',
  'provider_id',
  'provider_name',
  'type',
  'model',
  'url',
  'status_code',
  'success',
  'latency_ms',
  'prompt',
  'response',
  'error',
  'client_key',    // tên API key (tab KEYS) đã gọi request này
];

// Cột của sheet KEYS (API key do server cấp cho client)
export const KEY_COLUMNS = [
  'id',                // mã key, vd key-a1b2c3
  'name',              // tên gợi nhớ: "Server bot Telegram"
  'key_prefix',        // vài ký tự đầu để nhận diện: sk-rnd-a1b2…
  'key_hash',          // SHA-256 của key (không lưu key thật)
  'enabled',           // TRUE/FALSE
  'rate_per_min',      // giới hạn request/phút (trống = mặc định RATE_LIMIT_PER_MIN)
  'daily_limit',       // giới hạn request/ngày (trống = không giới hạn)
  'allowed_models',    // model được dùng, cách nhau dấu phẩy (trống = tất cả)
  'allowed_providers', // id API được dùng, cách nhau dấu phẩy (trống = tất cả)
  'expires_at',        // ngày hết hạn YYYY-MM-DD (trống = không hết hạn)
  'created_at',
  'total_requests',
  'today_date',
  'today_requests',
  'last_used',
  'note',
];

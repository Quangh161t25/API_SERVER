# Random API Server

Server gọi **ngẫu nhiên** nhiều API (OpenAI, Gemini, Claude, Groq/DeepSeek/OpenRouter, hoặc API bất kỳ).
- Danh sách API lưu ở **Google Sheet, tab `API`**: sửa trong sheet là server tự cập nhật (60 giây/lần).
- Mọi lần gọi được ghi vào **tab `LOG`**: thời gian, provider, mã lỗi, độ trễ, prompt, response...
- Có **fallback**: API lỗi thì tự chuyển sang API khác.
- Có **circuit breaker**: API lỗi 3 lần liên tiếp bị tạm loại 120 giây.

Ứng dụng cho người dùng (http://localhost:3000):
- 💬 **Chat** có nhớ lịch sử hội thoại, tùy chỉnh vai trò (system prompt)
- 🌐 **Dịch** 16 ngôn ngữ, 5 phong cách (tự nhiên, sát nghĩa, trang trọng, thân mật, chuyên ngành)
- ✍️ **Viết content**: bài Facebook, kịch bản TikTok, blog, SEO, quảng cáo, mô tả sản phẩm, email...
- 🔊 **Giọng đọc** (Gemini TTS): 30 giọng, chỉnh cách đọc, tải file WAV

Sheet: https://docs.google.com/spreadsheets/d/<ID_GOOGLE_SHEET>

## API key riêng + chuẩn OpenAI
Tạo key `sk-rnd-...` ở trang quản trị để server/app/tool khác gọi vào, server tự random sang các API gốc.
Dùng được với mọi thư viện OpenAI: `base_url = http://<server>/v1`, `model = auto`.
👉 Xem hướng dẫn chi tiết: [HUONG-DAN.md](HUONG-DAN.md)

## Đưa lên VPS
Một lệnh cài Node + pm2 + HTTPS (Caddy) + tường lửa: xem [TRIEN-KHAI-VPS.md](TRIEN-KHAI-VPS.md)
Hoặc deploy lên Render.com (không cần quản lý máy chủ): xem [DEPLOY-RENDER.md](DEPLOY-RENDER.md)

## Chạy

```bash
npm install
npm run init-sheet   # tạo tab API + LOG (chỉ cần chạy 1 lần)
npm start            # chạy server tại http://localhost:3000
```

- http://localhost:3000: ứng dụng cho người dùng (Chat, Dịch, Viết content, Giọng đọc). Bấm ⚙ để nhập key.
- http://localhost:3000/admin.html: trang quản trị (thống kê provider, log, gửi thử).

Yêu cầu:
- Sheet phải được **chia sẻ quyền Người chỉnh sửa** cho email service account: `<email service account trong file credentials>`
- Project Google Cloud phải bật **Google Sheets API**.
- File key nằm ở `credentials/service-account.json` (đã đưa vào `.gitignore`, **không được** đưa lên GitHub).

## Tab `API`: các cột

| Cột | Ý nghĩa |
|---|---|
| `id` | Mã duy nhất, vd `gemini-1` |
| `name` | Tên hiển thị |
| `type` | `openai` · `gemini` · `claude` · `generic` · `mock` |
| `url` | Để trống = URL mặc định của hãng. Với `openai` có thể đổi sang Groq, DeepSeek, OpenRouter... |
| `method` | GET/POST (chỉ cho `generic`) |
| `api_key` | Key của hãng |
| `model` | vd `gpt-4o-mini`, `gemini-3.8-flash`, `claude-haiku-5-5` |
| `headers` | JSON header thêm, vd `{"X-Foo":"bar"}` |
| `body_template` | (`generic`) JSON body, dùng `{{prompt}}` `{{system}}` `{{model}}` `{{api_key}}` |
| `response_path` | (`generic`) vị trí lấy kết quả, vd `data.answer` hoặc `choices[0].message.content` |
| `weight` | Trọng số khi chọn `weighted` (mặc định 1) |
| `enabled` | `TRUE` / `FALSE` |
| `timeout_ms` | Timeout riêng (ms) |
| `note` | Ghi chú |

> Dòng `mock-1`, `mock-2` là API giả để test. Khi đã thêm API thật, đặt `enabled = FALSE` cho chúng.

### Ví dụ thêm API bất kỳ (`generic`)
API nhận `POST https://abc.com/ask` với body `{"question":"..."}` và trả `{"data":{"answer":"..."}}`:

| type | url | method | headers | body_template | response_path |
|---|---|---|---|---|---|
| generic | https://abc.com/ask | POST | `{"Authorization":"Bearer {{api_key}}"}` | `{"question":"{{prompt}}"}` | `data.answer` |

API dạng GET: đặt `{{prompt}}` ngay trong url, vd `https://abc.com/q?text={{prompt}}` (tự động mã hóa URL).

## Tab `LOG`
`timestamp | request_id | endpoint | client_ip | strategy | attempt | provider_id | provider_name | type | model | url | status_code | success | latency_ms | prompt | response | error`

Một request bị fallback sẽ có nhiều dòng cùng `request_id` (attempt 1, 2, ...). Log được gom và ghi mỗi 3 giây để không vượt quota Google.

## Giọng đọc
Dùng key của các dòng `type = gemini` trong tab API, model đặt ở `TTS_MODEL` (mặc định `gemini-3.8-flash-tts`).
Nếu Google đổi tên model TTS, chỉ cần sửa `TTS_MODEL` trong `.env`. Dòng `mock` tạo tiếng "bíp" để test giao diện.

## API của server

Có 2 loại key (header `x-api-key: <key>` hoặc `Authorization: Bearer <key>`):
- `SERVER_API_KEY`: key người dùng, nhiều key cách nhau dấu phẩy. Dùng cho chat, dịch, content, giọng đọc. Bị giới hạn `RATE_LIMIT_PER_MIN` request/phút.
- `ADMIN_API_KEY`: key quản trị, dùng cho mọi endpoint, không bị giới hạn tốc độ. Để trống thì key người dùng cũng là key quản trị.

| Method | Đường dẫn | Chức năng |
|---|---|---|
| POST | `/api/chat` | Chat có lịch sử (gọi **ngẫu nhiên** 1 API) |
| GET / DELETE | `/api/sessions/:id` | Xem / xóa lịch sử 1 cuộc trò chuyện |
| POST | `/api/translate` | Dịch |
| POST | `/api/content` | Viết content |
| POST | `/api/tts` | Giọng đọc, trả file WAV |
| GET | `/api/options` | Danh sách ngôn ngữ, loại content, giọng đọc... |
| POST | `/api/compare` | Gọi **tất cả** API cùng lúc để so sánh |
| | *Các dòng dưới cần key quản trị* | |
| GET | `/api/providers` | Danh sách API (đã che key) |
| POST | `/api/providers` | Thêm API (ghi vào sheet) |
| PATCH | `/api/providers/:id` | Sửa API, vd `{"enabled":"FALSE"}` |
| DELETE | `/api/providers/:id` | Xóa API khỏi sheet |
| POST | `/api/reload` | Đọc lại sheet ngay |
| GET | `/api/stats` | Thống kê: số lần gọi, tỉ lệ thành công, độ trễ |
| GET | `/api/logs?limit=50` | Log gần nhất từ sheet |
| GET | `/health` | Kiểm tra server sống (không cần key) |

### Body của `/api/chat`
```json
{
  "message": "Xin chào",
  "session_id": "…",                       // tùy chọn: gửi lại id nhận được để AI nhớ hội thoại
  "system": "Trả lời bằng tiếng Việt",   // tùy chọn
  "strategy": "weighted",                 // random | weighted | roundrobin
  "type": "openai,gemini",                // tùy chọn: chỉ chọn trong các type này
  "provider": "gemini-1",                 // tùy chọn: ép dùng id này (có thể nhiều id, cách dấu phẩy)
  "raw": false,                           // true = trả thêm JSON gốc của hãng
  "max_attempts": 3
}
```

Kết quả:
```json
{
  "request_id": "fe3789dd",
  "session_id": "45420fe7-…",
  "provider": { "id": "gemini-1", "name": "Google Gemini", "type": "gemini", "model": "gemini-3.8-flash" },
  "text": "Xin chào! ...",
  "latency_ms": 812,
  "attempts": 2,
  "errors": [{ "provider": "openai-1", "status": 401, "error": "HTTP 401: ..." }]
}
```

Không muốn server lưu lịch sử: gửi `"messages": [{"role":"user","content":"..."}, {"role":"assistant","content":"..."}, ...]` thay cho `message`.

### `/api/translate`
`{ "text": "Hello", "to": "vi", "from": "auto", "style": "natural" }`
style: `natural` · `literal` · `formal` · `casual` · `technical`

### `/api/content`
`{ "topic": "Quán cà phê Đà Lạt", "kind": "facebook", "tone": "friendly", "length": "medium", "language": "vi", "keywords": "", "audience": "", "extra": "" }`
kind: `facebook` · `tiktok` · `blog` · `seo` · `ads` · `product` · `email` · `caption` · `idea` · `rewrite`
tone: `friendly` · `professional` · `funny` · `inspiring` · `urgent` · `luxury` · `youthful`
length: `short` · `medium` · `long`

### `/api/tts`
`{ "text": "Xin chào", "voice": "Kore", "style": "Đọc vui vẻ" }` trả về file `audio/wav`.
Thêm `"format": "json"` để nhận `audio_base64`.

### Gọi thử
```bash
curl -X POST http://localhost:3000/api/chat -H "Content-Type: application/json" -H "x-api-key: KEY_CUA_BAN" -d "{\"prompt\":\"hello\"}"
```

## Cấu hình `.env`
Xem `.env.example`: cổng, server key, tên tab, chiến lược mặc định, số lần thử, timeout, ngưỡng circuit breaker, chu kỳ ghi log.

## Cấu trúc
```
src/server.js          Express: các route
src/openai.js          Endpoint chuẩn OpenAI /v1 (models, chat/completions, audio/speech)
src/keys.js            API key do server cấp (tab KEYS)
src/models.js          Danh sách model mà từng key dùng được (cache 30 phút)
src/dispatch.js        Chọn provider + fallback + ghi log
src/middleware.js      Key người dùng / quản trị, giới hạn tốc độ
src/sessions.js        Lịch sử chat (lưu ra data/sessions.json)
src/prompts.js         Prompt có sẵn cho Dịch và Viết content
src/selector.js        Chọn random/weighted/roundrobin, circuit breaker, thống kê
src/providers/index.js Adapter openai/gemini/claude/generic/mock + giọng đọc
src/store.js           Đọc/ghi tab API
src/logger.js          Hàng đợi log -> tab LOG
src/sheets.js          Google Sheets API
scripts/init-sheet.js  Tạo tab + dòng mẫu
public/index.html      Ứng dụng cho người dùng
public/admin.html      Trang quản trị
```

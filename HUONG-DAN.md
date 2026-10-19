# Hướng dẫn: tạo API key riêng và dùng ở server khác

Server của bạn hoạt động như một **API Gateway**:

```
Server khác / app / tool  ──(1 key sk-rnd-...)──►  Server của bạn  ──(chọn ngẫu nhiên)──►  gemini-1, gemini-2, OpenAI, Claude...
```

- **Key gốc** (của Google, OpenAI...) nằm ở tab **API** trong Google Sheet, không bao giờ lộ ra ngoài.
- **Key bạn cấp** (`sk-rnd-...`) nằm ở tab **KEYS**. Đưa key này cho server/app khác dùng, thu hồi lúc nào cũng được.
- Chuẩn **OpenAI**: mọi thư viện/tool hỗ trợ OpenAI đều dùng được ngay.

---

## Bước 1. Chạy lại server

Tắt server đang chạy (Ctrl+C), rồi:

```bash
npm start
```

Dòng cuối phải thấy: `Server chạy tại http://localhost:3000 (... OpenAI API: /v1)`

## Bước 2. Tạo API key

1. Mở http://localhost:3000/admin.html
2. Ở mục **🔑 API key của tôi**, bấm **＋ Tạo API key**
3. Điền:
   | Ô | Ý nghĩa | Ví dụ |
   |---|---|---|
   | Tên key | Để nhớ key dùng ở đâu | `Bot Telegram` |
   | Giới hạn / phút | Chống spam. Trống = 30 (theo `.env`) | `20` |
   | Giới hạn / ngày | Bảo vệ quota Gemini. Trống = không giới hạn | `500` |
   | Chỉ được dùng các API | Tick để giới hạn key chỉ dùng vài API. Không tick = tất cả | `gemini-1` |
   | Chỉ được dùng các model | Trống = tất cả | `gemini-3.8-flash` |
   | Hết hạn ngày | Trống = không hết hạn | `2026-12-31` |
4. Bấm **Tạo key**, rồi **chép key ngay**. Key chỉ hiện **1 lần duy nhất**, vì Sheet chỉ lưu mã băm của key, không lưu key thật.

> Mất key: xóa key cũ và tạo key mới.
> Tạm dừng một key: gạt công tắc **Bật** sang tắt, key bị từ chối ngay lập tức.

⚠️ **Khi đã có ít nhất 1 key**, mọi request từ máy khác đều phải gửi key. Riêng trên chính máy chạy server, bạn vẫn dùng trang web bình thường mà không cần key.

## Bước 3. Dùng key

Hộp hiện key có sẵn code mẫu (nút **Xem code mẫu**). Ba thông tin cần nhớ:

```
base_url = http://<địa-chỉ-server>/v1
api_key  = sk-rnd-....
model    = auto        (ngẫu nhiên tất cả API)  hoặc tên model, vd gemini-3.8-flash
```

### Python
```python
# pip install openai
from openai import OpenAI

client = OpenAI(base_url="http://localhost:3000/v1", api_key="sk-rnd-...")

res = client.chat.completions.create(
    model="auto",
    messages=[
        {"role": "system", "content": "Bạn là trợ lý tiếng Việt"},
        {"role": "user", "content": "Xin chào"},
    ],
)
print(res.choices[0].message.content)
print("Model đã dùng:", res.model)
```

### Node.js
```js
// npm install openai
import OpenAI from "openai";
const client = new OpenAI({ baseURL: "http://localhost:3000/v1", apiKey: "sk-rnd-..." });

const res = await client.chat.completions.create({
  model: "auto",
  messages: [{ role: "user", content: "Xin chào" }],
});
console.log(res.choices[0].message.content);
```

### curl
```bash
curl http://localhost:3000/v1/chat/completions -H "Authorization: Bearer sk-rnd-..." -H "Content-Type: application/json" -d "{\"model\":\"auto\",\"messages\":[{\"role\":\"user\",\"content\":\"Xin chao\"}]}"
```

### Tool có sẵn (n8n, Dify, LangChain, Open WebUI, LobeChat, Cursor...)
Chọn nhà cung cấp **OpenAI** hoặc **OpenAI compatible**, rồi điền **Base URL** = `http://<server>/v1`, **API Key** = `sk-rnd-...`, **Model** = `auto`.

### Các endpoint
| Endpoint | Chức năng |
|---|---|
| `GET /v1/models` | Danh sách model key này dùng được (có `auto`) |
| `POST /v1/chat/completions` | Chat. Hỗ trợ `stream`, `temperature`, `max_tokens`, `top_p` |
| `POST /v1/audio/speech` | Giọng đọc: `{"input":"...","voice":"Kore"}`, trả về file WAV |

Tùy chọn thêm qua header:
- `X-Provider: gemini-1` để ép dùng 1 API.
- `X-Strategy: random | weighted | roundrobin` để chọn cách chọn API.

## Bước 4. Cho server khác gọi tới (đưa lên Internet)

`localhost` chỉ dùng được trên chính máy bạn. Để server khác gọi được, bạn cần một địa chỉ công khai.

**Trước tiên, đặt mật khẩu quản trị** trong file `.env`, rồi chạy lại server:
```
ADMIN_API_KEY=mot-chuoi-dai-kho-doan-cua-ban
```
Sau đó vào trang quản trị từ máy khác thì nhập chuỗi này vào ô **Admin key**.
Nếu chưa đặt, trang quản trị chỉ mở được từ chính máy chạy server (an toàn mặc định).

### Cách A: Cloudflare Tunnel (miễn phí, không cần mở port, có HTTPS)
1. Tải `cloudflared` cho Windows: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
2. Chạy (server vẫn đang chạy ở cổng 3000):
   ```bash
   cloudflared tunnel --url http://localhost:3000
   ```
3. Lệnh in ra địa chỉ dạng `https://abc-xyz.trycloudflare.com`. Server khác dùng:
   `base_url = https://abc-xyz.trycloudflare.com/v1`

> Địa chỉ `trycloudflare.com` đổi mỗi lần chạy lại. Muốn địa chỉ cố định, tạo "named tunnel" gắn với tên miền của bạn trong Cloudflare.

### Cách B: ngrok
```bash
ngrok http 3000
```

### Cách C: Thuê VPS (chạy 24/7)
Copy cả thư mục lên VPS (nhớ mang theo `credentials/` và `.env`), rồi chạy:
```bash
npm install
npm install -g pm2
pm2 start src/server.js --name api-server
pm2 save
```
Nên đặt Nginx/Caddy phía trước để có HTTPS.

## Bước 5. Theo dõi

- **Trang quản trị, mục API key:** số lượt hôm nay, tổng, lần dùng cuối của từng key. Các số này được ghi xuống tab KEYS mỗi 30 giây.
- **Tab LOG:** cột `client_key` cho biết request nào do key nào gọi.
- **Hết quota / lỗi:** server tự chuyển sang API khác. Xem cột `error` trong LOG.

## Lỗi thường gặp

| Mã | Thông báo | Cách xử lý |
|---|---|---|
| 401 | `Thiếu API key` / `API key không hợp lệ` | Kiểm tra header `Authorization: Bearer sk-rnd-...` |
| 401 | `đã bị thu hồi / tắt` / `đã hết hạn` | Bật lại key hoặc sửa ngày hết hạn |
| 403 | `không được dùng model ...` | Key bị giới hạn model. Dùng `auto` hoặc model được phép |
| 403 | `Trang quản trị chỉ mở từ máy chạy server` | Đặt `ADMIN_API_KEY` trong `.env` |
| 429 | `Quá ... request/phút` / `đã dùng hết ... hôm nay` | Đợi, hoặc tăng giới hạn của key |
| 503 | `Không có key nào dùng được model ...` | Sai tên model. Xem `GET /v1/models` |
| 502 | `Tất cả provider đã thử đều lỗi` | Các key Gemini đều lỗi/hết quota. Xem tab LOG |

## Lưu ý

- **Quota dùng chung:** mọi key `sk-rnd-` đều dùng chung quota của các key Gemini gốc. Đặt giới hạn/ngày để không key nào dùng hết phần của key khác.
- **Stream:** server chờ AI trả lời xong rồi mới gửi về theo từng đoạn, nên chữ không hiện dần từng chữ như khi gọi thẳng Gemini. Tool vẫn hoạt động bình thường.
- **Ảnh và function calling (`tools`) chưa được hỗ trợ:** phần ảnh trong tin nhắn sẽ bị bỏ qua.
- **Điều khoản:** dùng cho bản thân / hệ thống của bạn thì ổn. **Bán key** mà phía sau là Gemini miễn phí là vi phạm điều khoản của Google.

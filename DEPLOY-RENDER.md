# Deploy lên Render.com

Render chạy code trực tiếp từ **GitHub**: bạn đẩy code lên GitHub, Render tự cài và chạy, có sẵn **HTTPS** và địa chỉ dạng `https://ten-cua-ban.onrender.com`.

| Gói | Giá | Đặc điểm |
|---|---|---|
| **Free** | 0đ | **Ngủ sau 15 phút không có request**. Request đầu tiên sau khi ngủ phải chờ khoảng 1 phút. Khởi động lại sẽ mất lịch sử chat |
| **Starter** | $7/tháng | Chạy 24/7, không ngủ |

> Danh sách API, API key và log đều nằm ở **Google Sheet**, nên không bị mất khi Render khởi động lại.

---

## Bước 1. Tạo tài khoản
1. Tạo tài khoản **GitHub**: https://github.com/signup
2. Tạo tài khoản **Render**: https://dashboard.render.com/register. Chọn **"Sign up with GitHub"** cho tiện.

## Bước 2. Đẩy code lên GitHub (repo **Private**)

1. Trên GitHub bấm **New repository**:
   - Name: `api-server`
   - Chọn **Private** ⚠️ (bắt buộc private)
   - Không tick thêm README
   - Bấm **Create repository**
2. Mở PowerShell trong thư mục dự án, chạy lần lượt (thay `TEN_GITHUB` bằng tên GitHub của bạn):

```bash
git init
```
```bash
git add .
```
```bash
git status
```

👉 **Kiểm tra danh sách `git status` in ra: KHÔNG được có `.env`, `credentials/`, `node_modules/`.** Các mục này đã được chặn trong `.gitignore`. Nếu thấy chúng xuất hiện thì **dừng lại**, đừng đẩy lên.

```bash
git commit -m "Random API Server"
```
```bash
git branch -M main
```
```bash
git remote add origin https://github.com/TEN_GITHUB/api-server.git
```
```bash
git push -u origin main
```

Lần đầu `git push`, Windows mở cửa sổ đăng nhập GitHub. Bạn tự đăng nhập là xong.

> Không quen dòng lệnh? Dùng **GitHub Desktop** (https://desktop.github.com): File → Add local repository → chọn thư mục → Publish repository (tick **Keep this code private**).

## Bước 3. Tạo service trên Render

### Cách A: Blueprint (nhanh, dùng file `render.yaml` có sẵn)
1. Vào Render, chọn **New +** → **Blueprint**.
2. Kết nối GitHub, chọn repo `api-server`. Render đọc file `render.yaml`.
3. Render hỏi các biến còn thiếu:
   - **SPREADSHEET_ID**: `<ID_GOOGLE_SHEET>`
   - **GOOGLE_CREDENTIALS_JSON**: mở file `credentials/service-account.json` bằng Notepad, **chép toàn bộ nội dung** (từ `{` đến `}`) rồi dán vào.
4. Bấm **Apply**.

### Cách B: Tạo thủ công
1. Vào **New +** → **Web Service**, chọn repo `api-server`, rồi điền:

   | Ô | Giá trị |
   |---|---|
   | Name | `random-api-server` (thành địa chỉ `random-api-server.onrender.com`) |
   | Region | **Singapore** |
   | Branch | `main` |
   | Runtime / Language | **Node** |
   | Build Command | `npm ci --omit=dev` |
   | Start Command | `npm start` |
   | Instance Type | **Free** (hoặc Starter) |

2. Kéo xuống **Environment Variables** và thêm:

   | Key | Value |
   |---|---|
   | `NODE_VERSION` | `22` |
   | `SPREADSHEET_ID` | `<ID_GOOGLE_SHEET>` |
   | `GOOGLE_CREDENTIALS_JSON` | toàn bộ nội dung file `credentials/service-account.json` |
   | `ADMIN_API_KEY` | một chuỗi dài tự đặt, vd `adm-` + 30 ký tự ngẫu nhiên. **Nhớ lưu lại** |
   | `DEFAULT_STRATEGY` | `random` |
   | `TTS_MODEL` | `gemini-3.8-flash-tts` |

3. Ở mục **Advanced**, ô **Health Check Path** điền `/health`.
4. Bấm **Create Web Service**.

> **Không** đặt biến `PORT`, `HOST`: Render tự cấp.

## Bước 4. Kiểm tra

1. Mở tab **Logs** của service. Deploy thành công khi thấy:
   ```
   Đã tải 2 provider từ sheet "API"
   Đã tải 1 API key từ sheet "KEYS"
   Server chạy tại ...
   ```
   Trạng thái phía trên chuyển sang **Live** 🟢.
2. Mở các địa chỉ (thay bằng tên service của bạn):

   | Trang | Địa chỉ |
   |---|---|
   | Kiểm tra sống | `https://random-api-server.onrender.com/health` |
   | Trang quản trị | `https://random-api-server.onrender.com/admin.html` (nhập **ADMIN_API_KEY**, bấm Lưu) |
   | Test key | `https://random-api-server.onrender.com/test.html` |
   | Ứng dụng | `https://random-api-server.onrender.com/` |
   | **base_url OpenAI** | `https://random-api-server.onrender.com/v1` |

3. Dùng ở server khác:
   ```python
   from openai import OpenAI
   client = OpenAI(base_url="https://random-api-server.onrender.com/v1", api_key="sk-rnd-...")
   ```
   Với gói Free, nên đặt timeout ít nhất 90 giây để chờ được lúc server đang ngủ:
   ```python
   client = OpenAI(base_url="...", api_key="sk-rnd-...", timeout=90)
   ```

> Xem lại ADMIN_API_KEY: Render → service → tab **Environment**.

## Bước 5. Cập nhật code về sau

Sửa code trên máy rồi chạy:
```bash
git add .
```
```bash
git commit -m "Cap nhat"
```
```bash
git push
```
Render **tự deploy lại** sau khoảng 1–3 phút (xem ở tab **Events**).

## Gói Free: hạn chế ngủ

- Render cho **750 giờ chạy miễn phí mỗi tháng**, đủ cho 1 service chạy cả tháng.
- Có thể dùng dịch vụ hẹn giờ miễn phí như **cron-job.org** hoặc **UptimeRobot** để gọi `https://.../health` mỗi 10 phút, giữ server không ngủ. Đây là cách nhiều người dùng, nhưng Render có thể thay đổi chính sách. Cần chạy ổn định thật thì nên dùng **Starter ($7/tháng)** hoặc VPS.

## Lỗi thường gặp

| Hiện tượng (trong Logs) | Cách xử lý |
|---|---|
| `GOOGLE_CREDENTIALS_JSON không phải JSON hợp lệ` | Dán lại **toàn bộ** nội dung file, đủ cả dấu `{` đầu và `}` cuối |
| `Không tải được provider` / lỗi `permission` | Kiểm tra `SPREADSHEET_ID`, và Sheet đã share cho `<email service account trong file credentials>` quyền Người chỉnh sửa |
| Build lỗi `npm ci` | Kiểm tra file `package-lock.json` đã được đẩy lên GitHub |
| Trang quản trị báo 403 | Chưa nhập / nhập sai `ADMIN_API_KEY` |
| Request đầu tiên rất lâu | Gói Free đang ngủ, chờ khoảng 1 phút. Các request sau sẽ nhanh |
| `502` / `Tất cả provider đã thử đều lỗi` | Key Gemini lỗi hoặc hết quota. Xem tab **LOG** trong Google Sheet |

## Bảo mật
- Repo GitHub phải để **Private**. File key Google **không** nằm trong repo, mà chỉ nằm ở biến môi trường trên Render.
- Key Google service account đã từng dán vào chat: nên tạo key mới trong Google Cloud Console, rồi cập nhật lại `GOOGLE_CREDENTIALS_JSON` trên Render (tab Environment → Save, Render tự khởi động lại).

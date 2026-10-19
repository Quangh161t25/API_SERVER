# Đưa server lên VPS Ubuntu

Script `deploy/install.sh` cài **mọi thứ chỉ bằng 1 lệnh**:

| Thành phần | Tác dụng |
|---|---|
| **Node.js 22 LTS** | Chạy code |
| **pm2** | Giữ server luôn chạy, tự chạy lại khi lỗi và **khi VPS khởi động lại** |
| **Caddy** | **HTTPS miễn phí, tự gia hạn** (Let's Encrypt) |
| **ufw** | Tường lửa: chỉ mở cổng 22, 80, 443. Cổng 3000 không lộ ra ngoài |
| **swap 1GB** | Chống hết RAM trên VPS 1GB |
| **user `apiserver`** | App không chạy bằng root, an toàn hơn |

---

## 0. Chuẩn bị

- **VPS Ubuntu 22.04 hoặc 24.04**, tối thiểu 1 GB RAM. Khi mua, chọn hệ điều hành *Ubuntu*.
- Nhà cung cấp gửi cho bạn **IP**, user (thường là `root`) và **mật khẩu**.
- *(Tùy chọn)* **Tên miền.** Nếu có, vào trang quản lý DNS tạo bản ghi **A**: `api.tenmien.com` → `IP_VPS`. Nếu không có, script tự dùng tên miền miễn phí dạng `1-2-3-4.sslip.io`.

## 1. Đóng gói code (trên máy Windows)

Mở PowerShell trong thư mục dự án:

```bash
powershell -ExecutionPolicy Bypass -File deploy\pack.ps1
```

Lệnh tạo file `api-server.tar.gz` (khoảng 75 KB) gồm code, `.env` và `credentials/`.
⚠️ File này chứa key Google, **không gửi cho ai**. Upload xong thì có thể xóa.

## 2. Upload lên VPS

Windows 10/11 có sẵn lệnh `scp` (thay `IP_VPS` bằng IP thật, nhập mật khẩu VPS khi được hỏi):

```bash
scp api-server.tar.gz root@IP_VPS:/root/
```

> Thích dùng giao diện thì có thể dùng **WinSCP** hoặc **FileZilla** (giao thức SFTP), kéo file vào thư mục `/root/`.

## 3. Cài đặt (trên VPS)

Đăng nhập VPS:

```bash
ssh root@IP_VPS
```

Rồi chạy lần lượt:

```bash
mkdir -p ~/api-server && tar -xzf ~/api-server.tar.gz -C ~/api-server && cd ~/api-server
sed -i 's/\r$//' deploy/install.sh
sudo bash deploy/install.sh
```

Nếu có tên miền thì thay dòng cuối bằng:
```bash
sudo bash deploy/install.sh api.tenmien.com
```

Script chạy khoảng 2 đến 5 phút. Khi xong, màn hình hiện:

```
 XONG!
 Địa chỉ:          https://1-2-3-4.sslip.io
 Trang quản trị:   https://1-2-3-4.sslip.io/admin.html
 Trang test key:   https://1-2-3-4.sslip.io/test.html
 base_url OpenAI:  https://1-2-3-4.sslip.io/v1
 ADMIN KEY (dùng để vào trang quản trị, hãy lưu lại):
   adm-xxxxxxxxxxxxxxxx
```

👉 **Chép ADMIN KEY lại.** Mở trang quản trị, dán key vào ô **Admin key** rồi bấm **Lưu**.

## 4. Dùng

- Trên trang quản trị, tạo **API key** `sk-rnd-...` cho server hoặc app của bạn (xem [HUONG-DAN.md](HUONG-DAN.md)).
- Ở server khác, đặt `base_url = https://<địa-chỉ-của-bạn>/v1`.
- Thử nhanh bằng trang `https://<địa-chỉ-của-bạn>/test.html`.

## 5. Cập nhật code về sau

Trên Windows, đóng gói lại rồi upload như bước 1 và 2. Sau đó trên VPS:

```bash
rm -rf ~/api-server && mkdir -p ~/api-server && tar -xzf ~/api-server.tar.gz -C ~/api-server && cd ~/api-server
sed -i 's/\r$//' deploy/install.sh && sudo bash deploy/install.sh
```

Khi cập nhật, `.env`, `credentials/` và `data/` **trên VPS được giữ nguyên**, không bị file từ máy bạn ghi đè. Server khởi động lại gần như không gián đoạn.

## 6. Lệnh hay dùng trên VPS

| Việc | Lệnh |
|---|---|
| Xem log trực tiếp | `sudo -u apiserver pm2 logs api-server` |
| Trạng thái | `sudo -u apiserver pm2 status` |
| Khởi động lại app | `sudo -u apiserver pm2 restart api-server` |
| Sửa cấu hình | `sudo nano /opt/api-server/.env`, rồi khởi động lại app |
| Xem lại admin key | `sudo grep ADMIN_API_KEY /opt/api-server/.env` |
| Log của Caddy (HTTPS) | `journalctl -u caddy -n 50` |
| Thử khởi động lại VPS | `sudo reboot`. Khoảng 1 phút sau app tự chạy lại |

Code nằm ở `/opt/api-server`. Danh sách API, key và log vẫn ở **Google Sheet** như trước.

## 7. Lỗi thường gặp

| Hiện tượng | Cách xử lý |
|---|---|
| `Không kết nối được Google Sheet` | Thiếu `credentials/service-account.json` trong gói, hoặc Sheet chưa share cho service account |
| HTTPS báo lỗi / không vào được | Chờ 1–2 phút để Caddy lấy chứng chỉ. Nếu dùng tên miền riêng, kiểm tra bản ghi A đã trỏ đúng IP chưa. Xem `journalctl -u caddy -n 50` |
| Nhà cung cấp VPS có **tường lửa riêng** (Security Group) | Mở cổng **80** và **443** trong trang quản lý VPS |
| Trang quản trị báo 403 | Chưa nhập Admin key, hoặc nhập sai |
| `bash\r: No such file` | Quên chạy `sed -i 's/\r$//' deploy/install.sh` |
| App lỗi liên tục | Xem `sudo -u apiserver pm2 logs api-server --lines 100` |

## 8. Bảo mật nên làm thêm

- **Đổi mật khẩu root**, hoặc tốt hơn là đăng nhập SSH bằng khóa (ssh-key) rồi tắt đăng nhập bằng mật khẩu.
- Key Google service account đã từng dán vào chat: nên **tạo key mới** trong Google Cloud Console, thay file trên VPS (`/opt/api-server/credentials/service-account.json`), khởi động lại app, rồi xóa key cũ.

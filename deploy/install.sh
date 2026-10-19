#!/usr/bin/env bash
# =============================================================================
#  Cài / cập nhật Random API Server lên VPS Ubuntu (22.04 / 24.04)
#
#  Cách chạy (trong thư mục code đã giải nén trên VPS):
#     sudo bash deploy/install.sh                     # chưa có tên miền: tự dùng <ip>.sslip.io
#     sudo bash deploy/install.sh api.tenmien.com     # có tên miền (đã trỏ A record về IP VPS)
#
#  Chạy lại lệnh này mỗi khi cập nhật code: dữ liệu (.env, credentials, data/) trên VPS được giữ nguyên.
#
#  Cài đặt:  Node.js 22 LTS + pm2 (tự chạy lại khi lỗi / reboot) + Caddy (HTTPS tự động) + tường lửa ufw
# =============================================================================
set -euo pipefail

APP_NAME="api-server"
APP_USER="apiserver"
APP_DIR="/opt/api-server"
APP_PORT="3000"
NODE_MAJOR="22"

DOMAIN="${1:-}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

green() { echo -e "\e[32m$*\e[0m"; }
yellow() { echo -e "\e[33m$*\e[0m"; }
red() { echo -e "\e[31m$*\e[0m"; }
step() { echo; green "==> $*"; }

[ "$(id -u)" -eq 0 ] || { red "Hãy chạy bằng sudo: sudo bash deploy/install.sh $DOMAIN"; exit 1; }
[ -f "$SRC_DIR/package.json" ] && [ -f "$SRC_DIR/src/server.js" ] || { red "Không thấy code ở $SRC_DIR (cần package.json và src/server.js)"; exit 1; }
. /etc/os-release
[ "${ID:-}" = "ubuntu" ] || [ "${ID_LIKE:-}" = "debian" ] || [ "${ID:-}" = "debian" ] || yellow "Cảnh báo: script viết cho Ubuntu/Debian, hệ điều hành của bạn là ${PRETTY_NAME:-không rõ}"

# ---------------------------------------------------------------- tên miền
PUBLIC_IP="$(curl -4 -fsS --max-time 10 https://api.ipify.org || curl -4 -fsS --max-time 10 https://ifconfig.me || true)"
if [ -z "$DOMAIN" ]; then
  [ -n "$PUBLIC_IP" ] || { red "Không lấy được IP công khai. Hãy chạy kèm tên miền: sudo bash deploy/install.sh api.tenmien.com"; exit 1; }
  DOMAIN="${PUBLIC_IP//./-}.sslip.io"
  yellow "Chưa có tên miền -> dùng tên miền miễn phí: $DOMAIN (trỏ sẵn về $PUBLIC_IP)"
fi

# ---------------------------------------------------------------- gói hệ thống
step "Cập nhật hệ thống và cài gói cần thiết"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates gnupg rsync ufw debian-keyring debian-archive-keyring apt-transport-https

# ---------------------------------------------------------------- swap (VPS 1GB RAM dễ hết RAM khi npm install)
if ! swapon --show | grep -q .; then
  step "Tạo swap 1GB (chống hết RAM)"
  fallocate -l 1G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=1024
  chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# ---------------------------------------------------------------- Node.js
if ! command -v node >/dev/null || [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt 18 ]; then
  step "Cài Node.js $NODE_MAJOR LTS"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi
green "Node $(node -v), npm $(npm -v)"

# ---------------------------------------------------------------- pm2
if ! command -v pm2 >/dev/null; then
  step "Cài pm2"
  npm install -g pm2
fi

# ---------------------------------------------------------------- user chạy app
if ! id "$APP_USER" >/dev/null 2>&1; then
  step "Tạo user hệ thống '$APP_USER' để chạy app (không chạy bằng root cho an toàn)"
  useradd --system --create-home --home-dir "/home/$APP_USER" --shell /bin/bash "$APP_USER"
fi

# ---------------------------------------------------------------- chép code
step "Chép code vào $APP_DIR"
mkdir -p "$APP_DIR"
FIRST_INSTALL=0
[ -f "$APP_DIR/.env" ] || FIRST_INSTALL=1
if [ "$SRC_DIR" != "$APP_DIR" ]; then
  # Không chép đè: .env, credentials/, data/ (giữ dữ liệu trên VPS), node_modules
  rsync -a --delete \
    --exclude node_modules --exclude data --exclude .env --exclude credentials --exclude '*.zip' \
    "$SRC_DIR/" "$APP_DIR/"
  # Lần đầu: lấy .env và credentials từ gói upload
  if [ ! -f "$APP_DIR/.env" ] && [ -f "$SRC_DIR/.env" ]; then cp "$SRC_DIR/.env" "$APP_DIR/.env"; fi
  if [ ! -f "$APP_DIR/.env" ]; then cp "$APP_DIR/.env.example" "$APP_DIR/.env"; fi
  if [ ! -d "$APP_DIR/credentials" ] && [ -d "$SRC_DIR/credentials" ]; then cp -r "$SRC_DIR/credentials" "$APP_DIR/credentials"; fi
fi
mkdir -p "$APP_DIR/data"
sed -i 's/\r$//' "$APP_DIR/.env"   # bỏ ký tự xuống dòng kiểu Windows

[ -f "$APP_DIR/credentials/service-account.json" ] || { red "Thiếu $APP_DIR/credentials/service-account.json (file key Google). Chép file đó lên rồi chạy lại."; exit 1; }

# ---------------------------------------------------------------- .env cho VPS
set_env() { # set_env KEY VALUE : sửa nếu có, thêm nếu chưa có
  if grep -qE "^$1=" "$APP_DIR/.env"; then sed -i "s|^$1=.*|$1=$2|" "$APP_DIR/.env"; else echo "$1=$2" >> "$APP_DIR/.env"; fi
}
get_env() { grep -E "^$1=" "$APP_DIR/.env" | tail -1 | cut -d= -f2- || true; }

set_env PORT "$APP_PORT"
set_env HOST "127.0.0.1"   # chỉ nhận kết nối qua Caddy, không mở cổng 3000 ra ngoài
ADMIN_KEY_NEW=""
if [ -z "$(get_env ADMIN_API_KEY)" ]; then
  ADMIN_KEY_NEW="adm-$(openssl rand -hex 20)"
  set_env ADMIN_API_KEY "$ADMIN_KEY_NEW"
fi

chown -R "$APP_USER:$APP_USER" "$APP_DIR"
chmod 600 "$APP_DIR/.env" "$APP_DIR/credentials/"*.json

# ---------------------------------------------------------------- cài thư viện
step "Cài thư viện Node (npm)"
if [ -f "$APP_DIR/package-lock.json" ]; then
  sudo -u "$APP_USER" -H bash -c "cd '$APP_DIR' && npm ci --omit=dev --no-audit --no-fund"
else
  sudo -u "$APP_USER" -H bash -c "cd '$APP_DIR' && npm install --omit=dev --no-audit --no-fund"
fi

# ---------------------------------------------------------------- tạo tab Google Sheet nếu chưa có
step "Kiểm tra kết nối Google Sheet"
if ! sudo -u "$APP_USER" -H bash -c "cd '$APP_DIR' && node scripts/init-sheet.js"; then
  red "Không kết nối được Google Sheet. Kiểm tra file credentials và đã share Sheet cho service account chưa."
  exit 1
fi

# ---------------------------------------------------------------- chạy bằng pm2
step "Khởi động app bằng pm2"
PM2="sudo -u $APP_USER -H env PM2_HOME=/home/$APP_USER/.pm2 pm2"
if $PM2 describe "$APP_NAME" >/dev/null 2>&1; then
  $PM2 reload "$APP_DIR/ecosystem.config.cjs" --update-env
else
  $PM2 start "$APP_DIR/ecosystem.config.cjs"
fi
$PM2 save
# Tự chạy lại khi VPS khởi động lại
env PATH="$PATH:/usr/bin" pm2 startup systemd -u "$APP_USER" --hp "/home/$APP_USER" >/dev/null
systemctl enable "pm2-$APP_USER" >/dev/null 2>&1 || true
# Xoay vòng log để không đầy ổ cứng
$PM2 describe pm2-logrotate >/dev/null 2>&1 || $PM2 install pm2-logrotate >/dev/null 2>&1 || true

# ---------------------------------------------------------------- Caddy (HTTPS)
if ! command -v caddy >/dev/null; then
  step "Cài Caddy (web server có HTTPS tự động)"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

step "Cấu hình Caddy cho $DOMAIN"
cat > /etc/caddy/Caddyfile <<EOF
# Tạo bởi deploy/install.sh
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:$APP_PORT {
		flush_interval -1
	}
}
EOF
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl enable caddy >/dev/null 2>&1
systemctl reload caddy || systemctl restart caddy

# ---------------------------------------------------------------- tường lửa
step "Bật tường lửa: chỉ mở SSH (22), HTTP (80), HTTPS (443)"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

# ---------------------------------------------------------------- kiểm tra
step "Kiểm tra"
sleep 3
if curl -fsS --max-time 10 "http://127.0.0.1:$APP_PORT/health" >/dev/null; then
  green "App chạy OK trên cổng $APP_PORT"
else
  red "App chưa phản hồi. Xem log: sudo -u $APP_USER pm2 logs $APP_NAME"
fi
HTTPS_OK=0
for i in 1 2 3 4 5 6; do
  if curl -fsS --max-time 10 "https://$DOMAIN/health" >/dev/null 2>&1; then HTTPS_OK=1; break; fi
  sleep 5
done

echo
green "=============================================================="
green " XONG!"
green "=============================================================="
echo " Địa chỉ:          https://$DOMAIN"
echo " Ứng dụng:         https://$DOMAIN/"
echo " Trang quản trị:   https://$DOMAIN/admin.html"
echo " Trang test key:   https://$DOMAIN/test.html"
echo " base_url OpenAI:  https://$DOMAIN/v1"
if [ "$HTTPS_OK" = "1" ]; then green " HTTPS: OK"; else yellow " HTTPS chưa sẵn sàng (cấp chứng chỉ có thể mất 1-2 phút). Kiểm tra: journalctl -u caddy -n 50"; fi
if [ -n "$ADMIN_KEY_NEW" ]; then
  echo
  yellow " ADMIN KEY (dùng để vào trang quản trị, hãy lưu lại):"
  yellow "   $ADMIN_KEY_NEW"
  yellow " (Lưu trong $APP_DIR/.env, xem lại: sudo grep ADMIN_API_KEY $APP_DIR/.env)"
fi
echo
echo " Lệnh hay dùng:"
echo "   Xem log:        sudo -u $APP_USER pm2 logs $APP_NAME"
echo "   Trạng thái:     sudo -u $APP_USER pm2 status"
echo "   Khởi động lại:  sudo -u $APP_USER pm2 restart $APP_NAME"
echo "   Sửa cấu hình:   sudo nano $APP_DIR/.env   (rồi khởi động lại)"

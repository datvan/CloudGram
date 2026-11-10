#!/usr/bin/env bash
#
# Mở đường tải thẳng lên VPS (không qua Cloudflare) cho video phát ra trình
# phát ngoài. Chạy một lần từ máy mình, sau khi đã thêm bản ghi DNS:
#
#     A   up   <IP của VPS>   chế độ "DNS only" (mây XÁM, không phải cam)
#
#     bash deploy/vps-direct-upload.sh
#
# Script này đổi cấu hình hệ thống trên VPS, đọc trước khi chạy:
#   - thêm site nginx cloudgram-upload (cổng 80 cho certbot, cổng 8444 cho
#     tải lên) và cài lại cấu hình cloudgram.conf (CSP thêm up.datvan.com:8444)
#   - xin chứng chỉ Let's Encrypt cho up.datvan.com bằng certbot; cổng 80 chỉ
#     được mở trong lúc certbot chạy (hook của certbot mở rồi đóng)
#   - ufw: mở cổng 8444/tcp cho mọi nơi. Chỉ nginx của site này nghe cổng đó và
#     nó chỉ nhận PUT một đoạn video của phiên đang phát; các site khác không
#     bị mở ra ngoài Cloudflare.
#
# Hoàn tác:
#     ssh $DEPLOY_HOST 'rm /etc/nginx/sites-enabled/cloudgram-upload.conf &&
#       ufw delete allow 8444/tcp && nginx -t && systemctl reload nginx'
# và khôi phục cloudgram.conf từ thư mục sao lưu in ra ở bước đầu.
set -euo pipefail

if [ -z "${DEPLOY_HOST:-}" ] && [ -f .env ]; then
    DEPLOY_HOST=$(sed -n "s/^[[:space:]]*DEPLOY_HOST[[:space:]]*=[[:space:]]*//p" .env | tr -d "\"' \r" | head -1)
fi
if [ -z "${DEPLOY_HOST:-}" ]; then
    echo "Chưa có DEPLOY_HOST trong .env." >&2
    exit 1
fi
UP_HOST=up.datvan.com
UP_PORT=8444

echo "→ tải cấu hình lên"
STAGE=/root/cloudgram-upload-setup
ssh -o BatchMode=yes "$DEPLOY_HOST" "rm -rf '$STAGE' && mkdir -p '$STAGE'"
scp -q deploy/nginx/cloudgram-upload.conf deploy/nginx/cloudgram.conf "$DEPLOY_HOST:$STAGE/"

echo "→ cài đặt"
ssh -o BatchMode=yes "$DEPLOY_HOST" "STAGE='$STAGE' UP_HOST='$UP_HOST' UP_PORT='$UP_PORT' bash -s" <<'REMOTE'
set -euo pipefail
cd "$STAGE"
sed -i 's/\r$//' cloudgram-upload.conf cloudgram.conf

# DNS phải trỏ thẳng vào máy này (không qua Cloudflare)
dns=$(getent ahostsv4 "$UP_HOST" | awk '{print $1; exit}' || true)
mine=$(hostname -I | tr ' ' '\n' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | grep -v '^127\.' | head -5)
if [ -z "$dns" ]; then
    echo "$UP_HOST chưa có bản ghi DNS. Thêm A  up -> IP VPS (DNS only) rồi chạy lại." >&2
    exit 1
fi
if ! echo "$mine" | grep -qx "$dns"; then
    echo "$UP_HOST trỏ tới $dns, không phải VPS này ($(echo $mine))." >&2
    echo "Nếu là IP của Cloudflare thì mây đang cam: chuyển sang DNS only (mây xám)." >&2
    exit 1
fi
echo "   DNS ok: $UP_HOST -> $dns"

backup=/root/cloudgram-upload-backup-$(date +%Y%m%d%H%M%S)
mkdir -p "$backup"
cp /etc/nginx/sites-available/cloudgram.conf "$backup/cloudgram.conf"
ufw status numbered > "$backup/ufw.txt"
echo "   sao lưu ở $backup"

avail=/etc/nginx/sites-available/cloudgram-upload.conf
enabled=/etc/nginx/sites-enabled/cloudgram-upload.conf
undo() {
    rm -f "$enabled"
    nginx -t >/dev/null 2>&1 && systemctl reload nginx || true
    cp "$backup/cloudgram.conf" /etc/nginx/sites-available/cloudgram.conf
}

# bước 1: chỉ cổng 80, để certbot xác thực (chưa có chứng chỉ thì chưa mở 8444)
mkdir -p /var/www/acme
cat > "$avail" <<CONF
server {
    listen 80;
    listen [::]:80;
    server_name $UP_HOST;
    location /.well-known/acme-challenge/ { root /var/www/acme; }
    location / { return 404; }
}
CONF
ln -sf "$avail" "$enabled"
nginx -t
systemctl reload nginx

# cổng 80 mở chỉ trong lúc certbot chạy; hook được lưu vào cấu hình gia hạn
if [ ! -d /etc/letsencrypt/live/$UP_HOST ]; then
    certbot certonly --webroot -w /var/www/acme -d "$UP_HOST" \
        --non-interactive --agree-tos --register-unsafely-without-email \
        --pre-hook "ufw allow 80/tcp" --post-hook "ufw delete allow 80/tcp" ||
        { undo; echo "certbot lỗi, đã gỡ site tải lên." >&2; exit 1; }
fi

# bước 2: cấu hình đầy đủ, thử trước khi nạp
cp cloudgram-upload.conf "$avail"
cp cloudgram.conf /etc/nginx/sites-available/cloudgram.conf
if ! nginx -t; then
    undo
    echo "Cấu hình nginx mới lỗi (xem trên), đã trả lại bản cũ." >&2
    exit 1
fi
ufw allow "$UP_PORT"/tcp >/dev/null
systemctl reload nginx
echo "   nginx nạp cấu hình mới, ufw mở cổng $UP_PORT"

# gia hạn sẽ chạy được không (dùng máy chủ thử của Let's Encrypt)
certbot renew --dry-run --cert-name "$UP_HOST" >/dev/null 2>&1 &&
    echo "   gia hạn chứng chỉ thử: ok" ||
    echo "   CẢNH BÁO: gia hạn thử lỗi, chạy 'certbot renew --dry-run' để xem" >&2
ufw status | grep -E '^80/tcp|^80 ' && echo "   CẢNH BÁO: cổng 80 vẫn mở" >&2 || true

rm -rf "$STAGE"
REMOTE

echo "→ thử từ máy này"
code=$(curl -s -o /dev/null -w '%{http_code}' -m 20 -X OPTIONS \
    -H 'Origin: https://cloudgram.datvan.com' \
    -H 'Access-Control-Request-Method: PUT' \
    "https://$UP_HOST:$UP_PORT/api/play/AAAAAAAAAAAAAAAAAAAAAA/chunks/0" || true)
echo "   OPTIONS: $code (204 là đúng)"
code=$(curl -s -o /dev/null -w '%{http_code}' -m 20 "https://$UP_HOST:$UP_PORT/" || true)
echo "   GET /: $code (404 là đúng)"
curl -s -o /dev/null -w '%{http_code}' -m 20 https://cloudgram.datvan.com/ | grep -q 200 &&
    echo "   cloudgram.datvan.com vẫn lên (200)"
echo "Xong. Thêm vào .env:  VITE_PLAY_DIRECT_URL=https://$UP_HOST:$UP_PORT  rồi npm run deploy."

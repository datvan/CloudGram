#!/usr/bin/env bash
#
# Cài dịch vụ tài khoản lên VPS. Chạy một lần từ máy mình (hoặc chạy lại khi
# đổi unit systemd hay cấu hình nginx); các lần cập nhật mã sau đó chỉ cần
# 'npm run deploy'.
#
#     bash deploy/vps-setup.sh
#
# Script này đổi cấu hình hệ thống trên VPS: tạo user 'cloudgram', cài unit
# systemd, thay cấu hình nginx của cloudgram.datvan.com. Đọc trước khi chạy.
#
# Pepper (CLOUDGRAM_PEPPER) được sinh ngay trên VPS vào /etc/cloudgram-api.env
# ở lần chạy đầu và không bao giờ rời khỏi đó. Chạy lại không đổi nó: đổi
# pepper làm vô hiệu mọi link thiết lập và phiên đăng nhập đang có.
set -euo pipefail

if [ -z "${DEPLOY_HOST:-}" ] && [ -f .env ]; then
    DEPLOY_HOST=$(sed -n "s/^[[:space:]]*DEPLOY_HOST[[:space:]]*=[[:space:]]*//p" .env | tr -d "\"' \r" | head -1)
fi
if [ -z "${DEPLOY_HOST:-}" ]; then
    echo "Chưa có DEPLOY_HOST trong .env." >&2
    exit 1
fi

STAGE=/root/cloudgram-setup

echo "→ tải mã dịch vụ và cấu hình lên $STAGE"
ssh -o BatchMode=yes "$DEPLOY_HOST" "rm -rf '$STAGE' && mkdir -p '$STAGE/server'"
# tar thay vì scp để bỏ được dữ liệu và cấu hình dev (server/.data, .env.dev)
tar -C server --exclude=.data --exclude='.env*' --exclude=test --exclude=node_modules -cf - . |
    ssh -o BatchMode=yes "$DEPLOY_HOST" "tar -xf - -C '$STAGE/server'"
scp -q deploy/systemd/cloudgram-api.service deploy/cloudgram-admin deploy/nginx/cloudgram.conf "$DEPLOY_HOST:$STAGE/"

echo "→ cài đặt"
ssh -o BatchMode=yes "$DEPLOY_HOST" "STAGE='$STAGE' bash -s" <<'REMOTE'
set -euo pipefail
cd "$STAGE"
sed -i 's/\r$//' cloudgram-admin cloudgram-api.service cloudgram.conf

node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' ||
    { echo "Cần Node 20 trở lên, đang có $(node -v)" >&2; exit 1; }

id cloudgram >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin cloudgram

rm -rf /opt/cloudgram-api.incoming
cp -r server /opt/cloudgram-api.incoming
chown -R root:root /opt/cloudgram-api.incoming
chmod -R a+rX,go-w /opt/cloudgram-api.incoming
rm -rf /opt/cloudgram-api.old
[ -d /opt/cloudgram-api ] && mv /opt/cloudgram-api /opt/cloudgram-api.old
mv /opt/cloudgram-api.incoming /opt/cloudgram-api
rm -rf /opt/cloudgram-api.old

if [ ! -f /etc/cloudgram-api.env ]; then
    (umask 077 && printf 'CLOUDGRAM_PEPPER=%s\n' "$(openssl rand -hex 32)" > /etc/cloudgram-api.env)
    echo "   đã sinh /etc/cloudgram-api.env"
fi
chown root:root /etc/cloudgram-api.env
chmod 600 /etc/cloudgram-api.env

install -m 0644 cloudgram-api.service /etc/systemd/system/cloudgram-api.service
install -m 0755 cloudgram-admin /usr/local/bin/cloudgram-admin
systemctl daemon-reload
systemctl enable cloudgram-api >/dev/null 2>&1
systemctl restart cloudgram-api

for _ in 1 2 3 4 5 6 7 8 9 10; do
    code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4322/api/me || true)
    [ "$code" = 401 ] && break
    sleep 1
done
if [ "$code" != 401 ]; then
    echo "Dịch vụ không trả lời (mã $code):" >&2
    journalctl -u cloudgram-api -n 30 --no-pager >&2
    exit 1
fi
echo "   dịch vụ chạy, /api/me trả 401 như mong đợi"

# nginx: giữ bản cũ, thử bản mới, lỗi thì trả lại bản cũ
conf=/etc/nginx/sites-available/cloudgram.conf
backup=/root/cloudgram.conf.$(date +%Y%m%d%H%M%S)
cp "$conf" "$backup"
cp cloudgram.conf "$conf"
if nginx -t; then
    systemctl reload nginx
    echo "   nginx đã nạp cấu hình mới (bản cũ: $backup)"
else
    cp "$backup" "$conf"
    echo "Cấu hình nginx mới lỗi (xem trên), đã trả lại bản cũ." >&2
    exit 1
fi

rm -rf "$STAGE"
REMOTE

echo "Xong. Tạo tài khoản bằng:"
echo "    ssh $DEPLOY_HOST cloudgram-admin add <tên>"

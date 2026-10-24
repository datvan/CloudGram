#!/usr/bin/env bash
#
# Đẩy thư mục dist đã build lên VPS.
#
# Máy đích đọc từ biến DEPLOY_HOST, không có giá trị mặc định trong file này:
# repo này công khai, và IP gốc là thứ mà toàn bộ thiết lập Cloudflare phía
# trước đang cố giữ kín. Đặt nó trong .env (đã nằm trong .gitignore). Tiền tố
# không phải VITE_ nên Vite không nhúng nó vào bundle.
#
#     DEPLOY_HOST=root@203.0.113.10
#
# Tải vào thư mục tạm rồi mới hoán đổi, thay vì xoá thẳng thư mục đang phục vụ:
# scp mất vài giây cho ~50 file, và trong khoảng đó nginx vẫn đang trả file cho
# người dùng. Hoán đổi bằng mv thì cửa sổ hỏng chỉ còn vài mili giây.
set -euo pipefail

ROOT=/var/www/cloudgram
STAGE=/var/www/cloudgram.incoming
API=/opt/cloudgram-api
SITE=${DEPLOY_URL:-https://cloudgram.datvan.com}

if [ -z "${DEPLOY_HOST:-}" ] && [ -f .env ]; then
    DEPLOY_HOST=$(sed -n "s/^[[:space:]]*DEPLOY_HOST[[:space:]]*=[[:space:]]*//p" .env | tr -d "\"' \r" | head -1)
fi

if [ -z "${DEPLOY_HOST:-}" ]; then
    echo "Chưa có DEPLOY_HOST. Thêm vào .env một dòng như:" >&2
    echo "    DEPLOY_HOST=root@<ip-vps>" >&2
    exit 1
fi

if [ ! -f dist/index.html ]; then
    echo "Không thấy dist/index.html — chạy 'npm run build' trước." >&2
    exit 1
fi

# Bản build mới gọi /api, nên dịch vụ tài khoản phải có trước. Lần đầu thì
# chạy deploy/vps-setup.sh, script này chỉ cập nhật mã của nó.
if ! ssh -o BatchMode=yes "$DEPLOY_HOST" "systemctl cat cloudgram-api >/dev/null 2>&1"; then
    echo "VPS chưa có dịch vụ cloudgram-api — chạy 'bash deploy/vps-setup.sh' trước." >&2
    exit 1
fi

echo "→ cập nhật dịch vụ tài khoản"
ssh -o BatchMode=yes "$DEPLOY_HOST" "rm -rf '$API.incoming' && mkdir -p '$API.incoming'"
# tar thay vì scp để bỏ được dữ liệu và cấu hình dev (server/.data, .env.dev)
tar -C server --exclude=.data --exclude='.env*' --exclude=test --exclude=node_modules -cf - . |
    ssh -o BatchMode=yes "$DEPLOY_HOST" "tar -xf - -C '$API.incoming'"
ssh -o BatchMode=yes "$DEPLOY_HOST" "chown -R root:root '$API.incoming' && chmod -R a+rX,go-w '$API.incoming' \
    && rm -rf '$API.old' && mv '$API' '$API.old' && mv '$API.incoming' '$API' && rm -rf '$API.old' \
    && systemctl restart cloudgram-api"

echo "→ dọn thư mục tạm trên máy đích"
ssh "$DEPLOY_HOST" "rm -rf '$STAGE' && mkdir -p '$STAGE'"

echo "→ tải dist lên"
scp -q -r dist/. "$DEPLOY_HOST:$STAGE/"

echo "→ hoán đổi"
ssh "$DEPLOY_HOST" "rm -rf '$ROOT.old' && mv '$ROOT' '$ROOT.old' && mv '$STAGE' '$ROOT' && rm -rf '$ROOT.old'"

echo "→ kiểm tra"
curl -sS -o /dev/null -w "   /          %{http_code}\n" --max-time 20 "$SITE/"
curl -sS -o /dev/null -w "   /folder/x  %{http_code}\n" --max-time 20 "$SITE/folder/x"
curl -sS -o /dev/null -w "   /api/me    %{http_code} (401 là đúng)\n" --max-time 20 "$SITE/api/me"

echo "Xong: $SITE"

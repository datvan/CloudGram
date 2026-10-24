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

echo "→ dọn thư mục tạm trên máy đích"
ssh "$DEPLOY_HOST" "rm -rf '$STAGE' && mkdir -p '$STAGE'"

echo "→ tải dist lên"
scp -q -r dist/. "$DEPLOY_HOST:$STAGE/"

echo "→ hoán đổi"
ssh "$DEPLOY_HOST" "rm -rf '$ROOT.old' && mv '$ROOT' '$ROOT.old' && mv '$STAGE' '$ROOT' && rm -rf '$ROOT.old'"

echo "→ kiểm tra"
curl -sS -o /dev/null -w "   /          %{http_code}\n" --max-time 20 "$SITE/"
curl -sS -o /dev/null -w "   /folder/x  %{http_code}\n" --max-time 20 "$SITE/folder/x"

echo "Xong: $SITE"

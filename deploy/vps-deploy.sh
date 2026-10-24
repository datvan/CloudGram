#!/usr/bin/env bash
#
# Đẩy thư mục dist đã build lên VPS.
#
# Tải vào thư mục tạm rồi mới hoán đổi, thay vì xoá thẳng thư mục đang phục vụ:
# scp mất vài giây cho ~50 file, và trong khoảng đó nginx vẫn đang trả file cho
# người dùng. Hoán đổi bằng mv thì cửa sổ hỏng chỉ còn vài mili giây.
set -euo pipefail

HOST=${CLOUDGRAM_HOST:-root@163.61.182.248}
ROOT=/var/www/cloudgram
STAGE=/var/www/cloudgram.incoming

if [ ! -f dist/index.html ]; then
    echo "Không thấy dist/index.html — chạy 'npm run build' trước." >&2
    exit 1
fi

echo "→ dọn thư mục tạm trên $HOST"
ssh "$HOST" "rm -rf '$STAGE' && mkdir -p '$STAGE'"

echo "→ tải dist lên"
scp -q -r dist/. "$HOST:$STAGE/"

echo "→ hoán đổi"
ssh "$HOST" "rm -rf '$ROOT.old' && mv '$ROOT' '$ROOT.old' && mv '$STAGE' '$ROOT' && rm -rf '$ROOT.old'"

echo "→ kiểm tra"
curl -sS -o /dev/null -w "   /          %{http_code}\n" --max-time 20 https://cloudgram.datvan.com/
curl -sS -o /dev/null -w "   /folder/x  %{http_code}\n" --max-time 20 https://cloudgram.datvan.com/folder/x

echo "Xong: https://cloudgram.datvan.com"

# Deploy CloudGram lên cloudgram.datvan.com

Đang chạy tại https://cloudgram.datvan.com, phục vụ bởi nginx trên VPS riêng,
đứng sau proxy Cloudflare.

> Repo này công khai, nên IP máy chủ không được viết ở đây. Nó nằm trong `.env`
> (đã gitignore) dưới tên `DEPLOY_HOST`.

Repo: https://github.com/datvan/CloudGram

---

## Trước khi đọc tiếp: api_hash sẽ nằm công khai

Vite nhúng thẳng mọi biến `VITE_*` vào file JS gửi cho trình duyệt. Không có
backend nào ở giữa — app nói chuyện MTProto trực tiếp từ browser, đó là kiến
trúc của CloudGram chứ không phải lỗi cấu hình.

Hệ quả: **bất kỳ ai mở cloudgram.datvan.com đều đọc được `api_id` và `api_hash`
của bạn** bằng cách xem source. Họ không lấy được tài khoản Telegram của bạn
(cái đó nằm sau đăng nhập và lưu trong IndexedDB của từng máy), nhưng họ có thể
dùng cặp api_id/api_hash đó cho ứng dụng của họ, và nếu họ lạm dụng thì
**Telegram khóa api_id — của bạn.**

Vì vậy: tạo một app Telegram **riêng** cho bản deploy này, đừng dùng lại cặp
api_id/api_hash bạn đang dùng cho việc khác.

Đổi chỗ đặt trang không thay đổi điều này. Khoá đó để Telegram nhận diện ứng
dụng, không liên quan tới việc ai phục vụ file HTML.

---

## Bước 1 — Lấy api_id, api_hash và điền vào `.env`

1. Mở https://my.telegram.org và đăng nhập bằng **số điện thoại Telegram** của
   bạn. Mã xác nhận được gửi vào chính app Telegram, không phải SMS.
2. Chọn **API development tools**.
3. Điền form: App title `CloudGram`, Short name `cloudgram`, Platform **Web**,
   URL `https://cloudgram.datvan.com`.
4. Bấm **Create application**. Màn hình kết quả cho `App api_id` (dãy số) và
   `App api_hash` (32 ký tự hex). Lưu vào password manager ngay.
5. Điền vào `.env` ở thư mục gốc repo:

```
VITE_API_ID=1234567
VITE_API_HASH='xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
```

`.env` nằm trong `.gitignore` nên không bao giờ bị commit.

> Trang my.telegram.org giới hạn số lần thử rất chặt và hay trả
> `Too many attempts. Please try again later.` Gặp lỗi đó thì **ngừng bấm**,
> chờ vài giờ rồi thử lại; thử dồn dập làm đồng hồ đếm lại từ đầu. Đổi mạng
> (phát 4G thay vì wifi) đôi khi có tác dụng vì giới hạn tính theo IP.

---

## Bước 2 — Deploy

Thêm máy đích vào `.env`, cùng chỗ với khoá Telegram:

```
DEPLOY_HOST=root@<ip-vps>
```

Tiền tố không phải `VITE_` nên Vite không nhúng nó vào bundle gửi cho trình
duyệt. Rồi:

```bash
npm run deploy
```

Script này build rồi chạy [deploy/vps-deploy.sh](../deploy/vps-deploy.sh): tải
`dist` vào `/var/www/cloudgram.incoming` trên VPS, rồi `mv` đè lên
`/var/www/cloudgram`. Tải trước, hoán đổi sau — vì `scp` mất vài giây cho ~50
file, mà trong khoảng đó nginx vẫn đang phục vụ người dùng; hoán đổi bằng `mv`
thì cửa sổ hỏng chỉ còn vài mili giây.

Cuối script có sẵn hai lệnh kiểm tra `/` và `/folder/x`.

Đổi `.env` thì chạy lại lệnh trên là đủ — biến được đọc lúc build.

---

## Hạ tầng được nối như thế nào

Phần này ghi lại những thứ mất công tìm ra, để lần sau khỏi dò lại.

**Mọi traffic web phải đi qua Cloudflare.** `ufw` trên VPS chỉ mở 80/443 cho 22
dải IP của Cloudflare (15 IPv4 + 7 IPv6), chặn mọi nguồn khác. Gọi thẳng vào IP
máy chủ từ ngoài sẽ timeout, kể cả cổng 443.

Hệ quả thực tế: **bản ghi DNS bắt buộc phải để Proxied (đám mây cam).** Để
`DNS only` thì trang không chạy — không phải vấn đề bảo mật mà là không có
đường vào.

Thiết kế này tốt: DDoS bị Cloudflare hứng, và mọi luật WAF hay rate limit đặt ở
Cloudflare đều không bị đi vòng. Nó cũng giữ kín IP gốc — nhưng chỉ chừng nào
IP đó không bị viết ra chỗ khác, nên đừng đưa nó vào repo, issue hay ảnh chụp
màn hình.

**SSL mode của zone là Full (strict).** Biết được vì khi origin chưa có chứng
chỉ cho hostname, Cloudflare trả `526` chứ không phải phục vụ tạm.

**Certbot chạy được dù đứng sau proxy**, vì Cloudflare cho đường
`/.well-known/acme-challenge/` đi thẳng qua HTTP về origin, không ép sang
HTTPS. Đã kiểm chứng: đường đó trả 200 và có trong access log của nginx, trong
khi mọi đường khác bị Cloudflare 301 tại biên.

**Chứng chỉ** hết hạn 2027-01-22, Certbot đã cài sẵn tác vụ tự gia hạn.

**Cấu hình nginx** nằm ở [deploy/nginx/cloudgram.conf](../deploy/nginx/cloudgram.conf),
bản sao của `/etc/nginx/sites-available/cloudgram.conf`. Hai điểm đáng chú ý:

-   `location /` dùng `try_files $uri $uri/ /index.html` — đây là thứ làm
    `/folder/<id>` không 404 khi bấm F5.
-   `location /assets/` dùng `try_files $uri =404` — cố ý. Asset thiếu phải báo
    thiếu; nếu để nó rơi về `index.html` thì trình duyệt nhận HTML với mã 200
    trong lúc đang chờ JavaScript, và lỗi đó rất khó lần.

Khác với `qase-review.datvan.com`, site này **không** dùng `proxy_pass`.
`qase-review` có một app chạy ở `127.0.0.1:4321` nên nginx phải chuyển tiếp vào
đó; CloudGram là web tĩnh, dựng thêm một tiến trình chỉ để nginx gọi vào là
thừa.

**Đăng nhập SSH chỉ bằng khoá.** Từ 2026-10-24 máy chủ không nhận mật khẩu nữa.
Ba dòng sau nằm trong `/etc/ssh/sshd_config.d/00-hardening.conf`:

```
PermitRootLogin prohibit-password
PasswordAuthentication no
KbdInteractiveAuthentication no
```

**Tên file bắt đầu bằng `00` là cố ý.** sshd lấy giá trị đọc được **đầu tiên**,
mà thư mục đó có sẵn `50-cloud-init.conf` chứa `PasswordAuthentication yes`.
`00` đọc trước `50` nên thắng. Thêm vào cuối `/etc/ssh/sshd_config` thì vô tác
dụng, vì dòng `Include` nằm ở đầu file, đã nạp cả thư mục trước khi đọc tới
cuối.

`prohibit-password` chứ không phải `no`: root là tài khoản duy nhất có shell
thật trên máy, đặt `no` là tự khoá mình ra ngoài.

Hệ quả vận hành: **không còn đường dự phòng bằng mật khẩu.** Muốn vào từ một
máy khác thì phải `ssh-copy-id` từ máy đang vào được **trước**. Mất hết khoá thì
chỉ còn console VNC của nhà cung cấp VPS.

Kiểm tra bằng cách hỏi thẳng máy chủ xem nó chào những cách đăng nhập nào:

```bash
ssh -v -o BatchMode=yes -o PubkeyAuthentication=no <user>@<ip-vps> 2>&1 | grep -i "that can continue"
```

Đúng thì chỉ in `publickey`. Còn thấy `password` nghĩa là cấu hình chưa có hiệu
lực — thường do quên `systemctl reload ssh`. (`BatchMode=yes` có mặt chính vì
trường hợp hỏng đó: không có nó, lệnh in ra dòng cần xem rồi đứng chờ bạn gõ
mật khẩu.) Đừng nhìn PID của sshd để đoán:
`SIGHUP` làm nó `exec` lại chính nó, PID và giờ khởi động giữ nguyên dù cấu hình
đã đổi.

---

## Dựng lại từ đầu

Nếu phải làm lại trên máy khác:

Dùng [cloudgram.bootstrap.conf](../deploy/nginx/cloudgram.bootstrap.conf) chứ
không phải `cloudgram.conf`. Bản bootstrap chỉ nghe cổng 80 và không nhắc tới
chứng chỉ nào — đúng thứ cần có **trước** khi certbot chạy. Bản `cloudgram.conf`
là ảnh chụp cấu hình sau khi certbot đã sửa; đem nó đi dựng lại từ đầu thì nginx
không khởi động được, vì nó trỏ tới file chứng chỉ chưa tồn tại.

```bash
# trên VPS
mkdir -p /var/www/cloudgram
# chép deploy/nginx/cloudgram.bootstrap.conf vào
#   /etc/nginx/sites-available/cloudgram.conf
ln -s /etc/nginx/sites-available/cloudgram.conf /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

Rồi tạo bản ghi DNS `cloudgram` kiểu A trỏ về IP VPS, **bật Proxied**, và:

```bash
certbot --nginx -d cloudgram.datvan.com -n --redirect
```

Thứ tự quan trọng: phải có DNS trỏ đúng và proxy đã bật trước khi gọi certbot,
nếu không Let's Encrypt gọi thẳng vào IP và bị ufw chặn.

---

## Kiểm tra sau khi deploy

-   [ ] `https://cloudgram.datvan.com` → màn hình đăng nhập, không phải trang
        trắng. Trang trắng kéo dài thường là sai `VITE_API_ID`.
-   [ ] Console (F12) không có lỗi kết nối MTProto.
-   [ ] Đăng nhập được bằng số điện thoại.
-   [ ] Tạo một folder, vào trong nó, bấm **F5** → vẫn đúng folder đó, không 404. Đây là bài test cho `try_files`.
-   [ ] Upload vài file một lúc, xong chạy qua checklist trong
        [upgrade-plan.md](upgrade-plan.md).

Ba mức HTTP đã kiểm chứng trên bản đang chạy: `/` và `/folder/x` trả 200,
`/assets/<tên không tồn tại>.js` trả 404, `http://` chuyển 301 sang `https://`.

---

## Phụ lục — bản trên Cloudflare Pages

Trước khi chuyển sang VPS, app từng được deploy bằng Cloudflare Pages
(direct upload). Project `cloudgram` vẫn còn, phục vụ ở
`cloudgram-cew.pages.dev`, không gắn domain.

```bash
npm run deploy:pages
```

Bản đó cũng được build lúc chưa có khoá Telegram nên trắng y hệt bản đang
chạy, không dùng làm dự phòng được cho tới khi deploy lại. Muốn dọn thì:

```bash
npx wrangler pages project delete cloudgram
```

Khác biệt đáng nhớ giữa hai nơi: trên Pages, luật `public/_redirects`
(`/* /index.html 200`) bắt **mọi** đường dẫn, nên asset thiếu cũng trả 200 kèm
HTML. Bản nginx tách riêng `/assets/` nên không bị vậy.

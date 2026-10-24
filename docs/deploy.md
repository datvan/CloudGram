# Deploy CloudGram lên cloudgram.datvan.com

[English](deploy.en.md) · **Tiếng Việt**

Đang chạy tại https://cloudgram.datvan.com, phục vụ bởi nginx trên VPS riêng,
đứng sau proxy Cloudflare.

> Repo này công khai, nên IP máy chủ không được viết ở đây. Nó nằm trong `.env`
> (đã gitignore) dưới tên `DEPLOY_HOST`.

Repo: https://github.com/datvan/CloudGram

---

## Trước khi đọc tiếp: api_hash sẽ nằm công khai

Vite nhúng thẳng mọi biến `VITE_*` vào file JS gửi cho trình duyệt. App nói
chuyện MTProto với Telegram trực tiếp từ browser; dịch vụ tài khoản trên VPS
(xem [Tài khoản và kho mã hoá](#tài-khoản-và-kho-mã-hoá)) chỉ giữ bản mã hoá
của phiên, không chuyển tiếp gì tới Telegram. Đó là kiến trúc của CloudGram chứ
không phải lỗi cấu hình.

Hệ quả: **bất kỳ ai mở cloudgram.datvan.com đều đọc được `api_id` và `api_hash`
của bạn** bằng cách xem source. Họ không lấy được tài khoản Telegram của bạn
(cái đó nằm sau tài khoản CloudGram và được mã hoá bằng mật khẩu của nó), nhưng họ có thể
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
duyệt.

**Lần đầu**, cài dịch vụ tài khoản và cấu hình nginx mới:

```bash
bash deploy/vps-setup.sh
```

Script này đổi cấu hình hệ thống trên VPS, nên đọc nó trước khi chạy. Nó tạo
user hệ thống `cloudgram`, chép `server/` vào `/opt/cloudgram-api`, sinh
`/etc/cloudgram-api.env` (chứa `CLOUDGRAM_PEPPER` ngẫu nhiên, chỉ root đọc được),
cài unit [cloudgram-api.service](../deploy/systemd/cloudgram-api.service) và
lệnh `cloudgram-admin`, rồi thay cấu hình nginx — chạy `nginx -t` trước, lỗi thì
tự trả bản cũ. Chạy lại an toàn; pepper đã có thì giữ nguyên.

**Các lần sau**, chỉ cần:

```bash
npm run deploy
```

Script này build rồi chạy [deploy/vps-deploy.sh](../deploy/vps-deploy.sh):
cập nhật mã dịch vụ trong `/opt/cloudgram-api` và khởi động lại nó, rồi tải
`dist` vào `/var/www/cloudgram.incoming` và `mv` đè lên `/var/www/cloudgram`.
Tải trước, hoán đổi sau — vì `scp` mất vài giây cho ~50 file, mà trong khoảng
đó nginx vẫn đang phục vụ người dùng; hoán đổi bằng `mv` thì cửa sổ hỏng chỉ
còn vài mili giây. Nó từ chối chạy nếu VPS chưa có dịch vụ, vì bản build mới
không dùng được khi thiếu `/api`.

Cuối script có sẵn lệnh kiểm tra `/`, `/folder/x` và `/api/me` (trả 401 khi
chưa đăng nhập là đúng).

Đổi `.env` thì chạy lại lệnh trên là đủ — biến được đọc lúc build.

---

## Tài khoản và kho mã hoá

Đăng nhập vào CloudGram bằng tài khoản riêng của nó; tài khoản Telegram nằm
phía sau. Chỉ admin tạo tài khoản:

```bash
ssh root@<ip-vps> cloudgram-admin add <tên>      # in link thiết lập, dùng 7 ngày, 1 lần
ssh root@<ip-vps> cloudgram-admin reset <tên>    # quên mật khẩu: link mới, kho cũ bị xoá
ssh root@<ip-vps> cloudgram-admin delete <tên>
ssh root@<ip-vps> cloudgram-admin list
```

`cloudgram-admin` dừng dịch vụ trong lúc chạy rồi bật lại, vì dịch vụ giữ
`db.json` trong bộ nhớ và sẽ ghi đè thay đổi.

Người dùng mở link, đặt mật khẩu (ít nhất 10 ký tự), rồi liên kết Telegram một
lần. Từ đó đăng nhập trên máy nào cũng dùng được ngay.

**VPS không đọc được dữ liệu.** Mật khẩu đi qua PBKDF2-SHA256 (600 000 vòng)
ngay trong trình duyệt, ra hai nửa: một nửa gửi lên làm khoá đăng nhập (server
chỉ lưu scrypt của nó), nửa kia là khoá mở một khoá dữ liệu AES-256-GCM ngẫu
nhiên. Phiên Telegram và cây thư mục được mã hoá bằng khoá dữ liệu đó trước khi
gửi lên. Hệ quả: **quên mật khẩu là mất kho** — `reset` cho đăng nhập lại, nhưng
phải liên kết Telegram lại và cây thư mục trống (file vẫn còn trong Saved
Messages).

**Dữ liệu trên VPS** nằm ở `/var/lib/cloudgram-api` (`db.json` cho tài khoản và
phiên, `trees/<id>.json` cho cây thư mục đã mã hoá). Sao lưu thư mục đó là đủ;
nó vô dụng nếu thiếu mật khẩu người dùng. Pepper trong `/etc/cloudgram-api.env`
chỉ dùng để sinh salt giả cho tên không tồn tại (để không ai dò được tên nào
có tài khoản); mất hay đổi nó thì đăng nhập vẫn chạy, nhưng nên giữ cố định.

**Link chia sẻ** khác với phần còn lại: tệp được chép, đã mã hoá, lên VPS ở
`/var/lib/cloudgram-api/shares/<id>/`, vì người nhận không có Telegram. Khoá
giải mã chỉ nằm sau dấu `#` của link, nên máy chủ không đọc được tệp. Link hết
hạn hoặc bị xoá thì bản sao bị xoá trong vòng một phút. Mỗi tệp tối đa 2 GB,
mỗi tài khoản tối đa 500 link và 20 GB (đổi bằng `CLOUDGRAM_SHARE_QUOTA_GB` trong
`/etc/cloudgram-api.env`); máy chủ luôn chừa lại 1 GB ổ trống. Chưa chia sẻ được
cả thư mục.

**Một máy dùng Telegram tại một thời điểm.** Hai trình duyệt cùng dùng một phiên
Telegram thì Telegram huỷ phiên (`AUTH_KEY_DUPLICATED`), nên dịch vụ cấp "lượt"
cho từng trình duyệt. Mở ở máy thứ hai thì app hỏi có chuyển sang máy này không;
máy cũ nhả ra trong vòng vài giây.

**Đăng xuất** chỉ xoá phiên CloudGram trên máy đó, phiên Telegram vẫn còn cho
các máy khác. Muốn cắt hẳn Telegram thì dùng "Huỷ liên kết Telegram" trong menu
tài khoản.

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
bản sao của `/etc/nginx/sites-available/cloudgram.conf`. Những điểm đáng chú ý:

-   `location /` dùng `try_files $uri $uri/ /index.html` — đây là thứ làm
    `/folder/<id>` không 404 khi bấm F5.
-   `location /assets/` dùng `try_files $uri =404` — cố ý. Asset thiếu phải báo
    thiếu; nếu để nó rơi về `index.html` thì trình duyệt nhận HTML với mã 200
    trong lúc đang chờ JavaScript, và lỗi đó rất khó lần.
-   `location /api/` dùng `proxy_pass` tới dịch vụ tài khoản ở
    `127.0.0.1:4322`, không có `try_files`: đường `/api` sai phải nhận 404 JSON.
-   Content-Security-Policy chỉ cho script từ chính site và kết nối tới
    `wss://*.web.telegram.org` (nơi GramJS nói MTProto). Thêm thư viện gọi ra
    ngoài thì phải mở thêm ở đây, không thì trình duyệt chặn lặng lẽ — xem
    console.

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

Bản bootstrap không có `/api`. Sau khi certbot xong, chạy `bash deploy/vps-setup.sh`
để cài dịch vụ tài khoản và thay bằng `cloudgram.conf`. Trước đó, xem lại phần
SSL trong `cloudgram.conf` có khớp những gì certbot vừa ghi không.

---

## Kiểm tra sau khi deploy

-   [ ] `https://cloudgram.datvan.com` → màn hình đăng nhập CloudGram.
-   [ ] Đăng nhập, liên kết Telegram bằng số điện thoại (chỉ lần đầu).
-   [ ] Console (F12) không có lỗi kết nối MTProto hay vi phạm CSP.
-   [ ] Đăng nhập ở một trình duyệt khác → thấy đúng cây thư mục, không phải
        liên kết Telegram lại.
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

Project đó vẫn phục vụ **bản cũ** (trước khi có tài khoản), kèm cùng
`api_id`/`api_hash`. Lệnh `deploy:pages` đã bị bỏ: Pages không có `/api`, nên
bản mới đẩy lên đó không dùng được. Nên xoá project để khỏi có một bản cũ trôi
nổi:

```bash
npx wrangler pages project delete cloudgram
```

Khác biệt đáng nhớ giữa hai nơi: trên Pages, luật `public/_redirects`
(`/* /index.html 200`) bắt **mọi** đường dẫn, nên asset thiếu cũng trả 200 kèm
HTML. Bản nginx tách riêng `/assets/` nên không bị vậy.

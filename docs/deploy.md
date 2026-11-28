# Deploy CloudGram lên cloudgram.example.com

[English](deploy.en.md) · **Tiếng Việt**

Ví dụ: https://cloudgram.example.com, phục vụ bởi nginx trên VPS riêng,
đứng sau proxy Cloudflare.

> Repo này công khai, nên IP máy chủ không được viết ở đây. Nó nằm trong `.env`
> (đã gitignore) dưới tên `DEPLOY_HOST`.

Repo: https://github.com/datvan/CloudGram

---

## Trước khi đọc tiếp: api_hash sẽ nằm công khai

Vite nhúng thẳng mọi biến `VITE_*` vào file JS gửi cho trình duyệt. App nói
chuyện MTProto với Telegram trực tiếp từ browser; dịch vụ tài khoản trên VPS
(xem [Tài khoản và kho mã hoá](#tài-khoản-và-kho-mã-hoá)) cũng có thể duyệt
phiên mới bằng phiên root được mã hoá.

Hệ quả: **bất kỳ ai mở cloudgram.example.com đều đọc được `api_id` và `api_hash`
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
   URL `https://cloudgram.example.com`.
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
SITE_HOST=cloudgram.example.com
UPLOAD_HOST=up.example.com
VITE_SITE_HOST=cloudgram.example.com
```

`DEPLOY_HOST` không có tiền tố `VITE_` nên Vite không nhúng nó vào bundle gửi cho trình
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

### Telegram dùng chung

Mỗi tài khoản CloudGram có toàn quyền truy cập cùng tài khoản Telegram và tin nhắn.
Chỉ cấp CloudGram cho người được phép truy cập dữ liệu đó. Trong
`/etc/cloudgram-api.env`, đặt `CLOUDGRAM_TG_API_ID` và `CLOUDGRAM_TG_API_HASH`
giống frontend; đặt `CLOUDGRAM_TG_ROOT_KEY` bằng kết quả `openssl rand -base64 32`.
Sao lưu khóa an toàn và không đổi sau khi liên kết. Khởi động lại API, chạy
`cloudgram-admin telegram-link`, nhập số điện thoại, mã và mật khẩu 2FA.
`cloudgram-admin telegram-status` kiểm tra root; `cloudgram-admin telegram-unlink`
xóa root cục bộ, không thu hồi phiên đã cấp. Thu hồi phiên trong Telegram.
Máy chủ có khóa nên có thể đọc phiên root. Tắt bằng `CLOUDGRAM_SHARED_TELEGRAM=0`
và restart API hoặc `VITE_FEATURE_SHARED_TELEGRAM=0` và build lại frontend.

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

Người dùng mở link, đặt mật khẩu (ít nhất 10 ký tự). Nếu Telegram dùng chung đã
được cấu hình, app tự tạo phiên riêng; nếu chưa, người dùng liên kết thủ công.

**Kho người dùng được mã hoá.** Với Telegram dùng chung, VPS có thể giải mã
phiên root và truy cập Telegram. Mật khẩu đi qua PBKDF2-SHA256 (600 000 vòng)
ngay trong trình duyệt, ra hai nửa: một nửa gửi lên làm khoá đăng nhập (server
chỉ lưu scrypt của nó), nửa kia là khoá mở một khoá dữ liệu AES-256-GCM ngẫu
nhiên. Phiên Telegram và cây thư mục được mã hoá bằng khoá dữ liệu đó trước khi
gửi lên. Hệ quả: **quên mật khẩu là mất kho** — `reset` cho đăng nhập lại, nhưng
phải liên kết Telegram lại và cây thư mục trống (file vẫn còn trong Saved
Messages).

**Dữ liệu trên VPS** nằm ở `/var/lib/cloudgram-api` (`db.json` cho tài khoản và
phiên, `trees/<id>.json` cho cây thư mục đã mã hoá). Sao lưu thư mục đó và
khóa root riêng biệt. Pepper trong `/etc/cloudgram-api.env`
chỉ dùng để sinh salt giả cho tên không tồn tại (để không ai dò được tên nào
có tài khoản); mất hay đổi nó thì đăng nhập vẫn chạy, nhưng nên giữ cố định.

**Link chia sẻ** khác với phần còn lại: tệp được chép, đã mã hoá, lên VPS ở
`/var/lib/cloudgram-api/shares/<id>/`, vì người nhận không có Telegram. Khoá
giải mã chỉ nằm sau dấu `#` của link, nên máy chủ không đọc được tệp. Link hết
hạn hoặc bị xoá thì bản sao bị xoá trong vòng một phút. Mỗi tệp tối đa 2 GB,
mỗi tài khoản tối đa 500 link và 20 GB (đổi bằng `CLOUDGRAM_SHARE_QUOTA_GB` trong
`/etc/cloudgram-api.env`); máy chủ luôn chừa lại 1 GB ổ trống. Chưa chia sẻ được
cả thư mục.

**Nhập từ Dropbox** thì ngược lại, không lưu gì trên VPS: máy chủ chỉ hỏi
Dropbox xem link chia sẻ chuyển hướng tới đâu (`POST /api/dropbox/resolve`, chỉ
nhận link `dropbox.com`), còn trình duyệt tự tải ZIP thẳng từ Dropbox và đưa
từng tệp lên Telegram. Dropbox không cho tải một thư mục trên 20 GB hoặc hơn
10.000 tệp thành một ZIP; thư mục như vậy phải chia thành nhiều link nhỏ.

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

Cấu hình DNS, TLS và tường lửa cho hệ thống của bạn. Giới hạn truy cập máy chủ gốc qua proxy tin cậy nếu dùng proxy.

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
# thay __SITE_HOST__ bằng tên miền của bạn, rồi chép deploy/nginx/cloudgram.bootstrap.conf vào
#   /etc/nginx/sites-available/cloudgram.conf
ln -s /etc/nginx/sites-available/cloudgram.conf /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

Rồi tạo bản ghi DNS `cloudgram` kiểu A trỏ về IP VPS, **bật Proxied**, và:

```bash
certbot --nginx -d cloudgram.example.com -n --redirect
```

Đảm bảo DNS và tường lửa cho phép xác thực chứng chỉ trước khi chạy certbot.

Bản bootstrap không có `/api`. Sau khi certbot xong, chạy `bash deploy/vps-setup.sh`
để cài dịch vụ tài khoản và thay bằng `cloudgram.conf`. Trước đó, xem lại phần
SSL trong `cloudgram.conf` có khớp những gì certbot vừa ghi không.

---

## Kiểm tra sau khi deploy

-   [ ] `https://cloudgram.example.com` → màn hình đăng nhập CloudGram.
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

Các bản sửa bảo mật có 5 feature flag mặc định bật. Xem
[cấu hình và rollback](security-flags.md) trước khi tắt từng bản sửa.

Khi đổi CSP hoặc tích hợp Cloudflare, xem [nonce và triển khai nginx](csp.md).

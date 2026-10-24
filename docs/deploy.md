# Deploy CloudGram lên cloudgram.datvan.com (Cloudflare Pages)

Repo: https://github.com/datvan/CloudGram

Cách deploy ở đây là **Direct Upload**: build ngay trên máy bạn rồi đẩy thư mục
`dist` lên Cloudflare bằng `wrangler`. Khác với kiểu nối thẳng vào Git, cách này
không cần đụng gì tới form cấu hình build trên dashboard, và **api_id/api_hash
không bao giờ phải nhập vào dashboard** — chúng chỉ nằm trong file `.env` ở máy
bạn và được Vite nhúng vào bundle lúc build.

Đánh đổi: push lên `main` sẽ **không** tự deploy nữa. Mỗi lần muốn cập nhật
production thì chạy `npm run deploy`. Nếu sau này muốn quay lại kiểu tự động
theo Git thì tạo một project Pages mới nối với Git rồi chuyển domain sang.

`datvan.com` đang dùng nameserver Cloudflare (`fish.ns.cloudflare.com`,
`isaac.ns.cloudflare.com`), nên Pages tự tạo được bản ghi DNS cho subdomain và
tự cấp SSL. Không phải thêm CNAME thủ công.

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

---

## Bước 1 — Lấy api_id, api_hash và điền vào `.env` (bạn làm)

1. Mở https://my.telegram.org và đăng nhập bằng **số điện thoại Telegram** của
   bạn. Mã xác nhận được gửi vào chính app Telegram, không phải SMS.
2. Chọn **API development tools**.
3. Điền form tạo app:
    - **App title**: `CloudGram` (hoặc tên gì tùy bạn)
    - **Short name**: `cloudgram`
    - **Platform**: Web
    - **URL**: `https://cloudgram.datvan.com`
4. Bấm **Create application**.
5. Màn hình kết quả cho hai giá trị cần lấy:
    - `App api_id` — một dãy số, ví dụ `1234567`
    - `App api_hash` — chuỗi 32 ký tự hex

Trang này không cho tạo lại app đã có, nên lưu hai giá trị đó vào password
manager ngay.

6. Mở file `.env` ở thư mục gốc repo (đã tạo sẵn, nội dung còn là placeholder)
   và thay hai dòng bằng giá trị thật:

```
VITE_API_ID=1234567
VITE_API_HASH='xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
```

`.env` nằm trong `.gitignore` nên không bao giờ bị commit. Đừng paste hai giá
trị này vào chat.

---

## Bước 2 — Đăng nhập Cloudflare (bạn bấm Allow)

```bash
npx wrangler login
```

Lệnh này mở trình duyệt tới trang OAuth của Cloudflare. Bạn bấm **Allow**, token
được lưu vào máy; không ai phải gõ mật khẩu hay API token ở đâu cả.

Phải đăng nhập đúng **tài khoản Cloudflare đang giữ zone `datvan.com`**, nếu
không thì tới Bước 4 sẽ không tự tạo được bản ghi DNS.

Kiểm tra lại:

```bash
npx wrangler whoami
```

Nếu nó liệt kê nhiều hơn một account, đặt `CLOUDFLARE_ACCOUNT_ID` trước khi chạy
các lệnh sau, để wrangler không dừng lại hỏi chọn account.

---

## Bước 3 — Build và deploy

```bash
npx wrangler pages project create cloudgram --production-branch main --force
```

Chạy một lần duy nhất — và project `cloudgram` đã được tạo rồi, đây chỉ là ghi
lại cho lần sau.

`--force` ở đây không phá gì cả. Wrangler mặc định đẩy project mới sang nền
Workers, mà nền đó đòi Vite ≥ 6 còn repo này đang dùng Vite 4, nên nó dừng lại.
Cờ này bảo nó tạo thẳng trên Cloudflare Pages như cũ. Chỉ cần đúng một lần lúc
tạo; các lệnh sau không dùng tới nó nữa.

Sau đó:

```bash
npm run deploy
```

Script này là `vite build` rồi `wrangler pages deploy dist --project-name
cloudgram --branch main`. Cờ `--branch main` là bắt buộc: wrangler đoán branch
từ git, và bất kỳ branch nào khác `main` sẽ thành **preview deployment** —
build xanh, có URL riêng, nhưng domain thật không trỏ vào đó.

Output phải ghi là deploy lên **Production**. URL thử nghiệm là
https://cloudgram-cew.pages.dev — tên `cloudgram.pages.dev` đã có người khác
lấy, nên Cloudflare thêm hậu tố; tên _project_ thì vẫn là `cloudgram`, đó mới là
cái `--project-name` cần.

Mở thử URL đó: phải ra màn hình đăng nhập, không phải trang trắng. Trang trắng
nghĩa là `.env` sai hoặc chưa điền.

---

## Bước 4 — Gắn domain (bạn làm, trên dashboard)

wrangler không có lệnh nào cho custom domain, nên bước này phải qua giao diện web.

1. https://dash.cloudflare.com → **Workers & Pages** → chọn project **cloudgram**.
2. Tab **Custom domains** → **Set up a custom domain**.
3. Nhập `cloudgram.datvan.com` → **Continue** → **Activate domain**.
4. Vì `datvan.com` nằm sẵn trong tài khoản Cloudflare, bản ghi CNAME được tạo
   tự động. Chứng chỉ SSL cấp trong vài phút.

Bản ghi A của `datvan.com` (`27.74.11.37`) không bị đụng tới — subdomain này
độc lập hoàn toàn.

---

## Những thứ đã chuẩn bị sẵn trong repo

-   **`public/_redirects`** — `/*  /index.html  200`. App dùng client-side
    routing, nên `https://cloudgram.datvan.com/folder/<id>` là đường dẫn chỉ tồn
    tại trong trình duyệt, không có file nào tương ứng trên đĩa. Dòng này bảo
    host trả `index.html` cho mọi đường dẫn và để router tự xử lý.

    Docs của Cloudflare xác nhận dạng rewrite `200` này được hỗ trợ, nhưng
    **không** nói Pages có tự fallback về `index.html` khi thiếu file hay không.
    Có thể Pages vốn đã làm vậy và file này thành thừa — vô hại. Bài test F5
    bên dưới mới là câu trả lời thật.

-   **WebSocket bảo mật** — GramJS tự đặt `useWSS` theo `window.location.protocol`
    (`telegramBaseClient.js`), nên trên HTTPS nó dùng `wss://` mà không cần chỉnh
    gì. Không có lỗi mixed content.

---

## Kiểm tra sau khi deploy

-   [ ] Mở `https://cloudgram.datvan.com` → hiện màn hình đăng nhập, không phải
        trang trắng. Trang trắng kéo dài thường là sai `VITE_API_ID`.
-   [ ] Console (F12) không có lỗi kết nối MTProto.
-   [ ] Đăng nhập được bằng số điện thoại.
-   [ ] Tạo một folder, vào trong nó, bấm **F5** → vẫn đúng folder đó, không 404.
        Đây là bài test cho `_redirects`.
-   [ ] Upload vài file một lúc, xong chạy qua checklist trong
        [upgrade-plan.md](upgrade-plan.md).

---

## Lần deploy sau

```bash
npm run deploy
```

Chỉ vậy. Đổi `VITE_API_ID` / `VITE_API_HASH` thì sửa `.env` rồi chạy lại lệnh
trên — biến được đọc lúc build nên build lại là đủ, không cần làm gì trên
dashboard.

Muốn đẩy thử một bản preview mà không đụng domain thật:

```bash
npm run build && npx wrangler pages deploy dist --project-name cloudgram --branch preview
```

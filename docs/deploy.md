# Deploy CloudGram lên cloudgram.datvan.com (Cloudflare Pages)

Repo: https://github.com/datvan/CloudGram · nhánh production: `main`

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

## Bước 1 — Lấy api_id và api_hash

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

> Nếu muốn chạy thử ở máy trước: tạo file `.env` ở thư mục gốc repo với nội
> dung như `.env.example`. File `.env` đã nằm trong `.gitignore` nên không bao
> giờ bị commit.

```
VITE_API_ID=1234567
VITE_API_HASH='xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
```

---

## Bước 2 — Tạo project trên Cloudflare Pages

1. https://dash.cloudflare.com → **Workers & Pages** → **Create** → tab
   **Pages** → **Connect to Git**.
2. Cho Cloudflare quyền truy cập GitHub, chọn repo **datvan/CloudGram**.
3. Cấu hình build:

    | Mục                    | Giá trị         |
    | ---------------------- | --------------- |
    | Production branch      | `main`          |
    | Framework preset       | `React (Vite)`  |
    | Build command          | `npm run build` |
    | Build output directory | `dist`          |

4. **Khoan bấm Save and Deploy.** Mở **Environment variables** ngay trong form
   này và thêm cho cả **Production** lẫn **Preview**:

    | Variable        | Value                   |
    | --------------- | ----------------------- |
    | `VITE_API_ID`   | số api_id ở Bước 1      |
    | `VITE_API_HASH` | chuỗi api_hash ở Bước 1 |

    Phải thêm **trước** lần build đầu. Vite đọc biến lúc build chứ không phải
    lúc chạy; thiếu biến thì `parseInt(undefined)` ra `NaN`, bundle vẫn build
    thành công nhưng app không kết nối được, và lỗi đó không hiện rõ ràng.

5. **Save and Deploy**. Build mất khoảng 1–2 phút.

---

## Bước 3 — Gắn domain

1. Vào project vừa tạo → tab **Custom domains** → **Set up a custom domain**.
2. Nhập `cloudgram.datvan.com` → **Continue** → **Activate domain**.
3. Vì `datvan.com` nằm sẵn trong tài khoản Cloudflare, bản ghi CNAME được tạo
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

Mỗi lần push lên `main` là Cloudflare Pages build lại và tự lên production.
Push lên nhánh khác thì ra một preview URL riêng, không đụng tới domain thật.

Đổi `VITE_API_ID` / `VITE_API_HASH` thì phải **bấm Retry deployment** thủ công,
vì biến chỉ được đọc lúc build.

# Plan: mở video bằng trình phát ngoài (PotPlayer, VLC, mpv)

Trạng thái 2026-11-10: **đã code cả hai tầng** trên nhánh `feature/external-player` (chưa triển khai). Đã có test tự động (helper chạy thật với "trang giả", và phía trang). **Chưa thử với Telegram thật, PotPlayer thật, và quy tắc mạng riêng của Chrome** (bước 0 và 5 bên dưới). Mục tiêu: khi video quá đặc thù cho trình phát trong web (đuôi `.ts`, codec HEVC, âm thanh AC3 hoặc DTS...), có nút "Mở bằng PotPlayer" và video chạy ngay, tua được, không cần tải cả tệp về trước.

## Hiện trạng (đã kiểm tra trong code)

-   Trình phát trong web chạy qua service worker: [stream.js](../src/services/stream.js) đọc từng phần 1 MB từ Telegram, trả cho thẻ `<video>` theo yêu cầu Range. Chỉ trang web này đọc được, **trình phát ngoài không gọi vào service worker được**.
-   Container trình duyệt không đọc được thì đi qua ffmpeg trong trình duyệt (WebAssembly): [convert.js](../src/services/convert.js), danh sách `CONVERT_EXT`. **`ts` chưa có trong danh sách đó** (có `mts`, `m2ts`), nên `.ts` hiện chỉ rơi vào "xem trước không được".
-   Đã có chương trình hỗ trợ trên máy: [cloudgram-helper.mjs](../public/helper/cloudgram-helper.mjs), nghe ở `127.0.0.1:47633`, chỉ nhận trang `cloudgram.datvan.com`, CSP đã mở sẵn cho địa chỉ này. Hiện chỉ dùng để cắt video lớn khi tải lên.
-   Máy này có sẵn: `potplayer:` đã đăng ký trong Windows (lệnh `PotPlayerMini64.exe "%1"`) và có VLC.

## Điều cần nói thẳng

Trang web **không tự mở được ứng dụng trên máy** và **không tự đưa byte cho ứng dụng đó**. Muốn PotPlayer phát được mà không tải cả tệp, cần một địa chỉ HTTP trên máy mà PotPlayer đọc được, và chỉ có một chương trình chạy trên máy mới mở được địa chỉ đó. Vì vậy cách "xem ngay, tua được" **buộc phải dùng chương trình hỗ trợ**. Bạn đã ngại phải chạy node trên máy, nên plan chia hai tầng: tầng 1 không cần gì thêm, tầng 2 cần chương trình hỗ trợ nhưng làm nó tự chạy nền.

## Các hướng đã cân nhắc

| Hướng                                                                            | Kết luận                                                                                                                                                                                          |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Thêm `ts` vào ffmpeg trong trình duyệt                                           | **Làm (tầng 1).** Một dòng, dùng lại máy có sẵn. Chỉ hợp tệp nhỏ, vì ffmpeg trong trình duyệt phải nạp cả tệp vào bộ nhớ                                                                          |
| Cầu nối qua chương trình hỗ trợ: máy mở cổng HTTP cục bộ, trang web đưa byte vào | **Làm (tầng 2).** Xem tệp lớn và mọi codec, tua được, không tải cả tệp                                                                                                                            |
| Dùng `potplayer://...` từ trang web                                              | Chỉ là cách _mở_ PotPlayer, vẫn cần địa chỉ HTTP ở trên. Dùng làm phương án dự phòng cho PotPlayer khi chương trình hỗ trợ không tự mở được. Không có tài liệu chính thức, phải thử thật trên máy |
| Thư viện mpegts.js (phát `.ts` trong trình duyệt)                                | **Không làm.** Thêm thư viện mới, chỉ lo `.ts`, và tệp tĩnh không tua được theo [README](https://github.com/xqq/mpegts.js)                                                                        |
| Tải về rồi mở bằng tay                                                           | Đã có sẵn ("Tải xuống"). Trang web không biết đường dẫn tệp sau khi tải nên không tự mở được                                                                                                      |
| Link chia sẻ công khai đưa cho PotPlayer                                         | Không được: tệp chia sẻ mã hoá đầu cuối, PotPlayer không giải mã được, và link chia sẻ có giới hạn dung lượng                                                                                     |
| Mở tin nhắn trong Telegram Desktop (`tg://`)                                     | Tuỳ chọn phụ, không phải chính. Không dùng PotPlayer                                                                                                                                              |

## Thiết kế tầng 2 (cầu nối)

```
PotPlayer ──HTTP Range──► helper (127.0.0.1:47633/play/<token>/<tên>)
                              │  hỏi "cho tôi byte 5 MB đến 6 MB"
                              ▼
 trang CloudGram ◄── hỏi dài (long-poll) /bridge/<token>/next
        │  đọc từ Telegram bằng đúng hàm của stream.js (có cache, đọc trước)
        ▼
 trang CloudGram ──POST byte──► helper ──► trả lại cho PotPlayer (206)
```

-   Nút "Mở bằng PotPlayer": trang web gọi `POST /play` của chương trình hỗ trợ kèm id tệp, kích thước, tên, và **tên player** (`potplayer` | `vlc` | `mpv`). Chương trình hỗ trợ cấp một token ngẫu nhiên 128 bit, tự tìm player (đăng ký `potplayer:` trong Windows, VLC, mpv trên PATH) rồi chạy `player <địa chỉ>`.
-   Trang web **luôn là bên đọc Telegram**; khoá và phiên Telegram không rời trình duyệt. Chương trình hỗ trợ chỉ chuyển byte.
-   Dùng long-poll bằng `fetch` thay vì WebSocket hay EventSource: khỏi sửa CSP và nginx (`connect-src` đã có `http://127.0.0.1:47633`), và gửi được header `X-CloudGram`.
-   Tệp cắt thành nhiều mảnh (`.001`, `.002`...) không cần xử lý riêng: stream.js đã đọc theo vị trí byte toàn tệp.
-   Tua: PotPlayer bỏ yêu cầu cũ và gửi Range mới; chương trình hỗ trợ huỷ yêu cầu cũ.
-   Tab CloudGram phải còn mở trong lúc xem (nó là bên cấp byte). Đóng tab thì player báo hết dữ liệu.

### An toàn (bắt buộc, vì đây là chỗ mở ứng dụng trên máy)

-   Trang web **không bao giờ gửi đường dẫn chương trình**. Chỉ gửi tên trong danh sách cố định; đường dẫn do chương trình hỗ trợ tự tìm. Nếu không, một lỗi XSS trên trang là chạy được chương trình tuỳ ý trên máy bạn.
-   Chạy player bằng `spawn` với mảng tham số, không qua shell. Địa chỉ do chương trình hỗ trợ tự tạo, tên tệp được làm sạch.
-   Đường `/play/<token>/...` không có Origin (player không gửi), nên bảo vệ bằng token khó đoán, kiểm tra Host (chặn DNS rebinding) và hết hạn khi tab ngắt hoặc sau 6 giờ. Đường `/play` và `/bridge` vẫn bắt Origin + `X-CloudGram` như hiện nay.
-   Chỉ nghe `127.0.0.1`.
-   Theo [docs/security-flags.md](security-flags.md) cho cờ mới; cờ `VITE_FEATURE_EXTERNAL_PLAYER`, bật mặc định, `0` là tắt (nút biến mất).

## Các bước

0.  **Thử nhanh trên máy bạn (khoảng 30 phút, không đổi code):** chạy một máy chủ Range đơn giản ở `127.0.0.1`, mở bằng PotPlayer qua dòng lệnh và qua `potplayer://http://127.0.0.1:...`; thử một `.ts` thật, một HEVC, một AC3. Xác nhận: tua được, và Chrome (chạy từ `https://cloudgram.datvan.com` tới `http://127.0.0.1`) không chặn gọi (quy tắc mạng riêng của Chrome, hiện chương trình cắt video có thể đã chạy được nhưng chưa ai kiểm tra từ bản thật).
1.  **Tầng 1:** thêm `ts` vào `CONVERT_EXT`, kèm test. Tệp `.ts` H.264 + AAC nhỏ phát được ngay trong web.
2.  **Chương trình hỗ trợ:** thêm `GET /players`, `POST /play`, `/play/<token>/...`, `/bridge/<token>/next`, `POST /bridge/<token>/<req>`. Có test (khởi chạy thật trên cổng ngẫu nhiên, một "trang giả" cấp byte, kiểm tra Range 206, huỷ khi tua, token sai bị từ chối).
3.  **Phía trang:** `services/externalPlayer.js` (hỏi `/players`, mở phiên, vòng lặp long-poll gọi hàm đọc Range có sẵn trong stream.js). Tách hàm đọc Range ra khỏi service worker nếu hiện còn dính chặt.
4.  **Giao diện:** nút "Mở bằng PotPlayer/VLC" ở hộp xem trước (hiện cạnh thông báo khi video không phát được) và trong menu chuột phải của tệp video. Khi chương trình hỗ trợ chưa chạy: hướng dẫn một dòng, không báo lỗi khó hiểu.
5.  **Kiểm tra thật:** `.ts`, MKV HEVC, MKV AC3, tệp nhiều mảnh (`.001`), tua đầu và cuối, đóng tab giữa chừng, tab thứ hai.
6.  **Triển khai** (sao lưu VPS trước, như mọi lần). Máy chủ web không đổi, chỉ gói giao diện đổi; chương trình hỗ trợ là tệp mới bạn tải lại.

## Chương trình hỗ trợ tự chạy nền (quyết định của bạn)

Để khỏi gõ `node` mỗi lần: đóng gói thành một tệp chạy được (`.exe`) đăng ký tự khởi động cùng Windows, hoặc tệp `.cmd` đặt trong thư mục Startup. Việc này tách riêng, làm sau bước 5, và cũng giúp luôn cả tính năng cắt video khi tải lên.

## Rủi ro và điều chưa biết

-   `potplayer:` không có tài liệu chính thức; chỉ thấy trong [diễn đàn](https://forum.videolan.org/viewtopic.php?p=520087) và [một chủ đề Mozilla](https://support.mozilla.com/fr/questions/1437813) (Firefox từng đổi cách hiểu `potplayer://`). Vì thế đường chính là chương trình hỗ trợ tự chạy player, không dựa vào `potplayer:`.
-   Cần tab CloudGram mở và máy đang online với Telegram suốt lúc xem.
-   Mỗi lượt xem tốn băng thông Telegram như xem trong web; xem ngoài không có thanh xem trước thumbnail của player web.
-   Chỉ nhắm Windows trước (PotPlayer chỉ có Windows). VLC và mpv chạy được trên macOS và Linux, nhưng chưa kiểm tra.

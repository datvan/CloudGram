# Plan nghiên cứu: xem video bằng trình phát ngoài mà không cần `cloudgram-helper.mjs`

Trạng thái 2026-11-10: **mới là plan nghiên cứu, chưa viết code.** Mục tiêu: bấm "Mở bằng PotPlayer" (hoặc xem tệp `.ts` quá lớn) mà người dùng không phải tải, không phải chạy `node cloudgram-helper.mjs`.

## Điều cần nói thẳng trước

Helper hiện làm **hai việc** mà một trang web không tự làm được:

-   **A. Mở trình phát** trên máy (`spawn`). Trình duyệt không được phép chạy chương trình.
-   **B. Cho trình phát một địa chỉ HTTP có Range** để nó đọc và tua. Trình phát ngoài không gọi được vào service worker của trang.

Bỏ helper nghĩa là tìm chỗ khác làm A và B. Chỉ có ba chỗ: (1) thứ **đã có sẵn trên máy** (giao thức `potplayer:` mà PotPlayer tự đăng ký), (2) một **máy ở ngoài** (VPS), (3) **không dùng trình phát ngoài** mà làm trình phát trong web mạnh hơn. Hướng nào cũng có cái giá; bảng dưới nói rõ.

## Các hướng và điều đã biết

| Hướng                                                                                                       | Làm A bằng | Làm B bằng              | Phải cài gì              | Ghi chú                                                                                                 |
| ----------------------------------------------------------------------------------------------------------- | ---------- | ----------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------- |
| **H1. Cầu nối qua VPS** + `potplayer://https://cloudgram.datvan.com/play/<token>`                           | giao thức  | VPS chuyển tiếp byte    | Chỉ PotPlayer (đã có)    | Không cài thêm gì. Byte đi qua VPS, xem mục rủi ro                                                      |
| **H1b.** Như H1 nhưng trang hiện **địa chỉ để dán** vào Ctrl+U (PotPlayer) hoặc "Open Network Stream" (VLC) | người dùng | VPS chuyển tiếp byte    | Không                    | Chạy với mọi trình phát, không cần giao thức. Thêm một thao tác dán                                     |
| **H2. Trình phát trong web mạnh hơn** (mpegts.js, mux.js, WebCodecs, libav.js)                              | không cần  | service worker có sẵn   | Không                    | Hợp `.ts` H.264 + AAC. Không cứu được AC3/DTS, HEVC tuỳ trình duyệt. Tua tệp tĩnh của mpegts.js chưa rõ |
| **H3. Tiện ích Chrome + Native Messaging**                                                                  | host       | host                    | Tiện ích **và** tệp host | Vẫn phải cài chương trình trên máy; chỉ đổi nơi đặt. **Loại**                                           |
| **H4. Đóng gói helper thành `.exe`** (Node SEA) tự chạy cùng Windows                                        | `.exe`     | `.exe`                  | Một lần                  | Không phải "không cần helper", nhưng hết gõ `node`. Cũng dùng cho cắt video khi tải lên                 |
| **H5. Giao thức `cloudgram:`** đăng ký trong registry (HKCU, không cần admin) bật helper khi bấm nút        | giao thức  | helper bật theo yêu cầu | Một lần chạy tệp `.reg`  | Không phải để cửa sổ mở sẵn. Chrome hỏi xác nhận lần đầu                                                |
| **H6. Mở tin nhắn bằng `tg://` trong Telegram Desktop**                                                     | Telegram   | Telegram                | Telegram Desktop         | Trình phát của Telegram, không phải PotPlayer; tệp cắt `.001` không liền mạch. Chỉ là phương án phụ     |
| **H7. VPS tự kéo từ Telegram**                                                                              | —          | VPS                     | —                        | Phải đưa phiên Telegram lên VPS, phá nguyên tắc "server chỉ giữ bản mã". **Loại**                       |

## Cái giá của H1 (cần đo, không đoán)

-   **Riêng tư:** video đi qua VPS dưới dạng chưa mã hoá, dù không lưu. Mô hình hiện nay là server chỉ thấy bản mã. Cần quyết định: chấp nhận được không, và nếu có thì ghi rõ trong tài liệu bảo mật.
-   **Băng thông và độ trễ:** mỗi lượt xem là byte đi Telegram → trình duyệt → VPS → trình phát, tức hai chặng qua mạng nhà. Tệp 7.6 GB phát đều cần đường lên của máy bạn đủ nhanh, mà helper trên máy thì không có chặng này.
-   **Cloudflare:** site đi qua Cloudflare. Cloudflare nói năm 2023 đã bỏ mục 2.8 (cấm phát video qua gói thường) và chuyển ý đó vào điều khoản riêng cho CDN ([bài đăng](https://blog.cloudflare.com/updated-tos/)); chưa rõ chạy video qua proxy gói miễn phí có vi phạm không. Phải đọc điều khoản hiện hành. Ngoài ra có giới hạn thời gian cho một yêu cầu, nên phải trả byte theo từng đoạn Range ngắn.
-   **An toàn:** địa chỉ có token ngẫu nhiên, hết hạn khi tab đóng, và chỉ chuyển tiếp trong lúc tab mở. Ai có link thì xem được trong lúc đó.
-   **`potplayer://`:** không có tài liệu chính thức. Các nguồn cộng đồng nói dạng `potplayer://https://...` chạy được trên Chrome, nhưng Firefox từng đổi cách hiểu ([thảo luận](https://support.mozilla.com/fr/questions/1437813)). Chỉ PotPlayer có giao thức này; VLC và mpv không (có [một chủ đề](https://forum.videolan.org/viewtopic.php?p=520082) nhưng chưa phải tính năng).

## Các thí nghiệm, làm theo thứ tự rẻ nhất trước

Mỗi thí nghiệm không đổi code của sản phẩm, chạy trên máy bạn.

1.  **Biết tệp là gì (10 phút).** Chạy `ffprobe` trên tệp `.ts` 7.6 GB của bạn: codec hình (H.264 hay HEVC) và tiếng (AAC hay AC3). Quyết định H2 có khả thi không: H.264 + AAC thì có, HEVC hay AC3 thì H2 không đủ.
2.  **Giao thức `potplayer:` (30 phút).** Trong Chrome trên máy bạn, mở một trang thử có liên kết `potplayer://http://127.0.0.1:<cổng>/x.ts` trỏ vào máy chủ Range đơn giản, rồi `potplayer://https://...` trỏ vào một địa chỉ công khai. Ghi: Chrome có hỏi xác nhận không, PotPlayer có mở và tua được không, dạng một gạch hay hai gạch. Thử cả cách dán vào Ctrl+U.
3.  **Mẫu cầu nối qua VPS (nửa ngày).** Một đường `/play/<token>` và một cổng WebSocket (hoặc long-poll như hiện nay) trên máy chủ tài khoản, tab đẩy byte lên. Đo: độ trễ khi bắt đầu, tốc độ giữ được, có bị Cloudflare cắt không, tua đầu/cuối tệp, đóng tab giữa chừng.
4.  **mpegts.js trên tệp lớn (nửa ngày).** Nạp một `.ts` H.264 vài GB qua service worker hiện có, thử phát và tua. Nếu tua không chạy, thử tự cắt luồng TS thành đoạn fMP4 theo vị trí byte (mux.js). Ghi: bộ nhớ, thời gian tới khung hình đầu tiên, tua có nhảy đúng chỗ không.
5.  **Đóng gói `.exe` (nửa ngày).** Gói `cloudgram-helper.mjs` bằng Node SEA ([tài liệu](https://nodejs.org/download/release/v24.13.0/docs/api/single-executable-applications.html)). Lưu ý: chỉ hỗ trợ CommonJS và một tệp script, nên phải gộp trước; bản Node tạo blob phải trùng bản nhúng; tệp chưa ký có thể bị SmartScreen hoặc phần mềm diệt vi-rút cảnh báo. Thử thêm tệp `.reg` đăng ký `cloudgram:` (H5) và lối tắt Startup.

## Cách chọn

| Nếu kết quả là                                                   | Thì                                                                                                    |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Bước 1 ra H.264 + AAC và bước 4 tua ổn                           | **H2 là đường chính**: xem `.ts` ngay trong web, không cài gì, không cần VPS chuyển byte               |
| Bước 1 ra HEVC/AC3 (web không giải được)                         | Cần trình phát ngoài: **H1** nếu bước 2 và 3 ổn và bạn chấp nhận byte qua VPS, nếu không thì **H5/H4** |
| Bước 2 cho thấy `potplayer:` chạy nhưng bước 3 bị Cloudflare cắt | H1b (dán địa chỉ) với đường truyền khác, hoặc H5                                                       |
| Cả H1 và H2 đều không đạt                                        | **H4/H5**: chấp nhận một lần cài, nhưng không phải gõ `node` nữa                                       |

Tạm thời tôi nghiêng về: **H2 cho `.ts` H.264**, **H5** (một lần cài, helper bật theo yêu cầu) cho mọi thứ còn lại, và chỉ làm H1 nếu bạn chấp nhận video đi qua VPS. H1 là hướng duy nhất thật sự không cần cài thêm gì, nên đáng đo ở bước 2 và 3 trước khi bỏ.

## Câu hỏi cần bạn trả lời trước khi làm

1.  Video đi qua VPS dưới dạng chưa mã hoá có chấp nhận được không (quyết định H1)?
2.  Ưu tiên của bạn: chỉ xem được `.ts` ngay trong web (H2), hay phải mở bằng PotPlayer cho mọi loại tệp?
3.  Có chấp nhận cài **một lần** (`.exe` hoặc tệp `.reg`) không, hay phải là không cài gì cả?

## Chưa biết, ghi để khỏi quên

-   Điều khoản hiện hành của Cloudflare về phát video qua proxy (đọc tại cloudflare.com/terms, không dựa vào bài viết bên thứ ba).
-   Tua tệp tĩnh của mpegts.js: tài liệu npm ghi chưa hỗ trợ, còn tài liệu khác có tuỳ chọn `accurateSeek` ([kho mã](https://github.com/xqq/mpegts.js)). Chỉ thử thật mới biết.
-   HEVC trong MPEG-TS: tuỳ phần cứng và trình duyệt, không có nguồn nào xác nhận tua ổn.

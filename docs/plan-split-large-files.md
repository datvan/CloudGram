# Plan nghiên cứu: tự phát hiện tệp quá giới hạn Telegram và chia thành các phần

Trạng thái 2026-11-09: đã làm **giai đoạn 1 của cách 2** (cắt bằng ffmpeg trên máy bạn): phát hiện tệp quá giới hạn, chặn trước khi tải, hiện hộp thoại kèm lệnh cắt. Chưa làm: gom các phần thành một video và phát lần lượt trong trình phát (giai đoạn 2), cắt thô theo byte (mục 2 đến 5).

## Cờ bật tắt (rollback)

`VITE_FEATURE_SPLIT_LARGE`, mặc định bật. Chỉ giá trị đúng `0` mới tắt, giống các cờ `VITE_SECURITY_*` ([security-flags.md](security-flags.md)). Tắt: đặt `VITE_FEATURE_SPLIT_LARGE=0` trong `.env`, build lại và deploy. Khi tắt, `uploadLimit()` trả về vô hạn: tải lên từ máy không bị chặn nữa, nhập từ Dropbox quay về giới hạn cũ 4 GiB. Đọc cờ ở [features.js](../src/config/features.js).

## 1. Vấn đề

Telegram giới hạn dung lượng một tệp theo **số phần (part)**, không theo số byte tròn. Mỗi phần tối đa 512 KiB:

| Tài khoản                                | Số phần tối đa | Dung lượng tối đa                                                |
| ---------------------------------------- | -------------- | ---------------------------------------------------------------- |
| Thường (`upload_max_fileparts_default`)  | 4000           | 4000 x 512 KiB = 2.097.152.000 B (2000 MiB)                      |
| Premium (`upload_max_fileparts_premium`) | 8000           | 8000 x 512 KiB = **4.194.304.000 B (4000 MiB, khoảng 3,91 GiB)** |

Nguồn: [core.telegram.org/api/config](https://core.telegram.org/api/config) (hai số 4000 và 8000, và cách tính "nhân với 524288"), [core.telegram.org/api/files](https://core.telegram.org/api/files) (phần tối đa 512 KB, `part_size` chia hết 524288 và chia hết 1024).

Hiện trạng trong CloudGram (đã đọc code, chưa chạy thử):

-   Chỉ có **một** chỗ kiểm tra dung lượng: `MAX_FILE = 4 GiB` trong [dropboxImport.js:29](../src/services/dropboxImport.js) (dùng ở dòng 253 và 295, bỏ qua tệp với lý do "quá 4 GB").
    -   Con số này **sai**: 4 GiB = 4.294.967.296 B, lớn hơn giới hạn thật 4.194.304.000 B khoảng 100 MB. Tệp từ 3,91 đến 4 GiB vẫn lọt qua kiểm tra rồi mới bị Telegram từ chối.
-   Tải tệp từ máy ([driveActions.js:170, 209](../src/utils/driveActions.js)) và tải tiếp ([uploadResume.js:452](../src/services/uploadResume.js)) **không kiểm tra gì**. Tệp quá lớn đi thẳng vào hàng đợi.
-   [transfer.js:171-176](../src/utils/transfer.js) tính `parts = ceil(size / 512 KiB)` rồi gửi từng phần. Chưa rõ Telegram báo `FILE_PARTS_INVALID` ở phần đầu hay ở cuối (xem câu hỏi R2).
-   Code không hề biết tài khoản có Premium hay không. Tài khoản thường chỉ được 2000 MiB.
-   Mỗi tệp trong cây thư mục là **một bản ghi, một `file_id` (số tin nhắn)**. Tải xuống, phát video, ảnh nhỏ, xoá, sao lưu đều dựa vào giả định này.

## 2. Kích thước mỗi phần: "3,99 GB" nghĩa là gì

Giới hạn Premium là 4.194.304.000 B.

-   Nếu 3,99 GB là **thập phân** (3.990.000.000 B) thì vừa, còn dư khoảng 204 MB.
-   Nếu là **GiB** (3,99 GiB = 4.284.481.515 B) thì **vượt giới hạn**, phần đó vẫn bị từ chối.

Đề xuất: mỗi phần tối đa **3805 MiB = 3.989.831.680 B** (khoảng 3,99 GB thập phân, dư 195 MiB so với giới hạn). Số này chia hết cho 1 MiB, nên khi phát video, các lần đọc theo khoảng (range) của `stream.js` không bao giờ vắt qua ranh giới hai phần giữa chừng một khối.

Với tài khoản thường, dùng cùng công thức: tối đa khoảng 1900 MiB mỗi phần (còn dư để chắc chắn dưới 2000 MiB).

Chia đều hay chia theo mức tối đa? Ví dụ tệp 4,3 GB: chia theo mức tối đa cho ra phần 3,99 GB cộng một phần đuôi 0,3 GB. Chia đều cho ra hai phần 2,15 GB. Đề xuất chia đều: `n = ceil(size / max)`, mỗi phần `ceil(size / n)` làm tròn lên bội số của 1 MiB.

Tên phần theo kiểu `ten.mp4.001`, `ten.mp4.002`. Đây là cách đặt tên 7-Zip và HJSplit nhận. Nếu mất cây thư mục, các tệp trong Saved Messages vẫn ghép lại được bằng `copy /b` hoặc 7-Zip. Vì là cắt thô theo byte nên không mất chất lượng.

## 3. Hai hướng thiết kế

**Hướng A: một bản ghi, nhiều tin nhắn (đề xuất).** Bản ghi giữ `file_id` = tin nhắn của phần đầu và thêm `parts: [{ id, size }, ...]` cho các phần còn lại (hoặc đủ cả phần đầu). Giữ `file_id` làm phần đầu để các chỗ chỉ kiểm tra `file_id != null` ("đã tải lên xong") vẫn đúng mà không cần sửa. Giao diện chỉ thấy một tệp.

**Hướng B: mỗi phần là một bản ghi riêng, có nhóm.** Tận dụng nguyên hàng đợi, log và resume. Nhưng xoá, di chuyển, đổi tên, nhãn, sao, trùng tên, thùng rác đều phải xử lý theo nhóm, rất dễ sót. Không đề xuất.

**Hướng C: cắt video thật bằng ffmpeg để mỗi phần tự phát được.** Loại: ffmpeg trong trình duyệt (wasm) không đủ bộ nhớ cho tệp trên 2 GB, và tệp bị mã hoá lại. Chỉ ghi lại để khỏi bàn lại.

## 4. Câu hỏi cần trả lời trước khi viết code

Cần tài khoản Telegram thật của bạn đăng nhập trong trình duyệt cho R1 đến R3. Mình sẽ không tự đăng nhập hay tải tệp lớn lên.

| #   | Câu hỏi                                                                                                                             | Cách kiểm tra                                                                                                                                                                          | Cần tài khoản thật               |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| R1  | Số phần tối đa thật của tài khoản này là bao nhiêu, và có Premium không?                                                            | Gọi `help.getAppConfig` (bản `telegram` đang cài có `GetAppConfig`) đọc `upload_max_fileparts_*`; đọc `me.premium` từ `getMe()` (đã có ở [account.js:397](../src/services/account.js)) | Có, chỉ đọc                      |
| R2  | Gửi tệp vượt giới hạn thì Telegram báo lỗi ở đâu, lỗi gì?                                                                           | Gửi **một** phần 512 KB với `fileTotalParts` = 8000 rồi 8001 (rẻ, không tốn băng thông). Không cần tải 4 GB                                                                            | Có, chỉ đọc cộng một lần gửi nhỏ |
| R3  | Một tệp 3805 MiB có thực sự được nhận trọn vẹn và tải lại đúng từng byte không?                                                     | Một lần thử thật bằng tệp ngẫu nhiên khoảng 3,9 GB, so SHA-256 sau khi tải lại. Tốn khoảng 4 GB băng thông mỗi chiều và nằm lại trong Saved Messages cho đến khi xoá                   | Có, cần bạn đồng ý               |
| R4  | Cách ghép: tải về một tệp trong thư mục riêng của trình duyệt (OPFS) có chịu nổi trên 4 GB không?                                   | `downloadFile.js` đã ghi theo vị trí (`write(bytes, position)`), chỉ cần cộng thêm độ lệch của phần. Kiểm tra hạn mức OPFS thực tế trên Chrome                                         | Không                            |
| R5  | Phát video qua nhiều phần: ghép khoảng byte toàn cục thành (tin nhắn, vị trí trong tin nhắn) có chạy đúng khi MP4 có `moov` ở cuối? | Đọc kỹ `stream.js` (`info`, `fetchPart`, `part` đang khoá theo `fileId:index`); thử bằng stub Telegram                                                                                 | Không                            |
| R6  | Ảnh nhỏ và storyboard của video chia phần lấy từ đâu?                                                                               | Đọc `thumbnails.js:331`, `storyboard.js`. Có thể chỉ dùng phần đầu, và không có ảnh nhỏ nếu `moov` nằm cuối tệp                                                                        | Không                            |
| R7  | Gửi dạng video (`asMedia`) hay dạng tệp?                                                                                            | Các phần phải gửi **dạng tệp** (`forceDocument: true`). Phần 2 trở đi không phải video phát được. Kiểm tra `sendOptions` trong [uploadFile.js](../src/utils/uploadFile.js)             | Không                            |

## 5. Phạm vi thay đổi dự kiến (hướng A)

Phát hiện và hỏi:

1. Hàm `maxFileBytes()` đọc kết quả R1 (có Premium hay không, số phần tối đa), dùng chung cho mọi nơi.
2. Chỗ chặn chung trước khi vào hàng đợi, ở cả ba nơi gọi `enqueueUpload`: tải từ máy (`driveActions.js`), nhập từ Dropbox (`dropboxImport.js`, thay chỗ "bỏ qua quá 4 GB"), tải tiếp (`uploadResume.js`).
3. Hộp thoại gom một lần cho cả danh sách: "3 tệp vượt giới hạn Telegram Premium (4 GB): `a.mkv` 4,3 GB, ... Chia thành các phần tối đa 3,99 GB?" với các nút **Chia và tải lên**, **Bỏ qua các tệp này**. Có tích chọn "luôn chia, đừng hỏi lại" nếu bạn muốn.
4. Phạm vi: đề nghị áp dụng cho **mọi loại tệp**, không riêng video, vì giới hạn là như nhau. Với video, lời nhắn có thêm một dòng nói rõ phát vẫn bình thường.

Tải lên:

5. `uploadFile.js`: vòng lặp qua từng phần, mỗi phần là `new File([file.slice(a, b)], name + ".00N")`. Đây là cắt không sao chép dữ liệu nên không tốn bộ nhớ, và `uploadParts` đã đọc theo lát cắt sẵn. Mỗi phần có `sendFile` riêng. Kết quả trả về `changes.parts`.
6. Tiếp tục khi lỗi: `resume` hiện chỉ nhớ một `fileId` và các phần đã gửi ([uploadQueue.js:81-91](../src/utils/uploadQueue.js)). Cần nhớ theo từng phần, và `uploadLog` phải lưu được dạng mới.
7. Ràng buộc bảo mật theo [docs/security-flags.md](security-flags.md): mỗi phần gửi đi vẫn phải gọi `assertCurrent()` và gắn với `uploadScope()`. Đổi tài khoản giữa chừng không được gửi phần còn lại sang tài khoản khác.

Đọc, xoá, sao lưu (những chỗ đang giả định một `file_id`):

8. `downloadFile.js:136` `fetchFile`: lặp qua các phần, ghi vào cùng một tệp đích với độ lệch cộng dồn.
9. `stream.js:101, 130`: coi các phần như một tệp ảo, đổi chỉ số phần toàn cục thành (tin nhắn, chỉ số phần trong tin nhắn). Khoá bộ nhớ đệm `fileId:index` hiện chỉ có một `fileId`.
10. `driveActions.js:383, 418` và `tree.js:99`, `treeBackup.js:166`: danh sách tin nhắn cần xoá hoặc đã được dùng phải gồm **cả các phần**, nếu không xoá tệp sẽ bỏ sót phần 2 trở đi trong Saved Messages (tốn dung lượng Telegram mà không còn thấy).
11. `shares.js`: giới hạn chia sẻ 2 GB vẫn chặn trước, không đổi. `PreviewDialog.jsx` giới hạn xem trước video 300 MB vẫn đúng.
12. `DetailsPanel.jsx:163`: hiển thị "tin nhắn #..." cần ghi rõ nhiều phần.
13. Sửa luôn `MAX_FILE` thành giới hạn thật (kể cả khi chưa làm tính năng chia). Đây là lỗi nhỏ độc lập, có thể làm trước.

## 6. Kiểm thử

-   Đơn vị: hàm chia (biên 4000 MiB trừ 1, đúng 4000 MiB, cộng 1; tệp 0 byte; tệp đúng bội số phần), đảm bảo số phần mỗi tệp không vượt giới hạn.
-   Có stub Telegram (như `server/test/browser-security.test.js` đã dùng): gửi nhiều phần, đứt giữa chừng rồi tiếp tục, đổi tài khoản giữa chừng, xoá tệp rồi đếm tin nhắn bị xoá, phát video khoảng byte cắt ngang ranh giới hai phần.
-   Thật (chỉ khi bạn đồng ý): R3 là một lần, tệp khoảng 3,9 GB, xong thì xoá khỏi Saved Messages.
-   `npm run lint`, `npm run build`, `npm run test:api`; không có kiểm chứng thật thì ghi rõ trong báo cáo, như tài liệu bảo mật đang làm.

## 7. Thứ tự đề xuất

1. Làm ngay, nhỏ: sửa `MAX_FILE` và thêm chỗ chặn chung với thông báo rõ ràng (chưa chia). Người dùng hết bị tải mấy giờ rồi mới thấy lỗi.
2. R1 và R2 (rẻ): biết số thật và lỗi thật.
3. Hộp thoại gom và hàm chia, kèm kiểm thử đơn vị.
4. Tải lên nhiều phần cùng tiếp tục, tiếp theo là tải xuống và xoá.
5. Phát video qua nhiều phần và ảnh nhỏ.
6. R3 một lần thử thật, sau đó mới triển khai.

## 8. Video gửi dạng media: cắt bằng ffmpeg thay vì cắt thô

Cắt thô theo byte (mục 2) cho ra các phần **không tự phát được**: chỉ CloudGram ghép lại để phát. Nếu muốn mỗi phần là một video phát được ngay trong ứng dụng Telegram, phải cắt bằng ffmpeg.

-   Cách cắt: `-c copy` (không mã hoá lại, giữ nguyên chất lượng), cắt tại khung hình chính (keyframe), mỗi phần là một MP4 độc lập có `moov` ở đầu. Phần không đều nhau, nên phải tính thời lượng mỗi đoạn từ bitrate và chừa dư (video bitrate đổi theo cảnh có thể làm một đoạn lớn hơn dự tính).
-   **Giới hạn của ffmpeg trong trình duyệt:** bản đang dùng (`@ffmpeg/core` 0.12.6, [convert.js](../src/services/convert.js)) là WebAssembly, bộ nhớ khoảng 2 GB. Có thể mở tệp lớn không cần chép vào bộ nhớ bằng WORKERFS (cộng đồng báo đọc được mkv 13 GB, chỉ đọc, chạy chậm hơn), nhưng **các đoạn xuất ra nằm trong bộ nhớ**. Vì vậy mỗi phần chỉ khoảng 1 đến 1,5 GB, không đạt 3,99 GB. Chưa kiểm với bản này (câu hỏi R8). Nguồn tham khảo: [ffmpegwasm/ffmpeg.wasm#516](https://gh.r-mj.com/ffmpegwasm/ffmpeg.wasm/discussions/516) và các bài viết cộng đồng, chưa có tài liệu chính thức.
-   `moov` ở đầu (`+faststart`) buộc ffmpeg ghi lại cả đoạn, tốn gấp đôi bộ nhớ. Dùng MP4 phân mảnh thì không tốn, nhưng chưa rõ ứng dụng Telegram có tua được không.
-   **Ảnh hưởng tới trình phát của CloudGram:** các phần là MP4 độc lập nên không ghép bằng cách nối byte được. Trình phát phải phát lần lượt từng phần, thanh tua phải cộng thời lượng các phần, ảnh xem trước (storyboard) làm theo từng phần. Tải về thành một tệp duy nhất cũng cần ghép lại bằng ffmpeg (lại bị giới hạn bộ nhớ), hoặc tải các phần rời. Việc này lớn hơn nhiều so với cắt thô.

Ba cách, tuỳ bạn xem video ở đâu:

| Cách                                           | Mỗi phần           | Phát trong Telegram | Phát trong CloudGram               | Công sức                                 |
| ---------------------------------------------- | ------------------ | ------------------- | ---------------------------------- | ---------------------------------------- |
| Cắt thô theo byte (mục 2)                      | 3805 MiB           | Không               | Có, ghép liền mạch                 | Vừa                                      |
| ffmpeg chạy trên máy bạn, rồi tải các phần lên | Tuỳ ý, tới 3,99 GB | Có                  | Phát lần lượt (cần sửa trình phát) | Nhỏ cho phía tải lên, vừa cho trình phát |
| ffmpeg trong ứng dụng                          | 1 đến 1,5 GB       | Có                  | Phát lần lượt (cần sửa trình phát) | Lớn                                      |

Lệnh cắt trên máy (chưa chạy thử ở đây): `ffmpeg -i in.mp4 -map 0 -c copy -f segment -segment_time <giây> -reset_timestamps 1 -segment_format_options movflags=+faststart out_%03d.mp4`, với `<giây>` = thời lượng x (3,5 GB / dung lượng tệp), để chừa dư cho bitrate đổi theo cảnh.

Câu hỏi R8: ffmpeg trong ứng dụng cắt được tới dung lượng đoạn nào trước khi hết bộ nhớ, khi mở tệp bằng WORKERFS? Thử trên Chrome với một tệp thật vài GB.

## 8b. Giai đoạn 2: chương trình hỗ trợ trên máy (đã làm, chưa triển khai)

Trang web không tự chạy được chương trình trên máy, nên có thêm một chương trình nhỏ [cloudgram-helper.mjs](../public/helper/cloudgram-helper.mjs) (Node 20+, không cần cài gói nào) chạy trên máy bạn: `node cloudgram-helper.mjs`.

-   Hộp thoại "tệp quá lớn" tự tìm chương trình. Chưa chạy: hướng dẫn tải và chạy. Chạy rồi nhưng thiếu ffmpeg: hướng dẫn cài (`winget install Gyan.FFmpeg`). Đủ cả hai: nút "Tự cắt và tải lên".
-   Trang gửi tệp cho chương trình, chương trình đọc thời lượng bằng ffprobe rồi cắt bằng ffmpeg `-c copy` (không mã hoá lại, nên không dùng CPU lẫn VGA để mã hoá). Phần nào vượt giới hạn thì tự cắt ngắn lại, tối đa 3 lần. Các phần trả về trang, rồi đi qua `uploadEntries` như tệp chọn tay (có hỏi trùng tên). **Tệp gốc không bao giờ bị xoá.**
-   An toàn: chỉ nghe `127.0.0.1`, chỉ nhận trang `https://cloudgram.datvan.com` (kiểm tra `Origin` và `Host`), ffmpeg chạy bằng danh sách đối số cố định, không qua shell, chỉ dùng tên tệp tạm do chương trình tự đặt. Thư mục tạm xoá sau khi trang lấy xong các phần.
-   **Cờ bật tắt:** `VITE_FEATURE_LOCAL_HELPER=0` rồi build lại, hộp thoại quay về chỉ hiện lệnh (giai đoạn 1). Cần thêm `http://127.0.0.1:47633` vào `connect-src` của nginx ([csp.md](csp.md)); file mẫu đã sửa trong `deploy/nginx/cloudgram.conf`, chưa cài lên VPS. Quay lại: khôi phục bản sao lưu cấu hình nginx cũ.
-   Đã thử: chạy thật với ffmpeg 8.1 (cắt tệp 22 MB thành 4 phần từ trang chạy ở localhost:5173), kiểm tra từ chối sai Origin/Host. **Chưa thử:** tệp thật vài GB; trang HTTPS thật gọi vào 127.0.0.1 (Chrome có thể hiện hộp xin quyền truy cập mạng nội bộ; Safari chặn); mã hoá không tương thích mp4 (ví dụ một số âm thanh trong mkv) làm ffmpeg báo lỗi; huỷ giữa chừng. Cần khoảng 2 lần dung lượng tệp trống trên ổ đĩa (tệp tạm của chương trình, rồi các phần nằm trong trình duyệt). Các phần tải lên từ trình duyệt không có tay cầm tệp nên **không tiếp tục được sau khi tải lại trang**.

## 9. Chưa biết, chưa kiểm

-   Giá trị thật của `upload_max_fileparts_premium` cho tài khoản của bạn (R1). Mình lấy 8000 từ tài liệu Telegram, chưa gọi API.
-   Telegram có cho gửi một tệp **chính xác** 4000 MiB không, hay có thêm hao hụt nào (R3). Vì thế mới đề xuất 3805 MiB, dư 195 MiB.
-   Nén tệp gửi dạng tệp/phương tiện có khác giới hạn không: tài liệu Telegram không nói.

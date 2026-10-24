# CloudGram — Plan nâng cấp

Fork: https://github.com/datvan/CloudGram (upstream: MQ-xz/CloudGram)

Mục tiêu:

1. Xóa folder đã tạo (xóa đệ quy cả cây con, kèm file thật trên Telegram)
2. Upload nhiều file cùng lúc
3. Upload nguyên folder (giữ cấu trúc thư mục)

## Tình trạng

| Phase                           | Trạng thái                          | Commit                                                         |
| ------------------------------- | ----------------------------------- | -------------------------------------------------------------- |
| 0 — bug nền                     | xong                                | `Fix base bugs in DB writes, download name and progress state` |
| 1 — truy cập DB ngoài component | xong (đổi cách làm, xem bên dưới)   | `Add folder delete and a bounded multi-file upload queue`      |
| 2 — xóa folder đệ quy           | xong                                | cùng commit trên                                               |
| 3 — upload nhiều file           | xong                                | cùng commit trên                                               |
| 4 — upload nguyên folder        | xong                                | `Add whole-folder upload`                                      |
| 5 — migration + export metadata | **chưa làm** (tùy chọn, rủi ro cao) | —                                                              |

Phase 2 và 3 nằm chung một commit vì đường xóa phải gọi `cancelUploads` của hàng đợi; tách ra thì không commit nào build được.

Kiểm chứng đã chạy: `npm run lint` sạch, `npm run build` pass, prettier sạch (dạng LF), và 14 assertion trên các hàm thuần (`collectSubtree`, `buildTreeFromPaths`). Chưa chạy thử runtime — cần đăng nhập Telegram.

---

## 1. Hiện trạng kiến trúc

| Thành phần                            | Vai trò                                                      |
| ------------------------------------- | ------------------------------------------------------------ |
| React 18 + Vite + MUI 5               | UI                                                           |
| Redux (`src/redux`)                   | chỉ giữ `auth` + `progress` (tiến độ up/down theo `id`)      |
| IndexedDB qua `react-indexed-db-hook` | **toàn bộ cây thư mục/metadata**, store `file`, keyPath `id` |
| GramJS (`telegram`)                   | nói chuyện MTProto thẳng từ browser                          |
| Telegram "Saved Messages" (`"me"`)    | nơi chứa nội dung file thật                                  |

Record trong store `file`:

```js
{ id: uuid4(), name, type: "folder" | "file", parent?: <id cha>, file_id?: <message id> }
```

Điểm cốt lõi cần nhớ:

-   **Record ở root KHÔNG có key `parent`** (`CreateFolder.jsx:37`, `UploadFile.jsx:33` chỉ set khi có `parentID`). IndexedDB index bỏ qua record thiếu key → không query root bằng index được. Record con thì luôn có `parent`.
-   `file_id` = message id trong Saved Messages. Mất IndexedDB = mất cây = file trên Telegram thành mồ côi, không truy ngược được.
-   `Folder.jsx` đã có sẵn `@todo: folder delete`, nút menu và prop `deleteItem` đang bị comment (dòng 31–37, 48).
-   Không có test framework. CI chỉ chạy `lint` (`--max-warnings 0`) và `prettier --check`.

### Đã xác minh trong source GramJS (không phải suy đoán)

| Điểm                                                                      | Kết luận                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client.deleteMessages("me", ids, true)` (`File.jsx:40`)                  | `messages.ts:994` destructure `{ revoke = false }`. Truyền `true` (boolean) → `revoke` thành **false**. Không crash, và với Saved Messages (chat với chính mình) thì `revoke` vô nghĩa → hiện tại vẫn chạy đúng. Nên sửa thành `{ revoke: true }` cho đúng ý. |
| Batch delete                                                              | `messages.ts:1028` + `Utils.ts:78` → GramJS **tự chunk 100 id/request**. Không cần tự chia batch, chỉ cần truyền nguyên mảng.                                                                                                                                 |
| `new CustomFile(name, size, "", file.arrayBuffer())` (`uploadFile.js:11`) | `uploads.ts:109` làm `Buffer.from(await fileToBuffer(file))`, mà `fileToBuffer` trả thẳng `file.buffer` → `await` resolve được Promise. **Chạy đúng, nhưng nạp nguyên file vào RAM.** Đây là trần giới hạn thật của việc upload nhiều file/folder.            |

---

## Phase 0 — Sửa bug nền (bắt buộc làm trước)

Ba lỗi này sẽ phóng đại lên khi có nhiều file:

1. **Race `fetchData()`** — `UploadFile.jsx:34-55`, `CreateFolder.jsx:38-45`, `Explorer.jsx:46-53` gọi `fetchData()` trước khi `add()`/`deleteRecord()` resolve → list hiển thị thiếu/thừa. Sửa: `await` rồi mới `fetchData()`.
2. **`downloadFile.js:30`** — `link.download = name`, `name` là biến global `window.name` (chuỗi rỗng) → file tải về sai tên. Sửa: truyền `name` vào `downloadFile(id, file_id, name)`.
3. **`progressReducer.js:3-9`** — state khởi tạo có entry rác `{ id: 0, ... }`. Sửa: `activeProgress: []`.

Phụ: `File.jsx:40` → `{ revoke: true }`.

---

## Phase 1 — Lớp truy cập DB dùng được ngoài component

**Vấn đề:** `useIndexedDB` gọi `useMemo` bên trong (đã đọc `lib/main.js`) nên nó là hook thật, chỉ chạy được trong component. Mà xóa đệ quy và hàng đợi upload đều là logic ngoài render.

**Cách làm ban đầu đã bị loại:** tự mở connection thứ hai trong `fileRepo.js`. Nếu `indexedDB.open("CloudGram", 1)` của nó thắng race với `initDB` (`App.jsx:14`), nó tạo DB v1 rỗng không có object store, `onupgradeneeded` của `initDB` không bao giờ chạy → app hỏng hoàn toàn. Rủi ro này không đáng đánh đổi.

**Cách đã chọn — tiêm `ops` vào hàm thuần.** `useIndexedDB("file")` trả về một object hàm ổn định, và mỗi hàm tự mở connection riêng bên trong, không phụ thuộc React context. Vậy chỉ cần component lấy object đó rồi truyền xuống cho logic nền. Không có connection thứ hai, không có race, không đụng schema.

-   `src/utils/tree.js` — `collectSubtree` / `childrenOf` / `findFolder` / `recordIdsOf` / `messageIdsOf`, thuần, không import gì.
-   `src/utils/buildTreeFromPaths.js` — thuần, không import gì.
-   `src/utils/uploadQueue.js` — nhận `ops` theo từng job.

> **Không dùng được index `parent`.** `getByIndex` của thư viện chạy `index.get(key)` nên **chỉ trả về record ĐẦU TIÊN**, còn `openCursor` chỉ nhận key range trên keyPath (`id`). Không cái nào liệt kê được con của một folder. Mọi hàm vì thế chạy trên snapshot `getAll()` rồi lọc trong JS — đúng bằng chi phí mà `Explorer` vốn đã trả mỗi lần render.

> **Không bump DB version ở các phase này.** Chuẩn hóa `parent: "root"` cần `migrationFactory` và phải test trên DB v1 có sẵn data. Nếu migration hỏng, người dùng mất cây → mất luôn đường tới file Telegram. Để riêng ở Phase 5 (tùy chọn).

---

## Phase 2 — Xóa folder (đệ quy)

### Pure function (tách ra để test được sau này)

`src/utils/subtree.js`:

```js
collectSubtree(rootId, listChildren) -> { folders: [...], files: [...] }
```

BFS/DFS theo `parent`. Chỉ cần con cháu, mà con cháu luôn có `parent` → chạy được trên schema v1.

**`folders` BAO GỒM cả chính folder gốc `rootId`** (folder user bấm xóa), không chỉ con cháu.

### Luồng xóa

1. User bấm menu trên card folder → `collectSubtree` → đếm `n folder, m file`.
2. **Dialog xác nhận** nêu rõ số lượng và cảnh báo _xóa khỏi Saved Messages là không hoàn tác được_.
3. Hủy mọi upload job đang chạy/đang chờ trong cây con (`cancelUploads(recordIds)` của Phase 3). Không chặn thao tác xóa, mà hủy job.
4. Tính **hai tập id khác nhau, đừng lẫn**:
    - `messageIds = files.filter(f => f.file_id != null).map(f => f.file_id)` → **message id Telegram**. Bỏ file upload lỗi/đang dở vì chúng chưa có message nào trên Telegram.
    - `recordIds = [...folders.map(f => f.id), ...files.map(f => f.id)]` → **id record IndexedDB**, gồm _cả_ file chưa có `file_id` (nếu bỏ sót, chúng thành record mồ côi dưới một parent đã biến mất).
5. `await client.deleteMessages("me", messageIds, { revoke: true })` — GramJS tự chunk 100. Bỏ qua bước này nếu `messageIds` rỗng.
6. Chỉ khi bước 5 xong mới `deleteMany(recordIds)` trong IndexedDB. Thứ tự này đảm bảo: lỗi mạng → metadata còn nguyên, retry được. (Ngược lại sẽ tạo file mồ côi trên Telegram.)
7. `fetchData()`.

### Edge case bắt buộc xử lý

-   **`update()` của `react-indexed-db-hook` là `put` → upsert.** Nếu folder bị xóa trong lúc upload vào nó chưa xong, callback `update({...data, file_id})` ở `UploadFile.jsx:44` sẽ **hồi sinh record** dưới một parent không còn tồn tại → file mồ côi vĩnh viễn.
    **Cách xử lý đã chọn: trước mỗi `update` kiểm tra `getById(id)` còn tồn tại không; nếu không còn thì xóa message vừa upload trên Telegram thay vì ghi record lại.** Cộng thêm hủy job trong hàng đợi khi Phase 3 đã có — làm cả hai, vì job có thể đã gửi xong trước khi nhận tín hiệu hủy.

    > **Phase 2 phải tự an toàn, không đợi Phase 3.** Nếu Phase 2 lên trước, thêm thẳng bước kiểm tra `getById` vào đường upload đơn lẻ hiện tại (`UploadFile.jsx:44`). Hàng đợi ở Phase 3 sau đó dùng lại đúng bước kiểm tra này.

-   ~~Đang đứng _trong_ folder bị xóa → `navigate` về parent.~~ Không cần: menu xóa chỉ nằm trên card folder, mà card đó chỉ hiện khi ta đang ở folder **cha**. Không có đường nào trong UI để xóa chính folder mình đang đứng.
-   Folder rỗng → vẫn xóa bình thường, không gọi `deleteMessages` với mảng rỗng.

### UI

-   Bỏ comment nút `MoreVertIcon` trong `Folder.jsx`, thêm `Menu` có "Delete" (giống `File.jsx`).
-   **`onClick` của IconButton phải `e.stopPropagation()`** — nếu không, `onClick` của `Card` (`Folder.jsx:28`) sẽ navigate vào folder ngay khi bấm menu.
-   Tách `ConfirmDialog.jsx` dùng chung.

---

## Phase 3 — Upload nhiều file

### Hàng đợi có giới hạn (`src/utils/uploadQueue.js`)

-   Worker pool **concurrency 1–2**. Lý do: mỗi file bị nạp nguyên vào RAM (`uploads.ts:109`), chọn 10 file 500MB mà chạy song song là tab chết.
-   **Đọc file lazy _bên trong_ worker**, không chuẩn bị buffer trước cho cả hàng đợi.
-   **Gửi từng file một, không dùng album** — để mỗi file có message id riêng làm `file_id`.
-   API thực tế: `enqueueUpload({ops, file, parentID, name, onChange})` · `cancelUploads(ids)` (Phase 2 dùng) · `retryUpload(id)`.
-   Xử lý `FLOOD_WAIT_x`: bắt lỗi, chờ `x` giây, retry (tối đa 2–3 lần), rồi mới đánh `error`.

### Thay đổi UI/state

-   `UploadFile.jsx`: `<input multiple>` → `Array.from(e.target.file.files)` → tạo record + enqueue từng file.
-   `progressReducer`: thêm trạng thái `queued` / `error` bên cạnh `UPLOADING`/`DOWNLOADING`/`COMPLETED` (hiện `COMPLETED` xóa entry nên lỗi bị nuốt mất).
-   Thêm panel tổng "Đang tải lên x/y" + nút retry cho file lỗi.
-   File đang upload render dạng placeholder (chưa có `file_id` → chưa download/xóa được).

---

## Phase 4 — Upload nguyên folder

### Lấy input

-   `<input type="file" multiple webkitdirectory>` — **phải set như attribute** (`webkitdirectory=""` hoặc qua `ref`), React không nhận prop camelCase này.
-   Mỗi `File` có `webkitRelativePath` dạng `root/sub/a.txt`.
-   **`webkitdirectory` bỏ qua folder rỗng.** Nếu cần giữ folder rỗng → phải làm drag-and-drop với `DataTransferItem.webkitGetAsEntry()` (đề xuất: Phase 4b, không chặn Phase 4).

### Pure function

`src/utils/buildTreeFromPaths.js`:

```js
buildTreeFromPaths(files) -> { folders: [{tempId, name, parentTempId}], files: [{file, parentTempId}] }
```

Hoàn toàn thuần, không chạm DB → dễ test sau.

### Luồng thực thi

1. Build cây từ các `webkitRelativePath`.
2. Tạo folder **theo thứ tự trên xuống**, map `tempId → uuid thật`.
3. **Chính sách trùng tên:** nếu đã tồn tại folder cùng `(parent, name)` → **merge vào folder cũ** (không tạo bản sao). File trùng tên thì vẫn tạo record mới (Telegram không có khái niệm ghi đè).
4. Enqueue toàn bộ file vào đúng hàng đợi của Phase 3 với `parent` đã resolve.
5. Hiện preview trước khi chạy: "N file, M folder, tổng X MB" + cảnh báo nếu tổng dung lượng lớn.

> Phase 4 phụ thuộc Phase 3. Không làm song song.

---

## Phase 5 — Tùy chọn, làm sau cùng

-   Chuẩn hóa `parent: "root"` + bump DB version + `migrationFactory`. Phải test trên DB v1 có data thật trước khi merge.
-   Lưu thêm `size`, `mimeType`, `createdAt` vào record.
-   Export/import metadata ra JSON — bảo hiểm cho rủi ro lớn nhất của app: xóa dữ liệu trình duyệt là mất toàn bộ cây.

---

## Thứ tự thực thi & nhánh

| Thứ tự | Nhánh                              | Phụ thuộc |
| ------ | ---------------------------------- | --------- |
| 1      | `fix/base-bugs` (Phase 0)          | —         |
| 2      | `feat/file-repo` (Phase 1)         | Phase 0   |
| 3      | `feat/delete-folder` (Phase 2)     | Phase 1   |
| 4      | `feat/multi-file-upload` (Phase 3) | Phase 1   |
| 5      | `feat/folder-upload` (Phase 4)     | Phase 3   |

Phase 2 và 3 rốt cuộc nằm chung một commit: đường xóa phải gọi `cancelUploads` của hàng đợi, nên tách ra thì không commit nào build được.

---

## Kiểm thử

Repo không có test framework, nên mỗi PR phải chạy:

```bash
npm run lint && npm run prettier
```

(CI dùng `--max-warnings 0` và `--check`.)

Checklist thủ công:

**Xóa folder**

-   [ ] Folder rỗng → biến mất, không gọi API Telegram
-   [ ] Folder lồng 3 cấp có file → cả cây biến mất; mở Saved Messages xác nhận file đã mất
-   [ ] Bấm nút menu không bị navigate vào folder
-   [ ] Xóa folder trong lúc file trong đó đang upload → không sót record mồ côi, và message vừa lên cũng bị gỡ
-   [ ] Tắt mạng rồi xóa → báo lỗi, metadata còn nguyên, retry được
-   [ ] Xóa folder trong lúc file đang upload vào đó → không sót record mồ côi

**Upload nhiều file**

-   [ ] Chọn 5 file → cả 5 hiện ngay, progress riêng từng file
-   [ ] Tối đa 2 file chạy cùng lúc
-   [ ] Rút mạng giữa chừng → file đó `error`, các file khác không bị kéo theo
-   [ ] Download lại từng file, đúng nội dung và **đúng tên**

**Upload folder**

-   [ ] Folder lồng nhiều cấp → cấu trúc khớp hệt bên máy
-   [ ] Upload lại cùng folder đó → merge, không nhân đôi folder
-   [ ] Folder rỗng bị bỏ qua (hành vi đã biết của `webkitdirectory`)

---

## Rủi ro

| Rủi ro                                       | Mức             | Giảm thiểu                                          |
| -------------------------------------------- | --------------- | --------------------------------------------------- |
| Xóa nhầm → không hoàn tác được trên Telegram | Cao             | Dialog xác nhận có số lượng cụ thể                  |
| Hết RAM khi upload folder lớn                | Cao             | Concurrency 1–2, đọc file lazy, cảnh báo dung lượng |
| Record mồ côi do `put` upsert sau khi xóa    | Trung bình      | Hủy job + kiểm tra tồn tại trước `update`           |
| FLOOD_WAIT khi upload hàng loạt              | Trung bình      | Backoff + retry                                     |
| Mất IndexedDB = mất toàn bộ cây              | Cao (đã có sẵn) | Phase 5: export metadata                            |

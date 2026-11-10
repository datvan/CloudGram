import { useEffect, useState } from "react";
import PropTypes from "prop-types";

import {
    Box,
    Button,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    Typography,
} from "@mui/material";

import { LOCAL_HELPER } from "../../config/features";
import { helperStatus, splitWithHelper } from "../../services/splitHelper";
import { formatSize } from "../../utils/format";
import {
    FREE_MAX,
    isVideoName,
    pieceBytes,
    pieceCount,
    splitCommand,
} from "../../utils/splitPlan";
import { probeVideo } from "../../utils/thumbnails";

const SHOWN = 5;

const INSTALL = {
    win32: "winget install Gyan.FFmpeg",
    darwin: "brew install ffmpeg",
};
const STAGE = {
    sending: "Đang gửi tệp cho chương trình hỗ trợ...",
    cutting: "Đang cắt video (giữ nguyên chất lượng)...",
};

/**
 * Cuts one video with the local helper and queues the pieces. The helper is
 * looked for when this opens; every other state says what to do next.
 */
function AutoCut({ item, limit, onSend }) {
    // undefined while looking, null when the helper is not running
    const [status, setStatus] = useState(undefined);
    const [busy, setBusy] = useState("");
    const [error, setError] = useState("");
    const [sent, setSent] = useState(0);

    const check = () => {
        setStatus(undefined);
        helperStatus().then(setStatus);
    };
    useEffect(() => {
        let live = true;
        helperStatus().then((now) => live && setStatus(now));
        return () => {
            live = false;
        };
    }, []);

    const cut = async () => {
        setError("");
        setBusy(STAGE.sending);
        try {
            const files = await splitWithHelper(
                item.file,
                limit,
                (stage, n, total) =>
                    setBusy(
                        stage === "fetching"
                            ? `Đang lấy phần ${n}/${total} từ chương trình hỗ trợ...`
                            : STAGE[stage],
                    ),
            );
            if (onSend(item, files)) setSent(files.length);
            else setError("Đang có lượt tải lên khác, đợi xong rồi bấm lại.");
        } catch (err) {
            setError(err.message);
        }
        setBusy("");
    };

    const text = { variant: "body2", color: "text.secondary" };
    let body;
    if (sent)
        body = (
            <Typography {...text}>
                Đã cắt thành {sent} phần và đưa vào hàng chờ tải lên.{" "}
                {item.removeOriginal && item.handle
                    ? "Khi tất cả các phần đã tải lên xong, tệp gốc sẽ được xoá khỏi máy như bạn đã chọn."
                    : "Tệp gốc vẫn còn nguyên trên máy."}
            </Typography>
        );
    else if (status === undefined)
        body = (
            <Typography {...text}>Đang tìm chương trình hỗ trợ...</Typography>
        );
    else if (status === null)
        body = (
            <>
                <Typography {...text}>
                    Muốn web tự cắt và tải lên? Tải{" "}
                    <a href="/helper/cloudgram-helper.mjs" download>
                        cloudgram-helper.mjs
                    </a>
                    , mở Terminal tại thư mục chứa nó rồi chạy{" "}
                    <code>node cloudgram-helper.mjs</code> (cần Node.js). Giữ
                    cửa sổ đó mở, rồi bấm Kiểm tra lại.
                </Typography>
                <Button size="small" onClick={check}>
                    Kiểm tra lại
                </Button>
            </>
        );
    else if (!status.ffmpeg || !status.ffprobe)
        body = (
            <>
                <Typography {...text}>
                    Chương trình hỗ trợ đang chạy nhưng máy chưa có ffmpeg. Cài
                    bằng lệnh{" "}
                    <code>
                        {INSTALL[status.platform] ?? "sudo apt install ffmpeg"}
                    </code>
                    , rồi bấm Kiểm tra lại.
                </Typography>
                <Button size="small" onClick={check}>
                    Kiểm tra lại
                </Button>
            </>
        );
    else
        body = (
            <>
                <Typography {...text}>
                    ffmpeg đã sẵn sàng. Web sẽ cắt rồi tự tải các phần lên, cần
                    thêm chỗ trống trên ổ đĩa bằng khoảng 2 lần dung lượng tệp.
                </Typography>
                <Button
                    size="small"
                    variant="contained"
                    onClick={cut}
                    disabled={Boolean(busy)}
                >
                    Tự cắt và tải lên
                </Button>
            </>
        );
    return (
        <Box sx={{ mt: 1 }}>
            {body}
            {busy && <Typography variant="body2">{busy}</Typography>}
            {error && (
                <Typography variant="body2" color="error">
                    {error}
                </Typography>
            )}
        </Box>
    );
}

function Row({ item, limit, onSend }) {
    const video = isVideoName(item.name);
    // undefined while the length is being read, null when it cannot be
    const [duration, setDuration] = useState(video ? undefined : null);
    const [copied, setCopied] = useState(false);
    const [again, setAgain] = useState(false);

    useEffect(() => {
        if (!video) return undefined;
        let live = true;
        probeVideo(item.file)
            .then((info) => info?.duration ?? null)
            .catch(() => null)
            .then((seconds) => live && setDuration(seconds));
        return () => {
            live = false;
        };
    }, [item.file, video]);

    const command = splitCommand(item.name, item.size, limit, duration);
    const ratio = Math.floor((pieceBytes(limit) / item.size) * 100) / 100;
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(command);
            setCopied(true);
        } catch {
            // no clipboard here: the command can still be selected by hand
        }
    };

    if (item.parts > 0 && !again)
        return (
            <Box sx={{ mb: 2 }}>
                <Typography variant="body2" sx={{ fontWeight: 500 }}>
                    {item.name} ({formatSize(item.size)})
                </Typography>
                <Typography variant="body2" color="text.secondary">
                    Thư mục này đã có {item.parts} phần của tệp này (
                    {item.name.replace(/\.[^.]+$/, "")}.part001...), không cần
                    cắt và tải lại.
                </Typography>
                <Button size="small" onClick={() => setAgain(true)}>
                    Vẫn muốn cắt lại
                </Button>
            </Box>
        );

    return (
        <Box sx={{ mb: 2 }}>
            <Typography variant="body2" sx={{ fontWeight: 500 }}>
                {item.name} ({formatSize(item.size)})
            </Typography>
            {video && LOCAL_HELPER && (
                <AutoCut item={item} limit={limit} onSend={onSend} />
            )}
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                {video && LOCAL_HELPER ? "Hoặc tự làm: " : ""}
                {video
                    ? `Cắt thành khoảng ${pieceCount(
                          item.size,
                          limit,
                      )} video, giữ nguyên chất lượng (không mã hoá lại). Cần cài sẵn ffmpeg. Mở cửa sổ lệnh (Terminal) tại thư mục chứa tệp, dán lệnh dưới đây, rồi tải các tệp .part001.mp4, .part002.mp4... lên.`
                    : `Không phải video, nên nén thành nhiều phần bằng 7-Zip (khoảng ${pieceCount(
                          item.size,
                          limit,
                      )} phần). Mở cửa sổ lệnh tại thư mục chứa tệp, dán lệnh dưới đây, rồi tải các tệp .7z.001, .7z.002... lên.`}
            </Typography>
            <Box
                component="pre"
                sx={{
                    m: 0,
                    mt: 1,
                    p: 1,
                    borderRadius: 1,
                    bgcolor: "action.hover",
                    fontSize: 12,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-all",
                }}
            >
                {command}
            </Box>
            {video && duration === null && (
                <Typography variant="caption" color="text.secondary">
                    Chưa đọc được thời lượng video. Thay &lt;số giây&gt; bằng
                    thời lượng video tính bằng giây nhân với {ratio}.
                </Typography>
            )}
            <Box>
                <Button
                    size="small"
                    onClick={copy}
                    disabled={video && duration === undefined}
                >
                    {copied ? "Đã chép" : "Chép lệnh"}
                </Button>
            </Box>
        </Box>
    );
}

/**
 * Files bigger than Telegram takes in one piece: they are not uploaded, and
 * this says how to cut them. See uploadEntries (driveActions.js).
 */
export default function OversizeDialog({ files, limit, onClose, onSend }) {
    const list = files ?? [];
    return (
        <Dialog
            open={list.length > 0}
            onClose={onClose}
            maxWidth="sm"
            fullWidth
        >
            <DialogTitle>
                {list.length === 1
                    ? "Tệp này quá lớn để tải lên Telegram"
                    : `${list.length} tệp quá lớn để tải lên Telegram`}
            </DialogTitle>
            <DialogContent>
                <Typography variant="body2" sx={{ mb: 2 }}>
                    Giới hạn của tài khoản này là {formatSize(limit ?? 0)} mỗi
                    tệp
                    {limit === FREE_MAX ? " (chưa có Telegram Premium)" : ""}.
                    Các tệp dưới đây chưa được tải lên; những tệp còn lại vẫn
                    tải bình thường.
                </Typography>
                {list.slice(0, SHOWN).map((item, i) => (
                    <Row
                        key={`${i}:${item.name}`}
                        item={item}
                        limit={limit}
                        onSend={onSend}
                    />
                ))}
                {list.length > SHOWN && (
                    <Typography variant="body2">
                        và {list.length - SHOWN} tệp khác, làm tương tự.
                    </Typography>
                )}
            </DialogContent>
            <DialogActions>
                <Button onClick={onClose}>Đóng</Button>
            </DialogActions>
        </Dialog>
    );
}

Row.propTypes = {
    item: PropTypes.shape({
        name: PropTypes.string,
        size: PropTypes.number,
        file: PropTypes.object,
        parts: PropTypes.number,
    }),
    limit: PropTypes.number,
    onSend: PropTypes.func,
};

AutoCut.propTypes = {
    item: PropTypes.object,
    limit: PropTypes.number,
    onSend: PropTypes.func,
};

OversizeDialog.propTypes = {
    files: PropTypes.array,
    limit: PropTypes.number,
    onClose: PropTypes.func,
    onSend: PropTypes.func,
};

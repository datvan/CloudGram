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

function Row({ item, limit }) {
    const video = isVideoName(item.name);
    // undefined while the length is being read, null when it cannot be
    const [duration, setDuration] = useState(video ? undefined : null);
    const [copied, setCopied] = useState(false);

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

    return (
        <Box sx={{ mb: 2 }}>
            <Typography variant="body2" sx={{ fontWeight: 500 }}>
                {item.name} ({formatSize(item.size)})
            </Typography>
            <Typography variant="body2" color="text.secondary">
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
export default function OversizeDialog({ files, limit, onClose }) {
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
                    <Row key={`${i}:${item.name}`} item={item} limit={limit} />
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
    }),
    limit: PropTypes.number,
};

OversizeDialog.propTypes = {
    files: PropTypes.array,
    limit: PropTypes.number,
    onClose: PropTypes.func,
};

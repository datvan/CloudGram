import { useEffect, useState } from "react";
import PropTypes from "prop-types";

import {
    Alert,
    Box,
    Button,
    Checkbox,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    FormControlLabel,
    IconButton,
    LinearProgress,
    Stack,
    TextField,
    Tooltip,
    Typography,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import CloseIcon from "@mui/icons-material/Close";

import {
    cancelImport,
    clearFinished,
    isDropboxLink,
    startImport,
    useImports,
} from "../../services/dropboxImport";
import { formatSize } from "../../utils/format";

// the same preference as UploadModeDialog, so both remember one choice
const COMPRESS_KEY = "cloudgram.compressMedia";

function loadCompress() {
    try {
        return localStorage.getItem(COMPRESS_KEY) !== "0";
    } catch {
        return true;
    }
}

function JobRow({ job }) {
    const fraction = job.total ? job.received / job.total : null;
    const status = {
        waiting: "Đang chờ…",
        working: job.total
            ? `Đang tải ${formatSize(job.received)} / ${formatSize(job.total)}`
            : `Đang tải ${formatSize(job.received)}`,
        done: "Đã tải xong từ Dropbox",
        error: job.error,
        cancelled: "Đã dừng",
    }[job.status];
    const skipped = job.skipped.length;
    return (
        <Box sx={{ py: 1 }}>
            <Stack direction="row" alignItems="center" spacing={1}>
                <Typography
                    variant="body2"
                    sx={{ flex: 1, fontWeight: 500, wordBreak: "break-all" }}
                >
                    {job.name || job.link}
                </Typography>
                {(job.status === "waiting" || job.status === "working") && (
                    <Button
                        size="small"
                        color="inherit"
                        onClick={() => cancelImport(job.id)}
                    >
                        Dừng
                    </Button>
                )}
            </Stack>
            {job.status === "working" && (
                <LinearProgress
                    variant={
                        fraction === null ? "indeterminate" : "determinate"
                    }
                    value={(fraction ?? 0) * 100}
                    sx={{ my: 0.5 }}
                />
            )}
            <Typography
                variant="caption"
                color={job.status === "error" ? "error" : "text.secondary"}
                component="div"
            >
                {status}
                {job.files > 0 && ` · ${job.files} tệp đã vào hàng đợi tải lên`}
                {skipped > 0 && ` · bỏ qua ${skipped} tệp`}
            </Typography>
            {skipped > 0 && (
                <Typography
                    variant="caption"
                    color="text.secondary"
                    component="div"
                    sx={{ wordBreak: "break-all" }}
                >
                    {job.skipped
                        .slice(0, 5)
                        .map((s) => `${s.name} (${s.reason})`)
                        .join(", ")}
                    {skipped > 5 && `, và ${skipped - 5} tệp khác`}
                </Typography>
            )}
        </Box>
    );
}

JobRow.propTypes = { job: PropTypes.object.isRequired };

/**
 * Paste one or more Dropbox shared links (a file or a whole folder) and copy
 * them into the current folder, keeping Dropbox's folder structure.
 */
export default function DropboxDialog({ open, targetName, target, onClose }) {
    const jobs = useImports();
    const [links, setLinks] = useState([""]);
    const [compress, setCompress] = useState(loadCompress);
    const [touched, setTouched] = useState(false);

    useEffect(() => {
        if (open) {
            setLinks([""]);
            setTouched(false);
            setCompress(loadCompress());
        }
    }, [open]);

    const filled = links.map((l) => l.trim()).filter(Boolean);
    const invalid = links.map((l) => l.trim() !== "" && !isDropboxLink(l));
    const canStart = filled.length > 0 && !invalid.some(Boolean);

    function setLink(index, value) {
        // several links pasted at once fill several boxes; a one-line input
        // drops the line breaks, so a new "https://" also starts a link
        const parts = value.split(/\s+|(?=https?:\/\/)/).filter(Boolean);
        setLinks((current) => {
            const next = [...current];
            if (parts.length > 1) next.splice(index, 1, ...parts);
            else next[index] = value;
            return next;
        });
    }

    function start() {
        setTouched(true);
        if (!canStart) return;
        try {
            localStorage.setItem(COMPRESS_KEY, compress ? "1" : "0");
        } catch {
            // private mode; the choice just is not remembered
        }
        startImport(filled, target, { asMedia: compress });
        setLinks([""]);
        setTouched(false);
    }

    const finished = jobs.some(
        (j) => j.status !== "waiting" && j.status !== "working",
    );

    return (
        <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
            <DialogTitle>Nhập từ Dropbox</DialogTitle>
            <DialogContent>
                <Typography
                    variant="body2"
                    color="text.secondary"
                    sx={{ mb: 2 }}
                >
                    Dán link chia sẻ Dropbox của một tệp hoặc cả thư mục. Thư
                    mục được tạo lại đúng cấu trúc trong {targetName}. Tệp đi
                    thẳng từ Dropbox qua trình duyệt này lên Telegram, nên cần
                    giữ tab mở đến khi xong.
                </Typography>
                <Stack spacing={1}>
                    {links.map((link, index) => (
                        <Stack
                            key={index}
                            direction="row"
                            spacing={1}
                            alignItems="flex-start"
                        >
                            <TextField
                                fullWidth
                                size="small"
                                autoFocus={index === links.length - 1}
                                placeholder="https://www.dropbox.com/scl/fo/…"
                                value={link}
                                onChange={(e) => setLink(index, e.target.value)}
                                onPaste={(e) => {
                                    const text =
                                        e.clipboardData.getData("text");
                                    if (!/\s/.test(text.trim())) return;
                                    e.preventDefault();
                                    setLink(index, link + text);
                                }}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter") start();
                                }}
                                error={
                                    invalid[index] &&
                                    (touched || link.length > 20)
                                }
                                helperText={
                                    invalid[index] &&
                                    (touched || link.length > 20)
                                        ? "Không phải link chia sẻ Dropbox."
                                        : undefined
                                }
                            />
                            <Tooltip title="Bỏ link này">
                                <span>
                                    <IconButton
                                        onClick={() =>
                                            setLinks((current) =>
                                                current.length > 1
                                                    ? current.filter(
                                                          (_, i) => i !== index,
                                                      )
                                                    : [""],
                                            )
                                        }
                                        disabled={links.length === 1 && !link}
                                    >
                                        <CloseIcon fontSize="small" />
                                    </IconButton>
                                </span>
                            </Tooltip>
                        </Stack>
                    ))}
                </Stack>
                <Button
                    startIcon={<AddIcon />}
                    onClick={() => setLinks((current) => [...current, ""])}
                    sx={{ mt: 1 }}
                >
                    Thêm link
                </Button>
                <FormControlLabel
                    sx={{ display: "flex", mt: 1 }}
                    control={
                        <Checkbox
                            checked={compress}
                            onChange={(e) => setCompress(e.target.checked)}
                        />
                    }
                    label="Nén ảnh và video (gửi dạng media như Telegram)"
                />
                <Typography variant="caption" color="text.secondary">
                    {compress
                        ? "Ảnh dưới 10 MB và video MP4 được Telegram nén; tệp khác giữ nguyên."
                        : "Mọi tệp giữ nguyên bản gốc từng byte."}{" "}
                    Tệp đã có cùng tên và dung lượng trong thư mục sẽ được bỏ
                    qua, nên chạy lại một link bị ngắt giữa chừng không tạo bản
                    trùng.
                </Typography>

                {jobs.length > 0 && (
                    <Box sx={{ mt: 2 }}>
                        <Typography variant="subtitle2">Tiến trình</Typography>
                        {jobs.map((job) => (
                            <JobRow key={job.id} job={job} />
                        ))}
                        {jobs.some((j) => j.status === "error") && (
                            <Alert severity="info" sx={{ mt: 1 }}>
                                Link lỗi có thể chạy lại: tệp đã tải lên sẽ được
                                bỏ qua.
                            </Alert>
                        )}
                    </Box>
                )}
            </DialogContent>
            <DialogActions>
                {finished && (
                    <Button onClick={clearFinished} sx={{ mr: "auto" }}>
                        Xoá mục đã xong
                    </Button>
                )}
                <Button onClick={onClose}>Đóng</Button>
                <Button
                    variant="contained"
                    onClick={start}
                    disabled={!filled.length}
                >
                    Bắt đầu
                </Button>
            </DialogActions>
        </Dialog>
    );
}

DropboxDialog.propTypes = {
    open: PropTypes.bool,
    target: PropTypes.string,
    targetName: PropTypes.string,
    onClose: PropTypes.func,
};

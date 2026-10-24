import { useEffect, useState } from "react";
import PropTypes from "prop-types";

import {
    Alert,
    Box,
    Button,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    FormControlLabel,
    IconButton,
    InputAdornment,
    LinearProgress,
    Radio,
    RadioGroup,
    TextField,
    Tooltip,
    Typography,
} from "@mui/material";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";

import { getRecord, useDrive } from "../../services/drive";
import { describeError } from "../../services/api";
import {
    createShare,
    isExpired,
    revokeShare,
    shareLink,
} from "../../services/shares";
import { formatDateTime, formatSize } from "../../utils/format";

const MAX_BYTES = 2 * 1024 * 1024 * 1024;
const PRESETS = [
    { value: "forever", label: "Không bao giờ hết hạn" },
    { value: "1", label: "1 ngày" },
    { value: "7", label: "7 ngày" },
    { value: "30", label: "30 ngày" },
    { value: "custom", label: "Tuỳ chọn số ngày" },
];

function expiryText(share) {
    if (!share.expiresAt) return "Link không bao giờ hết hạn.";
    return isExpired(share)
        ? `Link đã hết hạn lúc ${formatDateTime(share.expiresAt)}.`
        : `Link hết hạn lúc ${formatDateTime(share.expiresAt)}.`;
}

/**
 * Public link for one file. Making one copies the file, encrypted, to the
 * VPS; the dialog shows the existing link when there is one.
 */
export default function ShareDialog({ open, id, onClose, onNotice }) {
    useDrive(); // re-render when the record gains or loses its link
    const record = id ? getRecord(id) : undefined;
    const share = record?.share;

    const [preset, setPreset] = useState("7");
    const [customDays, setCustomDays] = useState("14");
    const [work, setWork] = useState(null); // { stage, fraction }
    const [error, setError] = useState("");
    const [replacing, setReplacing] = useState(false);

    useEffect(() => {
        if (open) {
            setWork(null);
            setError("");
            setReplacing(false);
        }
    }, [open, id]);

    if (!record) return null;

    const days =
        preset === "forever"
            ? null
            : preset === "custom"
            ? Number(customDays)
            : Number(preset);
    const daysValid =
        days === null || (Number.isInteger(days) && days >= 1 && days <= 3650);
    const tooBig = (record.size ?? 0) > MAX_BYTES;
    const busy = Boolean(work);
    const choosing = !share || replacing;

    async function make() {
        setError("");
        setWork({ stage: "download", fraction: 0 });
        try {
            await createShare(record, days, (stage, fraction) =>
                setWork({ stage, fraction }),
            );
            setReplacing(false);
        } catch (e) {
            setError(describeError(e));
        }
        setWork(null);
    }

    async function remove() {
        setError("");
        setWork({ stage: "remove", fraction: null });
        try {
            await revokeShare(record);
            onNotice?.("Đã xoá link chia sẻ.");
        } catch (e) {
            setError(describeError(e));
        }
        setWork(null);
    }

    async function copy() {
        try {
            await navigator.clipboard.writeText(shareLink(share));
            onNotice?.("Đã sao chép link.");
        } catch {
            setError("Không sao chép được, hãy chọn link và sao chép tay.");
        }
    }

    const progressLabel = {
        download: "Đang lấy tệp từ Telegram…",
        upload: "Đang mã hoá và tải lên máy chủ…",
        remove: "Đang xoá link…",
    }[work?.stage];

    return (
        <Dialog
            open={open}
            onClose={busy ? undefined : onClose}
            maxWidth="sm"
            fullWidth
        >
            <DialogTitle sx={{ wordBreak: "break-word" }}>
                Chia sẻ “{record.name}”
            </DialogTitle>
            <DialogContent>
                {share && !replacing && (
                    <Box sx={{ mb: 1 }}>
                        <TextField
                            fullWidth
                            size="small"
                            value={shareLink(share)}
                            onFocus={(e) => e.target.select()}
                            disabled={isExpired(share)}
                            InputProps={{
                                readOnly: true,
                                endAdornment: (
                                    <InputAdornment position="end">
                                        <Tooltip title="Sao chép link">
                                            <span>
                                                <IconButton
                                                    edge="end"
                                                    onClick={copy}
                                                    disabled={isExpired(share)}
                                                >
                                                    <ContentCopyIcon fontSize="small" />
                                                </IconButton>
                                            </span>
                                        </Tooltip>
                                    </InputAdornment>
                                ),
                            }}
                        />
                        <Typography
                            variant="body2"
                            color={
                                isExpired(share) ? "error" : "text.secondary"
                            }
                            sx={{ mt: 1 }}
                        >
                            {expiryText(share)} Ai có link đều tải được tệp,
                            không cần tài khoản.
                        </Typography>
                    </Box>
                )}

                {choosing && (
                    <>
                        <Typography variant="body2" color="text.secondary">
                            Ai có link đều tải được tệp mà không cần tài khoản.
                            Một bản sao mã hoá ({formatSize(record.size ?? 0)})
                            được lưu trên máy chủ CloudGram; khoá giải mã chỉ
                            nằm trong link nên máy chủ không đọc được. Khi link
                            hết hạn hoặc bị xoá, bản sao bị xoá theo.
                        </Typography>
                        <Typography variant="subtitle2" sx={{ mt: 2 }}>
                            Thời hạn của link
                        </Typography>
                        <RadioGroup
                            value={preset}
                            onChange={(e) => setPreset(e.target.value)}
                        >
                            {PRESETS.map((p) => (
                                <FormControlLabel
                                    key={p.value}
                                    value={p.value}
                                    control={<Radio size="small" />}
                                    label={p.label}
                                    disabled={busy}
                                />
                            ))}
                        </RadioGroup>
                        {preset === "custom" && (
                            <TextField
                                size="small"
                                type="number"
                                label="Số ngày"
                                value={customDays}
                                onChange={(e) => setCustomDays(e.target.value)}
                                inputProps={{ min: 1, max: 3650 }}
                                error={!daysValid}
                                helperText={
                                    daysValid ? " " : "Từ 1 đến 3650 ngày."
                                }
                                disabled={busy}
                                sx={{ ml: 4, width: 160 }}
                            />
                        )}
                        {tooBig && (
                            <Alert severity="warning" sx={{ mt: 1 }}>
                                Tệp lớn hơn 2 GB, không chia sẻ được.
                            </Alert>
                        )}
                    </>
                )}

                {busy && (
                    <Box sx={{ mt: 2 }}>
                        <Typography variant="body2" sx={{ mb: 0.5 }}>
                            {progressLabel}
                        </Typography>
                        <LinearProgress
                            variant={
                                work.stage === "upload"
                                    ? "determinate"
                                    : "indeterminate"
                            }
                            value={(work.fraction ?? 0) * 100}
                        />
                    </Box>
                )}
                {error && (
                    <Alert severity="error" sx={{ mt: 2 }}>
                        {error}
                    </Alert>
                )}
            </DialogContent>
            <DialogActions>
                {share && !replacing && (
                    <>
                        <Button color="error" onClick={remove} disabled={busy}>
                            Xoá link
                        </Button>
                        <Box sx={{ flex: 1 }} />
                        <Button
                            onClick={() => setReplacing(true)}
                            disabled={busy || tooBig}
                        >
                            Tạo link mới
                        </Button>
                        <Button variant="contained" onClick={onClose}>
                            Xong
                        </Button>
                    </>
                )}
                {choosing && (
                    <>
                        <Button
                            onClick={
                                replacing ? () => setReplacing(false) : onClose
                            }
                            disabled={busy}
                        >
                            Huỷ
                        </Button>
                        <Button
                            variant="contained"
                            onClick={make}
                            disabled={busy || !daysValid || tooBig}
                        >
                            {replacing ? "Thay link" : "Tạo link"}
                        </Button>
                    </>
                )}
            </DialogActions>
        </Dialog>
    );
}

ShareDialog.propTypes = {
    open: PropTypes.bool,
    id: PropTypes.string,
    onClose: PropTypes.func,
    onNotice: PropTypes.func,
};

import { useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import {
    Alert,
    Button,
    Checkbox,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    FormControlLabel,
    LinearProgress,
    Typography,
} from "@mui/material";
import { getSnapshot, useDrive } from "../../services/drive";
import { migrateToShared } from "../../services/migrateShared";
import { describeError } from "../../services/api";

const message = (error) =>
    error?.code === "uploads_busy"
        ? error.message
        : (error?.code ?? error?.message) === "telegram_not_linked"
        ? "Máy chủ chưa liên kết Telegram chung, hãy báo quản trị viên."
        : describeError(error);

export default function MigrateSharedDialog({ onClose, required = false }) {
    const { records } = useDrive();
    const [deleteOriginal, setDeleteOriginal] = useState(false);
    const [state, setState] = useState("confirm");
    const [progress, setProgress] = useState(null);
    const [failures, setFailures] = useState([]);
    const [error, setError] = useState(null);
    const controller = useRef(null);
    useEffect(() => () => controller.current?.abort(), []);

    async function start() {
        const abort = new AbortController();
        controller.current = abort;
        const names = new Map(getSnapshot().records.map((r) => [r.id, r.name]));
        setState("running");
        setProgress(null);
        setError(null);
        setFailures([]);
        try {
            const result = await migrateToShared({
                deleteOriginal,
                signal: abort.signal,
                onProgress: setProgress,
            });
            setFailures(
                result.failed.map((f) => ({
                    ...f,
                    name: names.get(f.id) ?? f.id,
                })),
            );
            if (result.failed.length) setState("failed");
            else window.location.reload();
        } catch (e) {
            if (abort.signal.aborted) setState("paused");
            else {
                setError(message(e));
                setState("failed");
            }
        } finally {
            controller.current = null;
        }
    }

    const files = records.filter((r) => r.type === "file" && !r.deleted);
    const done = files.filter((r) => r.tg === "shared").length;
    const blocking = required || done > 0;
    const current = files.find((r) => r.id === progress?.id);
    const percentage = Math.max(
        0,
        Math.min(100, Math.round(progress?.percentage ?? 0)),
    );
    return (
        <Dialog
            open
            onClose={state === "running" || blocking ? undefined : onClose}
            fullWidth
            maxWidth="sm"
        >
            <DialogTitle>Chuyển sang Telegram chung</DialogTitle>
            <DialogContent>
                {state === "confirm" && (
                    <>
                        <Typography>
                            {required
                                ? "Việc chuyển sang Telegram chung chưa xong. Cần chuyển nốt trước khi dùng tiếp."
                                : "Mọi file sẽ được tải về, mã hoá và chuyển sang Telegram chung. Trong lúc chuyển hãy giữ tab mở. Tài khoản chỉ chuyển hẳn khi mọi file đã xong."}
                        </Typography>
                        <FormControlLabel
                            control={
                                <Checkbox
                                    checked={deleteOriginal}
                                    onChange={(e) =>
                                        setDeleteOriginal(e.target.checked)
                                    }
                                />
                            }
                            label="Xoá bản gốc trong Telegram riêng sau khi chuyển"
                        />
                    </>
                )}
                {state === "running" && (
                    <>
                        <Typography>
                            Đã chuyển {done}/{files.length} file
                        </Typography>
                        {current && (
                            <Typography>
                                {current.name} —{" "}
                                {progress.phase === "read"
                                    ? "Đang tải về"
                                    : "Đang mã hoá và tải lên"}
                                : {percentage}%
                            </Typography>
                        )}
                        <LinearProgress
                            variant={current ? "determinate" : "indeterminate"}
                            value={percentage}
                        />
                    </>
                )}
                {state === "paused" && (
                    <Alert severity="info">
                        Đã tạm dừng. Các file đã chuyển vẫn được giữ lại.
                    </Alert>
                )}
                {state === "success" && (
                    <Alert severity="success">
                        Đã chuyển sang Telegram chung
                    </Alert>
                )}
                {error && <Alert severity="error">{error}</Alert>}
                {failures.map((failure) => (
                    <Alert severity="error" key={failure.id}>
                        {failure.name}: {message({ message: failure.message })}
                    </Alert>
                ))}
            </DialogContent>
            <DialogActions>
                {state === "running" ? (
                    <Button onClick={() => controller.current?.abort()}>
                        Tạm dừng
                    </Button>
                ) : !blocking ? (
                    <Button onClick={onClose}>
                        {state === "confirm" ? "Huỷ" : "Đóng"}
                    </Button>
                ) : null}
                {state === "confirm" && (
                    <Button onClick={start}>
                        {required ? "Tiếp tục chuyển" : "Bắt đầu chuyển"}
                    </Button>
                )}
                {(state === "failed" || state === "paused") && (
                    <Button onClick={start}>
                        {state === "paused" ? "Tiếp tục chuyển" : "Thử lại"}
                    </Button>
                )}
            </DialogActions>
        </Dialog>
    );
}

MigrateSharedDialog.propTypes = {
    onClose: PropTypes.func.isRequired,
    required: PropTypes.bool,
};

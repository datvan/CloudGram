import { useEffect, useState } from "react";
import { useDispatch, useSelector } from "react-redux";

import {
    Box,
    CircularProgress,
    IconButton,
    Paper,
    Stack,
    Tooltip,
    Typography,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import ErrorIcon from "@mui/icons-material/Error";
import ReplayIcon from "@mui/icons-material/Replay";
import ScheduleIcon from "@mui/icons-material/Schedule";

import { FileIcon } from "./FileIcon";
import { getRecord } from "../../services/drive";
import { clearFinished } from "../../redux/actions/progressAction";
import { retryUpload } from "../../utils/uploadQueue";

/**
 * Drive's bottom-right transfer card. A folder upload can put hundreds of
 * entries in flight, most of them scrolled out of view in the file list, so
 * this is what answers "is it done yet".
 */
export default function TransferPanel() {
    const dispatch = useDispatch();
    const active = useSelector((state) => state.progress.activeProgress);
    const finished = useSelector((state) => state.progress.finished);
    const [collapsed, setCollapsed] = useState(false);
    const [hidden, setHidden] = useState(false);

    // a new transfer brings the panel back after it was closed
    useEffect(() => {
        if (active.length) setHidden(false);
    }, [active.length]);

    if (hidden || (!active.length && !finished.length)) return null;

    const running = active.filter((p) => p.type !== "ERROR");
    const failed = active.filter((p) => p.type === "ERROR");
    const uploading = running.filter((p) => p.direction !== "down").length;
    const downloading = running.length - uploading;
    const title = running.length
        ? [
              uploading && `Đang tải lên ${uploading} mục`,
              downloading && `Đang tải xuống ${downloading} mục`,
          ]
              .filter(Boolean)
              .join(", ")
        : failed.length
        ? `${failed.length} mục không thành công`
        : `Đã xong ${finished.length} mục`;

    const nameOf = (entry) => entry.name ?? getRecord(entry.id)?.name ?? "Tệp";

    function close() {
        if (running.length) {
            setCollapsed(true);
            return;
        }
        dispatch(clearFinished());
        setHidden(true);
    }

    const rows = [...active, ...finished.map((f) => ({ ...f, type: "DONE" }))];

    return (
        <Paper
            elevation={8}
            sx={{
                position: "fixed",
                right: { xs: 8, sm: 24 },
                bottom: 0,
                width: { xs: "calc(100% - 16px)", sm: 360 },
                borderRadius: "16px 16px 0 0",
                overflow: "hidden",
                zIndex: 1200,
            }}
        >
            <Stack
                direction="row"
                alignItems="center"
                sx={{
                    pl: 2.5,
                    pr: 1,
                    height: 52,
                    bgcolor: (t) =>
                        t.palette.mode === "light" ? "#f0f4f9" : "#282a2c",
                }}
            >
                <Typography fontWeight={500} sx={{ flex: 1 }} noWrap>
                    {title}
                </Typography>
                <IconButton
                    onClick={() => setCollapsed(!collapsed)}
                    aria-label={collapsed ? "Mở rộng" : "Thu gọn"}
                >
                    {collapsed ? <ExpandLessIcon /> : <ExpandMoreIcon />}
                </IconButton>
                <IconButton onClick={close} aria-label="Đóng">
                    <CloseIcon />
                </IconButton>
            </Stack>
            {!collapsed && (
                <Box sx={{ maxHeight: 280, overflow: "auto" }}>
                    {rows.map((entry) => (
                        <Stack
                            key={entry.id}
                            direction="row"
                            alignItems="center"
                            spacing={1.5}
                            sx={{ px: 2.5, py: 1 }}
                        >
                            <FileIcon
                                record={{ type: "file", name: nameOf(entry) }}
                            />
                            <Typography
                                variant="body2"
                                noWrap
                                sx={{ flex: 1 }}
                                title={nameOf(entry)}
                            >
                                {nameOf(entry)}
                            </Typography>
                            {entry.type === "DONE" && (
                                <CheckCircleIcon
                                    sx={{ color: "#1e8e3e" }}
                                    fontSize="small"
                                />
                            )}
                            {entry.type === "QUEUED" && (
                                <Tooltip title="Đang chờ">
                                    <ScheduleIcon
                                        color="action"
                                        fontSize="small"
                                    />
                                </Tooltip>
                            )}
                            {(entry.type === "UPLOADING" ||
                                entry.type === "DOWNLOADING") && (
                                <Tooltip
                                    title={`${Math.round(entry.percentage)}%`}
                                >
                                    <CircularProgress
                                        variant="determinate"
                                        value={Math.max(3, entry.percentage)}
                                        size={20}
                                        thickness={5}
                                    />
                                </Tooltip>
                            )}
                            {entry.type === "ERROR" && (
                                <>
                                    {entry.direction !== "down" &&
                                        getRecord(entry.id)?.file_id ==
                                            null && (
                                            <Tooltip title="Thử lại">
                                                <IconButton
                                                    size="small"
                                                    onClick={() =>
                                                        retryUpload(entry.id)
                                                    }
                                                >
                                                    <ReplayIcon fontSize="small" />
                                                </IconButton>
                                            </Tooltip>
                                        )}
                                    <Tooltip
                                        title={entry.message ?? "Thất bại"}
                                    >
                                        <ErrorIcon
                                            color="error"
                                            fontSize="small"
                                        />
                                    </Tooltip>
                                </>
                            )}
                        </Stack>
                    ))}
                </Box>
            )}
        </Paper>
    );
}

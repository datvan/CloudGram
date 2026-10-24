import { useEffect, useState } from "react";
import PropTypes from "prop-types";

import {
    Box,
    CircularProgress,
    Dialog,
    IconButton,
    Stack,
    Tooltip,
    Typography,
} from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import FileDownloadOutlinedIcon from "@mui/icons-material/FileDownloadOutlined";

import { previewKind } from "./fileTypes";
import { FileIcon } from "./FileIcon";
import { fetchFile, saveBlob } from "../../utils/downloadFile";
import { formatSize } from "../../utils/format";

// GramJS buffers the whole file in memory, so the preview stays within what a
// tab can comfortably hold; anything larger is offered as a download instead.
const LIMITS = { image: 50, pdf: 100, text: 5, audio: 200, video: 300 };

// a few recent previews, so flicking back and forth does not re-download
const cache = new Map();
function remember(id, value) {
    cache.set(id, value);
    while (cache.size > 6) {
        const [oldest, entry] = cache.entries().next().value;
        URL.revokeObjectURL(entry.url);
        cache.delete(oldest);
    }
}

export default function PreviewDialog({ item, siblings, onClose, onNavigate }) {
    const [state, setState] = useState({ status: "idle" });
    const kind = item ? previewKind(item) : null;
    const tooLarge =
        item && kind && (item.size ?? 0) > LIMITS[kind] * 1024 * 1024;
    const index = item ? siblings.findIndex((s) => s.id === item.id) : -1;
    const prev = index > 0 ? siblings[index - 1] : null;
    const next =
        index >= 0 && index < siblings.length - 1 ? siblings[index + 1] : null;

    useEffect(() => {
        if (!item || !kind || tooLarge || item.file_id == null) {
            setState({ status: "unsupported" });
            return undefined;
        }
        let cancelled = false;
        const cached = cache.get(item.id);
        if (cached) {
            setState({ status: "ready", ...cached });
            return undefined;
        }
        setState({ status: "loading" });
        fetchFile(item.id, item.file_id)
            .then(async (blob) => {
                const typed =
                    kind === "pdf"
                        ? new Blob([blob], { type: "application/pdf" })
                        : blob;
                const entry = {
                    blob,
                    url: URL.createObjectURL(typed),
                    text: kind === "text" ? await blob.text() : null,
                };
                remember(item.id, entry);
                if (!cancelled) setState({ status: "ready", ...entry });
            })
            .catch(
                (e) =>
                    !cancelled &&
                    setState({
                        status: "error",
                        error: e?.message ?? String(e),
                    }),
            );
        return () => {
            cancelled = true;
        };
    }, [item, kind, tooLarge]);

    useEffect(() => {
        if (!item) return undefined;
        const onKey = (e) => {
            if (e.key === "ArrowLeft" && prev) onNavigate(prev);
            if (e.key === "ArrowRight" && next) onNavigate(next);
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [item, prev, next, onNavigate]);

    async function download() {
        if (state.blob) saveBlob(state.blob, item.name);
        else saveBlob(await fetchFile(item.id, item.file_id), item.name);
    }

    const body = () => {
        if (state.status === "loading" || state.status === "idle") {
            return <CircularProgress sx={{ color: "#fff" }} />;
        }
        if (state.status === "error") {
            return (
                <Typography color="#fff">
                    Không tải được: {state.error}
                </Typography>
            );
        }
        if (state.status === "unsupported") {
            return (
                <Stack
                    alignItems="center"
                    spacing={2}
                    sx={{ bgcolor: "#3c4043", p: 4, borderRadius: 3 }}
                >
                    <FileIcon record={item} size={64} />
                    <Typography color="#fff">
                        {item.file_id == null
                            ? "Tệp chưa tải lên xong."
                            : tooLarge
                            ? `Tệp quá lớn để xem trước (${formatSize(
                                  item.size,
                              )}).`
                            : "Không xem trước được loại tệp này."}
                    </Typography>
                </Stack>
            );
        }
        const fit = { maxWidth: "100%", maxHeight: "100%" };
        switch (kind) {
            case "image":
                return (
                    <img
                        src={state.url}
                        alt={item.name}
                        style={{ ...fit, objectFit: "contain" }}
                    />
                );
            case "video":
                return <video src={state.url} controls autoPlay style={fit} />;
            case "audio":
                return <audio src={state.url} controls autoPlay />;
            case "pdf":
                return (
                    <iframe
                        src={state.url}
                        title={item.name}
                        style={{
                            width: "min(1000px, 100%)",
                            height: "100%",
                            border: 0,
                            background: "#fff",
                        }}
                    />
                );
            case "text":
                return (
                    <Box
                        component="pre"
                        sx={{
                            bgcolor: "#fff",
                            color: "#1f1f1f",
                            p: 3,
                            m: 0,
                            width: "min(1000px, 100%)",
                            height: "100%",
                            overflow: "auto",
                            fontSize: 13,
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-word",
                        }}
                    >
                        {state.text}
                    </Box>
                );
            default:
                return null;
        }
    };

    return (
        <Dialog
            open={Boolean(item)}
            onClose={onClose}
            fullScreen
            PaperProps={{
                sx: { bgcolor: "rgba(0,0,0,.85)", borderRadius: 0, p: 0 },
            }}
        >
            {item && (
                <>
                    <Stack
                        direction="row"
                        alignItems="center"
                        spacing={1.5}
                        sx={{ height: 64, px: 2, color: "#fff" }}
                    >
                        <IconButton
                            onClick={onClose}
                            sx={{ color: "#fff" }}
                            aria-label="Đóng"
                        >
                            <ArrowBackIcon />
                        </IconButton>
                        <FileIcon record={item} />
                        <Typography noWrap sx={{ flex: 1 }}>
                            {item.name}
                        </Typography>
                        <Tooltip title="Tải xuống">
                            <span>
                                <IconButton
                                    onClick={download}
                                    disabled={item.file_id == null}
                                    sx={{ color: "#fff" }}
                                    aria-label="Tải xuống"
                                >
                                    <FileDownloadOutlinedIcon />
                                </IconButton>
                            </span>
                        </Tooltip>
                    </Stack>
                    <Box
                        sx={{
                            flex: 1,
                            minHeight: 0,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            p: { xs: 1, md: 4 },
                            position: "relative",
                        }}
                        onClick={(e) =>
                            e.target === e.currentTarget && onClose()
                        }
                    >
                        {body()}
                        {prev && (
                            <IconButton
                                onClick={() => onNavigate(prev)}
                                sx={{
                                    position: "absolute",
                                    left: 16,
                                    color: "#fff",
                                    bgcolor: "rgba(0,0,0,.5)",
                                }}
                                aria-label="Trước"
                            >
                                <ChevronLeftIcon fontSize="large" />
                            </IconButton>
                        )}
                        {next && (
                            <IconButton
                                onClick={() => onNavigate(next)}
                                sx={{
                                    position: "absolute",
                                    right: 16,
                                    color: "#fff",
                                    bgcolor: "rgba(0,0,0,.5)",
                                }}
                                aria-label="Sau"
                            >
                                <ChevronRightIcon fontSize="large" />
                            </IconButton>
                        )}
                    </Box>
                </>
            )}
        </Dialog>
    );
}

PreviewDialog.propTypes = {
    item: PropTypes.object,
    siblings: PropTypes.array,
    onClose: PropTypes.func,
    onNavigate: PropTypes.func,
};

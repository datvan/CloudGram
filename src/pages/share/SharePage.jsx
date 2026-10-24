import { useEffect, useState } from "react";

import {
    Alert,
    Box,
    Button,
    LinearProgress,
    Stack,
    Typography,
} from "@mui/material";
import FileDownloadOutlinedIcon from "@mui/icons-material/FileDownloadOutlined";

import AuthShell from "../auth/AuthShell";
import { FileIcon } from "../../components/drive/FileIcon";
import { api, describeError, getShareChunk } from "../../services/api";
import {
    decryptChunk,
    decryptMeta,
    importShareKey,
} from "../../services/shareCrypto";
import { saveBlob } from "../../utils/downloadFile";
import { formatDateTime, formatSize } from "../../utils/format";

const PARALLEL = 4;

/**
 * The page behind a share link: no account, no Telegram. The key comes from
 * the #fragment, which the browser never sends anywhere, so the file is
 * decrypted here.
 */
export default function SharePage() {
    const [state, setState] = useState({ phase: "loading" });
    const [progress, setProgress] = useState(null);

    useEffect(() => {
        const id = window.location.pathname.split("/")[2];
        const secret = window.location.hash.slice(1);
        (async () => {
            if (!secret) {
                setState({
                    phase: "error",
                    text: "Link thiếu phần khoá sau dấu #. Hãy sao chép lại đầy đủ link.",
                });
                return;
            }
            try {
                const info = await api.publicShare(id);
                let key;
                let meta;
                try {
                    key = await importShareKey(secret);
                    meta = await decryptMeta(key, info.meta);
                } catch {
                    throw new Error(
                        "Link không đúng hoặc đã bị cắt mất một phần.",
                    );
                }
                setState({ phase: "ready", id, key, info, meta });
            } catch (e) {
                setState({ phase: "error", text: describeError(e) });
            }
        })();
    }, []);

    async function download() {
        const { id, key, info, meta } = state;
        const parts = new Array(info.chunks);
        let next = 0;
        let done = 0;
        setProgress(0);
        try {
            const worker = async () => {
                while (next < info.chunks) {
                    const index = next++;
                    const sealed = await getShareChunk(id, index);
                    parts[index] = await decryptChunk(key, index, sealed);
                    done += 1;
                    setProgress(done / info.chunks);
                }
            };
            await Promise.all(
                Array.from({ length: Math.min(PARALLEL, info.chunks) }, worker),
            );
            const blob = new Blob(parts, {
                type: meta.mime || "application/octet-stream",
            });
            if (blob.size !== meta.size)
                throw new Error("Tệp tải về không đủ dung lượng.");
            saveBlob(blob, meta.name);
            setProgress(null);
        } catch (e) {
            setProgress(null);
            setState({ ...state, downloadError: describeError(e) });
        }
    }

    if (state.phase === "loading") {
        return (
            <AuthShell title="Đang mở link…">
                <LinearProgress />
            </AuthShell>
        );
    }
    if (state.phase === "error") {
        return (
            <AuthShell title="Không mở được link">
                <Alert severity="error">{state.text}</Alert>
            </AuthShell>
        );
    }

    const { meta, info } = state;
    const record = { type: "file", name: meta.name, mime: meta.mime };
    return (
        <AuthShell title="Tệp được chia sẻ với bạn">
            <Stack spacing={2}>
                <Stack direction="row" spacing={2} alignItems="center">
                    <FileIcon record={record} size={40} />
                    <Box sx={{ minWidth: 0 }}>
                        <Typography sx={{ wordBreak: "break-word" }}>
                            {meta.name}
                        </Typography>
                        <Typography variant="body2" color="text.secondary">
                            {formatSize(meta.size)}
                        </Typography>
                    </Box>
                </Stack>
                <Typography variant="body2" color="text.secondary">
                    {info.expiresAt
                        ? `Link hết hạn lúc ${formatDateTime(info.expiresAt)}.`
                        : "Link không có hạn dùng."}{" "}
                    Tệp được giải mã ngay trong trình duyệt của bạn.
                </Typography>
                {progress !== null && (
                    <LinearProgress
                        variant="determinate"
                        value={progress * 100}
                    />
                )}
                {state.downloadError && (
                    <Alert severity="error">{state.downloadError}</Alert>
                )}
                <Button
                    variant="contained"
                    startIcon={<FileDownloadOutlinedIcon />}
                    onClick={download}
                    disabled={progress !== null}
                    sx={{ alignSelf: "flex-start" }}
                >
                    {progress !== null
                        ? `Đang tải ${Math.round(progress * 100)}%`
                        : "Tải xuống"}
                </Button>
            </Stack>
        </AuthShell>
    );
}

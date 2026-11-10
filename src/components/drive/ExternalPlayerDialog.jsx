import { useEffect, useState } from "react";
import PropTypes from "prop-types";

import {
    Button,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    Stack,
    Typography,
} from "@mui/material";

import { startRelay } from "../../services/externalPlayer";

/** A playlist file opens in whatever player the user has set for .m3u */
function downloadPlaylist(name, url) {
    const blob = new Blob([`#EXTM3U\n${url}\n`], {
        type: "audio/x-mpegurl",
    });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${name.replace(/\.[^.]+$/, "")}.m3u`;
    link.click();
    URL.revokeObjectURL(link.href);
}

/**
 * Play a video in PotPlayer, VLC or mpv on this computer. The server keeps a
 * short cache and gives an address; nothing is installed here. Closing the
 * dialog leaves the video playing; "Dừng" ends it and clears the cache.
 */
export default function ExternalPlayerDialog({ item, onClose }) {
    // { url, stop } once ready
    const [session, setSession] = useState(null);
    const [error, setError] = useState("");
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        if (!item) return undefined;
        let live = true;
        setSession(null);
        setError("");
        setCopied(false);
        startRelay(item).then(
            (made) => live && setSession(made),
            (err) => live && setError(err.message),
        );
        return () => {
            live = false;
        };
    }, [item]);

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(session.url);
            setCopied(true);
        } catch {
            setError("Không sao chép được, hãy chọn địa chỉ và sao chép tay.");
        }
    };
    const stop = async () => {
        await session.stop();
        onClose();
    };

    const text = { variant: "body2", color: "text.secondary" };
    let body;
    if (error)
        body = (
            <Typography variant="body2" color="error">
                {error}
            </Typography>
        );
    else if (!session)
        body = <Typography {...text}>Đang chuẩn bị...</Typography>;
    else
        body = (
            <Stack spacing={1} alignItems="flex-start">
                <Typography {...text}>
                    Video chạy ngay, tua được, không cần tải cả tệp. Giữ tab
                    CloudGram này mở và đừng để trình phát che kín cửa sổ trình
                    duyệt (Chrome làm chậm tab bị che) trong lúc xem: video được
                    đọc từ Telegram qua tab này, rồi đi qua máy chủ CloudGram
                    (chưa mã hoá) tới trình phát. Máy chủ chỉ giữ một đoạn ngắn
                    và xoá khi bạn dừng hoặc đóng tab.
                </Typography>
                <Button
                    variant="contained"
                    size="small"
                    href={`potplayer://${session.url}`}
                >
                    Mở bằng PotPlayer
                </Button>
                <Button
                    size="small"
                    onClick={() => downloadPlaylist(item.name, session.url)}
                >
                    Tải danh sách phát (.m3u) cho VLC, mpv
                </Button>
                <Button size="small" onClick={copy}>
                    {copied ? "Đã sao chép" : "Sao chép địa chỉ"}
                </Button>
                <Typography {...text}>
                    Hoặc dán địa chỉ vào PotPlayer (Ctrl+U) hay VLC (Ctrl+N). Ai
                    có địa chỉ này đều xem được cho tới khi bạn dừng.
                </Typography>
            </Stack>
        );

    return (
        <Dialog open={Boolean(item)} onClose={onClose} maxWidth="xs" fullWidth>
            <DialogTitle>Mở bằng trình phát ngoài</DialogTitle>
            <DialogContent>
                {item && (
                    <Typography
                        variant="body2"
                        noWrap
                        sx={{ mb: 1, fontWeight: 500 }}
                    >
                        {item.name}
                    </Typography>
                )}
                {body}
            </DialogContent>
            <DialogActions>
                {session && <Button onClick={stop}>Dừng</Button>}
                <Button onClick={onClose}>Đóng</Button>
            </DialogActions>
        </Dialog>
    );
}

ExternalPlayerDialog.propTypes = {
    item: PropTypes.object,
    onClose: PropTypes.func.isRequired,
};

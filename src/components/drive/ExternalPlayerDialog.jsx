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

import {
    PLAYER_LABEL,
    externalPlayers,
    openInPlayer,
} from "../../services/externalPlayer";

/**
 * Open a video in a player installed on this computer. Looks for the local
 * helper and the players it found when it opens; every state says what to do.
 */
export default function ExternalPlayerDialog({ item, onClose }) {
    // undefined while looking
    const [found, setFound] = useState(undefined);
    const [busy, setBusy] = useState("");
    const [opened, setOpened] = useState("");
    const [error, setError] = useState("");

    const look = () => {
        setFound(undefined);
        externalPlayers().then(setFound);
    };
    useEffect(() => {
        if (!item) return undefined;
        let live = true;
        setOpened("");
        setError("");
        setBusy("");
        setFound(undefined);
        externalPlayers().then((now) => live && setFound(now));
        return () => {
            live = false;
        };
    }, [item]);

    const open = async (player) => {
        setError("");
        setBusy(player);
        try {
            await openInPlayer(item, player);
            setOpened(PLAYER_LABEL[player]);
        } catch (err) {
            setError(err.message);
        }
        setBusy("");
    };

    const text = { variant: "body2", color: "text.secondary" };
    let body;
    if (opened)
        body = (
            <Typography {...text}>
                Đã mở trong {opened}. Giữ tab CloudGram này mở trong lúc xem:
                video được đọc từ Telegram qua tab này.
            </Typography>
        );
    else if (found === undefined)
        body = (
            <Typography {...text}>Đang tìm chương trình hỗ trợ...</Typography>
        );
    else if (!found.helper)
        body = (
            <Stack spacing={1} alignItems="flex-start">
                <Typography {...text}>
                    Cần chương trình hỗ trợ chạy trên máy này. Tải{" "}
                    <a href="/helper/cloudgram-helper.mjs" download>
                        cloudgram-helper.mjs
                    </a>
                    , mở Terminal tại thư mục chứa nó rồi chạy{" "}
                    <code>node cloudgram-helper.mjs</code> (cần Node.js). Giữ
                    cửa sổ đó mở, rồi bấm Kiểm tra lại.
                </Typography>
                <Button size="small" onClick={look}>
                    Kiểm tra lại
                </Button>
            </Stack>
        );
    else if (found.outdated)
        body = (
            <Stack spacing={1} alignItems="flex-start">
                <Typography {...text}>
                    Chương trình hỗ trợ đang chạy là bản cũ, chưa mở được trình
                    phát. Tắt nó (Ctrl+C), tải lại{" "}
                    <a href="/helper/cloudgram-helper.mjs" download>
                        cloudgram-helper.mjs
                    </a>{" "}
                    rồi chạy lại, sau đó bấm Kiểm tra lại.
                </Typography>
                <Button size="small" onClick={look}>
                    Kiểm tra lại
                </Button>
            </Stack>
        );
    else if (!found.players.length)
        body = (
            <Stack spacing={1} alignItems="flex-start">
                <Typography {...text}>
                    Chương trình hỗ trợ không tìm thấy PotPlayer, VLC hay mpv
                    trên máy. Cài một trong số đó, rồi bấm Kiểm tra lại. Nếu đã
                    cài ở chỗ lạ, chạy helper với biến CLOUDGRAM_POTPLAYER,
                    CLOUDGRAM_VLC hoặc CLOUDGRAM_MPV trỏ tới tệp chạy của nó.
                </Typography>
                <Button size="small" onClick={look}>
                    Kiểm tra lại
                </Button>
            </Stack>
        );
    else
        body = (
            <Stack spacing={1} alignItems="flex-start">
                <Typography {...text}>
                    Video chạy ngay, tua được, không cần tải cả tệp. Giữ tab này
                    mở trong lúc xem.
                </Typography>
                {found.players.map((player) => (
                    <Button
                        key={player}
                        variant="contained"
                        size="small"
                        disabled={Boolean(busy)}
                        onClick={() => open(player)}
                    >
                        {busy === player
                            ? "Đang mở..."
                            : `Mở bằng ${PLAYER_LABEL[player]}`}
                    </Button>
                ))}
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
                {error && (
                    <Typography variant="body2" color="error" sx={{ mt: 1 }}>
                        {error}
                    </Typography>
                )}
            </DialogContent>
            <DialogActions>
                <Button onClick={onClose}>Đóng</Button>
            </DialogActions>
        </Dialog>
    );
}

ExternalPlayerDialog.propTypes = {
    item: PropTypes.object,
    onClose: PropTypes.func.isRequired,
};

import { useState } from "react";
import { useSelector } from "react-redux";

import {
    Alert,
    Box,
    Button,
    CircularProgress,
    Stack,
    Typography,
} from "@mui/material";
import DevicesIcon from "@mui/icons-material/Devices";

import AuthShell from "./AuthShell";
import { acquireLease, logout, retry } from "../../services/account";

export function Connecting() {
    return (
        <Box
            sx={{
                minHeight: "100vh",
                display: "grid",
                placeItems: "center",
                bgcolor: "background.default",
            }}
        >
            <Stack alignItems="center" spacing={2}>
                <img src="/CloudGram.svg" width={64} height={64} alt="" />
                <CircularProgress size={28} />
            </Stack>
        </Box>
    );
}

export function ErrorScreen() {
    const error = useSelector((state) => state.auth.error);
    return (
        <AuthShell title="Có lỗi xảy ra">
            <Stack spacing={2}>
                <Alert severity="error">{error}</Alert>
                <Stack direction="row" justifyContent="space-between">
                    <Button onClick={logout}>Đăng xuất</Button>
                    <Button variant="contained" onClick={retry}>
                        Thử lại
                    </Button>
                </Stack>
            </Stack>
        </AuthShell>
    );
}

function describeAgent(agent) {
    if (!agent) return "một thiết bị khác";
    const browser = /Edg\//.test(agent)
        ? "Edge"
        : /Chrome\//.test(agent)
        ? "Chrome"
        : /Firefox\//.test(agent)
        ? "Firefox"
        : /Safari\//.test(agent)
        ? "Safari"
        : "trình duyệt";
    const os = /Windows/.test(agent)
        ? "Windows"
        : /Android/.test(agent)
        ? "Android"
        : /iPhone|iPad/.test(agent)
        ? "iOS"
        : /Mac OS/.test(agent)
        ? "macOS"
        : /Linux/.test(agent)
        ? "Linux"
        : "";
    return `${browser}${os ? ` trên ${os}` : ""}`;
}

/**
 * Telegram kills an auth key that is used from two IPs at once, so the session
 * is only ever live in one browser. This is what the others see.
 */
export function LeaseScreen() {
    const { lease, notice } = useSelector((state) => state.auth);
    const [asked, setAsked] = useState(false);
    const waiting = lease?.status === "waiting" || asked;

    function takeOver() {
        setAsked(true);
        acquireLease(true);
    }

    return (
        <AuthShell
            title="Đang dùng ở nơi khác"
            subtitle={
                lease?.holder
                    ? `CloudGram đang mở trên ${describeAgent(lease.holder)}${
                          lease.since
                              ? ` từ ${new Date(
                                    lease.since,
                                ).toLocaleTimeString()}`
                              : ""
                      }.`
                    : notice ?? "CloudGram đang mở trên thiết bị khác."
            }
        >
            <Stack spacing={2}>
                <Stack direction="row" spacing={2} alignItems="center">
                    <DevicesIcon color="action" />
                    <Typography variant="body2" color="text.secondary">
                        Telegram chỉ cho một phiên đăng nhập hoạt động ở một nơi
                        tại một thời điểm. Chuyển sang thiết bị này sẽ ngắt kết
                        nối ở thiết bị kia.
                    </Typography>
                </Stack>
                {waiting && (
                    <Alert
                        severity="info"
                        icon={<CircularProgress size={18} />}
                    >
                        Đang chờ thiết bị kia ngắt kết nối (tối đa khoảng 30
                        giây)…
                    </Alert>
                )}
                <Stack direction="row" justifyContent="space-between">
                    <Button onClick={logout}>Đăng xuất</Button>
                    <Button
                        variant="contained"
                        onClick={takeOver}
                        disabled={waiting}
                    >
                        Dùng ở thiết bị này
                    </Button>
                </Stack>
            </Stack>
        </AuthShell>
    );
}

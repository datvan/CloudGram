import { useEffect, useRef, useState } from "react";
import { useSelector } from "react-redux";

import {
    Alert,
    Button,
    Divider,
    Stack,
    TextField,
    Typography,
} from "@mui/material";
import TelegramIcon from "@mui/icons-material/Telegram";

import AuthShell from "./AuthShell";
import {
    sendCode,
    signIn,
    signInWithPassword,
    openSharedClient,
} from "../../services/telegramAuth";
import { SHARED_TELEGRAM } from "../../config/features";
import { describeError } from "../../services/api";
import {
    adoptLegacySession,
    adoptTelegram,
    logout,
} from "../../services/account";
import { newClient } from "../../services/telegram";

/**
 * Link a Telegram account behind the local one. The session that comes out of
 * this is sealed into the vault, so later sign-ins on any device skip the OTP.
 */
export default function TelegramLink() {
    const { hasLegacy, notice, username } = useSelector((state) => state.auth);
    const clientRef = useRef(null);

    const [step, setStep] = useState(SHARED_TELEGRAM ? "auto" : "phone");
    const [phoneNumber, setPhoneNumber] = useState("");
    const [phoneCodeHash, setPhoneCodeHash] = useState("");
    const [phoneCode, setPhoneCode] = useState("");
    const [password, setPassword] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => {
        const controller = new AbortController();
        let cancelled = false;
        (async () => {
            try {
                if (SHARED_TELEGRAM) {
                    const client = await openSharedClient({
                        signal: controller.signal,
                    });
                    if (cancelled) {
                        await client.destroy();
                        return;
                    }
                    clientRef.current = null;
                    try {
                        await adoptTelegram(client, "shared");
                    } catch (error) {
                        await client.destroy().catch(() => {});
                        throw error;
                    }
                    return;
                }
                const client = newClient("");
                clientRef.current = client;
                await client.connect();
            } catch (e) {
                if (cancelled) return;
                if (
                    SHARED_TELEGRAM &&
                    (e.code === "telegram_not_linked" || e.status === 404)
                ) {
                    const client = newClient("");
                    clientRef.current = client;
                    try {
                        await client.connect();
                        if (!cancelled) setStep("phone");
                    } catch (connectError) {
                        client.destroy().catch(() => {});
                        clientRef.current = null;
                        if (!cancelled) {
                            setError(describeError(connectError));
                            setStep("failed");
                        }
                    }
                } else {
                    clientRef.current?.destroy().catch(() => {});
                    clientRef.current = null;
                    setError(describeError(e));
                    setStep("failed");
                }
            }
        })();
        return () => {
            cancelled = true;
            controller.abort();
            clientRef.current?.destroy().catch(() => {});
        };
    }, []);

    async function finish() {
        const client = clientRef.current;
        clientRef.current = null;
        await adoptTelegram(client);
    }

    async function submit(event) {
        event.preventDefault();
        setBusy(true);
        setError(null);
        const client = clientRef.current;
        try {
            if (step === "phone") {
                const res = await sendCode(client, phoneNumber);
                setPhoneCodeHash(res.phoneCodeHash);
                setStep("code");
            } else if (step === "code") {
                try {
                    await signIn(client, phoneNumber, phoneCodeHash, phoneCode);
                    await finish();
                    return;
                } catch (e) {
                    if (e.errorMessage !== "SESSION_PASSWORD_NEEDED") throw e;
                    setStep("password");
                }
            } else {
                await signInWithPassword(client, password);
                await finish();
                return;
            }
        } catch (e) {
            setError(describeError(e));
        }
        setBusy(false);
    }

    async function useLegacy() {
        setBusy(true);
        setError(null);
        try {
            await adoptLegacySession();
        } catch (e) {
            setError(describeError(e));
            setBusy(false);
        }
    }

    const labels = {
        phone: "Gửi mã",
        code: "Xác minh",
        password: "Đăng nhập",
    };

    return (
        <AuthShell
            title="Liên kết Telegram"
            subtitle={`Tài khoản ${username} chưa có Telegram. File được lưu trong Saved Messages của tài khoản Telegram bạn liên kết.`}
        >
            <Stack spacing={2}>
                {notice && <Alert severity="warning">{notice}</Alert>}
                {step === "auto" && (
                    <Typography>Đang liên kết Telegram…</Typography>
                )}
                {step === "failed" && (
                    <>
                        <Alert severity="error">{error}</Alert>
                        <Button onClick={() => window.location.reload()}>
                            Thử lại
                        </Button>
                        <Button onClick={logout}>Đăng xuất</Button>
                    </>
                )}
                {(step === "phone" ||
                    step === "code" ||
                    step === "password") && (
                    <>
                        {hasLegacy && step === "phone" && (
                            <>
                                <Button
                                    variant="outlined"
                                    startIcon={<TelegramIcon />}
                                    onClick={useLegacy}
                                    disabled={busy}
                                >
                                    Dùng phiên Telegram đã đăng nhập trên máy
                                    này
                                </Button>
                                <Divider>hoặc</Divider>
                            </>
                        )}
                        <form onSubmit={submit}>
                            <Stack spacing={2}>
                                {step === "phone" && (
                                    <TextField
                                        label="Số điện thoại (kèm mã quốc gia)"
                                        placeholder="+84…"
                                        autoComplete="tel"
                                        required
                                        value={phoneNumber}
                                        onChange={(e) =>
                                            setPhoneNumber(e.target.value)
                                        }
                                    />
                                )}
                                {step === "code" && (
                                    <>
                                        <Typography
                                            variant="body2"
                                            color="text.secondary"
                                        >
                                            Mã đăng nhập đã được gửi vào app
                                            Telegram (hoặc SMS) của{" "}
                                            {phoneNumber}.
                                        </Typography>
                                        <TextField
                                            label="Mã xác minh"
                                            autoComplete="one-time-code"
                                            inputMode="numeric"
                                            autoFocus
                                            required
                                            value={phoneCode}
                                            onChange={(e) =>
                                                setPhoneCode(e.target.value)
                                            }
                                        />
                                    </>
                                )}
                                {step === "password" && (
                                    <TextField
                                        label="Mật khẩu xác minh 2 bước của Telegram"
                                        type="password"
                                        autoFocus
                                        required
                                        value={password}
                                        onChange={(e) =>
                                            setPassword(e.target.value)
                                        }
                                    />
                                )}
                                {error && (
                                    <Alert severity="error">{error}</Alert>
                                )}
                                <Stack
                                    direction="row"
                                    justifyContent="space-between"
                                >
                                    <Button onClick={logout} disabled={busy}>
                                        Đăng xuất
                                    </Button>
                                    <Button
                                        type="submit"
                                        variant="contained"
                                        disabled={busy}
                                        sx={{ px: 3 }}
                                    >
                                        {busy ? "Đang xử lý…" : labels[step]}
                                    </Button>
                                </Stack>
                            </Stack>
                        </form>
                    </>
                )}
            </Stack>
        </AuthShell>
    );
}

import { useEffect, useState } from "react";
import PropTypes from "prop-types";

import {
    Alert,
    Button,
    Checkbox,
    FormControlLabel,
    LinearProgress,
    Stack,
    TextField,
} from "@mui/material";

import AuthShell from "./AuthShell";
import RecoveryCode from "./RecoveryCode";
import { describeError } from "../../services/api";
import { completeSetup, prepareSetup, setupInfo } from "../../services/account";

const MIN_LENGTH = 10;

/**
 * First visit through the one-time link from `cloudgram-admin add`. The
 * password is chosen here, so it never passes through the admin's terminal.
 */
export default function Setup({ token }) {
    const [username, setUsername] = useState(null);
    const [loadError, setLoadError] = useState(null);
    const [password, setPassword] = useState("");
    const [confirm, setConfirm] = useState("");
    const [remember, setRemember] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    // step 2: the keys are made and the recovery code is shown
    const [prepared, setPrepared] = useState(null);
    const [saved, setSaved] = useState(false);

    useEffect(() => {
        setupInfo(token)
            .then((info) => setUsername(info.username))
            .catch((e) => setLoadError(describeError(e)));
    }, [token]);

    async function submit(event) {
        event.preventDefault();
        if (password.length < MIN_LENGTH) {
            setError(`Mật khẩu cần ít nhất ${MIN_LENGTH} ký tự.`);
            return;
        }
        if (password !== confirm) {
            setError("Hai mật khẩu không khớp.");
            return;
        }
        setBusy(true);
        setError(null);
        try {
            setPrepared(await prepareSetup(password));
        } catch (e) {
            setError(describeError(e));
        }
        setBusy(false);
    }

    async function create() {
        setBusy(true);
        setError(null);
        try {
            await completeSetup(token, prepared, remember);
        } catch (e) {
            setError(describeError(e));
            setBusy(false);
        }
    }

    if (loadError) {
        return (
            <AuthShell title="Không dùng được link này">
                <Alert severity="error">{loadError}</Alert>
            </AuthShell>
        );
    }

    if (!username) {
        return (
            <AuthShell title="Thiết lập tài khoản">
                <LinearProgress />
            </AuthShell>
        );
    }

    if (prepared) {
        return (
            <AuthShell title="Cất mã khôi phục">
                <Stack spacing={2}>
                    <RecoveryCode
                        code={prepared.code}
                        username={username}
                        saved={saved}
                        onSaved={setSaved}
                    />
                    {error && <Alert severity="error">{error}</Alert>}
                    <Stack direction="row" justifyContent="space-between">
                        <Button
                            onClick={() => {
                                setPrepared(null);
                                setSaved(false);
                            }}
                            disabled={busy}
                        >
                            Quay lại
                        </Button>
                        <Button
                            variant="contained"
                            onClick={create}
                            disabled={busy || !saved}
                            sx={{ px: 3 }}
                        >
                            {busy ? "Đang tạo…" : "Tạo tài khoản"}
                        </Button>
                    </Stack>
                </Stack>
            </AuthShell>
        );
    }

    return (
        <AuthShell
            title="Đặt mật khẩu"
            subtitle={
                <>
                    Tài khoản <b>{username}</b>. Mật khẩu này khoá phiên
                    Telegram và cây thư mục của bạn trên máy chủ. Bước sau sẽ
                    cho bạn một mã khôi phục, dùng khi quên mật khẩu.
                </>
            }
        >
            <form onSubmit={submit}>
                <input
                    type="text"
                    autoComplete="username"
                    value={username}
                    readOnly
                    hidden
                />
                <Stack spacing={2}>
                    <TextField
                        label="Mật khẩu mới"
                        type="password"
                        autoComplete="new-password"
                        autoFocus
                        required
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        helperText={`Ít nhất ${MIN_LENGTH} ký tự. Nên dùng password manager.`}
                    />
                    <TextField
                        label="Nhập lại mật khẩu"
                        type="password"
                        autoComplete="new-password"
                        required
                        value={confirm}
                        onChange={(e) => setConfirm(e.target.value)}
                    />
                    <FormControlLabel
                        control={
                            <Checkbox
                                checked={remember}
                                onChange={(e) => setRemember(e.target.checked)}
                            />
                        }
                        label="Ghi nhớ đăng nhập trên thiết bị này"
                    />
                    {error && <Alert severity="error">{error}</Alert>}
                    <Stack direction="row" justifyContent="flex-end">
                        <Button
                            type="submit"
                            variant="contained"
                            disabled={busy}
                            sx={{ px: 3 }}
                        >
                            {busy ? "Đang tạo khoá…" : "Tiếp theo"}
                        </Button>
                    </Stack>
                </Stack>
            </form>
        </AuthShell>
    );
}

Setup.propTypes = {
    token: PropTypes.string,
};

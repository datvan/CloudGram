import { useState } from "react";
import PropTypes from "prop-types";

import {
    Alert,
    Button,
    Checkbox,
    FormControlLabel,
    Stack,
    TextField,
} from "@mui/material";

import AuthShell from "./AuthShell";
import RecoveryCode from "./RecoveryCode";
import { describeError } from "../../services/api";
import { recover } from "../../services/account";

const MIN_LENGTH = 10;

/** Forgotten password: the recovery code sets a new one, nothing is lost. */
export default function Recover({ username: knownUser, onBack }) {
    const [username, setUsername] = useState(knownUser ?? "");
    const [code, setCode] = useState("");
    const [password, setPassword] = useState("");
    const [confirm, setConfirm] = useState("");
    const [remember, setRemember] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [done, setDone] = useState(null);
    const [saved, setSaved] = useState(false);

    async function submit(event) {
        event.preventDefault();
        if (password.length < MIN_LENGTH)
            return setError(`Mật khẩu cần ít nhất ${MIN_LENGTH} ký tự.`);
        if (password !== confirm) return setError("Hai mật khẩu không khớp.");
        setBusy(true);
        setError(null);
        try {
            setDone(await recover(username, code, password, remember));
        } catch (e) {
            setError(describeError(e));
        }
        setBusy(false);
    }

    async function go() {
        setBusy(true);
        try {
            await done.enter();
        } catch (e) {
            setError(describeError(e));
            setBusy(false);
        }
    }

    if (done) {
        return (
            <AuthShell
                title="Đã đặt mật khẩu mới"
                subtitle="Mã khôi phục cũ đã hết hiệu lực. Đây là mã mới."
            >
                <Stack spacing={2}>
                    <RecoveryCode
                        code={done.code}
                        username={username}
                        saved={saved}
                        onSaved={setSaved}
                    />
                    {error && <Alert severity="error">{error}</Alert>}
                    <Stack direction="row" justifyContent="flex-end">
                        <Button
                            variant="contained"
                            onClick={go}
                            disabled={busy || !saved}
                            sx={{ px: 3 }}
                        >
                            Vào CloudGram
                        </Button>
                    </Stack>
                </Stack>
            </AuthShell>
        );
    }

    return (
        <AuthShell
            title="Quên mật khẩu"
            subtitle="Dùng mã khôi phục bạn đã cất khi tạo tài khoản. Thư mục, file và Telegram được giữ nguyên."
        >
            <form onSubmit={submit}>
                <Stack spacing={2}>
                    <TextField
                        label="Tên đăng nhập"
                        autoComplete="username"
                        required
                        autoFocus={!knownUser}
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                    />
                    <TextField
                        label="Mã khôi phục"
                        placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
                        autoComplete="off"
                        required
                        autoFocus={Boolean(knownUser)}
                        value={code}
                        onChange={(e) => setCode(e.target.value)}
                        inputProps={{ style: { fontFamily: "monospace" } }}
                    />
                    <TextField
                        label="Mật khẩu mới"
                        type="password"
                        autoComplete="new-password"
                        required
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        helperText={`Ít nhất ${MIN_LENGTH} ký tự.`}
                    />
                    <TextField
                        label="Nhập lại mật khẩu mới"
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
                    <Stack direction="row" justifyContent="space-between">
                        <Button onClick={onBack} disabled={busy}>
                            Quay lại đăng nhập
                        </Button>
                        <Button
                            type="submit"
                            variant="contained"
                            disabled={busy}
                            sx={{ px: 3 }}
                        >
                            {busy ? "Đang kiểm tra…" : "Đặt mật khẩu mới"}
                        </Button>
                    </Stack>
                </Stack>
            </form>
        </AuthShell>
    );
}

Recover.propTypes = {
    username: PropTypes.string,
    onBack: PropTypes.func,
};

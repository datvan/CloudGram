import { useState } from "react";
import PropTypes from "prop-types";

import {
    Alert,
    Box,
    Button,
    Checkbox,
    FormControlLabel,
    Stack,
} from "@mui/material";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import DownloadIcon from "@mui/icons-material/Download";

/**
 * A recovery code shown once, with copy and download, and the box to tick
 * once it is put away. Used at setup, after a recovery and in settings.
 */
export default function RecoveryCode({ code, username, saved, onSaved }) {
    const [copied, setCopied] = useState(false);

    async function copy() {
        try {
            await navigator.clipboard.writeText(code);
            setCopied(true);
        } catch {
            setCopied(false);
        }
    }

    function download() {
        const text = [
            "Mã khôi phục CloudGram",
            `Tài khoản: ${username}`,
            `Mã: ${code}`,
            "",
            "Dùng mã này ở trang đăng nhập > Quên mật khẩu.",
            "Ai có mã này và tên đăng nhập là vào được tài khoản: cất kỹ.",
        ].join("\r\n");
        const url = URL.createObjectURL(
            new Blob([text], { type: "text/plain;charset=utf-8" }),
        );
        const a = document.createElement("a");
        a.href = url;
        a.download = `cloudgram-ma-khoi-phuc-${username}.txt`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    return (
        <Stack spacing={1.5}>
            <Alert severity="warning">
                Đây là <b>mã khôi phục</b>: quên mật khẩu thì dùng nó để đặt mật
                khẩu mới mà không mất dữ liệu. Mã chỉ hiện <b>một lần</b>. Cất
                vào trình quản lý mật khẩu, tải file về, hoặc chép ra giấy.
            </Alert>
            <Box
                aria-label="Mã khôi phục"
                sx={{
                    fontFamily: "monospace",
                    fontSize: 20,
                    letterSpacing: 1,
                    textAlign: "center",
                    p: 1.5,
                    borderRadius: 1,
                    bgcolor: "action.hover",
                    userSelect: "all",
                    wordBreak: "break-all",
                }}
            >
                {code}
            </Box>
            <Stack direction="row" spacing={1} justifyContent="center">
                <Button startIcon={<ContentCopyIcon />} onClick={copy}>
                    {copied ? "Đã chép" : "Chép mã"}
                </Button>
                <Button startIcon={<DownloadIcon />} onClick={download}>
                    Tải file về
                </Button>
            </Stack>
            <FormControlLabel
                control={
                    <Checkbox
                        checked={saved}
                        onChange={(e) => onSaved(e.target.checked)}
                    />
                }
                label="Tôi đã cất mã này ở chỗ an toàn"
            />
        </Stack>
    );
}

RecoveryCode.propTypes = {
    code: PropTypes.string.isRequired,
    username: PropTypes.string,
    saved: PropTypes.bool,
    onSaved: PropTypes.func,
};

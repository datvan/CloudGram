import { useCallback, useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";

import { Alert, Button, Stack } from "@mui/material";

import { describeError } from "../../services/api";
import {
    discard,
    handleRoots,
    matchPicked,
    resume,
    scan,
} from "../../services/uploadResume";
import { formatSize } from "../../utils/format";
import {
    askToRead,
    canKeepHandles,
    isAbort,
    pickFiles,
    pickFolder,
} from "../../utils/pickers";

/**
 * Shown when a closed tab left uploads unfinished: resume them (one click
 * where the browser kept the file handles, a picker otherwise), or let them
 * go. See services/uploadResume.js.
 */
export default function ResumeBanner({ onNotice }) {
    const [found, setFound] = useState(null);
    // files the user still has to pick again, after "Tiếp tục"
    const [waiting, setWaiting] = useState(null);
    const [busy, setBusy] = useState(false);
    const [confirm, setConfirm] = useState(false);
    const fileInput = useRef(null);
    const folderInput = useRef(null);

    const rescan = useCallback(async () => {
        try {
            const next = await scan();
            setFound(next.files.length || next.imports.length ? next : null);
        } catch (error) {
            console.log(error);
        }
    }, []);

    useEffect(() => {
        rescan();
    }, [rescan]);

    const attachFolderInput = useCallback((node) => {
        folderInput.current = node;
        if (node) {
            node.setAttribute("webkitdirectory", "");
            node.setAttribute("directory", "");
        }
    }, []);

    if (!found && !waiting) return null;

    function report(text, severity = "success") {
        onNotice({ severity, text });
    }

    async function onResume() {
        // started inside the click, before any await (pickers.js)
        const granted = askToRead(handleRoots(found));
        setBusy(true);
        try {
            const result = await resume(found, granted);
            const parts = [
                result.queued && `${result.queued} tệp tiếp tục tải lên`,
                result.adopted &&
                    `${result.adopted} tệp đã gửi xong từ trước, chỉ cần ghi nhận`,
                result.links && `chạy lại ${result.links} link Dropbox`,
            ].filter(Boolean);
            if (parts.length) report(`Đã tiếp tục: ${parts.join(", ")}.`);
            setFound(null);
            setWaiting(result.needsPick.length ? result.needsPick : null);
        } catch (error) {
            report(describeError(error), "error");
        } finally {
            setBusy(false);
        }
    }

    function onPicked(entries) {
        const { queued, unmatched } = matchPicked(waiting, entries);
        report(
            unmatched.length
                ? `Đã tiếp tục ${queued} tệp; còn ${unmatched.length} tệp chưa khớp.`
                : `Đã tiếp tục ${queued} tệp.`,
            unmatched.length ? "warning" : "success",
        );
        setWaiting(unmatched.length ? unmatched : null);
    }

    async function pick(folder) {
        if (!canKeepHandles) {
            (folder ? folderInput : fileInput).current?.click();
            return;
        }
        try {
            onPicked(await (folder ? pickFolder() : pickFiles()));
        } catch (error) {
            if (!isAbort(error)) report(describeError(error), "error");
        }
    }

    function onInput(event) {
        const files = Array.from(event.target.files ?? []);
        event.target.value = "";
        if (files.length)
            onPicked(
                files.map((file) => ({
                    file,
                    path: file.webkitRelativePath || file.name,
                })),
            );
    }

    async function onDiscard() {
        setBusy(true);
        try {
            await discard(found ?? { files: waiting, imports: [] });
            report("Đã bỏ các tệp tải lên dở.");
            setFound(null);
            setWaiting(null);
        } catch (error) {
            report(describeError(error), "error");
        } finally {
            setBusy(false);
            setConfirm(false);
        }
    }

    const list = found?.files ?? waiting;
    const bytes = list.reduce((sum, item) => sum + (item.size ?? 0), 0);
    const links = found?.imports.length ?? 0;
    const summary = [
        list.length && `${list.length} tệp (${formatSize(bytes)})`,
        links && `${links} link Dropbox`,
    ]
        .filter(Boolean)
        .join(" và ");

    const actions = confirm ? (
        <>
            <Button
                color="inherit"
                size="small"
                onClick={() => setConfirm(false)}
            >
                Giữ lại
            </Button>
            <Button
                color="error"
                size="small"
                disabled={busy}
                onClick={onDiscard}
            >
                Bỏ hẳn
            </Button>
        </>
    ) : found ? (
        <>
            <Button
                color="inherit"
                size="small"
                onClick={() => setConfirm(true)}
            >
                Bỏ
            </Button>
            <Button
                variant="contained"
                size="small"
                disabled={busy}
                onClick={onResume}
            >
                Tiếp tục
            </Button>
        </>
    ) : (
        <>
            <Button
                color="inherit"
                size="small"
                onClick={() => setConfirm(true)}
            >
                Bỏ
            </Button>
            <Button size="small" onClick={() => pick(true)}>
                Chọn thư mục
            </Button>
            <Button
                variant="contained"
                size="small"
                onClick={() => pick(false)}
            >
                Chọn tệp
            </Button>
        </>
    );

    const text = confirm
        ? `Xoá ${list.length} tệp chưa tải xong khỏi Drive? Tệp gốc trên máy không bị ảnh hưởng.`
        : found
        ? `Còn ${summary} tải lên dở từ lần trước (tab đã bị đóng giữa chừng).`
        : `Chọn lại ${list.length} tệp còn thiếu (${formatSize(
              bytes,
          )}) để tải tiếp, đúng tệp hoặc thư mục đã chọn lúc trước.`;

    return (
        <>
            <Alert
                severity={confirm ? "warning" : "info"}
                sx={{
                    mx: { xs: 1, md: 2 },
                    mb: 1,
                    alignItems: "center",
                    "& .MuiAlert-message": { flex: 1 },
                }}
            >
                {/* the buttons drop below the text where the row runs short */}
                <Stack
                    direction={{ xs: "column", md: "row" }}
                    alignItems={{ md: "center" }}
                    spacing={1}
                >
                    <span style={{ flex: 1 }}>{text}</span>
                    <Stack
                        direction="row"
                        spacing={1}
                        justifyContent="flex-end"
                        sx={{
                            flexShrink: 0,
                            "& .MuiButton-root": { whiteSpace: "nowrap" },
                        }}
                    >
                        {actions}
                    </Stack>
                </Stack>
            </Alert>
            <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                onChange={onInput}
            />
            <input
                ref={attachFolderInput}
                type="file"
                multiple
                hidden
                onChange={onInput}
            />
        </>
    );
}

ResumeBanner.propTypes = { onNotice: PropTypes.func.isRequired };

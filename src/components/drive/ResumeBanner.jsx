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
    scanProgress,
} from "../../utils/pickers";

/**
 * Shown when a closed tab left uploads unfinished: resume them (one click
 * where the browser kept the file handles, a picker otherwise), or let them
 * go. See services/uploadResume.js.
 */
export default function ResumeBanner({ onNotice }) {
    const [found, setFound] = useState(null);
    // files only a picker can bring back: straight away when nothing else
    // can resume on its own, or what "Tiếp tục" could not
    const [waiting, setWaiting] = useState(null);
    const [busy, setBusy] = useState(false);
    // { done, total } while "Tiếp tục" opens the files again
    const [opening, setOpening] = useState(null);
    // files read so far from a picked folder, while it is read and matched
    const [reading, setReading] = useState(null);
    const [confirm, setConfirm] = useState(false);
    const fileInput = useRef(null);
    const folderInput = useRef(null);

    const rescan = useCallback(async () => {
        try {
            const next = await scan();
            if (!next.files.length && !next.imports.length) return;
            // with no log entry there is nothing to resume without a picker,
            // so a "Tiếp tục" step would only lead here
            if (!next.imports.length && next.files.every((f) => !f.entry))
                setWaiting(next.files);
            else setFound(next);
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
        setOpening({ done: 0, total: found.files.length });
        try {
            const result = await resume(found, granted, setOpening);
            const parts = [
                result.queued && `${result.queued} tệp tiếp tục tải lên`,
                result.adopted &&
                    `${result.adopted} tệp đã gửi xong từ trước, chỉ cần ghi nhận`,
                result.links && `chạy lại ${result.links} link Dropbox`,
            ].filter(Boolean);
            if (parts.length) report(`Đã tiếp tục: ${parts.join(", ")}.`);
            // the browser said no to reading the folder for now: the next
            // click on "Tiếp tục" asks it again, no picking needed
            setFound(
                result.denied.length
                    ? { files: result.denied, imports: [], denied: true }
                    : null,
            );
            // added to what an earlier click left for picking
            setWaiting((before) => {
                const all = [...(before ?? []), ...result.needsPick];
                return all.length ? all : null;
            });
        } catch (error) {
            report(describeError(error), "error");
        } finally {
            setBusy(false);
            setOpening(null);
        }
    }

    async function onPicked(entries) {
        setReading(entries.length);
        // let the banner say so before matching thousands of files holds the
        // page for a moment
        await new Promise((resolve) => setTimeout(resolve, 50));
        const { queued, unmatched } = matchPicked(waiting, entries);
        setReading(null);
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
            const options = {
                onPicked: () => setReading(0),
                scan: scanProgress(({ files }) => setReading(files)),
            };
            const entries = await (folder
                ? pickFolder(options)
                : pickFiles(options));
            await onPicked(entries);
        } catch (error) {
            setReading(null);
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
            await discard({
                files: [...(found?.files ?? []), ...(waiting ?? [])],
                imports: found?.imports ?? [],
            });
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
            <Button
                size="small"
                disabled={reading != null}
                onClick={() => pick(true)}
            >
                Chọn thư mục
            </Button>
            <Button
                variant="contained"
                size="small"
                disabled={reading != null}
                onClick={() => pick(false)}
            >
                Chọn tệp
            </Button>
        </>
    );

    const count = (n) => n.toLocaleString("vi-VN");
    const text =
        opening != null
            ? `Đang mở lại các tệp trên máy… ${count(opening.done)} / ${count(
                  opening.total,
              )}`
            : reading != null
            ? `Đang đọc thư mục đã chọn… ${reading} tệp`
            : confirm
            ? `Xoá ${
                  (found?.files.length ?? 0) + (waiting?.length ?? 0)
              } tệp chưa tải xong khỏi Drive? Tệp gốc trên máy không bị ảnh hưởng.`
            : found?.denied
            ? `Trình duyệt chưa cho đọc lại thư mục nên còn ${summary} chưa tải tiếp. Bấm Tiếp tục, và chọn Cho phép nếu trình duyệt hỏi.`
            : found
            ? `Còn ${summary} tải lên dở từ lần trước (tab đã bị đóng giữa chừng).`
            : `Còn ${list.length} tệp (${formatSize(
                  bytes,
              )}) chưa tải lên xong. Chọn lại đúng thư mục hoặc các tệp đã chọn lúc trước để tải tiếp; tệp nào đã lên rồi sẽ không gửi lại.`;

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

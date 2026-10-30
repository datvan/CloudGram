import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import PropTypes from "prop-types";
import { useSelector } from "react-redux";
import {
    matchPath,
    Navigate,
    useLocation,
    useNavigate,
} from "react-router-dom";

import {
    Alert,
    Box,
    Breadcrumbs,
    Button,
    Chip,
    Drawer,
    Fab,
    IconButton,
    Link,
    Menu,
    MenuItem,
    Snackbar,
    Stack,
    ToggleButton,
    ToggleButtonGroup,
    Tooltip,
    Typography,
    useMediaQuery,
} from "@mui/material";
import { useTheme } from "@mui/material/styles";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import ArrowDropDownIcon from "@mui/icons-material/ArrowDropDown";
import ViewListIcon from "@mui/icons-material/ViewList";
import GridViewIcon from "@mui/icons-material/GridView";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import CloseIcon from "@mui/icons-material/Close";
import FileDownloadOutlinedIcon from "@mui/icons-material/FileDownloadOutlined";
import DriveFileMoveOutlinedIcon from "@mui/icons-material/DriveFileMoveOutlined";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import StarBorderIcon from "@mui/icons-material/StarBorder";
import RestoreFromTrashOutlinedIcon from "@mui/icons-material/RestoreFromTrashOutlined";
import DeleteForeverOutlinedIcon from "@mui/icons-material/DeleteForeverOutlined";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import AddIcon from "@mui/icons-material/Add";
import CloudUploadOutlinedIcon from "@mui/icons-material/CloudUploadOutlined";
import FolderOpenOutlinedIcon from "@mui/icons-material/FolderOpenOutlined";

import TopBar from "../../components/drive/TopBar";
import Sidebar, { NewMenu } from "../../components/drive/Sidebar";
import { ItemGrid, ItemList } from "../../components/drive/ItemViews";
import ItemMenu from "../../components/drive/ItemMenu";
import DetailsPanel from "../../components/drive/DetailsPanel";
import PreviewDialog from "../../components/drive/PreviewDialog";
import ShareDialog from "../../components/drive/ShareDialog";
import DropboxDialog from "../../components/drive/DropboxDialog";
import ResumeBanner from "../../components/drive/ResumeBanner";
import TransferPanel from "../../components/drive/TransferPanel";
import useMarquee from "../../components/drive/useMarquee";
import {
    ConfirmDialog,
    MoveDialog,
    NameDialog,
    PasswordDialog,
    ScanDialog,
    UploadConflictDialog,
    UploadModeDialog,
} from "../../components/drive/Dialogs";
import {
    DRAG_TYPE,
    KIND_FILTERS,
    kindOf,
    previewKind,
} from "../../components/drive/fileTypes";
import { Store } from "../../redux/store";
import { activeEntry } from "../../redux/reducers/progressReducer";
import * as drive from "../../services/drive";
import { logout, logoutOthers, unlinkTelegram } from "../../services/account";
import { describeError } from "../../services/api";
import { importsBusy } from "../../services/dropboxImport";
import {
    countForever,
    deleteForever,
    downloadMany,
    emptyTrash,
    readDrop,
    uploadEntries,
} from "../../utils/driveActions";
import { fold } from "../../utils/format";
import {
    askToWrite,
    canKeepHandles,
    isAbort,
    pickFiles,
    pickFolder,
    scanProgress,
} from "../../utils/pickers";
import { isHidden, pathTo } from "../../utils/tree";
import { retryUpload } from "../../utils/uploadQueue";

const VIEWS = {
    folder: {
        title: "Drive của tôi",
        empty: "Thả tệp vào đây hoặc dùng nút “Mới” để tải lên.",
    },
    recent: { title: "Gần đây", empty: "Chưa có tệp nào gần đây." },
    starred: {
        title: "Có gắn dấu sao",
        empty: "Gắn dấu sao cho những mục bạn muốn tìm nhanh.",
    },
    trash: { title: "Thùng rác", empty: "Thùng rác trống." },
    search: { title: "Kết quả tìm kiếm", empty: "Không có kết quả phù hợp." },
};

function readPref(key, fallback) {
    try {
        return localStorage.getItem(key) ?? fallback;
    } catch {
        return fallback;
    }
}

function writePref(key, value) {
    try {
        localStorage.setItem(key, value);
    } catch {
        // a preference that does not stick is no reason to fail
    }
}

function useView() {
    const { pathname, search } = useLocation();
    const folder = matchPath("/folder/:id", pathname);
    if (folder) return { kind: "folder", folderId: folder.params.id };
    if (pathname === "/") return { kind: "folder", folderId: null };
    if (pathname === "/recent") return { kind: "recent" };
    if (pathname === "/starred") return { kind: "starred" };
    if (pathname === "/trash") return { kind: "trash" };
    if (pathname === "/search")
        return {
            kind: "search",
            query: new URLSearchParams(search).get("q") ?? "",
        };
    return { kind: "unknown" };
}

export default function DriveApp({ mode, onToggleMode }) {
    const navigate = useNavigate();
    const theme = useTheme();
    const desktop = useMediaQuery(theme.breakpoints.up("md"));
    const view = useView();
    const { records, byId } = drive.useDrive();

    const [navOpen, setNavOpen] = useState(false);
    // bumped to have the resume banner look again
    const [resumeScan, setResumeScan] = useState(0);
    // the upload of picked or dropped files still scanning or asking
    const activeRun = useRef(null);
    // files whose names are taken where they go, waiting for an answer
    const [conflict, setConflict] = useState(null);
    // picked or dropped files still being read or checked (ScanDialog)
    const [scanning, setScanning] = useState(null);
    const [layout, setLayout] = useState(() =>
        readPref("cloudgram.layout", "list"),
    );
    const [sort, setSort] = useState({ key: "name", dir: "asc" });
    const [kindFilter, setKindFilter] = useState(null);
    const [selected, setSelected] = useState(() => new Set());
    const marquee = useMarquee(selected, setSelected);
    const [anchorIndex, setAnchorIndex] = useState(null);
    const [menu, setMenu] = useState(null);
    const [newMenu, setNewMenu] = useState(null);
    const [filterMenu, setFilterMenu] = useState(null);
    const [details, setDetails] = useState(false);
    const [preview, setPreview] = useState(null);
    const [dialog, setDialog] = useState(null);
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState(null);
    const [dropping, setDropping] = useState(false);
    const dragDepth = useRef(0);
    const fileInput = useRef(null);
    const folderInput = useRef(null);

    const folderId = view.kind === "folder" ? view.folderId : null;
    const currentFolder = folderId ? byId.get(folderId) : null;
    const inTrash = view.kind === "trash";
    // uploads from Recent, Starred or search land in My Drive, like Drive does
    const uploadTarget = view.kind === "folder" ? folderId : null;

    // ----- what is on screen ------------------------------------------------------

    const items = useMemo(() => {
        let list;
        switch (view.kind) {
            case "folder":
                list = records.filter(
                    (r) => (r.parent ?? null) === folderId && !r.trashedAt,
                );
                break;
            case "recent":
                list = records
                    .filter((r) => r.type === "file" && !isHidden(byId, r))
                    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
                    .slice(0, 100);
                break;
            case "starred":
                list = records.filter((r) => r.starred && !isHidden(byId, r));
                break;
            case "trash":
                // only the top of each trashed subtree, like Drive
                list = records.filter(
                    (r) =>
                        r.trashedAt &&
                        !(r.parent && isHidden(byId, byId.get(r.parent))),
                );
                break;
            case "search": {
                const q = fold(view.query.trim());
                list = q
                    ? records.filter(
                          (r) => fold(r.name).includes(q) && !isHidden(byId, r),
                      )
                    : [];
                break;
            }
            default:
                list = [];
        }
        if (kindFilter) list = list.filter((r) => kindOf(r) === kindFilter);
        if (view.kind === "recent") return list;

        const dir = sort.dir === "asc" ? 1 : -1;
        const dateKey = inTrash ? "trashedAt" : "updatedAt";
        return [...list].sort((a, b) => {
            // folders first, whatever the sort
            if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
            if (sort.key === "size")
                return ((a.size ?? 0) - (b.size ?? 0)) * dir;
            if (sort.key === "updatedAt")
                return ((a[dateKey] ?? 0) - (b[dateKey] ?? 0)) * dir;
            return a.name.localeCompare(b.name, "vi", { numeric: true }) * dir;
        });
    }, [
        records,
        byId,
        view.kind,
        view.query,
        folderId,
        kindFilter,
        sort,
        inTrash,
    ]);

    const selectedItems = useMemo(
        () => items.filter((item) => selected.has(item.id)),
        [items, selected],
    );
    const previewable = useMemo(
        () =>
            items.filter(
                (item) =>
                    item.type === "file" &&
                    item.file_id != null &&
                    previewKind(item),
            ),
        [items],
    );

    // a different place starts with nothing selected
    useEffect(() => {
        setSelected(new Set());
        setAnchorIndex(null);
        setKindFilter(null);
    }, [view.kind, folderId, view.query]);

    // records can vanish under the selection (another delete, a sync)
    useEffect(() => {
        setSelected((current) => {
            const live = new Set([...current].filter((id) => byId.has(id)));
            return live.size === current.size ? current : live;
        });
    }, [byId]);

    // ----- leaving with unsaved work ---------------------------------------------------

    useEffect(() => {
        const onBeforeUnload = (event) => {
            // read when leaving rather than subscribed to: following every
            // upload's progress would render the whole drive with each one
            const uploading = Store.getState().progress.activeProgress.some(
                (p) => p.type === "UPLOADING" || p.type === "QUEUED",
            );
            if (drive.getSnapshot().dirty || uploading || importsBusy()) {
                event.preventDefault();
                event.returnValue = "";
            }
        };
        window.addEventListener("beforeunload", onBeforeUnload);
        return () => window.removeEventListener("beforeunload", onBeforeUnload);
    }, []);

    // ----- selection --------------------------------------------------------------------

    const onSelect = useCallback(
        (event, item, index) => {
            if (event.shiftKey && anchorIndex !== null) {
                const [from, to] =
                    anchorIndex < index
                        ? [anchorIndex, index]
                        : [index, anchorIndex];
                setSelected(
                    new Set(items.slice(from, to + 1).map((i) => i.id)),
                );
                return;
            }
            if (event.ctrlKey || event.metaKey) {
                setSelected((current) => {
                    const next = new Set(current);
                    if (next.has(item.id)) next.delete(item.id);
                    else next.add(item.id);
                    return next;
                });
            } else {
                setSelected(new Set([item.id]));
            }
            setAnchorIndex(index);
        },
        [anchorIndex, items],
    );

    const open = useCallback(
        (item) => {
            if (item.trashedAt) {
                setNotice({
                    severity: "info",
                    text: "Khôi phục mục này để mở.",
                });
            } else if (item.type === "folder") {
                navigate(`/folder/${item.id}`);
            } else {
                setPreview(item);
            }
        },
        [navigate],
    );

    const onContextMenu = useCallback(
        (event, item, fromButton) => {
            if (!selected.has(item.id)) {
                setSelected(new Set([item.id]));
                setAnchorIndex(items.indexOf(item));
            }
            const rect = fromButton
                ? event.currentTarget.getBoundingClientRect()
                : null;
            setMenu({
                top: rect ? rect.bottom : event.clientY,
                left: rect ? rect.left - 180 : event.clientX,
                // the menu acts on the selection, widened to the clicked item
                ids: selected.has(item.id) ? [...selected] : [item.id],
            });
        },
        [selected, items],
    );

    // ----- actions -----------------------------------------------------------------------

    const menuItems = menu
        ? menu.ids.map((id) => byId.get(id)).filter(Boolean)
        : [];
    // a boolean, so the page renders again only when the answer changes
    const canRetry = useSelector((state) =>
        menuItems.some(
            (item) =>
                item.file_id == null &&
                activeEntry(state, item.id)?.type === "ERROR",
        ),
    );

    async function run(label, fn) {
        setBusy(true);
        try {
            await fn();
        } catch (e) {
            console.log(e);
            setNotice({
                severity: "error",
                text: `${label}: ${describeError(e)}`,
            });
        }
        setBusy(false);
    }

    function act(action, targets = selectedItems) {
        const ids = targets.map((t) => t.id);
        const single = targets.length === 1 ? targets[0] : null;
        switch (action) {
            case "open":
                if (single) open(single);
                break;
            case "download":
                downloadMany(targets);
                break;
            case "retry":
                ids.forEach(retryUpload);
                break;
            case "share":
                if (single) setDialog({ type: "share", id: single.id });
                break;
            case "rename":
                if (single) setDialog({ type: "rename", item: single });
                break;
            case "move":
                setDialog({ type: "move", items: targets });
                break;
            case "star":
            case "unstar":
                drive.setStarred(ids, action === "star");
                break;
            case "locate":
                if (single) {
                    navigate(single.parent ? `/folder/${single.parent}` : "/");
                    setTimeout(() => setSelected(new Set([single.id])), 0);
                }
                break;
            case "details":
                setDetails(true);
                break;
            case "trash":
                drive.trash(ids);
                setSelected(new Set());
                setNotice({
                    severity: "info",
                    text: `Đã chuyển ${targets.length} mục vào thùng rác.`,
                    undo: () => drive.restore(ids),
                });
                break;
            case "restore":
                drive.restore(ids);
                setSelected(new Set());
                setNotice({
                    severity: "success",
                    text: `Đã khôi phục ${targets.length} mục.`,
                });
                break;
            case "deleteForever":
                setDialog({ type: "forever", ids, ...countForever(ids) });
                break;
            default:
        }
    }

    async function confirmForever() {
        await run("Xoá thất bại, chưa có gì bị xoá", async () => {
            if (dialog.all) await emptyTrash();
            else await deleteForever(dialog.ids);
            setSelected(new Set());
            setNotice({ severity: "success", text: "Đã xoá vĩnh viễn." });
        });
        setDialog(null);
    }

    function onDropOnFolder(target, event) {
        const ids = JSON.parse(event.dataTransfer.getData(DRAG_TYPE) || "[]");
        if (!ids.length) return;
        if (target === "/trash") {
            act("trash", ids.map((id) => byId.get(id)).filter(Boolean));
            return;
        }
        const destination = target === "/" ? null : target;
        const moved = drive.move(ids, destination);
        if (moved.length) {
            const name = destination
                ? byId.get(destination)?.name
                : "Drive của tôi";
            setNotice({
                severity: "success",
                text: `Đã chuyển ${moved.length} mục vào “${name}”.`,
            });
        }
    }

    function onDragStartItem(event, item) {
        const ids = selected.has(item.id) ? [...selected] : [item.id];
        if (!selected.has(item.id)) setSelected(new Set([item.id]));
        event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(ids));
        event.dataTransfer.effectAllowed = "move";
    }

    // ----- uploads ---------------------------------------------------------------------------

    // what Telegram would send as a photo or a playable video
    const isMedia = (entry) =>
        /^image\/(jpeg|png)$|^video\/(mp4|quicktime|x-m4v)$/.test(
            (entry instanceof File ? entry : entry.file).type,
        );

    /**
     * One upload of picked or dropped files. A big folder arrives in batches
     * while it is still being read (scanProgress), so uploading starts after
     * the first hundred files instead of after the last. The questions, send
     * as media and what to do with names already taken, are asked once and
     * the answer kept for every batch after.
     */
    function newRun() {
        return {
            // fixed now; the user may browse away meanwhile
            target: uploadTarget,
            found: 0,
            media: 0,
            // the whole folder is read, so `found` and `media` are final
            scanned: false,
            asMedia: undefined,
            removeOriginal: false,
            choice: undefined,
            stopped: false,
            stop: null,
            counts: {
                queued: 0,
                resumed: 0,
                replaced: 0,
                renamed: 0,
                skipped: 0,
            },
            // batches go one after another, so folders made by one are found
            // by the next
            chain: Promise.resolve(),
        };
    }

    function stopRun(run) {
        run.stopped = true;
        run.stop?.();
    }

    function addBatch(run, entries) {
        run.found += entries.length;
        run.media += entries.filter(isMedia).length;
        run.chain = run.chain
            .then(() => sendBatch(run, entries))
            .catch((err) => {
                stopRun(run);
                endRun(run);
                setNotice({ severity: "error", text: describeError(err) });
            });
    }

    // a run stopped partway still says what its earlier batches queued
    function stopAndReport(run) {
        if (run.stopped) return;
        stopRun(run);
        finishRun(run);
    }

    async function sendBatch(run, entries) {
        if (run.stopped) return;
        // the rest of the scan goes on out of the way of the uploads
        setScanning((now) =>
            now?.phase === "reading" ? { ...now, phase: "background" } : now,
        );
        // only files picked with a handle (Chrome, Edge) can be deleted after
        const removable = entries.some((entry) => entry.handle);
        if (run.asMedia === undefined && (entries.some(isMedia) || removable)) {
            const answer = await new Promise((resolve) =>
                setDialog({
                    type: "uploadMode",
                    // while the folder is still read the counts are not
                    // final, so the dialog leaves them out
                    total: run.scanned ? run.found : null,
                    mediaCount: run.scanned ? run.media : null,
                    hasMedia: entries.some(isMedia),
                    removable,
                    resolve,
                }),
            );
            if (answer == null) {
                stopAndReport(run);
                return;
            }
            // "Dừng" may have been clicked while the question was open
            if (run.stopped) return;
            run.asMedia = answer.asMedia;
            run.removeOriginal = answer.removeOriginal;
        }
        // the first batch is still inside the click; a later one with roots
        // of its own is refused without it, and its files stay
        if (run.removeOriginal) await askToWrite(entries, run);
        const counts = await uploadEntries(entries, run.target, {
            asMedia: run.asMedia ?? false,
            removeOriginal: run.removeOriginal,
            onConflict: async (list) => {
                if (run.choice) return run.choice;
                const choice = await new Promise((resolve) =>
                    setConflict({ list, resolve }),
                );
                if (run.stopped) return "cancel";
                run.choice = choice;
                if (choice === "cancel") stopAndReport(run);
                return choice;
            },
        });
        for (const key of Object.keys(run.counts))
            run.counts[key] += counts[key];
    }

    /** The run no longer needs the scan dialog, nor holds back new ones. */
    function endRun(run) {
        if (activeRun.current !== run) return;
        activeRun.current = null;
        setScanning(null);
    }

    function finishRun(run) {
        endRun(run);
        const { queued, resumed, replaced, renamed, skipped } = run.counts;
        const { target } = run;
        // what the banner offered to resume may have just been picked up
        if (resumed || skipped) setResumeScan((n) => n + 1);
        const going = queued + replaced + renamed;
        if (!going && !resumed && !skipped) return;
        if (target && !resumed && !skipped && !replaced && !renamed) return;
        const text = [
            going &&
                `đang tải ${going} tệp lên${target ? "" : " Drive của tôi"}`,
            replaced && `${replaced} tệp sẽ thay bản cũ`,
            renamed && `${renamed} tệp được đổi tên để giữ cả hai`,
            resumed && `tải tiếp ${resumed} tệp đang dở`,
            skipped && `bỏ qua ${skipped} tệp`,
        ]
            .filter(Boolean)
            .join(", ");
        setNotice({
            severity: "info",
            text: `${text[0].toUpperCase()}${text.slice(1)}.`,
        });
    }

    /**
     * A scan for files about to be read, reporting into the scan dialog and
     * handing what it finds to an upload run as it goes. show() opens the
     * dialog; until then the counts are kept quietly. finish() is for once
     * the walk is done, and does nothing after "Huỷ".
     */
    function newScan() {
        const run = newRun();
        activeRun.current = run;
        const scan = scanProgress(
            (seen) => setScanning((now) => (now ? { ...now, ...seen } : now)),
            (entries) => addBatch(run, entries),
        );
        // stopping the run, e.g. "Huỷ tải lên" on a name conflict, also
        // stops reading the rest
        run.stop = () => scan.cancel();
        const cancel = () => stopAndReport(run);
        scan.show = () =>
            setScanning({ phase: "reading", files: 0, bytes: 0, cancel });
        // the walk may have finished just before the click reached it
        scan.finish = () => {
            run.scanned = true;
            if (!run.stopped)
                run.chain.then(() => {
                    if (!run.stopped) finishRun(run);
                });
        };
        // what was handed over before the error keeps uploading; the rest
        // of the walk stops
        scan.fail = (err) => {
            if (isAbort(err)) {
                endRun(run);
                return;
            }
            stopRun(run);
            run.chain.then(() => {
                endRun(run);
                setNotice({ severity: "error", text: describeError(err) });
            });
        };
        return scan;
    }

    // One upload at a time: a second one would share the scan note and the
    // questions with the first. Says so, and is false, while one runs.
    function canStartRun() {
        if (!activeRun.current) return true;
        setNotice({
            severity: "warning",
            text: "Đang quét và đưa lên các tệp vừa chọn. Đợi xong rồi thêm tiếp nhé.",
        });
        return false;
    }

    /** Files that came all at once, from an <input>. */
    function startUpload(entries) {
        if (!entries.length || !canStartRun()) return;
        const run = newRun();
        run.scanned = true;
        activeRun.current = run;
        addBatch(run, entries);
        run.chain.then(() => {
            if (!run.stopped) finishRun(run);
        });
    }

    // Chrome and Edge get the File System Access pickers, whose handles let a
    // closed tab resume without picking again; others keep the <input>
    function openPicker(folder) {
        if (!canKeepHandles) {
            (folder ? folderInput : fileInput).current?.click();
            return;
        }
        if (!canStartRun()) return;
        const scan = newScan();
        (folder ? pickFolder : pickFiles)({ onPicked: scan.show, scan }).then(
            scan.finish,
            scan.fail,
        );
    }

    function onPickFiles(event) {
        startUpload(Array.from(event.target.files ?? []));
        event.target.value = "";
    }

    const attachFolderInput = useCallback((node) => {
        folderInput.current = node;
        // React has no prop for a directory picker and warns about the unknown
        // attribute, so set it on the node once the input mounts.
        if (node) {
            node.setAttribute("webkitdirectory", "");
            node.setAttribute("directory", "");
        }
    }, []);

    const externalDrag = (event) => event.dataTransfer.types.includes("Files");

    const dropHandlers = inTrash
        ? {}
        : {
              onDragEnter: (e) => {
                  if (!externalDrag(e)) return;
                  dragDepth.current += 1;
                  setDropping(true);
              },
              onDragLeave: (e) => {
                  if (!externalDrag(e)) return;
                  dragDepth.current -= 1;
                  if (dragDepth.current <= 0) setDropping(false);
              },
              onDragOver: (e) => {
                  if (externalDrag(e)) e.preventDefault();
              },
              onDrop: (e) => {
                  if (!externalDrag(e)) return;
                  e.preventDefault();
                  dragDepth.current = 0;
                  setDropping(false);
                  if (!canStartRun()) return;
                  const scan = newScan();
                  scan.show();
                  readDrop(e.dataTransfer, scan).then(scan.finish, scan.fail);
              },
          };

    // ----- keyboard ----------------------------------------------------------------------------

    useEffect(() => {
        const onKey = (event) => {
            if (dialog || preview || menu) return;
            const tag = event.target.tagName;
            if (tag === "INPUT" || tag === "TEXTAREA") return;
            if (
                (event.ctrlKey || event.metaKey) &&
                event.key.toLowerCase() === "a"
            ) {
                event.preventDefault();
                setSelected(new Set(items.map((i) => i.id)));
            } else if (event.key === "Escape") {
                setSelected(new Set());
            } else if (event.key === "Delete" && selectedItems.length) {
                act(inTrash ? "deleteForever" : "trash");
            } else if (
                event.key === "F2" &&
                selectedItems.length === 1 &&
                !inTrash
            ) {
                event.preventDefault();
                act("rename");
            } else if (event.key === "Enter" && selectedItems.length === 1) {
                open(selectedItems[0]);
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    });

    // ----- account menu ---------------------------------------------------------------------------

    function onAccountAction(action) {
        if (action === "logout") logout();
        else if (action === "password") setDialog({ type: "password" });
        else if (action === "logoutOthers") {
            run("Không đăng xuất được", async () => {
                await logoutOthers();
                setNotice({
                    severity: "success",
                    text: "Đã đăng xuất khỏi các thiết bị khác.",
                });
            });
        } else if (action === "unlink") setDialog({ type: "unlink" });
    }

    // ----- layout ----------------------------------------------------------------------------------

    if (view.kind === "unknown") return <Navigate to="/" replace />;
    if (
        view.kind === "folder" &&
        folderId &&
        records.length &&
        !currentFolder
    ) {
        return <Navigate to="/" replace />;
    }

    const crumbs = view.kind === "folder" ? pathTo(byId, folderId) : [];
    const locationOf =
        view.kind === "folder"
            ? undefined
            : (item) =>
                  item.parent
                      ? byId.get(item.parent)?.name ?? "—"
                      : "Drive của tôi";

    const openDropbox = () =>
        setDialog({
            type: "dropbox",
            target: uploadTarget,
            targetName: currentFolder
                ? `“${currentFolder.name}”`
                : "Drive của tôi",
        });

    const sidebar = (
        <Sidebar
            onNewFolder={() => setDialog({ type: "newFolder" })}
            onUploadFiles={() => openPicker(false)}
            onUploadFolder={() => openPicker(true)}
            onImportDropbox={openDropbox}
            onNavigate={() => setNavOpen(false)}
            onDropOn={onDropOnFolder}
        />
    );

    const listProps = {
        items,
        selected,
        sort,
        onSort:
            view.kind === "recent"
                ? undefined
                : (key) =>
                      setSort((s) => ({
                          key,
                          dir:
                              s.key === key && s.dir === "asc" ? "desc" : "asc",
                      })),
        locationOf,
        dateField: inTrash ? "trashedAt" : "updatedAt",
        onSelect,
        onOpen: open,
        onContextMenu,
        onDragStartItem: inTrash ? undefined : onDragStartItem,
        onDropOnFolder: inTrash ? undefined : onDropOnFolder,
    };

    return (
        <Box
            sx={{
                height: "100vh",
                display: "flex",
                flexDirection: "column",
                bgcolor: "background.default",
            }}
        >
            <TopBar
                onMenu={() => setNavOpen(true)}
                mode={mode}
                onToggleMode={onToggleMode}
                onAccountAction={onAccountAction}
            />
            <Box sx={{ flex: 1, display: "flex", minHeight: 0 }}>
                {desktop ? (
                    sidebar
                ) : (
                    <Drawer open={navOpen} onClose={() => setNavOpen(false)}>
                        <Box
                            sx={{
                                pt: 2,
                                height: "100%",
                                bgcolor: "background.default",
                            }}
                        >
                            {sidebar}
                        </Box>
                    </Drawer>
                )}
                <Box
                    {...dropHandlers}
                    onClick={() => setSelected(new Set())}
                    onContextMenu={(e) => {
                        if (inTrash || e.defaultPrevented) return;
                        e.preventDefault();
                        setNewMenu({ top: e.clientY, left: e.clientX });
                    }}
                    sx={{
                        flex: 1,
                        minWidth: 0,
                        bgcolor: "background.paper",
                        borderRadius: { md: 4 },
                        mr: { md: 2 },
                        mb: { md: 2 },
                        display: "flex",
                        flexDirection: "column",
                        position: "relative",
                        overflow: "hidden",
                    }}
                >
                    {/* header: title or breadcrumbs, view switches */}
                    <Stack
                        direction="row"
                        alignItems="center"
                        spacing={1}
                        sx={{
                            px: { xs: 2, md: 3 },
                            pt: 2,
                            pb: 1,
                            minHeight: 64,
                        }}
                    >
                        <Box sx={{ flex: 1, minWidth: 0 }}>
                            {view.kind === "folder" ? (
                                <Breadcrumbs
                                    separator={<ChevronRightIcon />}
                                    maxItems={4}
                                    itemsAfterCollapse={2}
                                >
                                    <FolderCrumb
                                        label="Drive của tôi"
                                        current={!folderId}
                                        onClick={() => navigate("/")}
                                        onDrop={(e) => onDropOnFolder("/", e)}
                                        onMenu={(e) =>
                                            setNewMenu({
                                                top: e.currentTarget.getBoundingClientRect()
                                                    .bottom,
                                                left: e.currentTarget.getBoundingClientRect()
                                                    .left,
                                            })
                                        }
                                    />
                                    {crumbs.map((folder, index) => (
                                        <FolderCrumb
                                            key={folder.id}
                                            label={folder.name}
                                            current={
                                                index === crumbs.length - 1
                                            }
                                            onClick={() =>
                                                navigate(`/folder/${folder.id}`)
                                            }
                                            onDrop={(e) =>
                                                onDropOnFolder(folder.id, e)
                                            }
                                            onMenu={(e) =>
                                                setNewMenu({
                                                    top: e.currentTarget.getBoundingClientRect()
                                                        .bottom,
                                                    left: e.currentTarget.getBoundingClientRect()
                                                        .left,
                                                })
                                            }
                                        />
                                    ))}
                                </Breadcrumbs>
                            ) : (
                                <Typography
                                    variant="h5"
                                    component="h1"
                                    noWrap
                                    sx={{ fontWeight: 400 }}
                                >
                                    {view.kind === "search"
                                        ? `Kết quả cho “${view.query}”`
                                        : VIEWS[view.kind].title}
                                </Typography>
                            )}
                        </Box>
                        <ToggleButtonGroup
                            size="small"
                            exclusive
                            value={layout}
                            onChange={(_, value) => {
                                if (!value) return;
                                setLayout(value);
                                writePref("cloudgram.layout", value);
                            }}
                            sx={{
                                "& .MuiToggleButton-root": {
                                    px: 1.5,
                                    borderRadius: 999,
                                },
                                "& .Mui-selected": {
                                    bgcolor: "action.selected !important",
                                },
                            }}
                        >
                            <ToggleButton
                                value="list"
                                aria-label="Bố cục danh sách"
                            >
                                <ViewListIcon fontSize="small" />
                            </ToggleButton>
                            <ToggleButton value="grid" aria-label="Bố cục lưới">
                                <GridViewIcon fontSize="small" />
                            </ToggleButton>
                        </ToggleButtonGroup>
                        <Tooltip title="Xem thông tin chi tiết">
                            <IconButton
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setDetails(!details);
                                }}
                            >
                                <InfoOutlinedIcon
                                    color={details ? "primary" : "inherit"}
                                />
                            </IconButton>
                        </Tooltip>
                    </Stack>

                    {/* filter chips, or the selection toolbar while something is selected */}
                    <Box
                        sx={{ px: { xs: 2, md: 3 }, pb: 1.5, minHeight: 48 }}
                        onClick={(e) => e.stopPropagation()}
                    >
                        {selectedItems.length ? (
                            <Stack
                                direction="row"
                                alignItems="center"
                                spacing={0.5}
                                sx={{
                                    bgcolor: (t) =>
                                        t.palette.mode === "light"
                                            ? "#e9eef6"
                                            : "#282a2c",
                                    borderRadius: 999,
                                    px: 1,
                                    height: 40,
                                }}
                            >
                                <IconButton
                                    size="small"
                                    onClick={() => setSelected(new Set())}
                                    aria-label="Bỏ chọn"
                                >
                                    <CloseIcon fontSize="small" />
                                </IconButton>
                                <Typography variant="body2" sx={{ pr: 1 }}>
                                    Đã chọn {selectedItems.length}
                                </Typography>
                                {inTrash ? (
                                    <>
                                        <ToolbarButton
                                            title="Khôi phục"
                                            icon={
                                                <RestoreFromTrashOutlinedIcon fontSize="small" />
                                            }
                                            onClick={() => act("restore")}
                                        />
                                        <ToolbarButton
                                            title="Xoá vĩnh viễn"
                                            icon={
                                                <DeleteForeverOutlinedIcon fontSize="small" />
                                            }
                                            onClick={() => act("deleteForever")}
                                        />
                                    </>
                                ) : (
                                    <>
                                        <ToolbarButton
                                            title="Tải xuống"
                                            icon={
                                                <FileDownloadOutlinedIcon fontSize="small" />
                                            }
                                            disabled={
                                                !selectedItems.some(
                                                    (i) =>
                                                        i.type === "file" &&
                                                        i.file_id != null,
                                                )
                                            }
                                            onClick={() => act("download")}
                                        />
                                        <ToolbarButton
                                            title="Di chuyển"
                                            icon={
                                                <DriveFileMoveOutlinedIcon fontSize="small" />
                                            }
                                            onClick={() => act("move")}
                                        />
                                        <ToolbarButton
                                            title={
                                                selectedItems.every(
                                                    (i) => i.starred,
                                                )
                                                    ? "Bỏ gắn dấu sao"
                                                    : "Gắn dấu sao"
                                            }
                                            icon={
                                                <StarBorderIcon fontSize="small" />
                                            }
                                            onClick={() =>
                                                act(
                                                    selectedItems.every(
                                                        (i) => i.starred,
                                                    )
                                                        ? "unstar"
                                                        : "star",
                                                )
                                            }
                                        />
                                        <ToolbarButton
                                            title="Chuyển vào thùng rác"
                                            icon={
                                                <DeleteOutlineIcon fontSize="small" />
                                            }
                                            onClick={() => act("trash")}
                                        />
                                        <ToolbarButton
                                            title="Thao tác khác"
                                            icon={
                                                <MoreVertIcon fontSize="small" />
                                            }
                                            onClick={(e) => {
                                                const rect =
                                                    e.currentTarget.getBoundingClientRect();
                                                setMenu({
                                                    top: rect.bottom,
                                                    left: rect.left,
                                                    ids: selectedItems.map(
                                                        (i) => i.id,
                                                    ),
                                                });
                                            }}
                                        />
                                    </>
                                )}
                            </Stack>
                        ) : (
                            <Stack
                                direction="row"
                                spacing={1}
                                alignItems="center"
                            >
                                <Chip
                                    label={
                                        kindFilter
                                            ? KIND_FILTERS.find(
                                                  (k) => k.kind === kindFilter,
                                              )?.label
                                            : "Loại"
                                    }
                                    onClick={(e) =>
                                        setFilterMenu(e.currentTarget)
                                    }
                                    onDelete={
                                        kindFilter
                                            ? () => setKindFilter(null)
                                            : undefined
                                    }
                                    deleteIcon={
                                        kindFilter ? undefined : (
                                            <ArrowDropDownIcon />
                                        )
                                    }
                                    variant={kindFilter ? "filled" : "outlined"}
                                    color={kindFilter ? "secondary" : "default"}
                                    sx={{ borderRadius: 2 }}
                                />
                                {inTrash && items.length > 0 && (
                                    <>
                                        <Typography
                                            variant="body2"
                                            color="text.secondary"
                                            sx={{
                                                flex: 1,
                                                display: {
                                                    xs: "none",
                                                    sm: "block",
                                                },
                                            }}
                                        >
                                            Các mục trong thùng rác vẫn còn trên
                                            Telegram cho tới khi bị xoá vĩnh
                                            viễn.
                                        </Typography>
                                        <Button
                                            onClick={() => {
                                                const ids = records
                                                    .filter((r) => r.trashedAt)
                                                    .map((r) => r.id);
                                                setDialog({
                                                    type: "forever",
                                                    all: true,
                                                    ...countForever(ids),
                                                });
                                            }}
                                        >
                                            Dọn sạch thùng rác
                                        </Button>
                                    </>
                                )}
                            </Stack>
                        )}
                    </Box>

                    <ResumeBanner key={resumeScan} onNotice={setNotice} />

                    {/* the items */}
                    <Box
                        ref={marquee.ref}
                        onMouseDown={marquee.onMouseDown}
                        sx={{
                            position: "relative",
                            flex: 1,
                            minHeight: 0,
                            overflow: "auto",
                            px: { xs: 1, md: 2 },
                        }}
                    >
                        {marquee.box && (
                            <Box
                                sx={{
                                    position: "absolute",
                                    ...marquee.box,
                                    border: 1,
                                    borderColor: "primary.main",
                                    bgcolor: "rgba(11,87,208,.12)",
                                    pointerEvents: "none",
                                    zIndex: 2,
                                }}
                            />
                        )}
                        {items.length ? (
                            layout === "list" ? (
                                <ItemList {...listProps} />
                            ) : (
                                <Box sx={{ px: 1 }}>
                                    <ItemGrid {...listProps} />
                                </Box>
                            )
                        ) : (
                            <EmptyState
                                view={view}
                                onUpload={() => openPicker(false)}
                            />
                        )}
                    </Box>

                    {dropping && (
                        <Box
                            sx={{
                                position: "absolute",
                                inset: 0,
                                border: 2,
                                borderColor: "primary.main",
                                borderRadius: { md: 4 },
                                bgcolor: "rgba(11,87,208,.08)",
                                pointerEvents: "none",
                                display: "flex",
                                alignItems: "flex-end",
                                justifyContent: "center",
                                pb: 6,
                            }}
                        >
                            <Stack
                                direction="row"
                                spacing={1.5}
                                alignItems="center"
                                sx={{
                                    bgcolor: "primary.main",
                                    color: "#fff",
                                    px: 3,
                                    py: 1.5,
                                    borderRadius: 999,
                                }}
                            >
                                <CloudUploadOutlinedIcon />
                                <Typography>
                                    Thả tệp để tải lên{" "}
                                    {currentFolder
                                        ? `“${currentFolder.name}”`
                                        : "Drive của tôi"}
                                </Typography>
                            </Stack>
                        </Box>
                    )}
                </Box>
                {details &&
                    (desktop ? (
                        <Box
                            sx={{
                                bgcolor: "background.paper",
                                borderRadius: 4,
                                mr: 2,
                                mb: 2,
                                overflow: "hidden",
                            }}
                        >
                            <DetailsPanel
                                items={selectedItems}
                                folderName={
                                    currentFolder?.name ??
                                    VIEWS[view.kind].title
                                }
                                onClose={() => setDetails(false)}
                            />
                        </Box>
                    ) : (
                        <Drawer
                            anchor="bottom"
                            open
                            onClose={() => setDetails(false)}
                            PaperProps={{
                                sx: {
                                    height: "70vh",
                                    borderRadius: "16px 16px 0 0",
                                },
                            }}
                        >
                            <DetailsPanel
                                items={selectedItems}
                                folderName={
                                    currentFolder?.name ??
                                    VIEWS[view.kind].title
                                }
                                onClose={() => setDetails(false)}
                            />
                        </Drawer>
                    ))}
            </Box>

            {!desktop && !inTrash && (
                <Fab
                    color="secondary"
                    sx={{
                        position: "fixed",
                        right: 16,
                        bottom: 24,
                        borderRadius: 4,
                        width: 56,
                        height: 56,
                    }}
                    onClick={(e) =>
                        setNewMenu({
                            top:
                                e.currentTarget.getBoundingClientRect().top -
                                140,
                            left:
                                e.currentTarget.getBoundingClientRect().left -
                                160,
                        })
                    }
                    aria-label="Mới"
                >
                    <AddIcon />
                </Fab>
            )}

            <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                onChange={onPickFiles}
            />
            <input
                ref={attachFolderInput}
                type="file"
                multiple
                hidden
                onChange={onPickFiles}
            />

            <NewMenu
                anchor={
                    newMenu
                        ? {
                              getBoundingClientRect: () =>
                                  DOMRect.fromRect({
                                      x: newMenu.left,
                                      y: newMenu.top,
                                      width: 0,
                                      height: 0,
                                  }),
                              nodeType: 1,
                          }
                        : null
                }
                onClose={() => setNewMenu(null)}
                onNewFolder={() => setDialog({ type: "newFolder" })}
                onUploadFiles={() => openPicker(false)}
                onUploadFolder={() => openPicker(true)}
                onImportDropbox={openDropbox}
            />

            <Menu
                anchorEl={filterMenu}
                open={Boolean(filterMenu)}
                onClose={() => setFilterMenu(null)}
            >
                {KIND_FILTERS.map((k) => (
                    <MenuItem
                        key={k.kind}
                        selected={kindFilter === k.kind}
                        onClick={() => {
                            setKindFilter(k.kind);
                            setFilterMenu(null);
                        }}
                    >
                        {k.label}
                    </MenuItem>
                ))}
            </Menu>

            <ItemMenu
                position={
                    menu
                        ? { top: menu.top, left: Math.max(8, menu.left) }
                        : null
                }
                items={menuItems}
                inTrash={inTrash}
                showLocate={view.kind !== "folder" && !inTrash}
                canRetry={canRetry}
                onClose={() => setMenu(null)}
                onAction={(action) => act(action, menuItems)}
            />

            <NameDialog
                open={dialog?.type === "newFolder"}
                title="Thư mục mới"
                initial="Thư mục không có tiêu đề"
                confirmLabel="Tạo"
                onClose={() => setDialog(null)}
                onSubmit={(name) => {
                    drive.createFolder(name, uploadTarget);
                    setDialog(null);
                }}
            />
            <NameDialog
                open={dialog?.type === "rename"}
                title="Đổi tên"
                initial={dialog?.item?.name}
                onClose={() => setDialog(null)}
                onSubmit={(name) => {
                    drive.rename(dialog.item.id, name);
                    setDialog(null);
                }}
            />
            <MoveDialog
                open={dialog?.type === "move"}
                items={dialog?.items ?? []}
                onClose={() => setDialog(null)}
                onMove={(target) => {
                    const moved = drive.move(
                        dialog.items.map((i) => i.id),
                        target,
                    );
                    setDialog(null);
                    setNotice({
                        severity: "success",
                        text: `Đã di chuyển ${moved.length} mục.`,
                    });
                }}
            />
            <ConfirmDialog
                open={dialog?.type === "forever"}
                title={dialog?.all ? "Dọn sạch thùng rác?" : "Xoá vĩnh viễn?"}
                body={
                    dialog?.type === "forever"
                        ? `${dialog.files} tệp và ${dialog.folders} thư mục sẽ bị xoá khỏi Telegram Saved Messages. Không thể hoàn tác.`
                        : ""
                }
                confirmLabel="Xoá vĩnh viễn"
                danger
                busy={busy}
                onConfirm={confirmForever}
                onClose={() => setDialog(null)}
            />
            <ConfirmDialog
                open={dialog?.type === "unlink"}
                title="Huỷ liên kết Telegram?"
                body={
                    "Phiên Telegram sẽ bị đăng xuất trên mọi thiết bị và xoá khỏi máy chủ.\n" +
                    "Tệp và thư mục vẫn còn; đăng nhập lại đúng tài khoản Telegram đó để dùng tiếp."
                }
                confirmLabel="Huỷ liên kết"
                danger
                busy={busy}
                onConfirm={() =>
                    run("Không huỷ liên kết được", async () => {
                        await unlinkTelegram();
                        setDialog(null);
                    })
                }
                onClose={() => setDialog(null)}
            />
            <PasswordDialog
                open={dialog?.type === "password"}
                onClose={() => setDialog(null)}
                onDone={() => {
                    setDialog(null);
                    setNotice({
                        severity: "success",
                        text: "Đã đổi mật khẩu.",
                    });
                }}
            />
            <ShareDialog
                open={dialog?.type === "share"}
                id={dialog?.id}
                onClose={() => setDialog(null)}
                onNotice={(text) => setNotice({ severity: "success", text })}
            />
            <DropboxDialog
                open={dialog?.type === "dropbox"}
                target={dialog?.target ?? null}
                targetName={dialog?.targetName}
                onClose={() => setDialog(null)}
            />
            <UploadModeDialog
                open={dialog?.type === "uploadMode"}
                // null while the folder is still read: no count shown yet
                total={dialog?.total}
                mediaCount={dialog?.mediaCount}
                hasMedia={dialog?.hasMedia}
                removable={dialog?.removable}
                onClose={() => {
                    dialog?.resolve(null);
                    setDialog(null);
                }}
                onStart={(answer) => {
                    dialog.resolve(answer);
                    setDialog(null);
                }}
            />

            <ScanDialog scan={scanning} />

            <UploadConflictDialog
                conflicts={conflict?.list}
                onChoose={(choice) => {
                    conflict?.resolve(choice);
                    setConflict(null);
                }}
            />

            <PreviewDialog
                item={preview}
                siblings={previewable}
                onClose={() => setPreview(null)}
                onNavigate={setPreview}
                // from the bin there is nothing to star, share or bin again
                onAction={
                    inTrash
                        ? undefined
                        : (action, target) => act(action, [target])
                }
            />
            <TransferPanel />

            <Snackbar
                open={Boolean(notice)}
                autoHideDuration={notice?.severity === "error" ? 10000 : 5000}
                onClose={(_, reason) =>
                    reason !== "clickaway" && setNotice(null)
                }
                anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
            >
                <Alert
                    severity={notice?.severity}
                    variant="filled"
                    onClose={() => setNotice(null)}
                    action={
                        notice?.undo ? (
                            <Button
                                color="inherit"
                                size="small"
                                onClick={() => {
                                    notice.undo();
                                    setNotice(null);
                                }}
                            >
                                Hoàn tác
                            </Button>
                        ) : undefined
                    }
                >
                    {notice?.text}
                </Alert>
            </Snackbar>
        </Box>
    );
}

DriveApp.propTypes = {
    mode: PropTypes.string,
    onToggleMode: PropTypes.func,
};

function ToolbarButton({ title, icon, onClick, disabled }) {
    return (
        <Tooltip title={title}>
            <span>
                <IconButton
                    size="small"
                    onClick={onClick}
                    disabled={disabled}
                    aria-label={title}
                >
                    {icon}
                </IconButton>
            </span>
        </Tooltip>
    );
}

ToolbarButton.propTypes = {
    title: PropTypes.string,
    icon: PropTypes.node,
    onClick: PropTypes.func,
    disabled: PropTypes.bool,
};

function FolderCrumb({ label, current, onClick, onDrop, onMenu }) {
    const [over, setOver] = useState(false);
    const dropProps = {
        onDragOver: (e) => {
            if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
            e.preventDefault();
            setOver(true);
        },
        onDragLeave: () => setOver(false),
        onDrop: (e) => {
            setOver(false);
            if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
            e.preventDefault();
            e.stopPropagation();
            onDrop(e);
        },
    };
    if (current) {
        return (
            <Button
                color="inherit"
                endIcon={<ArrowDropDownIcon />}
                onClick={(e) => {
                    e.stopPropagation();
                    onMenu(e);
                }}
                {...dropProps}
                sx={{
                    fontSize: 22,
                    fontWeight: 400,
                    px: 1.5,
                    ml: -1.5,
                    outline: over ? 2 : 0,
                    outlineColor: "primary.main",
                }}
            >
                {label}
            </Button>
        );
    }
    return (
        <Link
            component="button"
            underline="none"
            color="text.secondary"
            onClick={(e) => {
                e.stopPropagation();
                onClick();
            }}
            {...dropProps}
            sx={{
                fontSize: 22,
                px: 1,
                py: 0.5,
                borderRadius: 999,
                outline: over ? 2 : 0,
                outlineColor: "primary.main",
                "&:hover": { bgcolor: "action.hover" },
            }}
        >
            {label}
        </Link>
    );
}

FolderCrumb.propTypes = {
    label: PropTypes.string,
    current: PropTypes.bool,
    onClick: PropTypes.func,
    onDrop: PropTypes.func,
    onMenu: PropTypes.func,
};

function EmptyState({ view, onUpload }) {
    return (
        <Stack
            alignItems="center"
            justifyContent="center"
            spacing={2}
            sx={{ height: "100%", minHeight: 320, textAlign: "center", px: 3 }}
        >
            {view.kind === "folder" ? (
                <CloudUploadOutlinedIcon
                    sx={{ fontSize: 96, color: "text.disabled" }}
                />
            ) : (
                <FolderOpenOutlinedIcon
                    sx={{ fontSize: 96, color: "text.disabled" }}
                />
            )}
            <Typography variant="h6" fontWeight={400}>
                {view.kind === "folder"
                    ? "Chưa có gì ở đây"
                    : VIEWS[view.kind]?.title}
            </Typography>
            <Typography color="text.secondary">
                {VIEWS[view.kind]?.empty}
            </Typography>
            {view.kind === "folder" && (
                <Button
                    variant="outlined"
                    onClick={onUpload}
                    startIcon={<CloudUploadOutlinedIcon />}
                >
                    Tải tệp lên
                </Button>
            )}
        </Stack>
    );
}

EmptyState.propTypes = {
    view: PropTypes.object,
    onUpload: PropTypes.func,
};

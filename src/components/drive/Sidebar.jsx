import { useMemo, useState } from "react";
import PropTypes from "prop-types";
import { useLocation, useNavigate } from "react-router-dom";

import {
    Box,
    Button,
    Checkbox,
    CircularProgress,
    Collapse,
    Divider,
    List,
    ListItemButton,
    ListItemIcon,
    ListItemText,
    Menu,
    MenuItem,
    Typography,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import CreateNewFolderOutlinedIcon from "@mui/icons-material/CreateNewFolderOutlined";
import UploadFileOutlinedIcon from "@mui/icons-material/UploadFileOutlined";
import DriveFolderUploadOutlinedIcon from "@mui/icons-material/DriveFolderUploadOutlined";
import CloudDownloadOutlinedIcon from "@mui/icons-material/CloudDownloadOutlined";
import HomeOutlinedIcon from "@mui/icons-material/HomeOutlined";
import AddToDriveOutlinedIcon from "@mui/icons-material/AddToDriveOutlined";
import ScheduleOutlinedIcon from "@mui/icons-material/ScheduleOutlined";
import StarBorderIcon from "@mui/icons-material/StarBorder";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import CloudOutlinedIcon from "@mui/icons-material/CloudOutlined";
import LabelOutlinedIcon from "@mui/icons-material/LabelOutlined";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import BackupOutlinedIcon from "@mui/icons-material/BackupOutlined";

import LabelsDialog from "./LabelsDialog";
import { describeError } from "../../services/api";
import { flush, useDrive } from "../../services/drive";
import { backupNow } from "../../services/treeBackup";
import { formatSize } from "../../utils/format";

const NAV = [
    {
        to: "/",
        label: "Drive của tôi",
        icon: AddToDriveOutlinedIcon,
        match: (p) => p === "/" || p.startsWith("/folder/"),
    },
    { to: "/recent", label: "Gần đây", icon: ScheduleOutlinedIcon },
    { to: "/starred", label: "Có gắn dấu sao", icon: StarBorderIcon },
    // not a page of its own: opens the list of labels
    { to: "/label", label: "Nhãn", icon: LabelOutlinedIcon, labels: true },
    { to: "/trash", label: "Thùng rác", icon: DeleteOutlineIcon },
];

const rowSx = {
    borderRadius: 999,
    height: 32,
    mb: 0.25,
    "&.Mui-selected": { bgcolor: "action.selected", fontWeight: 600 },
};

/** "Nhãn" with an arrow that opens the labels made so far, then "Chỉnh sửa nhãn". */
function LabelsNav({ pathname, go }) {
    const { labels } = useDrive();
    const [open, setOpen] = useState(() => pathname.startsWith("/label/"));
    const [editing, setEditing] = useState(false);
    // /label/<id>,<id>: the labels ticked; an item has to carry all of them
    const ticked = pathname.startsWith("/label/")
        ? pathname.slice("/label/".length).split(",").filter(Boolean)
        : [];
    const toggle = (id) => {
        const next = ticked.includes(id)
            ? ticked.filter((x) => x !== id)
            : [...ticked, id];
        go(next.length ? `/label/${next.join(",")}` : "/");
    };
    return (
        <>
            <ListItemButton
                onClick={() => setOpen(!open)}
                aria-expanded={open}
                sx={rowSx}
            >
                <ListItemIcon sx={{ minWidth: 40 }}>
                    <LabelOutlinedIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText
                    primary="Nhãn"
                    primaryTypographyProps={{ fontSize: 14 }}
                />
                {open ? (
                    <ExpandLessIcon fontSize="small" />
                ) : (
                    <ExpandMoreIcon fontSize="small" />
                )}
            </ListItemButton>
            <Collapse in={open} unmountOnExit>
                <List dense disablePadding>
                    {labels.map((label) => (
                        <ListItemButton
                            key={label.id}
                            selected={ticked.includes(label.id)}
                            onClick={() => toggle(label.id)}
                            sx={{ ...rowSx, pl: 2 }}
                        >
                            <ListItemIcon sx={{ minWidth: 40 }}>
                                <Checkbox
                                    edge="start"
                                    size="small"
                                    checked={ticked.includes(label.id)}
                                    tabIndex={-1}
                                    disableRipple
                                    inputProps={{
                                        "aria-label": `Lọc theo nhãn ${label.name}`,
                                    }}
                                />
                            </ListItemIcon>
                            <ListItemText
                                primary={label.name}
                                primaryTypographyProps={{
                                    fontSize: 14,
                                    noWrap: true,
                                }}
                            />
                        </ListItemButton>
                    ))}
                    <ListItemButton
                        onClick={() => setEditing(true)}
                        sx={{ ...rowSx, pl: 4 }}
                    >
                        <ListItemIcon sx={{ minWidth: 40 }}>
                            <EditOutlinedIcon fontSize="small" />
                        </ListItemIcon>
                        <ListItemText
                            primary={
                                labels.length
                                    ? "Chỉnh sửa nhãn"
                                    : "Tạo nhãn mới"
                            }
                            primaryTypographyProps={{ fontSize: 14 }}
                        />
                    </ListItemButton>
                </List>
            </Collapse>
            <LabelsDialog open={editing} onClose={() => setEditing(false)} />
        </>
    );
}

LabelsNav.propTypes = {
    pathname: PropTypes.string.isRequired,
    go: PropTypes.func.isRequired,
};

export function NewMenu({
    anchor,
    onClose,
    onNewFolder,
    onUploadFiles,
    onUploadFolder,
    onImportDropbox,
}) {
    const run = (fn) => () => {
        onClose();
        fn();
    };
    return (
        <Menu anchorEl={anchor} open={Boolean(anchor)} onClose={onClose}>
            <MenuItem onClick={run(onNewFolder)}>
                <ListItemIcon>
                    <CreateNewFolderOutlinedIcon fontSize="small" />
                </ListItemIcon>
                Thư mục mới
            </MenuItem>
            <Divider />
            <MenuItem onClick={run(onUploadFiles)}>
                <ListItemIcon>
                    <UploadFileOutlinedIcon fontSize="small" />
                </ListItemIcon>
                Tải tệp lên
            </MenuItem>
            <MenuItem onClick={run(onUploadFolder)}>
                <ListItemIcon>
                    <DriveFolderUploadOutlinedIcon fontSize="small" />
                </ListItemIcon>
                Tải thư mục lên
            </MenuItem>
            <Divider />
            <MenuItem onClick={run(onImportDropbox)}>
                <ListItemIcon>
                    <CloudDownloadOutlinedIcon fontSize="small" />
                </ListItemIcon>
                Nhập từ link Dropbox
            </MenuItem>
        </Menu>
    );
}

NewMenu.propTypes = {
    anchor: PropTypes.any,
    onClose: PropTypes.func,
    onNewFolder: PropTypes.func,
    onUploadFiles: PropTypes.func,
    onUploadFolder: PropTypes.func,
    onImportDropbox: PropTypes.func,
};

/**
 * Sends a copy of the tree (files, folders, labels) to Saved Messages now,
 * instead of waiting for the 30-minute one (services/treeBackup).
 */
function BackupNow() {
    const [state, setState] = useState({ busy: false, text: null });

    async function run() {
        setState({ busy: true, text: null });
        try {
            // the server has the latest too, not only Telegram
            await flush();
            const sent = await backupNow({ force: true });
            setState({
                busy: false,
                text: sent
                    ? `Đã sao lưu lúc ${new Date().toLocaleTimeString("vi-VN", {
                          hour: "2-digit",
                          minute: "2-digit",
                      })}.`
                    : "Chưa sao lưu được: chưa có gì để lưu hoặc máy đang mất mạng.",
                error: !sent,
            });
        } catch (error) {
            setState({
                busy: false,
                text: `Sao lưu thất bại: ${describeError(error)}`,
                error: true,
            });
        }
    }

    return (
        <>
            <Button
                size="small"
                startIcon={
                    state.busy ? (
                        <CircularProgress size={14} />
                    ) : (
                        <BackupOutlinedIcon fontSize="small" />
                    )
                }
                disabled={state.busy}
                onClick={run}
                sx={{ mt: 1, ml: -1, textTransform: "none" }}
            >
                Sao lưu ngay lên Telegram
            </Button>
            {state.text && (
                <Typography
                    variant="caption"
                    display="block"
                    color={state.error ? "error" : "text.secondary"}
                >
                    {state.text}
                </Typography>
            )}
        </>
    );
}

export default function Sidebar({
    onNewFolder,
    onUploadFiles,
    onUploadFolder,
    onImportDropbox,
    onNavigate,
    onDropOn,
}) {
    const navigate = useNavigate();
    const { pathname } = useLocation();
    const { records } = useDrive();
    const [anchor, setAnchor] = useState(null);
    const [dropTarget, setDropTarget] = useState(null);

    const used = useMemo(
        () =>
            records.reduce(
                (sum, r) =>
                    sum + (r.type === "file" && !r.trashedAt ? r.size ?? 0 : 0),
                0,
            ),
        [records],
    );

    function go(to) {
        navigate(to);
        onNavigate?.();
    }

    return (
        <Box
            sx={{
                width: 256,
                px: 1.5,
                pb: 2,
                display: "flex",
                flexDirection: "column",
                height: "100%",
            }}
        >
            <Box sx={{ pt: 1, pb: 2, pl: 0.5 }}>
                <Button
                    onClick={(e) => setAnchor(e.currentTarget)}
                    startIcon={<AddIcon />}
                    sx={{
                        height: 56,
                        px: 2.5,
                        borderRadius: 4,
                        bgcolor: "background.paper",
                        color: "text.primary",
                        boxShadow:
                            "0 1px 2px 0 rgba(60,64,67,.3), 0 1px 3px 1px rgba(60,64,67,.15)",
                        fontSize: 15,
                        "&:hover": {
                            bgcolor: (t) =>
                                t.palette.mode === "light"
                                    ? "#edf2fc"
                                    : "#37393b",
                        },
                    }}
                >
                    Mới
                </Button>
                <NewMenu
                    anchor={anchor}
                    onClose={() => setAnchor(null)}
                    onNewFolder={onNewFolder}
                    onUploadFiles={onUploadFiles}
                    onUploadFolder={onUploadFolder}
                    onImportDropbox={onImportDropbox}
                />
            </Box>
            <List dense disablePadding>
                {NAV.map((item) => {
                    if (item.labels)
                        return (
                            <LabelsNav
                                key={item.to}
                                pathname={pathname}
                                // ticking several labels keeps the menu open on a phone
                                go={navigate}
                            />
                        );
                    const Icon = item.icon;
                    const active = item.match
                        ? item.match(pathname)
                        : pathname === item.to;
                    // dropping onto "My Drive" moves to the root, onto Trash trashes
                    const droppable = item.to === "/" || item.to === "/trash";
                    return (
                        <ListItemButton
                            key={item.to}
                            selected={active}
                            onClick={() => go(item.to)}
                            onDragOver={(e) => {
                                if (
                                    !droppable ||
                                    !e.dataTransfer.types.includes(
                                        "application/x-cloudgram",
                                    )
                                )
                                    return;
                                e.preventDefault();
                                setDropTarget(item.to);
                            }}
                            onDragLeave={() => setDropTarget(null)}
                            onDrop={(e) => {
                                setDropTarget(null);
                                if (!droppable) return;
                                e.preventDefault();
                                onDropOn?.(item.to, e);
                            }}
                            sx={{
                                borderRadius: 999,
                                height: 32,
                                mb: 0.25,
                                outline: dropTarget === item.to ? 2 : 0,
                                outlineColor: "primary.main",
                                "&.Mui-selected": {
                                    bgcolor: "action.selected",
                                    fontWeight: 600,
                                },
                            }}
                        >
                            <ListItemIcon sx={{ minWidth: 40 }}>
                                {item.to === "/" && active ? (
                                    <HomeOutlinedIcon fontSize="small" />
                                ) : (
                                    <Icon fontSize="small" />
                                )}
                            </ListItemIcon>
                            <ListItemText
                                primary={item.label}
                                primaryTypographyProps={{
                                    fontSize: 14,
                                    fontWeight: active ? 600 : 400,
                                }}
                            />
                        </ListItemButton>
                    );
                })}
            </List>
            <Divider sx={{ my: 1.5 }} />
            <Box sx={{ px: 2 }}>
                <Typography
                    variant="body2"
                    sx={{
                        display: "flex",
                        alignItems: "center",
                        gap: 1,
                        mb: 1,
                    }}
                >
                    <CloudOutlinedIcon fontSize="small" /> Bộ nhớ
                </Typography>
                <Typography
                    variant="caption"
                    color="text.secondary"
                    display="block"
                >
                    Đã dùng {formatSize(used)}. Lưu trên Telegram, không giới
                    hạn dung lượng.
                </Typography>
                <BackupNow />
            </Box>
        </Box>
    );
}

Sidebar.propTypes = {
    onNewFolder: PropTypes.func,
    onUploadFiles: PropTypes.func,
    onUploadFolder: PropTypes.func,
    onImportDropbox: PropTypes.func,
    onNavigate: PropTypes.func,
    onDropOn: PropTypes.func,
};

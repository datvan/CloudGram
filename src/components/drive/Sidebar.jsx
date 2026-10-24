import { useMemo, useState } from "react";
import PropTypes from "prop-types";
import { useLocation, useNavigate } from "react-router-dom";

import {
    Box,
    Button,
    Divider,
    LinearProgress,
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

import { useDrive } from "../../services/drive";
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
    { to: "/trash", label: "Thùng rác", icon: DeleteOutlineIcon },
];

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
                <LinearProgress
                    variant="determinate"
                    value={Math.min(100, (used / 1024 ** 4) * 100 + 1)}
                    sx={{ borderRadius: 4, height: 4 }}
                />
                <Typography
                    variant="caption"
                    color="text.secondary"
                    display="block"
                    mt={1}
                >
                    Đã dùng {formatSize(used)}. Lưu trên Telegram, không giới
                    hạn dung lượng.
                </Typography>
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

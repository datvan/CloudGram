import { useState } from "react";
import PropTypes from "prop-types";

import {
    Button,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    IconButton,
    Stack,
    TextField,
    Typography,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import CheckIcon from "@mui/icons-material/Check";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import LabelOutlinedIcon from "@mui/icons-material/LabelOutlined";

import {
    createLabel,
    deleteLabel,
    renameLabel,
    useDrive,
} from "../../services/drive";

function Row({ label }) {
    const [draft, setDraft] = useState(label.name);
    const [error, setError] = useState(false);
    const [confirming, setConfirming] = useState(false);

    const commit = () => {
        if (draft === label.name) return;
        if (!renameLabel(label.id, draft)) {
            setDraft(label.name);
            setError(true);
        }
    };

    if (confirming) {
        return (
            <Stack direction="row" alignItems="center" spacing={1}>
                <Typography variant="body2" sx={{ flex: 1 }}>
                    Xoá nhãn “{label.name}”? Thư mục và tệp vẫn còn.
                </Typography>
                <Button size="small" onClick={() => setConfirming(false)}>
                    Huỷ
                </Button>
                <Button
                    size="small"
                    color="error"
                    onClick={() => deleteLabel(label.id)}
                >
                    Xoá
                </Button>
            </Stack>
        );
    }
    return (
        <Stack direction="row" alignItems="center" spacing={1.5}>
            <LabelOutlinedIcon fontSize="small" color="action" />
            <TextField
                fullWidth
                size="small"
                variant="standard"
                value={draft}
                error={error}
                helperText={
                    error ? "Tên trống hoặc đã có nhãn này." : undefined
                }
                onChange={(e) => {
                    setDraft(e.target.value);
                    setError(false);
                }}
                onBlur={commit}
                onKeyDown={(e) => e.key === "Enter" && e.target.blur()}
                inputProps={{ maxLength: 50 }}
            />
            <IconButton
                size="small"
                aria-label="Xoá nhãn"
                onClick={() => setConfirming(true)}
            >
                <DeleteOutlineIcon fontSize="small" />
            </IconButton>
        </Stack>
    );
}

Row.propTypes = { label: PropTypes.object.isRequired };

/** Keep's "Chỉnh sửa nhãn": make labels, rename them, delete them. */
export default function LabelsDialog({ open, onClose }) {
    const { labels } = useDrive();
    const [name, setName] = useState("");

    const add = () => {
        if (createLabel(name)) setName("");
    };

    return (
        <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
            <DialogTitle>Chỉnh sửa nhãn</DialogTitle>
            <DialogContent>
                <Stack spacing={2} sx={{ pt: 1 }}>
                    <Stack direction="row" alignItems="center" spacing={1.5}>
                        <AddIcon fontSize="small" color="action" />
                        <TextField
                            autoFocus
                            fullWidth
                            size="small"
                            variant="standard"
                            placeholder="Tạo nhãn mới"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            onKeyDown={(e) => e.key === "Enter" && add()}
                            inputProps={{ maxLength: 50 }}
                        />
                        <IconButton
                            size="small"
                            aria-label="Tạo nhãn"
                            disabled={!name.trim()}
                            onClick={add}
                        >
                            <CheckIcon fontSize="small" />
                        </IconButton>
                    </Stack>
                    {labels.map((label) => (
                        <Row key={label.id} label={label} />
                    ))}
                </Stack>
            </DialogContent>
            <DialogActions>
                <Button onClick={onClose}>Xong</Button>
            </DialogActions>
        </Dialog>
    );
}

LabelsDialog.propTypes = {
    open: PropTypes.bool,
    onClose: PropTypes.func,
};

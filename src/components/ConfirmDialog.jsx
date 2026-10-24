import PropTypes from "prop-types";

import {
    Button,
    Dialog,
    DialogActions,
    DialogContent,
    DialogContentText,
    DialogTitle,
} from "@mui/material";

export default function ConfirmDialog({
    open,
    title,
    body,
    confirmLabel,
    confirmColor,
    busy,
    onConfirm,
    onCancel,
}) {
    return (
        <Dialog open={open} onClose={busy ? undefined : onCancel}>
            <DialogTitle>{title}</DialogTitle>
            <DialogContent>
                <DialogContentText sx={{ whiteSpace: "pre-line" }}>
                    {body}
                </DialogContentText>
            </DialogContent>
            <DialogActions>
                <Button onClick={onCancel} disabled={busy}>
                    Cancel
                </Button>
                <Button
                    onClick={onConfirm}
                    color={confirmColor ?? "primary"}
                    variant="contained"
                    disabled={busy}
                >
                    {busy ? "Working…" : confirmLabel}
                </Button>
            </DialogActions>
        </Dialog>
    );
}

ConfirmDialog.propTypes = {
    open: PropTypes.bool,
    title: PropTypes.string,
    body: PropTypes.string,
    confirmLabel: PropTypes.string,
    confirmColor: PropTypes.string,
    busy: PropTypes.bool,
    onConfirm: PropTypes.func,
    onCancel: PropTypes.func,
};

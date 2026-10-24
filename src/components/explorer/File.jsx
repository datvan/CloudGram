import { useState } from "react";
import PropTypes from "prop-types";
import { connect } from "react-redux";

import {
    Avatar,
    Card,
    CardHeader,
    Grid,
    IconButton,
    Menu,
    MenuItem,
    Stack,
    Typography,
} from "@mui/material";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import FileUploadIcon from "@mui/icons-material/FileUpload";
import FileDownloadIcon from "@mui/icons-material/FileDownload";

import client from "../../services/telegram";
import ProgressCircle from "../ProgressCircle";
import downloadFile from "../../utils/downloadFile";
import getFileIcon from "../../utils/getFileIcon";
import { cancelUploads, retryUpload } from "../../utils/uploadQueue";

// eslint-disable-next-line react-refresh/only-export-components
function File(props) {
    const { id, name, file_id, deleteItem, activeProgress } = props;

    // No file_id means nothing reached Telegram yet: the upload is queued, in
    // flight, failed, or was cut short by a reload that took the File object
    // with it. Such a record can still be deleted, just not downloaded.
    const isPending = file_id === undefined || file_id === null;

    // A download failure also shows up as ERROR, so isPending is what tells the
    // two apart: only an upload that never landed can be sent again.
    const canRetry = isPending && activeProgress?.type === "ERROR";

    function handleDownloadFile() {
        downloadFile(id, file_id, name);
        handleClose();
    }

    function handleRetry() {
        handleClose();
        retryUpload(id);
    }

    async function handleDeleteFile() {
        handleClose();
        if (isPending) {
            // deleteMessages would throw on an undefined id and strand the
            // record, so drop the job and keep to IndexedDB
            cancelUploads([id]);
        } else {
            await client.deleteMessages("me", [file_id], { revoke: true });
        }
        await deleteItem(id);
    }

    const [anchorEl, setAnchorEl] = useState(null);
    const open = Boolean(anchorEl);

    const handleClick = (event) => {
        setAnchorEl(event.currentTarget);
    };
    const handleClose = () => {
        setAnchorEl(null);
    };

    return (
        <Grid item key={id}>
            <Card>
                <CardHeader
                    avatar={<Avatar height="48" src={getFileIcon(name)} />}
                    action={
                        <IconButton onClick={handleClick}>
                            <MoreVertIcon />
                        </IconButton>
                    }
                    title={
                        <>
                            {activeProgress && (
                                <Stack
                                    direction="row"
                                    alignItems="center"
                                    spacing={1}
                                >
                                    {activeProgress.type === "DOWNLOADING" ? (
                                        <FileDownloadIcon fontSize="small" />
                                    ) : (
                                        <FileUploadIcon fontSize="small" />
                                    )}
                                    {activeProgress.type === "ERROR" ? (
                                        <Typography
                                            variant="caption"
                                            color="error"
                                            noWrap
                                        >
                                            {activeProgress.message ?? "Failed"}
                                        </Typography>
                                    ) : activeProgress.type === "QUEUED" ? (
                                        <Typography
                                            variant="caption"
                                            color="text.secondary"
                                        >
                                            Queued
                                        </Typography>
                                    ) : (
                                        <ProgressCircle
                                            value={
                                                activeProgress.percentage ?? 0
                                            }
                                            size={32}
                                        />
                                    )}
                                </Stack>
                            )}
                            <Typography noWrap>{name}</Typography>
                        </>
                    }
                />
            </Card>
            <Menu
                id="basic-menu"
                anchorEl={anchorEl}
                open={open}
                onClose={handleClose}
                MenuListProps={{
                    "aria-labelledby": "basic-button",
                }}
            >
                <MenuItem onClick={handleDownloadFile} disabled={isPending}>
                    Download
                </MenuItem>
                {canRetry && <MenuItem onClick={handleRetry}>Retry</MenuItem>}
                <MenuItem onClick={handleDeleteFile}>delete</MenuItem>
            </Menu>
        </Grid>
    );
}

const mapStateToProps = (state, props) => {
    return {
        dispatch: state.dispatch,
        activeProgress: state.progress.activeProgress.find(
            (item) => item.id === props.id,
        ),
    };
};

File.propTypes = {
    id: PropTypes.string,
    name: PropTypes.string,
    file_id: PropTypes.number,
    deleteItem: PropTypes.func,
    dispatch: PropTypes.func,
    activeProgress: PropTypes.object,
};

// eslint-disable-next-line react-refresh/only-export-components
export default connect(mapStateToProps)(File);

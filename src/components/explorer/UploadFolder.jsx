import { useCallback, useState } from "react";
import { PropTypes } from "prop-types";
import { v4 as uuid4 } from "uuid";
import { useIndexedDB } from "react-indexed-db-hook";

import { Box, Button, Typography, Modal, Stack } from "@mui/material";

import {
    buildTreeFromPaths,
    formatSize,
    totalSize,
} from "../../utils/buildTreeFromPaths";
import { findFolder } from "../../utils/tree";
import { enqueueUpload } from "../../utils/uploadQueue";

const style = {
    position: "absolute",
    top: "50%",
    left: "50%",
    transform: "translate(-50%, -50%)",
    width: 400,
    bgcolor: "background.paper",
    border: "2px solid #000",
    boxShadow: 24,
    p: 4,
};

export default function UploadFolder({ parentID, fetchData, open, setOpen }) {
    const ops = useIndexedDB("file");

    const [picked, setPicked] = useState(null);
    const [busy, setBusy] = useState(false);

    function handleClose() {
        if (busy) return;
        setPicked(null);
        setOpen(false);
    }

    // React has no prop for a directory picker and warns about the unknown
    // attribute, so set it on the node once the input mounts.
    const attachDirectoryInput = useCallback((node) => {
        if (!node) return;
        node.setAttribute("webkitdirectory", "");
        node.setAttribute("directory", "");
    }, []);

    function handlePick(event) {
        const files = Array.from(event.target.files ?? []);
        if (!files.length) {
            setPicked(null);
            return;
        }
        const tree = buildTreeFromPaths(files);
        setPicked({
            folders: tree.folders,
            entries: tree.files,
            bytes: totalSize(files),
        });
    }

    async function handleUploadFolder() {
        if (!picked) return;
        setBusy(true);
        try {
            const records = await ops.getAll();
            const realId = new Map();

            // buildTreeFromPaths lists parents before children, so every parent
            // already has a real id by the time its child is reached.
            for (const folder of picked.folders) {
                const parent = folder.parentTempId
                    ? realId.get(folder.parentTempId)
                    : parentID;

                // uploading the same folder twice merges into the existing one
                const existing = findFolder(records, parent, folder.name);
                if (existing) {
                    realId.set(folder.tempId, existing.id);
                    continue;
                }

                const record = {
                    id: uuid4(),
                    name: folder.name,
                    type: "folder",
                };
                if (parent) record.parent = parent;
                await ops.add(record);
                // keep the snapshot current so the next sibling dedupes too
                records.push(record);
                realId.set(folder.tempId, record.id);
            }
            fetchData();

            for (const entry of picked.entries) {
                await enqueueUpload({
                    ops,
                    file: entry.file,
                    name: entry.name,
                    parentID: entry.parentTempId
                        ? realId.get(entry.parentTempId)
                        : parentID,
                    onChange: fetchData,
                });
            }
        } catch (e) {
            console.log(e);
        }
        setBusy(false);
        fetchData();
        setPicked(null);
        setOpen(false);
    }

    return (
        <div>
            <Modal
                open={open}
                onClose={handleClose}
                aria-labelledby="modal-modal-title"
                aria-describedby="modal-modal-description"
            >
                <Box sx={style}>
                    <Typography
                        id="modal-modal-title"
                        variant="h6"
                        component="h2"
                    >
                        Upload Folder
                    </Typography>
                    <Stack spacing={2} mt={2}>
                        <input
                            id="folder"
                            type="file"
                            name="folder"
                            multiple
                            ref={attachDirectoryInput}
                            onChange={handlePick}
                        />
                        {picked && (
                            <Typography variant="body2">
                                {picked.entries.length} files,{" "}
                                {picked.folders.length} folders,{" "}
                                {formatSize(picked.bytes)}
                                <br />
                                <Typography
                                    variant="caption"
                                    color="text.secondary"
                                >
                                    Empty folders are skipped; the browser only
                                    reports files.
                                </Typography>
                            </Typography>
                        )}
                        <Button
                            variant="outlined"
                            onClick={handleUploadFolder}
                            disabled={!picked || busy}
                        >
                            {busy ? "Creating folders…" : "Upload"}
                        </Button>
                    </Stack>
                </Box>
            </Modal>
        </div>
    );
}

UploadFolder.propTypes = {
    parentID: PropTypes.string,
    fetchData: PropTypes.func,
    open: PropTypes.bool,
    setOpen: PropTypes.func,
};

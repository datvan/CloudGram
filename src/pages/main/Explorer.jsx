import { useEffect, useRef, useState } from "react";
import { useIndexedDB } from "react-indexed-db-hook";
import { useParams } from "react-router-dom";

import { Alert, Grid, Typography, Container, Snackbar } from "@mui/material";

import Folder from "../../components/explorer/Folder";
import File from "../../components/explorer/File";
import WorkingDir from "../../components/explorer/WorkingDir";
import CreateButton from "../../components/explorer/CreateButton";
import ConfirmDialog from "../../components/ConfirmDialog";
import client from "../../services/telegram";
import { collectSubtree, messageIdsOf, recordIdsOf } from "../../utils/tree";
import { cancelUploads } from "../../utils/uploadQueue";

export default function Explorer() {
    const { parentID } = useParams();
    const [workDir, setWorkDir] = useState([
        {
            id: undefined,
            name: "Home",
        },
    ]);

    const { openCursor, deleteRecord, getAll } = useIndexedDB("file");

    const [data, setData] = useState([]);
    const [pendingDelete, setPendingDelete] = useState(null);
    const [deleting, setDeleting] = useState(false);
    const [notice, setNotice] = useState(null);

    // "/" and "/folder/:parentID" share one <Explorer />, so navigating between
    // folders does not remount it. Async callers (uploads, deletes) keep a
    // closure over the fetchData of the render they started in; reading the
    // folder from a ref keeps them from repainting the grid with a stale folder.
    const parentIDRef = useRef(parentID);
    parentIDRef.current = parentID;

    useEffect(() => {
        fetchData();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [parentID]);

    function fetchData() {
        const currentParent = parentIDRef.current;
        let _data = [];
        openCursor((e) => {
            var cursor = e.target.result;
            if (cursor) {
                if (cursor.value.parent === currentParent)
                    _data = [..._data, cursor.value];
                cursor.continue();
            } else {
                setData(_data);
            }
        });
    }

    async function deleteItem(id) {
        try {
            await deleteRecord(id);
        } catch (e) {
            console.log(e);
        }
        fetchData();
    }

    /** Count what is about to go, then let the user look before leaping. */
    async function requestDeleteFolder(id, name) {
        try {
            const subtree = collectSubtree(await getAll(), id);
            setPendingDelete({
                id,
                name,
                folders: subtree.folders.length,
                files: subtree.files.length,
            });
        } catch (e) {
            console.log(e);
            setNotice({
                severity: "error",
                text: "Could not read the folder.",
            });
        }
    }

    async function confirmDeleteFolder() {
        setDeleting(true);
        try {
            // Counted again rather than reusing the snapshot behind the dialog:
            // a folder upload may have added records to this subtree meanwhile.
            const subtree = collectSubtree(await getAll(), pendingDelete.id);
            const recordIds = recordIdsOf(subtree);
            const messageIds = messageIdsOf(subtree);

            cancelUploads(recordIds);

            // Telegram first. If this throws, the metadata is still intact and
            // the delete can be retried; the other order would leave files in
            // Saved Messages that nothing points at any more.
            if (messageIds.length) {
                await client.deleteMessages("me", messageIds, { revoke: true });
            }
            for (const recordId of recordIds) {
                await deleteRecord(recordId);
            }

            setPendingDelete(null);
            setNotice({
                severity: "success",
                text: `Deleted ${pendingDelete.name}.`,
            });
        } catch (e) {
            console.log(e);
            setNotice({
                severity: "error",
                text: `Delete failed: ${e?.message ?? e}. Nothing was removed.`,
            });
        }
        setDeleting(false);
        fetchData();
    }

    return (
        <>
            <WorkingDir workDir={workDir} setWorkDir={setWorkDir} />
            <h3>Folders</h3>
            <Grid
                container
                rowSpacing={1}
                columnSpacing={{ xs: 0.5, sm: 7, md: 1 }}
                m={0.5}
            >
                {data.length ? (
                    data?.map((item) => {
                        switch (item.type) {
                            case "folder":
                                return (
                                    <Folder
                                        key={item.id}
                                        id={item.id}
                                        name={item.name}
                                        deleteFolder={requestDeleteFolder}
                                        workDir={workDir}
                                        setWorkDir={setWorkDir}
                                    />
                                );
                            case "file":
                                return (
                                    <File
                                        key={item.id}
                                        id={item.id}
                                        name={item.name}
                                        file_id={item.file_id}
                                        deleteItem={deleteItem}
                                    />
                                );
                            default:
                                return null;
                        }
                    })
                ) : (
                    <Container>
                        <Typography variant="body" align="center" gutterBottom>
                            There is nothing to show here, please upload some
                            file or create some folders.
                        </Typography>
                    </Container>
                )}
            </Grid>
            <CreateButton parentID={parentID} fetchData={fetchData} />
            <ConfirmDialog
                open={Boolean(pendingDelete)}
                title={`Delete "${pendingDelete?.name ?? ""}"?`}
                body={
                    pendingDelete
                        ? `This removes ${pendingDelete.folders} folder(s) and ${pendingDelete.files} file(s).\n` +
                          `The files are deleted from your Telegram Saved Messages and cannot be recovered.`
                        : ""
                }
                confirmLabel="Delete"
                confirmColor="error"
                busy={deleting}
                onConfirm={confirmDeleteFolder}
                onCancel={() => setPendingDelete(null)}
            />
            <Snackbar
                open={Boolean(notice)}
                autoHideDuration={6000}
                onClose={() => setNotice(null)}
            >
                <Alert
                    severity={notice?.severity}
                    onClose={() => setNotice(null)}
                >
                    {notice?.text}
                </Alert>
            </Snackbar>
        </>
    );
}

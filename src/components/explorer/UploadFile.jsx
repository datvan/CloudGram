import { PropTypes } from "prop-types";
import { useIndexedDB } from "react-indexed-db-hook";

import { Box, Button, Typography, Modal, Stack } from "@mui/material";

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

export default function UploadFile({ parentID, fetchData, open, setOpen }) {
    const ops = useIndexedDB("file");

    const handleClose = () => setOpen(false);

    async function handlerUploadFiles(fileList) {
        // Each file gets its own record and its own message so it keeps a
        // file_id of its own; the queue decides how many run at a time.
        for (const file of Array.from(fileList)) {
            try {
                await enqueueUpload({
                    ops,
                    file,
                    parentID,
                    onChange: fetchData,
                });
            } catch (e) {
                console.log(e);
            }
        }
        fetchData();
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
                        Upload Files
                    </Typography>
                    <form
                        onSubmit={(e) => {
                            e.preventDefault();
                            handlerUploadFiles(e.target.file.files);
                            handleClose();
                        }}
                    >
                        <Stack spacing={2}>
                            <input
                                id="file"
                                type="file"
                                name="file"
                                multiple
                                placeholder="Upload File"
                            />
                            <Button type="submit" variant="outlined">
                                Upload
                            </Button>
                        </Stack>
                    </form>
                </Box>
            </Modal>
        </div>
    );
}

UploadFile.propTypes = {
    parentID: PropTypes.string,
    fetchData: PropTypes.func,
    open: PropTypes.bool,
    setOpen: PropTypes.func,
};

import { PropTypes } from "prop-types";
import { v4 as uuid4 } from "uuid";
import { useIndexedDB } from "react-indexed-db-hook";

import { Box, Button, Typography, Modal, Stack } from "@mui/material";

import uploadFile from "../../utils/uploadFile";

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
    const { add, update } = useIndexedDB("file");

    const handleClose = () => setOpen(false);

    async function handlerUploadFile(file) {
        let data = {
            id: uuid4(),
            name: file.name,
            type: "file",
        };
        if (parentID) data["parent"] = parentID;
        try {
            await add(data);
        } catch (e) {
            console.log(e);
            return;
        }
        // show the placeholder record before the upload starts
        fetchData();

        try {
            const res = await uploadFile(data.id, file);
            await update({ ...data, file_id: res.id });
        } catch (e) {
            console.log(e);
        }
        // refresh again so the record picks up its file_id
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
                        Upload File
                    </Typography>
                    <form
                        onSubmit={(e) => {
                            e.preventDefault();
                            handlerUploadFile(e.target.file.files[0]);
                            handleClose();
                        }}
                    >
                        <Stack spacing={2}>
                            <input
                                id="file"
                                type="file"
                                name="file"
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

import { useState } from "react";
import PropTypes from "prop-types";
import { useNavigate } from "react-router-dom";

import {
    Card,
    CardHeader,
    Grid,
    IconButton,
    Menu,
    MenuItem,
} from "@mui/material";
import FolderOpenIcon from "@mui/icons-material/FolderOpen";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import Typography from "@mui/material/Typography";

function Folder(props) {
    const { id, name, workDir, setWorkDir, deleteFolder } = props;
    const navigate = useNavigate();

    const [anchorEl, setAnchorEl] = useState(null);
    const open = Boolean(anchorEl);

    function openFolder() {
        setWorkDir([...workDir, { id, name }]);
        navigate(`/folder/${id}`);
    }

    function handleMenuClick(event) {
        // the whole card opens the folder, so the menu button must not reach it
        event.stopPropagation();
        setAnchorEl(event.currentTarget);
    }

    const handleMenuClose = () => setAnchorEl(null);

    function handleDelete() {
        handleMenuClose();
        deleteFolder(id, name);
    }

    return (
        <Grid item key={id}>
            <Card onClick={openFolder}>
                <CardHeader
                    avatar={<FolderOpenIcon />}
                    action={
                        <IconButton onClick={handleMenuClick}>
                            <MoreVertIcon />
                        </IconButton>
                    }
                    title={<Typography noWrap>{name}</Typography>}
                />
            </Card>
            {/* Kept outside the Card on purpose. MUI renders a Menu through a
                portal, but React events still travel up the React tree, so a
                Menu nested in the Card would hand every click on it — items and
                backdrop alike — to the Card's onClick and navigate into the
                folder being deleted. */}
            <Menu anchorEl={anchorEl} open={open} onClose={handleMenuClose}>
                <MenuItem onClick={handleDelete}>Delete</MenuItem>
            </Menu>
        </Grid>
    );
}

Folder.propTypes = {
    id: PropTypes.string,
    name: PropTypes.string,
    deleteFolder: PropTypes.func,
    workDir: PropTypes.array,
    setWorkDir: PropTypes.func,
};

export default Folder;

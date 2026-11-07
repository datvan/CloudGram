import { useState } from "react";
import PropTypes from "prop-types";

import {
    Box,
    Checkbox,
    InputAdornment,
    List,
    ListItemButton,
    ListItemIcon,
    ListItemText,
    Popover,
    TextField,
    Typography,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import SearchIcon from "@mui/icons-material/Search";

import {
    createLabel,
    findLabel,
    setLabel,
    useDrive,
} from "../../services/drive";
import { fold } from "../../utils/format";

function Body({ ids }) {
    const { labels, byId } = useDrive();
    const [query, setQuery] = useState("");
    // read live, so a tick shows at once and a trashed item drops out
    const items = ids.map((id) => byId.get(id)).filter(Boolean);
    const q = query.trim();
    const shown = q
        ? labels.filter((l) => fold(l.name).includes(fold(q)))
        : labels;
    const exact = q ? findLabel(q) : null;

    const stateOf = (label) => {
        const have = items.filter((i) => i.labels?.includes(label.id)).length;
        return {
            all: items.length > 0 && have === items.length,
            some: have > 0 && have < items.length,
        };
    };
    const toggle = (label) => setLabel(ids, label.id, !stateOf(label).all);
    const create = () => {
        const label = createLabel(q);
        if (!label) return;
        setLabel(ids, label.id, true);
        setQuery("");
    };

    return (
        <Box sx={{ width: 260, py: 1 }}>
            <Typography variant="body2" sx={{ px: 2, pb: 1 }}>
                Gắn nhãn cho{" "}
                {items.length > 1 ? `${items.length} mục` : "mục này"}
            </Typography>
            <Box sx={{ px: 2, pb: 0.5 }}>
                <TextField
                    autoFocus
                    fullWidth
                    size="small"
                    variant="standard"
                    placeholder="Nhập tên nhãn"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key !== "Enter" || !q) return;
                        e.preventDefault();
                        if (exact) toggle(exact);
                        else create();
                    }}
                    inputProps={{ maxLength: 50 }}
                    InputProps={{
                        endAdornment: (
                            <InputAdornment position="end">
                                <SearchIcon fontSize="small" />
                            </InputAdornment>
                        ),
                    }}
                />
            </Box>
            <List
                dense
                disablePadding
                sx={{ maxHeight: 240, overflow: "auto" }}
            >
                {shown.map((label) => {
                    const state = stateOf(label);
                    return (
                        <ListItemButton
                            key={label.id}
                            onClick={() => toggle(label)}
                            sx={{ py: 0 }}
                        >
                            <ListItemIcon sx={{ minWidth: 36 }}>
                                <Checkbox
                                    edge="start"
                                    size="small"
                                    tabIndex={-1}
                                    disableRipple
                                    checked={state.all}
                                    indeterminate={state.some}
                                />
                            </ListItemIcon>
                            <ListItemText
                                primary={label.name}
                                primaryTypographyProps={{ noWrap: true }}
                            />
                        </ListItemButton>
                    );
                })}
                {!shown.length && !q && (
                    <Typography
                        variant="body2"
                        color="text.secondary"
                        sx={{ px: 2, py: 1 }}
                    >
                        Chưa có nhãn nào. Gõ tên để tạo nhãn đầu tiên.
                    </Typography>
                )}
            </List>
            {q && !exact && (
                <ListItemButton onClick={create} dense>
                    <ListItemIcon sx={{ minWidth: 36 }}>
                        <AddIcon fontSize="small" />
                    </ListItemIcon>
                    <ListItemText
                        primary={`Tạo “${q}”`}
                        primaryTypographyProps={{ noWrap: true }}
                    />
                </ListItemButton>
            )}
        </Box>
    );
}

Body.propTypes = { ids: PropTypes.array.isRequired };

/**
 * "Gắn nhãn" for the selected items, like Keep's label box: search, tick to
 * put a label on or take it off, or make a new one from what was typed.
 * `position` is where the menu it replaces stood; null closes it. `above`
 * opens it upward from there, for a button at the bottom of the screen.
 */
export default function LabelPicker({ position, ids, onClose, above }) {
    return (
        <Popover
            open={Boolean(position)}
            onClose={onClose}
            anchorReference="anchorPosition"
            anchorPosition={position ?? undefined}
            transformOrigin={
                above ? { vertical: "bottom", horizontal: "left" } : undefined
            }
        >
            {position && <Body ids={ids} />}
        </Popover>
    );
}

LabelPicker.propTypes = {
    position: PropTypes.object,
    ids: PropTypes.array,
    onClose: PropTypes.func,
    above: PropTypes.bool,
};

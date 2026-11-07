import PropTypes from "prop-types";

import { Chip, Stack } from "@mui/material";

import { labelsOf, useDrive } from "../../services/drive";

const chipSx = {
    height: 20,
    fontSize: 12,
    maxWidth: 110,
    "& .MuiChip-label": { px: 1 },
};

/**
 * The labels on an item as small tags. `max` tags are drawn and the rest
 * counted as "+N"; a details panel passes Infinity and lets them wrap.
 * Callers draw it only for items with labels: each one listens to the drive.
 */
export default function LabelChips({ item, max = 2, wrap = false }) {
    const { labelsById } = useDrive();
    const labels = labelsOf(item, labelsById);
    if (!labels.length) return null;
    const shown = labels.slice(0, max);
    const extra = labels.length - shown.length;
    return (
        <Stack
            direction="row"
            spacing={0.5}
            useFlexGap
            sx={{ flexShrink: 0, flexWrap: wrap ? "wrap" : "nowrap" }}
        >
            {shown.map((label) => (
                <Chip
                    key={label.id}
                    size="small"
                    label={label.name}
                    title={label.name}
                    sx={chipSx}
                />
            ))}
            {extra > 0 && (
                <Chip
                    size="small"
                    label={`+${extra}`}
                    title={labels
                        .slice(shown.length)
                        .map((l) => l.name)
                        .join(", ")}
                    sx={chipSx}
                />
            )}
        </Stack>
    );
}

LabelChips.propTypes = {
    item: PropTypes.object.isRequired,
    max: PropTypes.number,
    wrap: PropTypes.bool,
};

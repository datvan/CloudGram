import PropTypes from "prop-types";
import { connect } from "react-redux";

import { Chip, Stack } from "@mui/material";
import CloudUploadIcon from "@mui/icons-material/CloudUpload";
import CloudDownloadIcon from "@mui/icons-material/CloudDownload";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";

/**
 * Running total for everything in flight.
 *
 * A folder upload can put hundreds of cards on screen, most of them scrolled
 * out of view, so the per-file spinners alone never answer "is it done yet".
 *
 * Failures are counted on their own rather than lumped in with uploads: an
 * ERROR entry can come from a download too, and the entry carries no direction.
 */
// eslint-disable-next-line react-refresh/only-export-components
function TransferStatus({ uploading, queued, downloading, failed }) {
    const active = uploading + queued;
    if (!active && !downloading && !failed) return null;

    return (
        <Stack
            direction="row"
            spacing={1}
            sx={{ position: "fixed", bottom: 16, left: 16, zIndex: 1 }}
        >
            {active > 0 && (
                <Chip
                    icon={<CloudUploadIcon />}
                    label={
                        queued
                            ? `Uploading ${uploading}, ${queued} queued`
                            : `Uploading ${uploading}`
                    }
                />
            )}
            {downloading > 0 && (
                <Chip
                    icon={<CloudDownloadIcon />}
                    label={`Downloading ${downloading}`}
                />
            )}
            {failed > 0 && (
                <Chip
                    color="error"
                    icon={<ErrorOutlineIcon />}
                    label={`${failed} failed`}
                />
            )}
        </Stack>
    );
}

const mapStateToProps = (state) => {
    const entries = state.progress.activeProgress;
    const count = (type) => entries.filter((item) => item.type === type).length;
    return {
        uploading: count("UPLOADING"),
        queued: count("QUEUED"),
        downloading: count("DOWNLOADING"),
        failed: count("ERROR"),
    };
};

TransferStatus.propTypes = {
    uploading: PropTypes.number,
    queued: PropTypes.number,
    downloading: PropTypes.number,
    failed: PropTypes.number,
};

// eslint-disable-next-line react-refresh/only-export-components
export default connect(mapStateToProps)(TransferStatus);

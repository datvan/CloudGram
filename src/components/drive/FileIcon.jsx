import PropTypes from "prop-types";

import { KINDS, kindOf } from "./fileTypes";

export function FileIcon({ record, size = 24 }) {
    const info = KINDS[kindOf(record)];
    const Icon = info.icon;
    return <Icon sx={{ color: info.color, fontSize: size, flexShrink: 0 }} />;
}

FileIcon.propTypes = {
    record: PropTypes.object.isRequired,
    size: PropTypes.number,
};

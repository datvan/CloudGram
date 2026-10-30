import { useEffect, useState } from "react";
import PropTypes from "prop-types";

import {
    Box,
    Divider,
    IconButton,
    Link,
    Stack,
    Typography,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";

import { pathTo } from "../../utils/tree";
import { formatDateTime, formatSize } from "../../utils/format";

function exposure(seconds) {
    if (!seconds) return null;
    return seconds >= 1
        ? `${seconds} giây`
        : `1/${Math.round(1 / seconds)} giây`;
}

/**
 * What is known about a picture: its file, its pixels, where it sits in the
 * drive, and the camera's own notes (EXIF) when the file still carries them.
 */
export default function ImageInfo({ item, blob, size, byId, onClose }) {
    const [exif, setExif] = useState({ status: "idle" });

    useEffect(() => {
        if (!blob) {
            setExif({ status: "idle" });
            return undefined;
        }
        let cancelled = false;
        setExif({ status: "loading" });
        import("exifr/dist/lite.esm.mjs")
            // the lite build reads JPEG and HEIC; picking tags needs the
            // full one, so everything is read and the few shown are taken
            .then(({ default: exifr }) => exifr.parse(blob))
            .then((tags) => !cancelled && setExif({ status: "ready", tags }))
            .catch(
                () => !cancelled && setExif({ status: "ready", tags: null }),
            );
        return () => {
            cancelled = true;
        };
    }, [blob]);

    const folder = pathTo(byId, item.parent)
        .map((f) => f.name)
        .join(" / ");
    const tags = exif.tags ?? {};
    const camera = [tags.Make, tags.Model]
        .filter(Boolean)
        .join(" ")
        .replace(/^(\S+) \1 /i, "$1 ");
    const shot = [
        tags.FNumber && `f/${tags.FNumber}`,
        exposure(tags.ExposureTime),
        tags.ISO && `ISO ${tags.ISO}`,
        tags.FocalLength && `${Math.round(tags.FocalLength)} mm`,
    ]
        .filter(Boolean)
        .join(" · ");
    const place =
        typeof tags.latitude === "number" && typeof tags.longitude === "number"
            ? `${tags.latitude.toFixed(5)}, ${tags.longitude.toFixed(5)}`
            : null;

    const rows = [
        ["Loại tệp", item.mime || "—"],
        ["Dung lượng", formatSize(item.size ?? 0)],
        size && [
            "Kích thước",
            `${size.w} × ${size.h} px (${((size.w * size.h) / 1e6).toFixed(
                1,
            )} MP)`,
        ],
        ["Thư mục", folder || "Drive của tôi"],
        ["Tải lên lúc", formatDateTime(item.createdAt)],
    ].filter(Boolean);
    const cameraRows = [
        tags.DateTimeOriginal && [
            "Chụp lúc",
            formatDateTime(new Date(tags.DateTimeOriginal).getTime()),
        ],
        camera && ["Máy ảnh", camera],
        tags.LensModel && ["Ống kính", tags.LensModel],
        shot && ["Thông số", shot],
    ].filter(Boolean);

    const row = ([label, value]) => (
        <Box key={label}>
            <Typography
                variant="caption"
                sx={{ color: "rgba(255,255,255,.6)" }}
            >
                {label}
            </Typography>
            <Typography variant="body2" sx={{ wordBreak: "break-word" }}>
                {value}
            </Typography>
        </Box>
    );

    return (
        <Box
            sx={{
                width: { xs: "100%", sm: 320 },
                flexShrink: 0,
                bgcolor: "#202124",
                color: "#fff",
                overflow: "auto",
                position: { xs: "absolute", sm: "relative" },
                inset: { xs: 0, sm: "auto" },
                zIndex: 2,
            }}
        >
            <Stack
                direction="row"
                alignItems="center"
                sx={{ px: 2.5, pt: 1.5, pb: 1 }}
            >
                <Typography fontWeight={500} sx={{ flex: 1 }}>
                    Thông tin ảnh
                </Typography>
                <IconButton
                    onClick={onClose}
                    sx={{ color: "#fff" }}
                    aria-label="Đóng thông tin"
                >
                    <CloseIcon />
                </IconButton>
            </Stack>
            <Stack spacing={1.5} sx={{ px: 2.5, pb: 2.5 }}>
                <Typography sx={{ wordBreak: "break-word" }}>
                    {item.name}
                </Typography>
                {rows.map(row)}
                <Divider sx={{ borderColor: "rgba(255,255,255,.12)" }} />
                {exif.status !== "ready" ? (
                    <Typography
                        variant="body2"
                        sx={{ color: "rgba(255,255,255,.6)" }}
                    >
                        {blob ? "Đang đọc thông tin máy ảnh…" : "Đang tải ảnh…"}
                    </Typography>
                ) : cameraRows.length || place ? (
                    <>
                        {cameraRows.map(row)}
                        {place &&
                            row([
                                "Vị trí",
                                <Link
                                    key="map"
                                    href={`https://www.google.com/maps?q=${tags.latitude},${tags.longitude}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    sx={{ color: "#8ab4f8" }}
                                >
                                    {place}
                                </Link>,
                            ])}
                    </>
                ) : (
                    <Typography
                        variant="body2"
                        sx={{ color: "rgba(255,255,255,.6)" }}
                    >
                        Ảnh này không còn thông tin máy ảnh (EXIF). Ảnh gửi dạng
                        “ảnh” (nén) thì Telegram đã xoá phần này; gửi dạng tệp
                        gốc thì mới giữ lại.
                    </Typography>
                )}
            </Stack>
        </Box>
    );
}

ImageInfo.propTypes = {
    item: PropTypes.object.isRequired,
    blob: PropTypes.instanceOf(Blob),
    size: PropTypes.shape({ w: PropTypes.number, h: PropTypes.number }),
    byId: PropTypes.instanceOf(Map).isRequired,
    onClose: PropTypes.func,
};

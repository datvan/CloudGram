import FolderIcon from "@mui/icons-material/Folder";
import ImageIcon from "@mui/icons-material/Image";
import MovieIcon from "@mui/icons-material/Movie";
import AudiotrackIcon from "@mui/icons-material/Audiotrack";
import PictureAsPdfIcon from "@mui/icons-material/PictureAsPdf";
import DescriptionIcon from "@mui/icons-material/Description";
import TableChartIcon from "@mui/icons-material/TableChart";
import SlideshowIcon from "@mui/icons-material/Slideshow";
import FolderZipIcon from "@mui/icons-material/FolderZip";
import CodeIcon from "@mui/icons-material/Code";
import ArticleIcon from "@mui/icons-material/Article";
import InsertDriveFileIcon from "@mui/icons-material/InsertDriveFile";

/**
 * File kinds by extension, with Drive's colour coding. Icons are bundled MUI
 * glyphs rather than remote images, which the CSP would block anyway.
 */
export const KINDS = {
    folder: { label: "Thư mục", icon: FolderIcon, color: "#5f6368" },
    image: {
        label: "Hình ảnh",
        icon: ImageIcon,
        color: "#d93025",
        ext: [
            "png",
            "jpg",
            "jpeg",
            "gif",
            "webp",
            "bmp",
            "svg",
            "heic",
            "avif",
            "ico",
        ],
    },
    video: {
        label: "Video",
        icon: MovieIcon,
        color: "#d93025",
        ext: ["mp4", "webm", "mkv", "mov", "avi", "m4v", "wmv", "flv"],
    },
    audio: {
        label: "Âm thanh",
        icon: AudiotrackIcon,
        color: "#d93025",
        ext: ["mp3", "aac", "wav", "flac", "ogg", "m4a", "opus"],
    },
    pdf: {
        label: "PDF",
        icon: PictureAsPdfIcon,
        color: "#ea4335",
        ext: ["pdf"],
    },
    doc: {
        label: "Tài liệu",
        icon: DescriptionIcon,
        color: "#4285f4",
        ext: ["doc", "docx", "odt", "rtf"],
    },
    sheet: {
        label: "Bảng tính",
        icon: TableChartIcon,
        color: "#0f9d58",
        ext: ["xls", "xlsx", "ods", "csv"],
    },
    slide: {
        label: "Bản trình bày",
        icon: SlideshowIcon,
        color: "#f4b400",
        ext: ["ppt", "pptx", "odp", "key"],
    },
    archive: {
        label: "Tệp nén",
        icon: FolderZipIcon,
        color: "#5f6368",
        ext: ["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "iso"],
    },
    code: {
        label: "Mã nguồn",
        icon: CodeIcon,
        color: "#1a73e8",
        ext: [
            "js",
            "jsx",
            "ts",
            "tsx",
            "py",
            "java",
            "c",
            "cpp",
            "h",
            "cs",
            "go",
            "rs",
            "php",
            "rb",
            "sh",
            "html",
            "css",
            "json",
            "xml",
            "yml",
            "yaml",
            "sql",
        ],
    },
    text: {
        label: "Văn bản",
        icon: ArticleIcon,
        color: "#4285f4",
        ext: ["txt", "md", "log", "ini", "srt", "vtt"],
    },
    other: { label: "Tệp", icon: InsertDriveFileIcon, color: "#5f6368" },
};

const byExt = new Map();
for (const [kind, info] of Object.entries(KINDS)) {
    for (const ext of info.ext ?? []) byExt.set(ext, kind);
}

export function extensionOf(name) {
    const index = name.lastIndexOf(".");
    return index > 0 ? name.slice(index + 1).toLowerCase() : "";
}

export function kindOf(record) {
    if (record.type === "folder") return "folder";
    return byExt.get(extensionOf(record.name)) ?? "other";
}

export function kindLabel(record) {
    return KINDS[kindOf(record)].label;
}

export const KIND_FILTERS = [
    "folder",
    "image",
    "video",
    "audio",
    "pdf",
    "doc",
    "sheet",
    "archive",
].map((kind) => ({
    kind,
    label: KINDS[kind].label,
}));

/** What the preview can show in the browser, and how. */
export function previewKind(record) {
    const kind = kindOf(record);
    const ext = extensionOf(record.name);
    if (kind === "image" && ext !== "heic") return "image";
    if (kind === "video" && ["mp4", "webm", "mov", "m4v"].includes(ext))
        return "video";
    if (kind === "audio") return "audio";
    if (kind === "pdf") return "pdf";
    if (kind === "text" || kind === "code") return "text";
    return null;
}

/** dataTransfer type for items dragged inside the app, as opposed to OS files. */
export const DRAG_TYPE = "application/x-cloudgram";

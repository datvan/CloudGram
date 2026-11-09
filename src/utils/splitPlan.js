// What Telegram takes in one file, and how to cut a bigger one. No browser or
// Vite imports, so server/test can load it.
const MiB = 1024 * 1024;

// parts a file may have x 512 KiB a part (core.telegram.org/api/config:
// upload_max_fileparts_default 4000, upload_max_fileparts_premium 8000)
export const FREE_MAX = 4000 * 512 * 1024;
export const PREMIUM_MAX = 8000 * 512 * 1024;

// Premium unknown (the profile could not be read) counts as Premium, so only
// what no account can send is stopped.
export const maxFileBytes = (premium) =>
    premium === false ? FREE_MAX : PREMIUM_MAX;

// A piece aims below the limit: cuts fall on keyframes and the bitrate
// changes with the scene, so a piece can come out bigger than the average.
const AIM = 0.85;
export const pieceBytes = (limit) => Math.floor((limit * AIM) / MiB) * MiB;
export const pieceCount = (size, limit) => Math.ceil(size / pieceBytes(limit));

const VIDEO = /\.(mp4|m4v|mov|mkv|avi|webm|wmv|flv|mpe?g|m2?ts|3gp)$/i;
export const isVideoName = (name) => VIDEO.test(name);

const quote = (text) => `"${text.replace(/"/g, '\\"')}"`;

/**
 * The command that cuts `name` (`size` bytes) into pieces under `limit`:
 * ffmpeg for a video, copying the streams as they are (no re-encoding, so no
 * loss), each piece a playable MP4; 7-Zip volumes for anything else.
 * `duration` in seconds; without it the command keeps a placeholder.
 * shortcut: a video always comes out as .mp4, so a codec MP4 cannot hold
 * makes ffmpeg stop with an error; upgrade by keeping the original extension.
 */
export function splitCommand(name, size, limit, duration) {
    const piece = pieceBytes(limit);
    if (!isVideoName(name))
        return `7z a -v${Math.floor(piece / MiB)}m ${quote(
            `${name}.7z`,
        )} ${quote(name)}`;
    const base = name.replace(/\.[^.]+$/, "").replace(/%/g, "%%");
    const seconds = duration
        ? Math.max(1, Math.floor((duration * piece) / size))
        : "<số giây>";
    return [
        `ffmpeg -i ${quote(name)} -map 0:v -map "0:a?" -c copy`,
        `-f segment -segment_time ${seconds} -reset_timestamps 1`,
        `-segment_format_options movflags=+faststart ${quote(
            `${base}.part%03d.mp4`,
        )}`,
    ].join(" ");
}

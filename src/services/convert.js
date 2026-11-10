/**
 * Turns a video the browser cannot play (avi, wmv, flv...) into an MP4 it can,
 * inside the tab, with ffmpeg compiled to WebAssembly. ffmpeg is a ~30 MB
 * download, fetched only when such a video is opened, and the file never
 * leaves the machine. The original in Telegram is not touched.
 */

// containers browsers cannot read; the file manager opens these through here
export const CONVERT_EXT = [
    "avi",
    "wmv",
    "asf",
    "flv",
    "mpg",
    "mpeg",
    "vob",
    "3gp",
    "3g2",
    "rm",
    "rmvb",
    "divx",
    "mts",
    "m2ts",
];

const extOf = (name) => name?.split(".").pop().toLowerCase();

// .ts is also TypeScript. A source file is never this big, a video stream
// (MPEG-TS) is, so size tells them apart without opening the file.
const TS_VIDEO_MIN = 1024 * 1024;

/** An MPEG-TS video, not a TypeScript file. */
export const isTsVideo = (record) =>
    extOf(record.name) === "ts" && record.size >= TS_VIDEO_MIN;

/** Does this file have to go through ffmpeg before a <video> can play it? */
export const needsConvert = (record) =>
    CONVERT_EXT.includes(extOf(record.name)) || isTsVideo(record);

// h264 with these sounds goes into an mp4 as it is, in seconds; anything else
// is re-encoded, which in WebAssembly runs at a fraction of real time
const COPYABLE_VIDEO = ["h264"];
const COPYABLE_AUDIO = ["aac", "mp3"];

/**
 * `blob` (a video in any container ffmpeg reads) as an MP4 Blob.
 * `onProgress(percent | null)`: null while the work cannot be measured.
 */
export async function convertToMp4(blob, name, onProgress = () => {}) {
    onProgress(null);
    const [{ FFmpeg }, coreURL, wasmURL] = await Promise.all([
        import("@ffmpeg/ffmpeg"),
        import(
            "../../node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.js?url"
        ).then((m) => m.default),
        import(
            "../../node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.wasm?url"
        ).then((m) => m.default),
    ]);
    const ffmpeg = new FFmpeg();
    try {
        let log = "";
        ffmpeg.on("log", ({ message }) => {
            log += `${message}\n`;
        });
        await ffmpeg.load({ coreURL, wasmURL });
        const input = `in.${extOf(name) || "bin"}`;
        await ffmpeg.writeFile(input, new Uint8Array(await blob.arrayBuffer()));

        // `-i` alone ends in an error by design; the log is what is wanted
        await ffmpeg.exec(["-i", input]);
        const video = /Video: (\w+)/.exec(log)?.[1];
        const audio = /Audio: (\w+)/.exec(log)?.[1];
        if (!video) throw new Error("không đọc được hình trong tệp này");

        const copy =
            COPYABLE_VIDEO.includes(video) &&
            (!audio || COPYABLE_AUDIO.includes(audio));
        ffmpeg.on("progress", ({ progress }) => {
            if (Number.isFinite(progress) && progress >= 0)
                onProgress(Math.min(99, Math.round(progress * 100)));
        });
        const args = copy
            ? ["-c", "copy"]
            : [
                  ...["-c:v", "libx264", "-preset", "ultrafast", "-crf", "28"],
                  // phones and TVs make the odd sizes x264 refuses
                  ...["-vf", "scale='min(854,iw)':-2", "-pix_fmt", "yuv420p"],
                  ...(audio ? ["-c:a", "aac", "-b:a", "128k"] : []),
              ];
        const code = await ffmpeg.exec([
            ...["-i", input],
            ...args,
            ...["-movflags", "+faststart", "out.mp4"],
        ]);
        if (code !== 0) throw new Error("ffmpeg không chuyển được tệp này");
        const out = await ffmpeg.readFile("out.mp4");
        onProgress(100);
        return new Blob([out], { type: "video/mp4" });
    } finally {
        // frees the WebAssembly memory, which can be gigabytes
        ffmpeg.terminate();
    }
}

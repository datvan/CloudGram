/**
 * How long the video at `url` is, in seconds, read from its start only
 * (0 when it cannot be read in time). Used to lay the parts of one video
 * along a single seek bar.
 */
export function probeLength(url, ms = 20000) {
    return new Promise((resolve) => {
        const video = document.createElement("video");
        const done = (seconds) => {
            clearTimeout(timer);
            video.removeAttribute("src");
            video.load();
            resolve(seconds);
        };
        const timer = setTimeout(() => done(0), ms);
        video.preload = "metadata";
        video.muted = true;
        video.onloadedmetadata = () =>
            done(Number.isFinite(video.duration) ? video.duration : 0);
        video.onerror = () => done(0);
        video.src = url;
    });
}

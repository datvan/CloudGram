import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import { execFileSync } from "node:child_process";

let buildId = "00000000";
try {
    const revision = execFileSync("git", ["rev-parse", "--short=8", "HEAD"], {
        encoding: "utf8",
    }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], {
        encoding: "utf8",
    }).trim();
    if (/^[0-9a-f]{7,12}$/.test(revision))
        buildId = revision + (dirty ? "-dirty" : "");
} catch {
    // Git is optional in source archives.
}

// https://vitejs.dev/config/
export default defineConfig({
    define: { __BUILD_ID__: JSON.stringify(buildId) },
    plugins: [react()],
    // ffmpeg starts its own worker from a path inside the package, which the
    // dev server's pre-bundling would break
    optimizeDeps: { exclude: ["@ffmpeg/ffmpeg"] },
    server: {
        // `npm run dev:api` serves the account service here; in production
        // nginx does the same proxying
        proxy: { "/api": "http://127.0.0.1:4322" },
    },
});

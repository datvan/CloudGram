import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";

// https://vitejs.dev/config/
export default defineConfig({
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

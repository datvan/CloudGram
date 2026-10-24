import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [react()],
    server: {
        // `npm run dev:api` serves the account service here; in production
        // nginx does the same proxying
        proxy: { "/api": "http://127.0.0.1:4322" },
    },
});

// Decrypts download parts away from the page, so several connections can
// decrypt at once and the page stays responsive meanwhile (decryptWorkers.js).
import { decryptIge } from "./fastIge";

self.onmessage = ({ data: { id, body, key, iv } }) => {
    try {
        const out = decryptIge(body, key, iv);
        self.postMessage({ id, out }, [out.buffer]);
    } catch (error) {
        self.postMessage({ id, error: String(error) });
    }
};

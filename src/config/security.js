// Operator flags: only the literal "0" restores the previous behavior.
export const STREAM_GUARD = import.meta.env.VITE_SECURITY_STREAM_GUARD !== "0";
export const UPLOAD_OWNER = import.meta.env.VITE_SECURITY_UPLOAD_OWNER !== "0";
export const LOG_OWNER = import.meta.env.VITE_SECURITY_LOG_OWNER !== "0";

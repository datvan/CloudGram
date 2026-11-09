// Feature flags: like security.js, only the literal "0" switches one off.
// VITE_FEATURE_SPLIT_LARGE=0 and a rebuild: files over Telegram's limit are
// no longer caught before upload (the behavior from before this feature).
export const SPLIT_LARGE = import.meta.env.VITE_FEATURE_SPLIT_LARGE !== "0";

// Feature flags: like security.js, only the literal "0" switches one off.
// VITE_FEATURE_SPLIT_LARGE=0 and a rebuild: files over Telegram's limit are
// no longer caught before upload (the behavior from before this feature).
export const SPLIT_LARGE = import.meta.env.VITE_FEATURE_SPLIT_LARGE !== "0";

// VITE_FEATURE_LOCAL_HELPER=0 and a rebuild: the dialog for a file over the
// limit only shows the command to cut it by hand, with no helper program.
export const LOCAL_HELPER = import.meta.env.VITE_FEATURE_LOCAL_HELPER !== "0";

// VITE_FEATURE_SPLIT_RAW=0 and a rebuild: a file over the limit is stopped
// again (the dialog above), instead of going up as several messages that
// the drive shows and plays as one file. Files already sent that way keep
// working: reading them does not depend on this switch.
export const SPLIT_RAW = import.meta.env.VITE_FEATURE_SPLIT_RAW !== "0";

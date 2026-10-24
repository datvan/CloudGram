import { createTheme } from "@mui/material/styles";

/**
 * A Google Drive look: a tinted page, white (or dark grey) surfaces, the
 * pill-shaped selection colour, and Roboto throughout.
 */
export function makeTheme(mode) {
    const light = mode === "light";
    return createTheme({
        palette: {
            mode,
            primary: { main: light ? "#0b57d0" : "#a8c7fa" },
            secondary: { main: light ? "#c2e7ff" : "#004a77" },
            background: {
                default: light ? "#f8fafd" : "#1b1b1b",
                paper: light ? "#ffffff" : "#131314",
            },
            text: {
                primary: light ? "#1f1f1f" : "#e3e3e3",
                secondary: light ? "#444746" : "#c4c7c5",
            },
            divider: light ? "#e1e3e1" : "#444746",
            action: {
                selected: light ? "#c2e7ff" : "#004a77",
                hover: light ? "rgba(68,71,70,0.08)" : "rgba(227,227,227,0.08)",
            },
        },
        shape: { borderRadius: 12 },
        typography: {
            fontFamily: "Roboto, 'Google Sans', Arial, sans-serif",
            button: { textTransform: "none", fontWeight: 500 },
        },
        components: {
            MuiButton: {
                styleOverrides: { root: { borderRadius: 999 } },
            },
            MuiDialog: {
                styleOverrides: { paper: { borderRadius: 28, padding: 8 } },
            },
            MuiMenu: {
                styleOverrides: { paper: { borderRadius: 8, minWidth: 220 } },
            },
            MuiTooltip: {
                defaultProps: { enterDelay: 500 },
            },
        },
    });
}

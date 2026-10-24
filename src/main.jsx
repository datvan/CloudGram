import { useMemo, useState } from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";

// redux
import { Provider } from "react-redux";
import { Store } from "./redux/store.js";

// mui theme
import { ThemeProvider } from "@mui/material/styles";
import CssBaseline from "@mui/material/CssBaseline";
import useMediaQuery from "@mui/material/useMediaQuery";
import "@fontsource/roboto/300.css";
import "@fontsource/roboto/400.css";
import "@fontsource/roboto/500.css";
import "@fontsource/roboto/700.css";

import { makeTheme } from "./theme";

// the transfer speed benchmark (window.cgBench); dev server only
if (import.meta.env.DEV) import("./utils/transferBench");

function readMode() {
    try {
        return localStorage.getItem("cloudgram.theme");
    } catch {
        return null;
    }
}

// eslint-disable-next-line react-refresh/only-export-components
function Root() {
    const prefersDark = useMediaQuery("(prefers-color-scheme: dark)");
    const [chosen, setChosen] = useState(readMode);
    const mode = chosen ?? (prefersDark ? "dark" : "light");
    const theme = useMemo(() => makeTheme(mode), [mode]);

    function toggle() {
        const next = mode === "light" ? "dark" : "light";
        setChosen(next);
        try {
            localStorage.setItem("cloudgram.theme", next);
        } catch {
            // the choice just will not survive a reload
        }
    }

    return (
        <ThemeProvider theme={theme}>
            <CssBaseline />
            <Provider store={Store}>
                <App mode={mode} onToggleMode={toggle} />
            </Provider>
        </ThemeProvider>
    );
}

// dev builds only: lets the browser console drive the store when exercising
// the UI without a Telegram account
if (import.meta.env.DEV) {
    import("./services/drive").then((drive) => {
        window.__cloudgram = { Store, drive };
    });
}

ReactDOM.createRoot(document.getElementById("root")).render(<Root />);

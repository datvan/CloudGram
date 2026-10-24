import { useEffect } from "react";
import PropTypes from "prop-types";
import { useSelector } from "react-redux";
import { BrowserRouter, Route, Routes } from "react-router-dom";

import DriveApp from "./pages/drive/DriveApp";
import SignIn from "./pages/auth/SignIn";
import Setup from "./pages/auth/Setup";
import TelegramLink from "./pages/auth/TelegramLink";
import {
    Connecting,
    ErrorScreen,
    LeaseScreen,
} from "./pages/auth/StatusScreens";
import SharePage from "./pages/share/SharePage";
import { boot, logout } from "./services/account";

const SHARE_PATH = /^\/s\/[^/]+\/?$/;

/**
 * A share link opens without signing in or touching Telegram; everything else
 * goes through the account flow.
 */
export default function App(props) {
    return SHARE_PATH.test(window.location.pathname) ? (
        <SharePage />
    ) : (
        <DriveRoot {...props} />
    );
}

App.propTypes = {
    mode: PropTypes.string,
    onToggleMode: PropTypes.func,
};

/** Which screen the sign-in phase calls for; services/account.js drives it. */
function DriveRoot({ mode, onToggleMode }) {
    const { phase, username, setupToken } = useSelector((state) => state.auth);

    useEffect(() => {
        boot();
    }, []);

    let screen;
    switch (phase) {
        case "setup":
            screen = <Setup token={setupToken} />;
            break;
        case "signedOut":
            screen = <SignIn />;
            break;
        case "locked":
            screen = (
                <SignIn locked username={username} onSwitchUser={logout} />
            );
            break;
        case "lease":
            screen = <LeaseScreen />;
            break;
        case "link":
            screen = <TelegramLink />;
            break;
        case "error":
            screen = <ErrorScreen />;
            break;
        case "ready":
            screen = <DriveApp mode={mode} onToggleMode={onToggleMode} />;
            break;
        default:
            screen = <Connecting />;
    }

    return (
        <BrowserRouter>
            <Routes>
                <Route path="*" element={screen} />
            </Routes>
        </BrowserRouter>
    );
}

DriveRoot.propTypes = {
    mode: PropTypes.string,
    onToggleMode: PropTypes.func,
};

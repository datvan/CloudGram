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
import { boot, logout } from "./services/account";

/** Which screen the sign-in phase calls for; services/account.js drives it. */
export default function App({ mode, onToggleMode }) {
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

App.propTypes = {
    mode: PropTypes.string,
    onToggleMode: PropTypes.func,
};

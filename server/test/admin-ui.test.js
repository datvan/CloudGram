import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = (path) =>
    readFile(new URL(`../../src/${path}`, import.meta.url), "utf8");

test("account state tracks admin and blocks storage entry", async () => {
    const account = await source("services/account.js");
    assert.match(account, /admin: account\.admin/);
    assert.match(account, /admin: current\.admin/);
    assert.match(account, /phase: "signedOut"[\s\S]*?admin: false/);
    assert.match(
        account,
        /async function enter\(key\) \{[\s\S]*?if \(!account\.admin\) \{[\s\S]*?phase: "link"[\s\S]*?return;[\s\S]*?openDrive/,
    );
});

test("Telegram entries require admin", async () => {
    const top = await source("components/drive/TopBar.jsx");
    assert.match(top, /admin && me &&/);
    for (const action of ["quick", "unlink", "backup"])
        assert.match(top, new RegExp(`admin &&[^}]*?pick\\("${action}"\\)`));
    assert.match(
        await source("components/drive/QuickSettings.jsx"),
        /admin && privateTelegram && SHARED_TELEGRAM/,
    );
    const signIn = await source("pages/auth/SignIn.jsx");
    assert.match(signIn, /admin && quick/);
    assert.match(signIn, /admin && !locked/);
    const dialogs = await source("components/drive/Dialogs.jsx");
    const backup = dialogs.slice(
        dialogs.indexOf("export function BackupDialog"),
        dialogs.indexOf("BackupDialog.propTypes"),
    );
    assert.match(backup, /if \(!admin \|\| !open\) return/);
    assert.match(
        backup,
        /if \(!admin\) return null;[\s\S]*?restoreBackup[\s\S]*?importFromTelegram/,
    );
    assert.match(
        await source("pages/drive/DriveApp.jsx"),
        /!admin && \["quick", "unlink", "backup"\]\.includes\(action\)/,
    );
});

test("non-admin link screen does not connect and offers logout", async () => {
    const link = await source("pages/auth/TelegramLink.jsx");
    const effect = link.match(
        /useEffect\(\(\) => \{([\s\S]*?)\r?\n    \}, \[admin\]\);/,
    )[1];
    let calls = 0;
    const context = vm.createContext({
        admin: false,
        AbortController,
        openSharedClient: () => calls++,
        newClient: () => calls++,
        sendCode: () => calls++,
        adoptLegacySession: () => calls++,
    });
    vm.runInContext(`(function () {${effect}})()`, context);
    assert.equal(calls, 0);
    assert.match(
        link,
        /if \(!admin\)\s*return \([\s\S]*?Tài khoản này chưa được cấp quyền lưu trữ\. Liên hệ quản\s+trị viên\.[\s\S]*?onClick=\{logout\}[\s\S]*?Đăng xuất[\s\S]*?\);\s*return \(/,
    );
    assert.match(
        await source("services/api.js"),
        /admin_only:\s*"Tài khoản này chưa được cấp quyền lưu trữ\. Liên hệ quản trị viên\."/,
    );
});

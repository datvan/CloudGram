import { createHmac, randomBytes } from "node:crypto";

export const requestId = () => randomBytes(4).toString("hex");

export function accountId(pepper, username) {
    return pepper && username
        ? createHmac("sha256", pepper)
              .update(username)
              .digest("hex")
              .slice(0, 8)
        : "-";
}

export function errorDetails(error) {
    const name =
        typeof error?.name === "string" &&
        /^[A-Z][A-Za-z]{2,39}$/.test(error.name)
            ? error.name
            : "Error";
    const code =
        typeof error?.code === "string" &&
        /^[A-Z][A-Z0-9_]{2,39}$/.test(error.code)
            ? error.code
            : undefined;
    const header =
        typeof error?.message === "string" && error.message
            ? `${error.name}: ${error.message}`
            : `${error?.name || "Error"}`;
    const source = typeof error?.stack === "string" ? error.stack : "";
    const firstNewline = source.indexOf("\n");
    const frames = source.startsWith(header)
        ? source.slice(header.length)
        : firstNewline < 0
          ? ""
          : source.slice(firstNewline + 1);
    const stack = source
        ? frames
              .split("\n")
              .map((line) => {
                  const match =
                      /^\s*at (?:(?:async |new )?([\w.$<>]+)(?: \[as [\w$]+\])? \(.*:(\d+):(\d+)\)|.*:(\d+):(\d+))\s*$/.exec(
                          line,
                      );
                  return match
                      ? `${match[1] || "anonymous"}:${match[2] || match[4]}:${match[3] || match[5]}`
                      : null;
              })
              .filter(Boolean)
              .slice(0, 12)
        : [];
    return { errName: name, ...(code ? { errCode: code } : {}), stack };
}

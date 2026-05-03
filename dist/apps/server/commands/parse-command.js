"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseBuiltInCommand = parseBuiltInCommand;
const COMMANDS = [
    "/new",
    "/reset",
    "/clear",
    "/last",
    "/yesterday",
    "/memory",
    "/mode",
    "/summary",
    "/time",
    "/recent",
    "/help",
    "/whoami",
    "/sessions",
    "/file",
    "/sendfile",
    "/files",
    "/accounts",
    "/codex",
];
function splitCommandArgs(raw) {
    const args = [];
    let current = "";
    let quote;
    let escaping = false;
    for (const char of raw) {
        if (escaping) {
            current += char;
            escaping = false;
            continue;
        }
        if (char === "\\") {
            escaping = true;
            continue;
        }
        if (quote) {
            if (char === quote) {
                quote = undefined;
            }
            else {
                current += char;
            }
            continue;
        }
        if (char === "\"" || char === "'") {
            quote = char;
            continue;
        }
        if (/\s/.test(char)) {
            if (current) {
                args.push(current);
                current = "";
            }
            continue;
        }
        current += char;
    }
    if (escaping) {
        current += "\\";
    }
    if (current) {
        args.push(current);
    }
    return args;
}
function parseBuiltInCommand(text) {
    const trimmed = text.trim();
    const head = trimmed.split(/\s+/, 1)[0];
    if (!head || !COMMANDS.includes(head)) {
        return undefined;
    }
    const argText = trimmed.slice(head.length).trim();
    return {
        name: head,
        raw: trimmed,
        args: splitCommandArgs(argText),
    };
}

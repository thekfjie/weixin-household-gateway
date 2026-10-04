import { BuiltInCommand, ParsedCommand } from "./types.js";

const COMMANDS: readonly BuiltInCommand[] = [
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

function splitCommandArgs(raw: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "\"" | "'" | undefined;
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
      } else {
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

export function parseBuiltInCommand(text: string): ParsedCommand | undefined {
  const trimmed = text.trim();
  const head = trimmed.split(/\s+/, 1)[0] as BuiltInCommand | undefined;
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

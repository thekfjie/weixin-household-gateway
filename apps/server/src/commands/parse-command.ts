import { BuiltInCommand, ParsedCommand } from "./types.js";
import { splitCommandArgs } from "../utils/index.js";

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
  "/output",
];

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

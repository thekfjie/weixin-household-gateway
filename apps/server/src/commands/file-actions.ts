import path from "node:path";
import { ParsedCommand } from "./types.js";

export function extractQuotedText(text: string): string | undefined {
  const match = text.match(/["'""'']([^"'""'']+)["'""'']/);
  return match?.[1]?.trim() || undefined;
}

export function extractAbsolutePath(text: string): string | undefined {
  const quoted = extractQuotedText(text);
  if (quoted && (path.isAbsolute(quoted) || /^[A-Za-z]:[\\\/]/.test(quoted))) {
    return quoted;
  }

  const match = text.match(
    /(?:^|\s)((?:\/[^\s"'""'']+)+|[A-Za-z]:[\\\/][^\s"'""'']+)/,
  );
  return match?.[1]?.trim() || undefined;
}

export function parseNaturalFileRequest(text: string): ParsedCommand | undefined {
  const hasSendIntent = /(发|发送|传|传给|send)\s*/i.test(text);
  if (!hasSendIntent) {
    return undefined;
  }

  const filePath = extractAbsolutePath(text);
  if (!filePath) {
    return undefined;
  }

  const caption = text.replace(filePath, "").replace(/["'""'']/g, "").trim();
  return {
    name: "/file",
    raw: text,
    args: caption ? [filePath, caption] : [filePath],
  };
}

export function parseAssistantFileAction(text: string):
  | {
      command: ParsedCommand;
      cleanedText: string;
    }
  | undefined {
  const match = text.match(
    /\[\[send_file\s+path=(?:"([^"]+)"|'([^']+)'|([^\]\s]+))(?:\s+caption=(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\s*\]\]/i,
  );
  if (!match) {
    return undefined;
  }

  const filePath = (match[1] ?? match[2] ?? match[3] ?? "").trim();
  const caption = (match[4] ?? match[5] ?? match[6] ?? "").trim();
  if (!filePath) {
    return undefined;
  }

  return {
    command: {
      name: "/file",
      raw: match[0],
      args: caption ? [filePath, caption] : [filePath],
    },
    cleanedText: text.replace(match[0], "").trim(),
  };
}

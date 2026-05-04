export interface SplitCommandArgsOptions {
  strictQuotes?: boolean;
}

export function splitCommandArgs(
  raw: string,
  options: SplitCommandArgsOptions = {},
): string[] {
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

  if (quote && options.strictQuotes) {
    throw new Error(`Unclosed quote in command args: ${raw}`);
  }

  if (current) {
    args.push(current);
  }

  return args;
}

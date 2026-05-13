export type BuiltInCommand =
  | "/new"
  | "/reset"
  | "/clear"
  | "/last"
  | "/yesterday"
  | "/memory"
  | "/mode"
  | "/summary"
  | "/time"
  | "/recent"
  | "/help"
  | "/whoami"
  | "/sessions"
  | "/file"
  | "/sendfile"
  | "/files"
  | "/accounts"
  | "/codex"
  | "/output";

export interface ParsedCommand {
  name: BuiltInCommand;
  raw: string;
  args: string[];
}

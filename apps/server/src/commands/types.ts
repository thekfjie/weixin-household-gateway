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
  | "/stop"
  | "/cancel"
  | "/whoami"
  | "/sessions"
  | "/file"
  | "/sendfile"
  | "/files"
  | "/accounts"
  | "/codex"
  | "/provider"
  | "/output";

export interface ParsedCommand {
  name: BuiltInCommand;
  raw: string;
  args: string[];
}

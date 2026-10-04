import { CodexRuntimeConfig } from "../config/types.js";
import { AcpCodexBackend } from "./acp-backend.js";
import { CodexBackend } from "./backend-types.js";
import { CliCodexBackend } from "./cli-backend.js";

export function createCodexBackend(config: CodexRuntimeConfig): CodexBackend {
  return config.backend === "acp"
    ? new AcpCodexBackend(config)
    : new CliCodexBackend(config);
}

import { CodexRuntimeConfig } from "../config/types.js";
import { AcpCodexBackend } from "./acp-backend.js";
import { ApiCodexBackend } from "./api-backend.js";
import { CodexBackend } from "./backend-types.js";
import { CliCodexBackend } from "./cli-backend.js";

export function createCodexBackend(config: CodexRuntimeConfig): CodexBackend {
  if (config.backend === "acp") {
    return new AcpCodexBackend(config);
  }

  if (config.backend === "api") {
    return new ApiCodexBackend(config);
  }

  return new CliCodexBackend(config);
}

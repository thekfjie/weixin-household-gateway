import { AppConfig, UserRole } from "../config/types.js";

export function buildApiSystemPrompt(params: {
  config: AppConfig;
  role: UserRole;
}): string {
  return params.role === "admin"
    ? params.config.prompts.adminApi
    : params.config.prompts.familyApi;
}

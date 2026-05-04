import { UserRole } from "../config/types.js";
import { WechatAccountRecord } from "../storage/index.js";

export function isUserRole(value: unknown): value is UserRole {
  return value === "admin" || value === "family";
}

export function sanitizeAccountRecord(
  account: WechatAccountRecord,
): Record<string, unknown> {
  return {
    id: account.id,
    displayName: account.displayName ?? null,
    role: account.role,
    uin: account.uin,
    baseUrl: account.baseUrl ?? null,
    status: account.status,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

import { UserRole } from "../config/types.js";

export interface RouteTarget {
  role: UserRole;
  reason: string;
}

export function resolveRole(params: {
  configuredRole?: UserRole;
}): RouteTarget {
  if (params.configuredRole === "admin") {
    return {
      role: "admin",
      reason: "account role is explicitly configured as admin",
    };
  }

  return {
    role: "family",
    reason: "fall back to family route by default",
  };
}

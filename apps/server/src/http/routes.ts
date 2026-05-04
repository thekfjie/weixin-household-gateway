import http from "node:http";
import { AppConfig } from "../config/types.js";
import { renderLoginPage } from "../login-page.js";
import { formatBeijingTime } from "../sessions/index.js";
import { AppDatabase } from "../storage/index.js";
import { isUserRole, sanitizeAccountRecord } from "./accounts.js";
import { LoginManager } from "./login-manager.js";
import {
  readJsonBody,
  respondHtml,
  respondJson,
  respondPng,
} from "./response.js";

const SERVICE_NAME = "weixin-household-gateway";
const ROOT_ENDPOINTS = [
  "/healthz",
  "/readyz",
  "/api/accounts",
  "/api/logins",
  "/api/logins/:id",
  "/api/logins/:id/view",
  "/api/logins/:id/qrcode.png",
  "/api/accounts/:id/role",
];

interface HttpRouteContext {
  request: http.IncomingMessage;
  response: http.ServerResponse;
  config: AppConfig;
  database: AppDatabase;
  loginManager: LoginManager;
  startedAt: string;
  method: string;
  pathname: string;
  segments: string[];
}

export async function routeHttpRequest(params: {
  request: http.IncomingMessage;
  response: http.ServerResponse;
  config: AppConfig;
  database: AppDatabase;
  loginManager: LoginManager;
  startedAt: string;
}): Promise<void> {
  const requestUrl = new URL(params.request.url ?? "/", "http://127.0.0.1");
  const context: HttpRouteContext = {
    ...params,
    method: params.request.method ?? "GET",
    pathname: requestUrl.pathname,
    segments: requestUrl.pathname.split("/").filter(Boolean),
  };

  if (await handleHealthRoutes(context)) {
    return;
  }

  if (await handleAccountRoutes(context)) {
    return;
  }

  if (await handleLoginRoutes(context)) {
    return;
  }

  if (await handleRootRoute(context)) {
    return;
  }

  respondJson(context.response, 404, {
    ok: false,
    error: "not_found",
    path: context.pathname,
  });
}

async function handleHealthRoutes(
  context: HttpRouteContext,
): Promise<boolean> {
  if (context.method === "GET" && context.pathname === "/healthz") {
    respondJson(context.response, 200, {
      ok: true,
      service: SERVICE_NAME,
      timezone: context.config.server.timezone,
      startedAt: context.startedAt,
    });
    return true;
  }

  if (context.method === "GET" && context.pathname === "/readyz") {
    respondJson(context.response, 200, {
      ok: true,
      databaseFile: context.database.getFilePath(),
      accounts: context.database.listAccounts().length,
    });
    return true;
  }

  return false;
}

async function handleAccountRoutes(
  context: HttpRouteContext,
): Promise<boolean> {
  if (context.method === "GET" && context.pathname === "/api/accounts") {
    respondJson(context.response, 200, {
      ok: true,
      accounts: context.database.listAccounts().map(sanitizeAccountRecord),
    });
    return true;
  }

  if (
    context.method === "POST" &&
    context.segments[0] === "api" &&
    context.segments[1] === "accounts" &&
    context.segments[3] === "role" &&
    context.segments.length === 4
  ) {
    const accountId = decodeURIComponent(context.segments[2] ?? "");
    const body = await readJsonBody(context.request);

    if (!isUserRole(body.role)) {
      respondJson(context.response, 400, {
        ok: false,
        error: "invalid_role",
      });
      return true;
    }

    if (!context.database.getAccountById(accountId)) {
      respondJson(context.response, 404, {
        ok: false,
        error: "account_not_found",
      });
      return true;
    }

    const updated = context.database.updateAccountRole(accountId, body.role);
    respondJson(context.response, 200, {
      ok: true,
      account: sanitizeAccountRecord(updated),
    });
    return true;
  }

  return false;
}

async function handleLoginRoutes(context: HttpRouteContext): Promise<boolean> {
  if (context.method === "POST" && context.pathname === "/api/logins") {
    const body = await readJsonBody(context.request);
    const role = isUserRole(body.role) ? body.role : "family";
    const created = await context.loginManager.create(role);

    respondJson(context.response, 201, {
      ok: true,
      login: created,
    });
    return true;
  }

  if (
    context.method === "GET" &&
    context.segments[0] === "api" &&
    context.segments[1] === "logins" &&
    context.segments.length === 3
  ) {
    const login = context.loginManager.serializeById(
      decodeURIComponent(context.segments[2] ?? ""),
    );
    if (!login) {
      respondJson(context.response, 404, {
        ok: false,
        error: "login_not_found",
      });
      return true;
    }

    respondJson(context.response, 200, {
      ok: true,
      login,
    });
    return true;
  }

  if (
    context.method === "GET" &&
    context.segments[0] === "api" &&
    context.segments[1] === "logins" &&
    context.segments[3] === "view" &&
    context.segments.length === 4
  ) {
    const loginId = decodeURIComponent(context.segments[2] ?? "");
    const login = context.loginManager.serializeById(loginId);
    if (!login) {
      respondJson(context.response, 404, {
        ok: false,
        error: "login_not_found",
      });
      return true;
    }

    respondHtml(
      context.response,
      200,
      renderLoginPage({
        loginId,
        role: String(login.role ?? "family"),
        status: String(login.status ?? "waiting"),
      }),
    );
    return true;
  }

  if (
    context.method === "GET" &&
    context.segments[0] === "api" &&
    context.segments[1] === "logins" &&
    context.segments[3] === "qrcode.png" &&
    context.segments.length === 4
  ) {
    const buffer = context.loginManager.getQrCodeBuffer(
      decodeURIComponent(context.segments[2] ?? ""),
    );
    if (!buffer) {
      respondJson(context.response, 404, {
        ok: false,
        error: "login_not_found",
      });
      return true;
    }

    respondPng(context.response, 200, buffer);
    return true;
  }

  return false;
}

async function handleRootRoute(context: HttpRouteContext): Promise<boolean> {
  if (context.method !== "GET" || context.pathname !== "/") {
    return false;
  }

  respondJson(context.response, 200, {
    service: SERVICE_NAME,
    status: "running",
    time: formatBeijingTime(new Date()),
    endpoints: ROOT_ENDPOINTS,
  });
  return true;
}

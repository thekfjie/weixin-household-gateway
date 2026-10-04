import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import QRCode from "qrcode";
import { loadConfig } from "./config/index.js";
import { AppConfig, UserRole } from "./config/types.js";
import { formatBeijingTime } from "./sessions/index.js";
import {
  AppDatabase,
  SQLITE_SCHEMA,
  WechatAccountRecord,
} from "./storage/index.js";
import {
  ILinkApiClient,
  ILinkQrCodeResponse,
  ILinkQrCodeStatusResponse,
  summarizeQrStatus,
  WechatWorker,
} from "./transport/index.js";

function ensureDirectory(target: string): void {
  fs.mkdirSync(target, { recursive: true });
}

function writeSchemaSnapshot(dataDir: string): string {
  const outputPath = path.join(dataDir, "schema.sql");
  fs.writeFileSync(outputPath, SQLITE_SCHEMA, "utf8");
  return outputPath;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function respondJson(
  response: http.ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>,
): void {
  const body = JSON.stringify(payload, null, 2);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body, "utf8"),
  });
  response.end(body);
}

function respondPng(
  response: http.ServerResponse,
  statusCode: number,
  buffer: Buffer,
): void {
  response.writeHead(statusCode, {
    "Content-Type": "image/png",
    "Content-Length": buffer.length,
    "Cache-Control": "no-store",
  });
  response.end(buffer);
}

function respondHtml(
  response: http.ServerResponse,
  statusCode: number,
  html: string,
): void {
  response.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html, "utf8"),
    "Cache-Control": "no-store",
  });
  response.end(html);
}

async function readJsonBody(
  request: http.IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }

  return JSON.parse(raw) as Record<string, unknown>;
}

function isUserRole(value: unknown): value is UserRole {
  return value === "admin" || value === "family";
}

function sanitizeAccountRecord(account: WechatAccountRecord): Record<string, unknown> {
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

interface PendingLoginRecord {
  id: string;
  role: UserRole;
  qrcode: string;
  qrcodeContentUrl: string;
  qrcodeFilePath: string;
  status: "waiting" | "scanned" | "confirmed" | "expired" | "failed";
  refreshCount: number;
  createdAt: string;
  updatedAt: string;
  error?: string | undefined;
  accountId?: string;
  scannedByUserId?: string;
  baseUrl?: string;
}

class LoginManager {
  private readonly pending = new Map<string, PendingLoginRecord>();

  private readonly qrCodeDir: string;

  private readonly maxRefreshes = 3;

  constructor(
    private readonly config: AppConfig,
    private readonly database: AppDatabase,
  ) {
    this.qrCodeDir = path.join(config.server.dataDir, "qrcodes");
    ensureDirectory(this.qrCodeDir);
  }

  private createClient(): ILinkApiClient {
    return new ILinkApiClient({
      baseUrl: this.config.wechat.apiBaseUrl,
      cdnBaseUrl: this.config.wechat.cdnBaseUrl,
      channelVersion: this.config.wechat.channelVersion,
      ...(this.config.wechat.routeTag
        ? { routeTag: this.config.wechat.routeTag }
        : {}),
    });
  }

  private serialize(record: PendingLoginRecord): Record<string, unknown> {
    return {
      id: record.id,
      role: record.role,
      status: record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      accountId: record.accountId ?? null,
      scannedByUserId: record.scannedByUserId ?? null,
      baseUrl: record.baseUrl ?? null,
      error: record.error ?? null,
      refreshCount: record.refreshCount,
      qrcodeContentUrl: record.qrcodeContentUrl,
      qrcodeViewUrl: `/api/logins/${encodeURIComponent(record.id)}/view`,
      qrcodeImageUrl: `/api/logins/${encodeURIComponent(record.id)}/qrcode.png`,
      qrcodeFilePath: record.qrcodeFilePath,
    };
  }

  private updateRecord(
    loginId: string,
    patch: Partial<PendingLoginRecord> & { error?: string | undefined },
  ): PendingLoginRecord {
    const current = this.pending.get(loginId);
    if (!current) {
      throw new Error(`Login session not found: ${loginId}`);
    }

    const updated: PendingLoginRecord = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.pending.set(loginId, updated);
    return updated;
  }

  private async monitorLogin(record: PendingLoginRecord): Promise<void> {
    const client = this.createClient();

    try {
      let attempt = 0;

      while (attempt < 180) {
        attempt += 1;
        const status = await client.pollQRCodeStatus(record.qrcode);
        const shouldStop = await this.handleQrStatus(record.id, status, client);

        if (shouldStop) {
          return;
        }

        await sleep(1_000);
      }

      this.updateRecord(record.id, {
        status: "failed",
        error: "QR login confirmation timed out",
      });
    } catch (error) {
      this.updateRecord(record.id, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleQrStatus(
    loginId: string,
    status: ILinkQrCodeStatusResponse,
    client: ILinkApiClient,
  ): Promise<boolean> {
    const summarized = summarizeQrStatus(status);

    if (summarized === "waiting") {
      this.updateRecord(loginId, { status: "waiting" });
      return false;
    }

    if (summarized === "scanned") {
      this.updateRecord(loginId, { status: "scanned" });
      return false;
    }

    if (summarized === "expired") {
      const current = this.get(loginId);
      if (current && current.refreshCount < this.maxRefreshes) {
        const nextQrCode = await client.getQRCode();
        await this.replaceQrCode(loginId, nextQrCode, current.refreshCount + 1);
        return false;
      }

      this.updateRecord(loginId, {
        status: "expired",
        error: "QR code expired before confirmation",
      });
      return true;
    }

    if (
      summarized === "confirmed" &&
      status.bot_token &&
      status.ilink_bot_id &&
      status.baseurl
    ) {
      this.database.saveAccount({
        id: status.ilink_bot_id,
        role: this.get(loginId)?.role ?? "family",
        authToken: status.bot_token,
        uin: status.ilink_user_id ?? status.ilink_bot_id,
        baseUrl: status.baseurl,
        status: "active",
      });

      this.updateRecord(loginId, {
        status: "confirmed",
        accountId: status.ilink_bot_id,
        baseUrl: status.baseurl,
        ...(status.ilink_user_id
          ? { scannedByUserId: status.ilink_user_id }
          : {}),
      });
      return true;
    }

    this.updateRecord(loginId, {
      status: "failed",
      error: `Unexpected QR status payload: ${JSON.stringify(status)}`,
    });
    return true;
  }

  async create(role: UserRole): Promise<Record<string, unknown>> {
    const client = this.createClient();
    const qrCode = await client.getQRCode();
    const loginId = crypto.randomUUID();
    const qrcodeFilePath = path.join(this.qrCodeDir, `${loginId}.png`);

    await this.writeQrCodeFile(qrCode, qrcodeFilePath);

    const record: PendingLoginRecord = {
      id: loginId,
      role,
      qrcode: qrCode.qrcode,
      qrcodeContentUrl: qrCode.qrcode_img_content,
      qrcodeFilePath,
      status: "waiting",
      refreshCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.pending.set(loginId, record);
    void this.monitorLogin(record);
    return this.serialize(record);
  }

  get(loginId: string): PendingLoginRecord | undefined {
    return this.pending.get(loginId);
  }

  serializeById(loginId: string): Record<string, unknown> | undefined {
    const record = this.pending.get(loginId);
    return record ? this.serialize(record) : undefined;
  }

  getQrCodeBuffer(loginId: string): Buffer | undefined {
    const record = this.pending.get(loginId);
    if (!record) {
      return undefined;
    }

    return fs.existsSync(record.qrcodeFilePath)
      ? fs.readFileSync(record.qrcodeFilePath)
      : undefined;
  }

  private async replaceQrCode(
    loginId: string,
    qrCode: ILinkQrCodeResponse,
    refreshCount: number,
  ): Promise<void> {
    const record = this.get(loginId);
    if (!record) {
      return;
    }

    await this.writeQrCodeFile(qrCode, record.qrcodeFilePath);
    const nextPatch: Partial<PendingLoginRecord> & {
      error?: string | undefined;
    } = {
      qrcode: qrCode.qrcode,
      qrcodeContentUrl: qrCode.qrcode_img_content,
      status: "waiting",
      refreshCount,
    };

    nextPatch.error = undefined;
    this.updateRecord(loginId, nextPatch);
  }

  private async writeQrCodeFile(
    qrCode: ILinkQrCodeResponse,
    filePath: string,
  ): Promise<void> {
    const buffer = await QRCode.toBuffer(qrCode.qrcode_img_content, {
      type: "png",
      errorCorrectionLevel: "M",
      margin: 1,
      width: 320,
    });
    fs.writeFileSync(filePath, buffer);
  }
}

function createHealthServer(params: {
  config: AppConfig;
  database: AppDatabase;
  loginManager: LoginManager;
  startedAt: string;
}): http.Server {
  return http.createServer(async (request, response) => {
    const method = request.method ?? "GET";
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const pathname = requestUrl.pathname;
    const segments = pathname.split("/").filter(Boolean);

    try {
      if (method === "GET" && pathname === "/healthz") {
        respondJson(response, 200, {
          ok: true,
          service: "weixin-household-gateway",
          timezone: params.config.server.timezone,
          startedAt: params.startedAt,
        });
        return;
      }

      if (method === "GET" && pathname === "/readyz") {
        respondJson(response, 200, {
          ok: true,
          databaseFile: params.database.getFilePath(),
          accounts: params.database.listAccounts().length,
        });
        return;
      }

      if (method === "GET" && pathname === "/api/accounts") {
        respondJson(response, 200, {
          ok: true,
          accounts: params.database
            .listAccounts()
            .map(sanitizeAccountRecord),
        });
        return;
      }

      if (method === "POST" && pathname === "/api/logins") {
        const body = await readJsonBody(request);
        const role = isUserRole(body.role) ? body.role : "family";
        const created = await params.loginManager.create(role);
        respondJson(response, 201, {
          ok: true,
          login: created,
        });
        return;
      }

      if (
        method === "GET" &&
        segments[0] === "api" &&
        segments[1] === "logins" &&
        segments.length === 3
      ) {
        const login = params.loginManager.serializeById(
          decodeURIComponent(segments[2] ?? ""),
        );
        if (!login) {
          respondJson(response, 404, {
            ok: false,
            error: "login_not_found",
          });
          return;
        }

        respondJson(response, 200, {
          ok: true,
          login,
        });
        return;
      }

      if (
        method === "GET" &&
        segments[0] === "api" &&
        segments[1] === "logins" &&
        segments[3] === "view"
      ) {
        const loginId = decodeURIComponent(segments[2] ?? "");
        const login = params.loginManager.serializeById(loginId);
        if (!login) {
          respondJson(response, 404, {
            ok: false,
            error: "login_not_found",
          });
          return;
        }

        const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>微信扫码登录</title>
    <style>
      body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        margin: 0;
        padding: 32px 20px;
        background: #f5f7fb;
        color: #1f2937;
      }
      .wrap {
        max-width: 480px;
        margin: 0 auto;
        background: #ffffff;
        border-radius: 12px;
        padding: 24px;
        box-shadow: 0 12px 30px rgba(15, 23, 42, 0.08);
      }
      h1 {
        margin: 0 0 12px;
        font-size: 22px;
      }
      p {
        line-height: 1.6;
        margin: 8px 0;
      }
      img {
        display: block;
        width: 320px;
        max-width: 100%;
        margin: 20px auto;
        border: 1px solid #e5e7eb;
        border-radius: 8px;
        background: #fff;
      }
      code {
        font-size: 13px;
        background: #f3f4f6;
        padding: 2px 6px;
        border-radius: 6px;
      }
      .status {
        font-weight: 600;
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <h1>微信扫码登录</h1>
      <p>登录任务：<code>${loginId}</code></p>
      <p>角色：<span id="role">${String(login.role ?? "family")}</span></p>
      <p>状态：<span class="status" id="status">${String(login.status ?? "waiting")}</span></p>
      <img id="qrcode" src="/api/logins/${encodeURIComponent(loginId)}/qrcode.png?ts=${Date.now()}" alt="微信登录二维码" />
      <p id="hint">如果二维码过期，这个页面会自动刷新。</p>
    </div>
    <script>
      const loginId = ${JSON.stringify(loginId)};
      const statusEl = document.getElementById("status");
      const hintEl = document.getElementById("hint");
      const imageEl = document.getElementById("qrcode");

      async function refreshStatus() {
        try {
          const response = await fetch("/api/logins/" + encodeURIComponent(loginId), { cache: "no-store" });
          const payload = await response.json();
          const login = payload.login || {};
          statusEl.textContent = login.status || "unknown";
          if (login.error) {
            hintEl.textContent = login.error;
          }
          if (login.status === "waiting" || login.status === "scanned") {
            imageEl.src = "/api/logins/" + encodeURIComponent(loginId) + "/qrcode.png?ts=" + Date.now();
          }
          if (login.status === "confirmed") {
            hintEl.textContent = "登录成功，可以回到终端继续下一步。";
          }
        } catch (error) {
          hintEl.textContent = "状态刷新失败，请稍后手动刷新页面。";
        }
      }

      setInterval(refreshStatus, 3000);
      refreshStatus();
    </script>
  </body>
</html>`;

        respondHtml(response, 200, html);
        return;
      }

      if (
        method === "GET" &&
        segments[0] === "api" &&
        segments[1] === "logins" &&
        segments[3] === "qrcode.png"
      ) {
        const buffer = params.loginManager.getQrCodeBuffer(
          decodeURIComponent(segments[2] ?? ""),
        );
        if (!buffer) {
          respondJson(response, 404, {
            ok: false,
            error: "login_not_found",
          });
          return;
        }

        respondPng(response, 200, buffer);
        return;
      }

      if (
        method === "POST" &&
        segments[0] === "api" &&
        segments[1] === "accounts" &&
        segments[3] === "role"
      ) {
        const accountId = decodeURIComponent(segments[2] ?? "");
        const body = await readJsonBody(request);
        if (!isUserRole(body.role)) {
          respondJson(response, 400, {
            ok: false,
            error: "invalid_role",
          });
          return;
        }

        const updated = params.database.updateAccountRole(accountId, body.role);
        respondJson(response, 200, {
          ok: true,
          account: sanitizeAccountRecord(updated),
        });
        return;
      }

      if (method === "GET" && pathname === "/") {
        respondJson(response, 200, {
          service: "weixin-household-gateway",
          status: "running",
          time: formatBeijingTime(new Date()),
          endpoints: [
            "/healthz",
            "/readyz",
            "/api/accounts",
            "/api/logins",
            "/api/logins/:id",
            "/api/logins/:id/view",
            "/api/logins/:id/qrcode.png",
            "/api/accounts/:id/role",
          ],
        });
        return;
      }

      respondJson(response, 404, {
        ok: false,
        error: "not_found",
        path: pathname,
      });
    } catch (error) {
      respondJson(response, 500, {
        ok: false,
        error: "internal_error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

async function listen(server: http.Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  ensureDirectory(config.server.dataDir);
  ensureDirectory(config.codex.admin.workspace);
  ensureDirectory(config.codex.family.workspace);
  for (const directory of config.fileSend.allowedDirs) {
    ensureDirectory(directory);
  }

  const database = new AppDatabase(
    path.join(config.server.dataDir, "weixin-household-gateway.sqlite"),
  );
  database.initialize();
  const startedAt = new Date().toISOString();
  const schemaPath = writeSchemaSnapshot(config.server.dataDir);

  const loginManager = new LoginManager(config, database);
  const worker = new WechatWorker({
    config,
    database,
  });
  worker.start();

  console.log("[bootstrap] service initialized");
  console.log(`[bootstrap] port: ${config.server.port}`);
  console.log(`[bootstrap] timezone: ${config.server.timezone}`);
  console.log(`[bootstrap] data dir: ${config.server.dataDir}`);
  console.log(`[bootstrap] db file: ${database.getFilePath()}`);
  console.log(`[bootstrap] schema snapshot: ${schemaPath}`);
  console.log(`[bootstrap] worker accounts: ${database.listAccounts().length}`);
  console.log(
    `[bootstrap] admin workspace: ${config.codex.admin.workspace}`,
  );
  console.log(
    `[bootstrap] family workspace: ${config.codex.family.workspace}`,
  );
  console.log(`[bootstrap] admin codex backend: ${config.codex.admin.backend}`);
  console.log(`[bootstrap] family codex backend: ${config.codex.family.backend}`);
  console.log(
    `[bootstrap] file send allowed dirs: ${config.fileSend.allowedDirs.join(", ")}`,
  );

  const server = createHealthServer({
    config,
    database,
    loginManager,
    startedAt,
  });

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    console.log(`[shutdown] received ${signal}`);

    try {
      await closeServer(server);
    } catch (error) {
      console.error("[shutdown] failed to close http server", error);
    }

    try {
      await worker.stop();
    } catch (error) {
      console.error("[shutdown] failed to stop worker", error);
    }

    try {
      database.close();
    } catch (error) {
      console.error("[shutdown] failed to close database", error);
    }

    process.exit(0);
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });

  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  await listen(server, config.server.port);
  console.log(
    `[bootstrap] http server listening on 0.0.0.0:${config.server.port}`,
  );
}

void bootstrap().catch((error: unknown) => {
  console.error("[fatal] bootstrap failed", error);
  process.exit(1);
});

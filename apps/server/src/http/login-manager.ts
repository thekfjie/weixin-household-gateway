import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import QRCode from "qrcode";
import { AppConfig, UserRole } from "../config/types.js";
import { AppDatabase } from "../storage/index.js";
import {
  ILinkApiClient,
  ILinkQrCodeResponse,
  ILinkQrCodeStatusResponse,
  summarizeQrStatus,
} from "../transport/index.js";
import { sleep } from "../utils/index.js";

type PendingLoginStatus =
  | "waiting"
  | "scanned"
  | "confirmed"
  | "expired"
  | "failed";

export interface PendingLoginRecord {
  id: string;
  role: UserRole;
  qrcode: string;
  qrcodeContentUrl: string;
  qrcodeFilePath: string;
  status: PendingLoginStatus;
  refreshCount: number;
  createdAt: string;
  updatedAt: string;
  error?: string | undefined;
  accountId?: string;
  scannedByUserId?: string;
  baseUrl?: string;
}

function ensureDirectory(target: string): void {
  fs.mkdirSync(target, { recursive: true });
}

export class LoginManager {
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
      qrcodeImageUrl:
        `/api/logins/${encodeURIComponent(record.id)}/qrcode.png`,
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

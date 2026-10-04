import crypto from "node:crypto";
import {
  ILinkGetConfigResponse,
  ILinkGetUpdatesResponse,
  ILinkGetUploadUrlRequest,
  ILinkGetUploadUrlResponse,
  ILinkQrCodeResponse,
  ILinkQrCodeStatusResponse,
  ILinkSendMessageRequest,
  ILinkSendMessageResponse,
  ILinkSendTypingRequest,
} from "./protocol.js";

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function randomWechatUinHeader(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf8").toString("base64");
}

export interface ILinkApiClientOptions {
  baseUrl: string;
  cdnBaseUrl: string;
  channelVersion: string;
  routeTag?: string;
  token?: string;
}

export class ILinkApiClient {
  readonly baseUrl: string;
  readonly cdnBaseUrl: string;
  private readonly channelVersion: string;
  private readonly routeTag: string | undefined;
  private token: string | undefined;

  constructor(options: ILinkApiClientOptions) {
    this.baseUrl = ensureTrailingSlash(options.baseUrl);
    this.cdnBaseUrl = options.cdnBaseUrl;
    this.channelVersion = options.channelVersion;
    this.routeTag = options.routeTag;
    this.token = options.token;
  }

  setToken(token: string): void {
    this.token = token;
  }

  getToken(): string | undefined {
    return this.token;
  }

  private buildHeaders(bodyText?: string): Record<string, string> {
    const headers: Record<string, string> = {
      AuthorizationType: "ilink_bot_token",
      "X-WECHAT-UIN": randomWechatUinHeader(),
    };

    if (bodyText !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(
        Buffer.byteLength(bodyText, "utf8"),
      );
    }

    if (this.token?.trim()) {
      headers.Authorization = `Bearer ${this.token.trim()}`;
    }

    if (this.routeTag) {
      headers.SKRouteTag = this.routeTag;
    }

    return headers;
  }

  private async postJson<TResponse, TBody extends object>(
    endpoint: string,
    body: TBody,
    timeoutMs: number,
  ): Promise<TResponse> {
    const bodyText = JSON.stringify({
      ...body,
      base_info: {
        channel_version: this.channelVersion,
      },
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const url = new URL(endpoint, this.baseUrl);
      const response = await fetch(url, {
        method: "POST",
        headers: this.buildHeaders(bodyText),
        body: bodyText,
        signal: controller.signal,
      });

      const responseText = await response.text();
      if (!response.ok) {
        throw new Error(`iLink API ${endpoint} ${response.status}: ${responseText}`);
      }

      return JSON.parse(responseText) as TResponse;
    } finally {
      clearTimeout(timer);
    }
  }

  async getUpdates(
    cursor: string,
    timeoutMs = 35_000,
  ): Promise<ILinkGetUpdatesResponse> {
    try {
      return await this.postJson<
        ILinkGetUpdatesResponse,
        { get_updates_buf: string }
      >(
        "ilink/bot/getupdates",
        { get_updates_buf: cursor },
        timeoutMs,
      );
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return { ret: 0, msgs: [], get_updates_buf: cursor };
      }

      throw error;
    }
  }

  sendMessage(
    request: ILinkSendMessageRequest,
  ): Promise<ILinkSendMessageResponse> {
    return this.postJson<ILinkSendMessageResponse, ILinkSendMessageRequest>(
      "ilink/bot/sendmessage",
      request,
      15_000,
    );
  }

  getUploadUrl(
    request: ILinkGetUploadUrlRequest,
  ): Promise<ILinkGetUploadUrlResponse> {
    return this.postJson<
      ILinkGetUploadUrlResponse,
      ILinkGetUploadUrlRequest
    >(
      "ilink/bot/getuploadurl",
      request,
      15_000,
    );
  }

  getConfig(
    ilinkUserId: string,
    contextToken?: string,
  ): Promise<ILinkGetConfigResponse> {
    return this.postJson<
      ILinkGetConfigResponse,
      { ilink_user_id: string; context_token?: string }
    >(
      "ilink/bot/getconfig",
      contextToken
        ? {
            ilink_user_id: ilinkUserId,
            context_token: contextToken,
          }
        : {
            ilink_user_id: ilinkUserId,
          },
      10_000,
    );
  }

  sendTyping(
    request: ILinkSendTypingRequest,
  ): Promise<Record<string, unknown>> {
    return this.postJson<Record<string, unknown>, ILinkSendTypingRequest>(
      "ilink/bot/sendtyping",
      request,
      10_000,
    );
  }

  async getQRCode(botType = "3"): Promise<ILinkQrCodeResponse> {
    const headers: Record<string, string> = {};
    if (this.routeTag) {
      headers.SKRouteTag = this.routeTag;
    }

    const url = new URL(
      `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
      this.baseUrl,
    );
    const response = await fetch(url, { headers });
    if (!response.ok) {
      const body = await response.text().catch(() => "(unreadable)");
      throw new Error(
        `Failed to fetch login QR code: ${response.status} ${response.statusText}: ${body}`,
      );
    }

    return (await response.json()) as ILinkQrCodeResponse;
  }

  async pollQRCodeStatus(
    qrcode: string,
    timeoutMs = 35_000,
  ): Promise<ILinkQrCodeStatusResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers: Record<string, string> = {
      "iLink-App-ClientVersion": "1",
    };

    if (this.routeTag) {
      headers.SKRouteTag = this.routeTag;
    }

    try {
      const url = new URL(
        `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
        this.baseUrl,
      );
      const response = await fetch(url, {
        headers,
        signal: controller.signal,
      });

      const responseText = await response.text();
      if (!response.ok) {
        throw new Error(
          `Failed to poll QR code status: ${response.status} ${response.statusText}: ${responseText}`,
        );
      }

      return JSON.parse(responseText) as ILinkQrCodeStatusResponse;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return { status: "wait" };
      }

      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

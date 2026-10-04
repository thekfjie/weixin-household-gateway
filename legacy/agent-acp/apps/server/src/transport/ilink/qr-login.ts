import { ILinkApiClient } from "./api-client.js";
import { ILinkQrCodeResponse, ILinkQrCodeStatusResponse } from "./protocol.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ILinkLoginResult {
  accountId: string;
  token: string;
  baseUrl: string;
  scannedByUserId?: string;
}

export async function createLoginQRCode(
  client: ILinkApiClient,
): Promise<ILinkQrCodeResponse> {
  return client.getQRCode();
}

export async function waitForQRCodeConfirmation(
  client: ILinkApiClient,
  qrcode: string,
  options?: {
    pollIntervalMs?: number;
    maxAttempts?: number;
  },
): Promise<ILinkLoginResult> {
  const pollIntervalMs = options?.pollIntervalMs ?? 1_000;
  const maxAttempts = options?.maxAttempts ?? 180;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const status = await client.pollQRCodeStatus(qrcode);

    if (status.status === "confirmed") {
      if (!status.bot_token || !status.ilink_bot_id || !status.baseurl) {
        throw new Error(
          `QR login confirmed but response is incomplete: ${JSON.stringify(status)}`,
        );
      }

      return {
        accountId: status.ilink_bot_id,
        token: status.bot_token,
        baseUrl: status.baseurl,
        ...(status.ilink_user_id
          ? { scannedByUserId: status.ilink_user_id }
          : {}),
      };
    }

    if (status.status === "expired") {
      throw new Error("QR code expired before confirmation");
    }

    await delay(pollIntervalMs);
  }

  throw new Error("QR login confirmation timed out");
}

export function summarizeQrStatus(status: ILinkQrCodeStatusResponse): string {
  switch (status.status) {
    case "wait":
      return "waiting";
    case "scaned":
      return "scanned";
    case "confirmed":
      return "confirmed";
    case "expired":
      return "expired";
    default:
      return "unknown";
  }
}

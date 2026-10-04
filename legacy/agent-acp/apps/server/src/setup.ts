import path from "node:path";
import readline from "node:readline";
import QRCode from "qrcode";
import { loadConfig } from "./config/index.js";
import { UserRole } from "./config/types.js";
import { AppDatabase } from "./storage/index.js";
import { createLoginQRCode, ILinkApiClient } from "./transport/index.js";

function ensureRole(value: string | undefined): UserRole {
  return value === "admin" ? "admin" : "family";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function askYesNo(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

async function renderTerminalQr(url: string): Promise<void> {
  const qr = await QRCode.toString(url, {
    type: "terminal",
    small: true,
  });
  console.log(qr);
}

function buildClient(config = loadConfig()): ILinkApiClient {
  return new ILinkApiClient({
    baseUrl: config.wechat.apiBaseUrl,
    cdnBaseUrl: config.wechat.cdnBaseUrl,
    channelVersion: config.wechat.channelVersion,
    ...(config.wechat.routeTag ? { routeTag: config.wechat.routeTag } : {}),
  });
}

async function runSetup(): Promise<void> {
  const config = loadConfig();
  const role = ensureRole(process.argv.slice(2).find((arg) => arg === "admin" || arg === "family"));
  const force = process.argv.includes("--force");
  const dbPath = path.join(
    config.server.dataDir,
    "weixin-household-gateway.sqlite",
  );
  const database = new AppDatabase(dbPath);
  database.initialize();

  try {
    const existingAccounts = database.listAccounts();
    if (existingAccounts.length > 0) {
      console.log("Existing accounts:");
      for (const account of existingAccounts) {
        console.log(`- ${account.id} (${account.role})`);
      }
      console.log("");

      if (!force) {
        const confirmed = await askYesNo(
          "Continue and add a new WeChat account? (y/N) ",
        );
        if (!confirmed) {
          console.log("Setup cancelled.");
          return;
        }
      }
    }

    const client = buildClient(config);
    const qr = await createLoginQRCode(client);

    console.log("WeChat login QR code:\n");
    await renderTerminalQr(qr.qrcode_img_content);
    console.log("Scan the QR code in WeChat, then confirm on your phone.\n");

    let scannedPrinted = false;
    const deadline = Date.now() + 8 * 60 * 1000;

    while (Date.now() < deadline) {
      const status = await client.pollQRCodeStatus(qr.qrcode);

      switch (status.status) {
        case "wait":
          process.stdout.write(".");
          break;
        case "scaned":
          if (!scannedPrinted) {
            scannedPrinted = true;
            console.log("\nQR code scanned. Confirm the login in WeChat...");
          }
          break;
        case "expired":
          console.log("\nThe QR code expired. Run setup again.");
          process.exitCode = 1;
          return;
        case "confirmed":
          if (!status.ilink_bot_id || !status.bot_token) {
            throw new Error("Login confirmed but credentials are incomplete.");
          }

          database.saveAccount({
            id: status.ilink_bot_id,
            role,
            authToken: status.bot_token,
            uin: status.ilink_user_id ?? status.ilink_bot_id,
            baseUrl: status.baseurl ?? config.wechat.apiBaseUrl,
            status: "active",
          });

          console.log("\nWeChat login completed.");
          console.log(`Account ID: ${status.ilink_bot_id}`);
          console.log(`Role: ${role}`);
          console.log(`User ID: ${status.ilink_user_id ?? "(unknown)"}`);
          console.log(`Database: ${dbPath}`);
          console.log("");
          console.log("Next step:");
          console.log("  corepack pnpm start");
          return;
      }

      await sleep(1_000);
    }

    console.log("\nLogin timed out. Run setup again.");
    process.exitCode = 1;
  } finally {
    database.close();
  }
}

void runSetup().catch((error: unknown) => {
  console.error(
    `Setup failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});

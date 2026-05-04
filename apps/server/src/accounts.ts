import path from "node:path";
import { loadConfig, UserRole } from "./config/index.js";
import { AppDatabase, WechatAccountRecord } from "./storage/index.js";

class CliUsageError extends Error {
  override name = "CliUsageError";
}

function usage(): string {
  return [
    "用法：node dist/apps/server/accounts.js <命令> [参数]",
    "",
    "命令：",
    "  list                         列出微信账号",
    "  role <account_id> admin|family  修改账号角色",
    "  enable <account_id>          启用账号轮询",
    "  disable <account_id>         停用账号轮询",
    "",
    "示例：",
    "  node dist/apps/server/accounts.js list",
    "  node dist/apps/server/accounts.js role 1f31...@im.bot family",
    "  node dist/apps/server/accounts.js disable 1f31...@im.bot",
  ].join("\n");
}

function isRole(value: string | undefined): value is UserRole {
  return value === "admin" || value === "family";
}

function printAccount(account: WechatAccountRecord): void {
  console.log(
    [
      `id=${account.id}`,
      `role=${account.role}`,
      `status=${account.status}`,
      `uin=${account.uin}`,
      `base=${account.baseUrl ?? "-"}`,
      `updated=${account.updatedAt}`,
    ].join("  "),
  );
}

function openDatabase(): AppDatabase {
  const config = loadConfig();
  const database = new AppDatabase(
      path.join(config.server.dataDir, "weixin-household-gateway.sqlite"),
  );
  database.initialize();
  return database;
}

function requireArg(value: string | undefined, name: string): string {
  if (!value) {
    throw new CliUsageError(`缺少参数：${name}`);
  }

  return value;
}

function run(): void {
  const [command, accountIdArg, valueArg] = process.argv.slice(2);
  if (!command || command === "-h" || command === "--help") {
    console.log(usage());
    return;
  }

  const database = openDatabase();
  try {
    switch (command) {
      case "list": {
        const accounts = database.listAccounts();
        if (accounts.length === 0) {
          console.log("当前没有微信账号。请先运行 setup 扫码绑定。");
          return;
        }

        for (const account of accounts) {
          printAccount(account);
        }
        return;
      }
      case "role": {
        const accountId = requireArg(accountIdArg, "account_id");
        if (!isRole(valueArg)) {
          throw new CliUsageError("角色必须是 admin 或 family。");
        }

        printAccount(database.updateAccountRole(accountId, valueArg));
        return;
      }
      case "enable":
      case "disable": {
        const accountId = requireArg(accountIdArg, "account_id");
        printAccount(
          database.updateAccountStatus(
            accountId,
            command === "enable" ? "active" : "disabled",
          ),
        );
        return;
      }
      default:
        throw new CliUsageError(`未知命令：${command}`);
    }
  } finally {
    database.close();
  }
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  if (error instanceof CliUsageError) {
    console.error("");
    console.error(usage());
  }
  process.exit(1);
}

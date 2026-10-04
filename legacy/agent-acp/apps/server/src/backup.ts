import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config/index.js";

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function parseOutDir(dataDir: string): string {
  const outIndex = process.argv.indexOf("--out");
  if (outIndex >= 0) {
    const out = process.argv[outIndex + 1];
    if (!out) {
      throw new Error("--out requires a directory path");
    }
    return path.resolve(out);
  }

  return path.join(dataDir, "backups", `manual-${timestamp()}`);
}

function parseRestoreDir(): string | undefined {
  const restoreIndex = process.argv.indexOf("--restore");
  if (restoreIndex < 0) {
    return undefined;
  }

  const source = process.argv[restoreIndex + 1];
  if (!source) {
    throw new Error("--restore requires a backup directory path");
  }

  if (!process.argv.includes("--yes")) {
    throw new Error("restore requires --yes");
  }

  return path.resolve(source);
}

function shouldSkip(source: string, backupRoot: string): boolean {
  const relative = path.relative(backupRoot, source);
  return relative === "" || (!!relative && !relative.startsWith(".."));
}

function copyRecursive(source: string, target: string, backupRoot: string): void {
  if (shouldSkip(source, backupRoot)) {
    return;
  }

  const stat = fs.statSync(source);
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(source)) {
      copyRecursive(path.join(source, entry), path.join(target, entry), backupRoot);
    }
    return;
  }

  if (stat.isFile()) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
}

function restoreBackup(sourceDir: string, dataDir: string): void {
  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
    throw new Error(`Backup directory does not exist: ${sourceDir}`);
  }

  if (path.resolve(sourceDir) === path.resolve(dataDir)) {
    throw new Error("Refusing to restore from DATA_DIR into itself");
  }

  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  copyRecursive(sourceDir, dataDir, path.join(sourceDir, "backups"));
  console.log(`恢复完成：${sourceDir} -> ${dataDir}`);
  console.log("请确认文件权限属于服务用户，然后重启 systemd 服务。");
}

function run(): void {
  const config = loadConfig();
  const dataDir = config.server.dataDir;
  const restoreDir = parseRestoreDir();
  if (restoreDir) {
    restoreBackup(restoreDir, dataDir);
    return;
  }

  const backupDir = parseOutDir(dataDir);

  if (!fs.existsSync(dataDir)) {
    throw new Error(`Data directory does not exist: ${dataDir}`);
  }

  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  copyRecursive(dataDir, backupDir, path.join(dataDir, "backups"));
  fs.writeFileSync(
    path.join(backupDir, "README.txt"),
    [
      "weixin-household-gateway data backup",
      `created_at=${new Date().toISOString()}`,
      `source=${dataDir}`,
      "",
      "This backup copies the data directory only.",
      "It does not copy /opt/weixin-household-gateway/.env or ~/.codex credentials.",
    ].join("\n"),
    "utf8",
  );

  console.log(`备份完成：${backupDir}`);
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

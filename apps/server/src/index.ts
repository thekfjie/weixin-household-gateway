import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config/index.js";
import {
  closeServer,
  createGatewayHttpServer,
  listenServer,
  LoginManager,
} from "./http/index.js";
import { AppDatabase, SQLITE_SCHEMA } from "./storage/index.js";
import { WechatWorker } from "./transport/index.js";

function ensureDirectory(target: string): void {
  fs.mkdirSync(target, { recursive: true });
}

function writeSchemaSnapshot(dataDir: string): string {
  const outputPath = path.join(dataDir, "schema.sql");
  fs.writeFileSync(outputPath, SQLITE_SCHEMA, "utf8");
  return outputPath;
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

  const server = createGatewayHttpServer({
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

  await listenServer(server, config.server.port);
  console.log(
    `[bootstrap] http server listening on 0.0.0.0:${config.server.port}`,
  );
}

void bootstrap().catch((error: unknown) => {
  console.error("[fatal] bootstrap failed", error);
  process.exit(1);
});

import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config/index.js";
import { createCodexBackend } from "./codex/index.js";
import type { CodexProgressEvent } from "./codex/index.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertSuccessfulResult(
  name: string,
  result: {
    text: string;
    stderr: string;
    exitCode: number | null;
    timedOut: boolean;
    cancelled?: boolean | undefined;
  },
): void {
  assert(!result.timedOut, `${name}: timed out`);
  assert(!result.cancelled, `${name}: cancelled`);
  assert(
    result.exitCode === 0,
    `${name}: exit=${result.exitCode}, stderr=${result.stderr}`,
  );
  assert(result.text.trim(), `${name}: empty response`);
}

async function run(): Promise<void> {
  const config = loadConfig();
  const stamp = `${Date.now()}-${process.pid}`;
  const adminMarker = path.join(
    config.codex.admin.workspace,
    `.compat-admin-${stamp}.txt`,
  );
  const familyReadDir = path.join(
    config.server.dataDir,
    "inbox",
    `compat-${stamp}`,
  );
  const familyWriteDir = path.join(
    config.server.dataDir,
    "outbox",
    `compat-${stamp}`,
  );
  const familySeed = path.join(familyReadDir, `seed-${stamp}.txt`);
  const familyMarker = path.join(familyWriteDir, `result-${stamp}.txt`);
  const adminConversationId = `compat-admin-${stamp}`;
  const progressEvents: CodexProgressEvent[] = [];

  fs.mkdirSync(config.codex.admin.workspace, { recursive: true });
  fs.mkdirSync(config.codex.family.workspace, { recursive: true });
  fs.mkdirSync(familyReadDir, { recursive: true });
  fs.mkdirSync(familyWriteDir, { recursive: true });
  fs.writeFileSync(familySeed, "家庭中文附件读取正常\n", "utf8");

  const adminBackend = createCodexBackend(config.codex.admin);
  try {
    const first = await adminBackend.run({
      conversationId: adminConversationId,
      role: "admin",
      persistentSession: true,
      responseMode: "final_message_run",
      systemPrompt: config.prompts.adminAcp,
      prompt: [
        "这是隔离兼容测试。",
        `请使用终端工具把 UTF-8 文本“管理员中文工具调用正常”写入 ${adminMarker}。`,
        "完成后只回复：管理员工具链通过",
      ].join("\n"),
      onProgress: (event) => progressEvents.push(event),
    });
    assertSuccessfulResult("admin tool call", first);
    assert(fs.existsSync(adminMarker), "admin tool call: marker missing");
    assert(
      fs.readFileSync(adminMarker, "utf8").includes("管理员中文工具调用正常"),
      "admin tool call: UTF-8 marker mismatch",
    );
    assert(
      progressEvents.some((event) => event.phase === "responding"),
      "admin tool call: no streaming responding event",
    );
  } finally {
    adminBackend.dispose();
  }

  const resumedAdminBackend = createCodexBackend(config.codex.admin);
  try {
    const resumed = await resumedAdminBackend.run({
      conversationId: adminConversationId,
      role: "admin",
      persistentSession: true,
      responseMode: "final_message_run",
      systemPrompt: config.prompts.adminAcp,
      prompt: "请只回复：管理员会话恢复通过",
    });
    assertSuccessfulResult("admin session resume", resumed);
    assert(
      resumed.text.includes("管理员会话恢复通过"),
      `admin session resume: unexpected response ${resumed.text}`,
    );
  } finally {
    resumedAdminBackend.dispose();
  }

  const sessionMapPath = path.join(
    config.codex.admin.workspace,
    ".acp-session-map.json",
  );
  assert(fs.existsSync(sessionMapPath), "admin session map missing");
  assert(
    fs.readFileSync(sessionMapPath, "utf8").includes(adminConversationId),
    "admin session map does not contain regression conversation",
  );

  const familyBackend = createCodexBackend(config.codex.family);
  try {
    const family = await familyBackend.run({
      conversationId: `compat-family-${stamp}`,
      role: "family",
      persistentSession: false,
      responseMode: "final_message_run",
      systemPrompt: config.prompts.familyAcp,
      additionalDirectories: [familyWriteDir, familyReadDir],
      readOnlyDirectories: [familyReadDir],
      prompt: [
        "这是隔离兼容测试。",
        `请使用终端读取 ${familySeed}，再把读取到的 UTF-8 中文原样写入 ${familyMarker}。`,
        "完成后只回复：家庭工具链通过",
      ].join("\n"),
    });
    assertSuccessfulResult("family isolated tool call", family);
    assert(fs.existsSync(familyMarker), "family tool call: marker missing");
    assert(
      fs.readFileSync(familyMarker, "utf8") ===
        fs.readFileSync(familySeed, "utf8"),
      "family tool call: UTF-8 marker mismatch",
    );
  } finally {
    familyBackend.dispose();
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        codexCommand: config.codex.admin.command,
        acpCommand: config.codex.admin.acpCommand,
        modelInstructionsFile:
          process.env.CODEX_CLI_MODEL_INSTRUCTIONS_FILE ?? null,
        adminToolCall: "ok",
        adminSessionResume: "ok",
        familyIsolatedToolCall: "ok",
        chineseUtf8: "ok",
        streamingRespondingEvents: progressEvents.filter(
          (event) => event.phase === "responding",
        ).length,
        visibleMessageRuns: progressEvents.filter(
          (event) => event.phase === "visible_message_run",
        ).length,
      },
      null,
      2,
    ),
  );
}

void run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});

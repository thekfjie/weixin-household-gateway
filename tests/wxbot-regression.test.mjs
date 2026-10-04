import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { InboundTaskQueue } from "../dist/apps/server/transport/ilink/inbound-task-queue.js";
import { parseBuiltInCommand } from "../dist/apps/server/commands/parse-command.js";
import { parseNaturalFileRequest } from "../dist/apps/server/commands/file-actions.js";
import { sendTextMessage } from "../dist/apps/server/transport/ilink/media.js";
import {
  WECHAT_TEXT_MAX_CHARS,
  WECHAT_TEXT_MAX_UTF8_BYTES,
  splitWechatText,
} from "../dist/apps/server/transport/ilink/text-chunks.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("multi-line technical requests are not mistaken for file sends", () => {
  const request = [
    "请评估 Remote Router 方案。",
    "将请求转发到上游。",
    "HTTP /responses",
  ].join("\n");
  assert.equal(parseBuiltInCommand(request), undefined);
  assert.equal(parseNaturalFileRequest(request), undefined);
  assert.equal(parseNaturalFileRequest("把 /tmp/report.pdf 发给我")?.args[0], "/tmp/report.pdf");
  assert.equal(parseBuiltInCommand("/file /tmp/report.pdf")?.name, "/file");
});

test("long WeChat text is split without truncating content", () => {
  const text = Array.from(
    { length: 900 },
    (_, index) => `第${index + 1}项：这是中文验证内容。`,
  ).join("\n");
  const chunks = splitWechatText(text);

  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(Array.from(chunk).length <= WECHAT_TEXT_MAX_CHARS);
    assert.ok(Buffer.byteLength(chunk, "utf8") <= WECHAT_TEXT_MAX_UTF8_BYTES);
  }
  assert.equal(chunks.join("\n"), text);
});

test("text sender delivers every generated chunk", async () => {
  const text = "中文😀".repeat(1_500);
  const requests = [];
  const client = {
    async sendMessage(request) {
      requests.push(request);
      return { ret: 0 };
    },
  };

  const clientId = await sendTextMessage({
    client,
    toUserId: "contact",
    contextToken: "context",
    text,
  });

  const sentText = requests
    .map((request) => request.msg.item_list[0].text_item.text)
    .join("");
  assert.ok(requests.length > 1);
  assert.equal(sentText, text);
  assert.equal(clientId, requests.at(-1).msg.client_id);
});

test("inbound tasks stay ordered per contact and run in parallel across contacts", async () => {
  const queue = new InboundTaskQueue();
  const events = [];
  let releaseFirst;
  const firstBlocked = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  const first = queue.enqueue("contact-a", async () => {
    events.push("a1:start");
    await firstBlocked;
    events.push("a1:end");
  });
  const second = queue.enqueue("contact-a", async () => {
    events.push("a2");
  });
  const parallel = queue.enqueue("contact-b", async () => {
    events.push("b1");
  });

  await parallel;
  assert.deepEqual(events, ["a1:start", "b1"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["a1:start", "b1", "a1:end", "a2"]);
});

test("a failed inbound task does not block later messages", async () => {
  const queue = new InboundTaskQueue();
  const events = [];
  const failed = queue.enqueue("contact", async () => {
    throw new Error("expected failure");
  });
  const next = queue.enqueue("contact", async () => {
    events.push("continued");
  });

  await assert.rejects(failed, /expected failure/);
  await next;
  assert.deepEqual(events, ["continued"]);
});

test("configure-codex refuses to copy the wxbot key into another Codex home", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "wxbot-codex-home-"));
  const wxbotHome = path.join(fixture, "wxbot-home");
  const personalHome = path.join(fixture, "personal-home");
  const personalAuth = {
    auth_mode: "apikey",
    OPENAI_API_KEY: "sk-personal-regression-key",
  };

  fs.mkdirSync(personalHome, { recursive: true });
  fs.writeFileSync(
    path.join(personalHome, "auth.json"),
    `${JSON.stringify(personalAuth)}\n`,
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(fixture, ".env"),
    [
      `CODEX_CLI_HOME=${wxbotHome}`,
      "CODEX_CLI_AUTH_MODE=api_key",
      "CODEX_CLI_API_KEY=sk-wxbot-regression-key",
      "CODEX_CLI_MODEL=gpt-5.6-sol",
      "CODEX_CLI_REASONING_EFFORT=high",
      "",
    ].join("\n"),
  );

  const childEnv = { ...process.env, CODEX_CLI_HOME: personalHome };
  delete childEnv.CODEX_CLI_API_KEY;
  delete childEnv.CODEX_CLI_AUTH_MODE;
  delete childEnv.CODEX_CLI_ALLOW_CROSS_HOME_APPLY;

  const result = spawnSync(
    process.execPath,
    [path.join(repoRoot, "dist/apps/server/configure-codex.js"), "--apply"],
    {
      cwd: fixture,
      encoding: "utf8",
      env: childEnv,
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /拒绝跨 Codex Home 写入/);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(personalHome, "auth.json"), "utf8")),
    personalAuth,
  );
});

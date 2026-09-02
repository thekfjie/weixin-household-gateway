import assert from "node:assert/strict";
import test from "node:test";

import { InboundTaskQueue } from "../dist/apps/server/transport/ilink/inbound-task-queue.js";
import { sendTextMessage } from "../dist/apps/server/transport/ilink/media.js";
import {
  WECHAT_TEXT_MAX_CHARS,
  WECHAT_TEXT_MAX_UTF8_BYTES,
  splitWechatText,
} from "../dist/apps/server/transport/ilink/text-chunks.js";

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

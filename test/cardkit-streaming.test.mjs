/** CardKit wrapper + typewriter controller behaviour. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createCardKit } from "../src/feishu/cardkit.js";
import { CardStream } from "../src/dsh/streaming.js";

function fakeClient() {
  const calls = [];
  const reply = (tag, payload) => {
    calls.push({ tag, payload });
    if (tag === "card.create") return { code: 0, data: { card_id: "card_1" } };
    if (tag === "im.create" || tag === "im.reply") return { code: 0, data: { message_id: "msg_1" } };
    if (tag === "card.idConvert") return { code: 0, data: { card_id: "card_9" } };
    return { code: 0 };
  };
  return {
    calls,
    cardkit: {
      v1: {
        card: {
          create: async (payload) => reply("card.create", payload),
          batchUpdate: async (payload) => reply("card.batchUpdate", payload),
          settings: async (payload) => reply("card.settings", payload),
          idConvert: async (payload) => reply("card.idConvert", payload),
        },
        cardElement: { content: async (payload) => reply("card.content", payload) },
      },
    },
    im: {
      message: {
        create: async (payload) => reply("im.create", payload),
        reply: async (payload) => reply("im.reply", payload),
      },
    },
  };
}

test("createCard and sendByReference use the card entity content shape", async () => {
  const client = fakeClient();
  const kit = createCardKit(client, {});
  const created = await kit.createCard({ schema: "2.0", body: { elements: [] } });
  assert.equal(created.ok, true);
  assert.equal(created.cardId, "card_1");

  const sent = await kit.sendByReference({ chatId: "chat_1", cardId: created.cardId });
  assert.equal(sent.ok, true);
  const content = JSON.parse(client.calls.at(-1).payload.data.content);
  assert.deepEqual(content, { type: "card", data: { card_id: "card_1" } });
});

test("cardkit owns the per-card sequence and advances it across calls", async () => {
  const client = fakeClient();
  const kit = createCardKit(client, {});
  const res1 = await kit.patchElements("card_1", [{ elementId: "run_answer", partial: { content: "hi" } }]);
  assert.equal(res1.ok, true);
  const data1 = client.calls.at(-1).payload.data;
  assert.equal(data1.sequence, 1);
  assert.deepEqual(data1.actions, [
    { action: "partial_update_element", params: { element_id: "run_answer", partial_element: { content: "hi" } } },
  ]);
  const res2 = await kit.patchElements("card_1", [{ elementId: "run_answer", partial: { content: "hi!" } }]);
  assert.equal(res2.ok, true);
  assert.equal(client.calls.at(-1).payload.data.sequence, 2);
});

test("CardStream coalesces pushes and lands the newest text", async () => {
  const client = fakeClient();
  const kit = createCardKit(client, {});
  const stream = new CardStream({ cardkit: kit, cardId: "card_1", elementId: "run_answer", baseThrottleMs: 100 });
  stream.push("a");
  stream.push("ab");
  stream.push("abc");
  await new Promise((resolve) => setTimeout(resolve, 250));
  const updates = client.calls.filter((call) => call.tag === "card.content");
  assert.equal(updates.length, 1);
  assert.equal(updates[0].payload.data.content, "abc");
  assert.equal(stream.okCount, 1);
});

test("CardStream raises the interval as the payload grows", () => {
  const stream = new CardStream({ cardkit: {}, cardId: "c", elementId: "e", baseThrottleMs: 300 });
  assert.equal(stream.delayFor("x".repeat(1_000)), 300);
  assert.equal(stream.delayFor("x".repeat(20_000)), 500);
  assert.equal(stream.delayFor("x".repeat(50_000)), 800);
  const fast = new CardStream({ cardkit: {}, cardId: "c", elementId: "e", baseThrottleMs: 900 });
  assert.equal(fast.delayFor("x".repeat(50_000)), 900, "never below the configured base");
});

test("close pushes the final text then leaves streaming mode", async () => {
  const client = fakeClient();
  const kit = createCardKit(client, {});
  const stream = new CardStream({ cardkit: kit, cardId: "card_1", elementId: "run_answer", baseThrottleMs: 5_000 });
  stream.push("final answer");
  const closed = await stream.close("done");
  assert.equal(closed.ok, true);
  const tags = client.calls.map((call) => call.tag);
  assert.deepEqual(tags.filter((tag) => tag !== "card.create"), ["card.content", "card.settings"]);
  const settings = JSON.parse(client.calls.at(-1).payload.data.settings);
  assert.deepEqual(settings.config, { streaming_mode: false, summary: { content: "done" } });
});

test("CardStream rolls over to a new card past maxChars", async () => {
  const client = fakeClient();
  const kit = createCardKit(client, {});
  let created = 0;
  const stream = new CardStream({
    cardkit: kit,
    cardId: "card_1",
    elementId: "run_answer",
    baseThrottleMs: 50,
    maxChars: 100,
    onRollover: async () => {
      created += 1;
      return { cardId: `card_next_${created}`, elementId: "run_answer" };
    },
  });
  stream.push("x".repeat(500));
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(created, 1);
  assert.equal(stream.cardId, "card_next_1");
  assert.equal(client.calls.some((call) => call.tag === "card.settings"), true);
});

test("RunCards streams the answer element and only replaces the card on chrome changes", async () => {
  const { RunCards } = await import("../src/dsh/runs.js");
  const calls = [];
  const cardkit = {
    async createCard() {
      calls.push("create");
      return { ok: true, cardId: "card_1" };
    },
    async sendByReference() {
      calls.push("send");
      return { ok: true, messageId: "msg_1", cardId: "card_1" };
    },
    async updateElement(_cardId, _elementId, content) {
      calls.push(`element:${content}`);
      return { ok: true };
    },
    async updateCard() {
      calls.push("card");
      return { ok: true };
    },
    async closeStreaming() {
      calls.push("close");
      return { ok: true };
    },
  };
  const runs = new RunCards({
    bridge: {},
    sender: {},
    cardkit,
    state: {},
    config: { maxAnswerChars: 12_000, streamThrottleMs: 50, stream: true },
    log: { warn() {}, debug() {}, info() {} },
  });
  const run = {
    sessionId: "s1",
    chatId: "chat",
    tools: [],
    toolTotal: 0,
    reasoningSteps: [],
    status: "starting",
    startedAt: Date.now(),
    streamingText: "",
    streamingReasoning: "",
    text: "",
  };
  await runs.openCard(run, undefined, "chat");
  assert.equal(run.cardId, "card_1");
  assert.ok(run.stream, "typewriter controller attached");

  run.status = "running";
  run.streamingText = "第一段";
  await runs.patch(run, true);
  assert.equal(calls.at(-1), "card", "first patch writes the whole card");

  run.streamingText = "第一段和第二段";
  await runs.patch(run, false);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.ok(calls.some((call) => call === "element:第一段和第二段"), "answer flows through the element path");

  await runs.finalize(run);
  assert.ok(calls.includes("close"), "stream closed before the terminal card");
  runs.dispose();
});

test("reconcileOrphans closes a card left running by the previous process", async () => {
  const { RunCards } = await import("../src/dsh/runs.js");
  const calls = [];
  const cardkit = {
    async closeStreaming(cardId) {
      calls.push(`close:${cardId}`);
      return { ok: true };
    },
    async updateCard(cardId, card) {
      calls.push(`update:${cardId}:${card.header.title.content}`);
      return { ok: true };
    },
    async cardContentOf() {
      return {
        body: {
          elements: [
            { tag: "markdown", element_id: "_1", content: "🤖 处理中\n✍️ 正在生成回答…" },
            { tag: "button", text: { content: "停止" } },
          ],
        },
      };
    },
  };
  let cleared = false;
  const runs = new RunCards({
    bridge: {},
    sender: {},
    cardkit,
    state: {
      takeLiveCards() {
        return { s1: { messageId: "m1", cardId: "c1" } };
      },
      clearLiveCard() {
        cleared = true;
      },
      setLiveCard() {},
    },
    config: { maxAnswerChars: 1_000, streamThrottleMs: 50, stream: true },
    log: { warn() {}, debug() {}, info() {} },
  });
  await runs.reconcileOrphans();
  runs.dispose();
  assert.ok(calls.includes("close:c1"), "streaming closed first");
  assert.ok(calls.some((call) => call.startsWith("update:c1:❌ 回合已中断")), "terminal header written");
  assert.equal(cleared, false, "clearing happens on a normal finish, not here");
});

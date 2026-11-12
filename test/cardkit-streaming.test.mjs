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

test("CardStream no longer rolls over: 长答案由 finish() 的分卡投递负责", async () => {
  const client = fakeClient();
  const kit = createCardKit(client, {});
  const stream = new CardStream({
    cardkit: kit,
    cardId: "card_1",
    elementId: "run_answer",
    baseThrottleMs: 50,
  });
  stream.push("x".repeat(30_000));
  // 30KB 的内容会走大负载节流（500ms），等它真的 flush 一次。
  await new Promise((resolve) => setTimeout(resolve, 700));
  // 只写当前卡的答案元素，不创建新卡、不关流。
  assert.deepEqual(
    [...new Set(client.calls.map((call) => call.tag))],
    ["card.content"],
    "只有一个元素写入，没有 create/settings",
  );
  assert.equal(stream.cardId, "card_1");
  assert.equal(stream.okCount, 1);
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

test("长答案让面板让位时，patch 走整卡写入（否则服务端会留下大面板并爆 30KB）", async () => {
  const { RunCards } = await import("../src/dsh/runs.js");
  const calls = [];
  const written = [];
  const cardkit = {
    async createCard() {
      return { ok: true, cardId: "card_1" };
    },
    async sendByReference() {
      return { ok: true, messageId: "msg_1", cardId: "card_1" };
    },
    async updateElement(_cardId, _elementId, content) {
      calls.push(`element:${content.length}`);
      return { ok: true };
    },
    async updateCard(_cardId, card) {
      calls.push("card");
      written.push(card);
      return { ok: true };
    },
    async closeStreaming() {
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
  const reasoning = "思".repeat(2_400);
  const run = {
    sessionId: "s1",
    chatId: "chat",
    tools: [],
    toolTotal: 1,
    step: 1,
    reasoningSteps: [{ step: 1, text: reasoning }],
    streamingReasoning: reasoning,
    status: "starting",
    startedAt: Date.now(),
    streamingText: "",
    streamingReasoning: reasoning,
    text: "",
  };
  await runs.openCard(run, undefined, "chat");
  run.status = "running";

  run.streamingText = "短答案";
  await runs.patch(run, true);
  assert.equal(calls.at(-1), "card");

  // 答案长到必须让面板缩水：这次不能只发元素，否则服务端卡片会保留大面板。
  run.streamingText = "字".repeat(9_000);
  await runs.patch(run);
  assert.equal(calls.at(-1), "card", "面板尺寸变了要整卡重写");
  const panel = written.at(-1).body.elements.find((element) => element.tag === "collapsible_panel");
  assert.ok(panel, "面板还在");
  const panelBody = panel.elements[0].content;
  assert.ok(
    Buffer.byteLength(panelBody, "utf8") < 2_400,
    "面板应当让位（原始 2400 字）",
  );
  const answer = written.at(-1).body.elements.find((element) => element.element_id === "run_answer").content;
  assert.equal(answer, "字".repeat(9_000), "答案完整保留");
  assert.ok(Buffer.byteLength(JSON.stringify(written.at(-1)), "utf8") <= 29_000);

  // 同样的内容再 patch 一次：既没换面板也没换答案，就不该再整卡重写。
  const cardCount = calls.filter((call) => call === "card").length;
  await runs.patch(run);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(calls.filter((call) => call === "card").length, cardCount, "无变化时退回元素流式");
  runs.dispose();
});

test("出错的回合也会把长答案分卡投递（不再整段丢掉）", async () => {
  const { RunCards } = await import("../src/dsh/runs.js");
  const sent = [];
  const runs = new RunCards({
    bridge: {},
    sender: {
      async replyCard(anchor, card) {
        sent.push(card);
        return { ok: true, messageId: `om_part_${sent.length}` };
      },
      async patchCard() {
        return { ok: true };
      },
      async sendCard() {
        return { ok: false };
      },
    },
    state: {},
    config: { maxAnswerChars: 4_000, streamThrottleMs: 50 },
    log: { debug() {}, info() {}, warn() {} },
  });
  const longAnswer = "字".repeat(12_000); // 36KB，必须分卡
  const run = {
    sessionId: "session-error-split",
    chatId: "oc_chat",
    messageId: "om_run",
    status: "running",
    startedAt: Date.now(),
    tools: [],
    toolTotal: 0,
    text: longAnswer,
    streamingText: longAnswer,
    streamingReasoning: "",
    turn: 1,
    step: 0,
    error: "",
    canStop: true,
    finished: false,
  };
  runs.runs.set(run.sessionId, run);
  runs.finish(run, "error", "boom");
  // finish() 同步决定分段，sendParts 随后异步清空 splitParts。
  const splitCount = run.splitParts.length;
  await new Promise((resolve) => setTimeout(resolve, 400));

  assert.equal(run.status, "error");
  assert.equal(run.answerHidden, true, "主卡不再硬塞 12,000 字");
  assert.ok(splitCount > 1, `拆成多段，实测 ${splitCount}`);
  assert.ok(sent.length > 1, `应发出多张分段卡，实测 ${sent.length}`);
  const delivered = sent
    .flatMap((card) => card.body.elements)
    .filter((element) => element.tag === "markdown")
    .reduce((total, element) => total + String(element.content ?? "").length, 0);
  assert.ok(delivered >= 11_000, `分段卡应带走绝大部分内容，实测 ${delivered}`);
  assert.match(JSON.stringify(run.answerNote ?? ""), /分成 .* 段/);
  runs.dispose();
});

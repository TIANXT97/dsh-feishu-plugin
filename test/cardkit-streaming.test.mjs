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

test("patchElements builds partial_update_element actions", async () => {
  const client = fakeClient();
  const kit = createCardKit(client, {});
  const res = await kit.patchElements("card_1", [{ elementId: "run_answer", partial: { content: "hi" } }], 7);
  assert.equal(res.ok, true);
  const data = client.calls.at(-1).payload.data;
  assert.equal(data.sequence, 7);
  assert.deepEqual(data.actions, [
    { action: "partial_update_element", params: { element_id: "run_answer", partial_element: { content: "hi" } } },
  ]);
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

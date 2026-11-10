/**
 * Regression for the 300317 sequence clash (see ~/.dsh/_patchwork era report
 * and ~/.dsh/DSH 飞书通道/streamfix-sequence-300317-report.md): whole-card
 * updates and element-level streaming used to keep two independent counters
 * for the same card, so the second writer's sequence=1 collided with the
 * first writer's sequence=1 and the card was permanently downgraded to
 * whole-card updates. cardkit now owns one strictly increasing counter per
 * card, so every writer draws from the same well.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createCardKit } from "../src/feishu/cardkit.js";
import { CardStream } from "../src/dsh/streaming.js";

/** Fake Feishu: official rules — int32 positive and strictly increasing per card. */
function strictClient() {
  const last = new Map();
  const seen = [];
  const guard = (cardId, sequence) => {
    seen.push({ cardId, sequence });
    const prev = last.get(cardId) ?? 0;
    if (!(Number.isInteger(sequence) && sequence >= 1 && sequence <= 2_147_483_647) || sequence <= prev) {
      return { code: 300317, msg: "ErrMsg: sequence number compare failed; " };
    }
    last.set(cardId, sequence);
    return { code: 0, data: {} };
  };
  const client = {
    cardkit: {
      v1: {
        card: {
          create: async () => ({ code: 0, data: { card_id: "card_1" } }),
          update: async (p) => guard(p.path.card_id, p.data.sequence),
          batchUpdate: async (p) => guard(p.path.card_id, p.data.sequence),
          settings: async (p) => guard(p.path.card_id, p.data.sequence),
        },
        cardElement: { content: async (p) => guard(p.path.card_id, p.data.sequence) },
      },
    },
    im: { message: { create: async () => ({ code: 0, data: { message_id: "m1" } }) } },
  };
  return { client, seen, last };
}

test("整卡更新与元素流式共用一张卡时，sequence 全程严格递增", async () => {
  const { client, seen } = strictClient();
  const kit = createCardKit(client, {});
  const created = await kit.createCard({ schema: "2.0", body: { elements: [] } });
  const cardId = created.cardId;

  await kit.updateCard(cardId, { schema: "2.0" }); // writer 1: chrome
  const stream = new CardStream({
    cardkit: kit,
    cardId,
    elementId: "run_answer",
    baseThrottleMs: 100,
  });
  stream.push("答案"); // writer 2: element streaming
  await new Promise((resolve) => setTimeout(resolve, 250));
  await kit.closeStreaming(cardId, "完成");

  assert.equal(stream.failed, false, "流式不应被序号冲突打挂");
  const nums = seen.map((entry) => entry.sequence);
  assert.deepEqual(nums, nums.map((_, index) => index + 1), `sequence 必须 1,2,3… 递增，实测 ${nums}`);
});

test("重启恢复：adopt 上个进程保存的序号后，写入老卡不撞 300317", async () => {
  const { client, last } = strictClient();
  const kit = createCardKit(client, {});
  // 假设上一个进程在这张卡上已经发到 5。
  assert.equal(kit.adopt("card_old", 5), true);
  // 保存的旧值不能把计数器往回拨。
  assert.equal(kit.adopt("card_old", 2), true);
  const res = await kit.updateCard("card_old", { schema: "2.0" });
  assert.equal(res.ok, true);
  assert.equal(last.get("card_old"), 6);
});

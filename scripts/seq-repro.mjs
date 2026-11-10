#!/usr/bin/env node
/**
 * seq-repro.mjs — 飞书流式卡片 "sequence number compare failed" (300317) 最小复现
 *
 * 用插件仓库的**真实源码** (src/feishu/cardkit.js + src/dsh/streaming.js) 驱动一个
 * "假飞书":它按官方规则校验 sequence —— 必须是 int32 内的正整数,且相对同一张卡
 * 上一次操作**严格递增**,否则返回 code=300317。
 *
 * 然后模拟 src/dsh/runs.js 里 patch() 的真实调用序:
 *   1) chrome 变了 -> cardkit.updateCard(cardId, card, ++run.sequence)
 *   2) 答案到达   -> CardStream.push(text) -> cardkit.updateElement(..., ++stream.sequence)
 *
 * 若两个计数器各自从 0 起,第 1 步和第 2 步都会发出 sequence=1,第 2 步必被拒。
 *
 * 用法:
 *   node seq-repro.mjs [插件仓库根目录]      # 默认 ./ 或 $PLUGIN_ROOT
 *   node seq-repro.mjs ~/repos/dsh-feishu-plugin
 *
 * 退出码:
 *   0 = 序号全程严格递增(健康,修复后应当如此)
 *   1 = 复现到序号冲突(该 bug 仍在)
 *   2 = 脚本自身出错(例如路径不对)
 */

import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(
  process.argv[2] || process.env.PLUGIN_ROOT || ".",
);

let createCardKit;
let CardStream;
try {
  ({ createCardKit } = await import(
    pathToFileURL(path.join(root, "src", "feishu", "cardkit.js")).href
  ));
  ({ CardStream } = await import(
    pathToFileURL(path.join(root, "src", "dsh", "streaming.js")).href
  ));
} catch (error) {
  console.error(`无法从 ${root} 加载插件源码: ${error.message}`);
  console.error("请把插件仓库根目录作为第一个参数传入。");
  process.exit(2);
}

const MAX_SEQUENCE = 2_147_483_647;
const CALLS = [];

/** 假飞书:严格按官方规则校验 sequence。 */
function strictFeishu() {
  const last = new Map(); // cardId -> 上一次被接受的 sequence
  const guard = (cardId, sequence, kind) => {
    const prev = last.get(cardId) ?? 0;
    const inRange = Number.isInteger(sequence) && sequence >= 1 && sequence <= MAX_SEQUENCE;
    const accepted = inRange && sequence > prev;
    CALLS.push({ kind, sequence, prev, accepted, inRange });
    if (!accepted) {
      return {
        code: 300317,
        msg: "ErrMsg: sequence number compare failed; ",
      };
    }
    last.set(cardId, sequence);
    return { code: 0, data: {} };
  };
  return {
    last,
    cardkit: {
      v1: {
        card: {
          create: async () => ({ code: 0, data: { card_id: "card_1" } }),
          update: async (p) => guard(p.path.card_id, p.data.sequence, "updateCard"),
          batchUpdate: async (p) => guard(p.path.card_id, p.data.sequence, "patchElements"),
          settings: async (p) => guard(p.path.card_id, p.data.sequence, "closeStreaming"),
          idConvert: async () => ({ code: 0, data: { card_id: "card_1" } }),
        },
        cardElement: {
          content: async (p) => guard(p.path.card_id, p.data.sequence, "updateElement"),
        },
      },
    },
    im: { message: { get: async () => ({ code: 0, data: { items: [] } }) } },
  };
}

const logs = [];
const log = {
  warn: (m, d) => logs.push(`WARN ${m} ${JSON.stringify(d)}`),
  debug: () => {},
  info: () => {},
};

const client = strictFeishu();
const kit = createCardKit(client, log);
await kit.createCard({ schema: "2.0", body: { elements: [] } });

const cardId = "card_1";
const run = { sequence: 0, streamingEnabled: true };

// 1) runs.js patch():chrome 指纹变了 -> 整卡更新,用 run.sequence
const first = await kit.updateCard(
  cardId,
  { schema: "2.0" },
  (run.sequence = ((run.sequence ?? 0) % MAX_SEQUENCE) + 1),
);
console.log(
  `[1] 整卡更新(处理中)   run.sequence=${run.sequence}  -> ${first.ok ? "接受" : first.error}`,
);

// 2) 答案到达 -> CardStream 用自己的计数器发元素级流式更新
const stream = new CardStream({
  cardkit: kit,
  log,
  cardId,
  elementId: "run_answer",
  baseThrottleMs: 100, // CardStream 内部下限就是 100ms
});
stream.push("第一段答案");
await new Promise((resolve) => setTimeout(resolve, 250));
console.log(
  `[2] 元素流式更新      stream.sequence=${stream.sequence}  -> ` +
    (stream.failed ? "被拒 300317,markFailed" : "接受"),
);
console.log(`    stream.failed=${stream.failed}  okCount=${stream.okCount}`);

// 3) 此后该卡的每一次 patch() 都因为 stream.failed 退回整卡更新
const third = await kit.updateCard(
  cardId,
  { schema: "2.0" },
  (run.sequence = ((run.sequence ?? 0) % MAX_SEQUENCE) + 1),
);
console.log(
  `[3] 后续整卡更新       run.sequence=${run.sequence}  -> ${third.ok ? "接受(整卡重发)" : third.error}`,
);

console.log("\n实际发出的序号:");
for (const c of CALLS) {
  console.log(
    `    ${c.kind.padEnd(14)} sequence=${String(c.sequence).padEnd(3)} ` +
      `卡上已有=${c.prev}  ${c.accepted ? "✓" : "✗ 300317"}`,
  );
}

const rejected = CALLS.filter((c) => !c.accepted);
if (logs.length) console.log(`\n插件日志:\n  ${logs.join("\n  ")}`);
console.log(`\n飞书侧最终序号: ${JSON.stringify([...client.last.entries()])}`);

if (rejected.length > 0) {
  console.log(
    `\n结论: 复现成功 —— ${rejected.length} 次请求因序号未严格递增被拒(300317)。`,
  );
  process.exit(1);
}
console.log("\n结论: 序号全程严格递增,未复现 300317。");
process.exit(0);

/** Feishu interactive-card builders (JSON 2.0). Pure functions only. */
import { formatDuration, relativeTime, truncate, truncateMiddle } from "./utils.js";

const MAX_CARD_BYTES = 29_000;
const TRUNCATED_MARK = "\n\n…（内容过长，卡片已截断）";

function utf8Bytes(text) {
  return Buffer.byteLength(String(text), "utf8");
}

function truncateUtf8(text, maxBytes) {
  let out = "";
  let used = 0;
  for (const char of String(text)) {
    const size = utf8Bytes(char);
    if (used + size > maxBytes) break;
    out += char;
    used += size;
  }
  return out;
}

function textNodes(elements, out = []) {
  for (const element of Array.isArray(elements) ? elements : []) {
    if (!element || typeof element !== "object") continue;
    if (element.tag === "markdown" && typeof element.content === "string") out.push(element);
    if (Array.isArray(element.elements)) textNodes(element.elements, out);
    if (Array.isArray(element.columns)) {
      for (const column of element.columns) textNodes(column?.elements, out);
    }
  }
  return out;
}

const MAX_CARD_TABLES = 5;

function isTableSeparator(line) {
  const text = String(line).trim();
  if (!text.includes("|")) return false;
  const cells = text.replace(/^\|/, "").replace(/\|$/, "").split("|");
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function tableSpans(text) {
  const lines = String(text).split("\n");
  const spans = [];
  let inCode = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*(```|~~~)/.test(lines[i])) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    if (i > 0 && isTableSeparator(lines[i]) && lines[i - 1].includes("|")) {
      let end = i;
      while (end + 1 < lines.length && lines[end + 1].includes("|") && lines[end + 1].trim() !== "") end += 1;
      spans.push([i - 1, end]);
      i = end;
    }
  }
  return spans;
}

function limitTablesInText(text, budget) {
  const spans = tableSpans(text);
  if (spans.length <= budget) return { text, converted: 0, used: spans.length };
  const convert = new Set(spans.slice(budget).map(([start]) => start));
  const lines = String(text).split("\n");
  const out = [];
  let converted = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (!convert.has(i)) {
      out.push(lines[i]);
      continue;
    }
    const span = spans.find(([start]) => start === i);
    out.push("```");
    for (let j = i; j <= span[1]; j += 1) out.push(lines[j]);
    out.push("```");
    i = span[1];
    converted += 1;
  }
  return { text: out.join("\n"), converted, used: Math.min(spans.length, budget) };
}

/** Feishu cards allow at most five rendered table components. Tables beyond the
 * fifth are wrapped in code fences so they stay readable without failing the
 * whole card update. */
function limitCardTables(value) {
  let budget = MAX_CARD_TABLES;
  let converted = 0;
  for (const node of textNodes(value.body?.elements ?? [])) {
    const result = limitTablesInText(node.content, budget);
    node.content = result.text;
    budget -= result.used;
    converted += result.converted;
  }
  if (converted > 0) {
    value.body.elements.push({
      tag: "markdown",
      content: `…（表格过多，后 ${converted} 个表格已转为代码块）`,
      text_size: "notation",
    });
  }
  return value;
}

/** Feishu rejects cards over 30KB; truncate the largest text blocks before send. */
function fitCard(value) {
  let bytes = utf8Bytes(JSON.stringify(value));
  if (bytes <= MAX_CARD_BYTES) return value;
  const nodes = textNodes(value.body?.elements ?? []).sort(
    (a, b) => utf8Bytes(b.content) - utf8Bytes(a.content),
  );
  for (const node of nodes) {
    if (bytes <= MAX_CARD_BYTES) break;
    const excess = bytes - MAX_CARD_BYTES;
    const target = Math.max(64, utf8Bytes(node.content) - excess - 64);
    node.content = `${truncateUtf8(node.content, target)}${TRUNCATED_MARK}`;
    bytes = utf8Bytes(JSON.stringify(value));
  }
  return value;
}

function card({ title, template = "blue", elements = [], streaming = false }) {
  const config = { update_multi: true };
  if (streaming) {
    // Declaring the streaming config in the card JSON lets Feishu animate as
    // soon as the card exists; 15ms print frequency is the fry-cards default.
    config.streaming_mode = true;
    config.summary = { content: "[Generating...]" };
    config.streaming_config = {
      print_frequency_ms: { default: 15 },
      print_step: { default: 1 },
      print_strategy: "fast",
    };
  }
  return fitCard(limitCardTables({
    schema: "2.0",
    config,
    header: { title: { tag: "plain_text", content: truncate(title, 80) }, template },
    body: { elements: elements.slice(0, 190) },
  }));
}

function md(content) {
  return { tag: "markdown", content: truncate(content, 24_000) };
}

function note(content) {
  return { tag: "markdown", content: truncate(content, 2_000), text_size: "notation" };
}

function hr() {
  return { tag: "hr" };
}

function button(text, type, value, extra = {}) {
  return {
    tag: "button",
    text: { tag: "plain_text", content: truncate(text, 60) },
    type,
    behaviors: [{ type: "callback", value }],
    ...extra,
  };
}

function columns(text, buttons) {
  return {
    tag: "column_set",
    flex_mode: "none",
    horizontal_spacing: "small",
    columns: [
      { tag: "column", width: "weighted", weight: 5, vertical_align: "center", elements: [md(text)] },
      { tag: "column", width: "auto", vertical_align: "center", elements: buttons },
    ],
  };
}

export function modelLabel(model) {
  if (!model) return "(默认)";
  return `${model.provider}/${model.model}`;
}

export function sessionLine(view, index, now = Date.now()) {
  const marks = [relativeTime(view.updatedAt, now)];
  if (view.running) marks.unshift("⚡ 运行中");
  if (view.cwd) marks.push(`📍 ${truncateMiddle(view.cwd, 36)}`);
  if (view.perm) marks.push(`🔐 ${view.perm}`);
  const title = truncate((view.title || "(未命名会话)").trim(), 50);
  return `${index}. **${title}** · ${marks.join(" · ")}`;
}

export function helpCard() {
  return card({
    title: "🧭 DSH 飞书桥接",
    template: "turquoise",
    elements: [
      md(
        [
          "**主聊天流**（管理台）",
          "`/new [标题]` 新建会话（表单：目录 / 模型 / 权限）",
          "`/sessions` 会话列表（可翻页、进入会话的话题）",
          "`/open <序号>`、`/resume <序号>` 推荐进入列表中的会话",
          "`/help` 本帮助",
          "",
          "**话题内**（一条话题 = 一个 DSH 会话）",
          "直接发消息即对话；`/stop` 停止当前回合；`/recover` 清理卡住的运行/提问/审批状态；`/current` 查看会话",
          "`/model [关键词]` 切换模型；`/effort [档位]` 切换推理强度；`/perm [档位]` 切换权限预设",
          "`/cd <绝对路径>` 迁移工作目录；`/rename <标题>` 重命名",
          "`/steer <文本>` 立即插队；`/queue <文本>` 排队",
          "",
          "**审批与提问**",
          "DSH 的审批请求会变成飞书卡片：只支持「允许一次 / 拒绝」（DSH 的审批是一次性授权）。",
          "模型反问：选择题用按钮（单选点一下、多选切换后提交），纯文字题用卡片内输入框提交；超时后仍可继续回答。审批卡超时后也保留 30 分钟可操作。",
        ].join("\n"),
      ),
      note("全程 WebSocket 长连接：不监听端口，也不需要公网地址。"),
    ],
  });
}

export function mainHintCard({ pendingKey, pendingText }) {
  const elements = [
    md(
      pendingText
        ? `收到一条任务：\n> ${truncate(pendingText.replace(/\n/g, " "), 300)}\n\n主聊天流不做对话。可以把它带进一个新会话：`
        : "主聊天流只做管理。直接发消息不会进入任何会话；请新建会话，或进入已有会话的话题。",
    ),
  ];
  if (pendingKey) {
    elements.push(button("🚀 用这条消息新建会话", "primary", { a: "quicknew", k: pendingKey }));
  }
  elements.push(button("📝 新建会话", "default", { a: "new" }));
  elements.push(button("🧩 会话列表", "default", { a: "list", p: 0 }));
  elements.push(button("❓ 帮助", "default", { a: "help" }));
  return card({ title: "🧭 管理台", template: "blue", elements });
}

export function thinkingCard(text = "⏳ 正在理解你的意图…") {
  return card({ title: "🧭 管理台", template: "blue", elements: [md(text)] });
}

export function createdHintCard(title, lines) {
  return card({
    title,
    template: "green",
    elements: [md(lines.join("\n") || "(无)")],
  });
}

export function sessionListCard({ sessions, page, pageSize, currentSessionId, now, title = "🧩 DSH 会话", intro }) {
  const elements = [];
  if (intro) elements.push(md(intro));
  const pageCount = Math.max(1, Math.ceil(sessions.length / pageSize));
  const safePage = Math.min(Math.max(0, page), pageCount - 1);
  const rows = sessions.slice(safePage * pageSize, safePage * pageSize + pageSize);
  if (sessions.length === 0) {
    elements.push(md("还没有会话。点下方「新建会话」创建；创建后会自动开一个飞书话题。"));
  } else {
    rows.forEach((view, index) => {
      if (index > 0) elements.push(hr());
      elements.push(
        columns(sessionLine(view, safePage * pageSize + index + 1, now), [
          button(view.running ? "⚡ 查看" : "▶️ 进入", view.sessionId === currentSessionId ? "primary" : "default", {
            a: "open",
            s: view.sessionId,
          }),
        ]),
      );
    });
  }
  const controls = [];
  if (safePage > 0) controls.push(button("⬅️ 上一页", "default", { a: "list", p: safePage - 1 }));
  if (safePage + 1 < pageCount) controls.push(button("➡️ 下一页", "default", { a: "list", p: safePage + 1 }));
  controls.push(button("➕ 新建会话", "primary", { a: "new" }));
  elements.push(hr());
  elements.push({ tag: "column_set", flex_mode: "none", columns: controls.map((b) => ({ tag: "column", width: "auto", elements: [b] })) });
  elements.push(note(`第 ${safePage + 1}/${pageCount} 页 · 共 ${sessions.length} 个会话。进入会新开一个话题并绑定该会话。`));
  return card({ title, template: "blue", elements });
}

export function newSessionFormCard({ values = {}, error, models = [], perms = [], dirs = [], roots = [], defaultModel }) {
  const elements = [];
  if (error) elements.push(md(`⚠️ **提交失败**：${error}`));

  elements.push(
    md(
      [
        "一次填好，点「创建会话」后机器人会自动开一个话题。",
        `目录留空 = \`${roots[0] ?? process.cwd()}\`；目录不存在会自动创建。`,
        roots.length ? `目录必须位于允许范围：${roots.map((r) => `\`${r}\``).join("、")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    ),
  );

  const form = [];
  form.push({
    tag: "input",
    name: "title",
    required: false,
    width: "fill",
    placeholder: { tag: "plain_text", content: "会话标题（可留空，第一条消息会自动生成）" },
    default_value: values.title ?? "",
  });
  form.push({
    tag: "input",
    name: "dir",
    required: false,
    width: "fill",
    placeholder: { tag: "plain_text", content: "工作目录绝对路径（可留空）" },
    default_value: values.dir ?? "",
  });
  if (dirs.length) {
    form.push({
      tag: "select_static",
      name: "dir_select",
      type: "default",
      width: "fill",
      placeholder: { tag: "plain_text", content: "或从允许根目录的一级子目录中选择" },
      options: [
        { text: { tag: "plain_text", content: "✍️ 手动输入路径（以上面的输入框为准）" }, value: "__custom__" },
        ...dirs.map((entry) => ({
          text: { tag: "plain_text", content: truncate(`${entry.isRepo ? "📦 " : "📁 "}${entry.name}`, 60) },
          value: entry.path,
        })),
      ],
      initial_option: "__custom__",
    });
  }
  if (models.length) {
    const selected = values.model
      ? `${values.model.provider}/${values.model.model}`
      : defaultModel
        ? `${defaultModel.provider}/${defaultModel.model}`
        : undefined;
    form.push({
      tag: "select_static",
      name: "model",
      type: "default",
      width: "fill",
      placeholder: { tag: "plain_text", content: "选择模型（可留空 = DSH 默认）" },
      options: models.slice(0, 40).map((model) => ({
        text: { tag: "plain_text", content: truncate(`${model.providerName ? `${model.providerName} / ` : ""}${model.name}`, 70) },
        value: `${model.provider}::${model.model}`,
      })),
      ...(selected && models.some((m) => `${m.provider}::${m.model}` === selected)
        ? { initial_option: selected }
        : {}),
    });
  }
  if (perms.length) {
    form.push({
      tag: "select_static",
      name: "perm",
      type: "default",
      width: "fill",
      placeholder: { tag: "plain_text", content: "选择权限预设" },
      options: perms.map((perm) => ({
        text: { tag: "plain_text", content: truncate(`${perm.name}${perm.description ? `：${perm.description}` : ""}`, 80) },
        value: perm.value,
      })),
      ...(values.perm && perms.some((p) => p.value === values.perm) ? { initial_option: values.perm } : {}),
    });
  }
  form.push({
    tag: "button",
    name: "submit",
    type: "primary",
    text: { tag: "plain_text", content: "✅ 创建会话" },
    behaviors: [{ type: "callback", value: { a: "create" } }],
    form_action_type: "submit",
  });
  elements.push({ tag: "form", name: "dsh_new_session", elements: form });
  return card({ title: "📝 新建 DSH 会话", template: "blue", elements });
}

export function openedSessionCard({ view, style = "resumed", brief }) {
  // The Feishu topic name follows this card's header title, so show the real
  // session title instead of a generic "已进入话题" status.
  const headerTitle = truncate(view.title || "(未命名会话)", 60);
  const lines = [];
  if (style === "created") {
    lines.push("会话已创建。直接在这个话题里发消息即可开始。");
  } else if (style === "entered") {
    const entered = [];
    if (view.sessionId) entered.push(`**会话 ID**：\`${view.sessionId}\``);
    entered.push("", "已为这个会话打开新的飞书话题，请到话题里继续。");
    return card({
      title: headerTitle,
      template: "green",
      elements: [md(entered.join("\n"))],
    });
  } else {
    lines.push("已在这个话题里接入选中的 DSH 会话。直接发消息即可继续。");
  }
  lines.push("");
  if (view.sessionId) lines.push(`**会话 ID**：\`${view.sessionId}\``);
  if (view.cwd) lines.push(`**目录**：\`${truncateMiddle(view.cwd, 80)}\``);
  lines.push(`**模型**：${view.model ? `${view.model.provider}/${view.model.model}` : "(DSH 默认)"}`);
  if (view.perm) lines.push(`**权限**：${view.perm}`);
  if (view.updatedAt) lines.push(`**最近活动**：${relativeTime(view.updatedAt)}`);
  if (brief && style !== "created") {
    const excerpts = [];
    if (brief.summary) excerpts.push(`**历史摘要**\n> ${truncate(brief.summary.replace(/\n/g, "\n> "), 900)}`);
    if (brief.lastUser) excerpts.push(`**你的上一条**\n> ${truncate(brief.lastUser.replace(/\n/g, "\n> "), 400)}`);
    if (brief.lastAssistant) excerpts.push(`**上次回复**\n> ${truncate(brief.lastAssistant.replace(/\n/g, "\n> "), 600)}`);
    if (excerpts.length) lines.push("", "—", ...excerpts);
  }
  return card({
    title: headerTitle,
    template: "green",
    elements: [md(lines.join("\n"))],
  });
}

/** Reasoning levels one provider/model advertises, if any. */
export function reasoningChoicesOf(model, catalog) {
  const entry = (catalog?.models ?? []).find(
    (item) => item.provider === model?.provider && item.model === model?.model,
  );
  const efforts = Array.isArray(entry?.reasoning?.efforts) ? entry.reasoning.efforts : [];
  return efforts.length > 0 ? { efforts, defaultEffort: entry.reasoning?.defaultEffort } : undefined;
}

/** Effort picker for the session's current model. */
export function reasoningCard({ sid, provider, model, current, catalog }) {
  const choices = reasoningChoicesOf({ provider, model }, catalog);
  const elements = [];
  const lines = [`**${provider}/${model}**`, "选择这一会话的推理强度，点下面任一项即可切换。"];
  if (current?.provider === provider && current?.model === model && current?.reasoningEffort) {
    lines.push(`当前：**${current.reasoningEffort}**`);
  }
  elements.push(md(lines.join("\n")));
  if (choices) {
    const levels = choices.efforts.map((effort) => effort.name || effort.id);
    if (choices.defaultEffort === undefined) levels.unshift("默认");
    elements.push(note(`可选：${levels.join(" / ")}`));
    for (const effort of choices.efforts) {
      const label = effort.name || effort.id;
      const selected =
        current?.provider === provider && current?.model === model && current?.reasoningEffort === effort.id;
      elements.push(
        button(`${selected ? "✅ " : "🎯 "}${label}`, selected ? "primary" : "default", {
          a: "effort",
          s: sid,
          p: provider,
          m: model,
          e: effort.id,
        }),
      );
    }
    const defaulting = choices.defaultEffort !== undefined ? choices.defaultEffort : "off";
    const selectedDefault =
      current?.provider === provider && current?.model === model && !current?.reasoningEffort;
    elements.push(
      button(`${selectedDefault ? "✅ " : "⚖️ "}默认（${defaulting}）`, selectedDefault ? "primary" : "default", {
        a: "effort",
        s: sid,
        p: provider,
        m: model,
        e: "__default",
      }),
    );
  } else {
    elements.push(md("该模型未声明可选的推理强度。"));
  }
  elements.push(md("也可以发 `/effort <档位>`，例如 `/effort high`。"));
  elements.push(button("⬅️ 返回选择模型", "default", { a: "effortback", s: sid }));
  elements.push(note("切换只影响后续回复。"));
  return card({ title: "🎯 选择推理强度", template: "turquoise", elements });
}

export function modelCard({ sid, current, models, page = 0, pageSize = 8, catalog }) {
  const elements = [];
  if (current) elements.push(md(`当前模型：**${current.provider}/${current.model}**`));
  if (current) {
    const supportsEffort = Boolean(reasoningChoicesOf(current, catalog));
    elements.push(
      button(
        supportsEffort
          ? `🎯 切换推理强度${current.reasoningEffort ? `（当前 ${current.reasoningEffort}）` : ""}`
          : "🎯 当前模型不支持推理强度",
        supportsEffort ? "primary" : "default",
        supportsEffort ? { a: "effortopen", s: sid } : { a: "noop", s: sid },
      ),
    );
  }
  const pageCount = Math.max(1, Math.ceil(models.length / pageSize));
  const safePage = Math.min(Math.max(0, page), pageCount - 1);
  const slice = models.slice(safePage * pageSize, safePage * pageSize + pageSize);
  for (const model of slice) {
    const selected = current && current.provider === model.provider && current.model === model.model;
    elements.push(
      button(
        `${selected ? "✅ " : "🧠 "}${model.name}`,
        selected ? "primary" : "default",
        { a: "model", s: sid, p: model.provider, m: model.model },
      ),
    );
  }
  if (models.length === 0) elements.push(md("当前没有可路由的模型。请先在 DSH 设置里配置模型。"));
  if (safePage > 0) elements.push(button("⬅️ 上一页", "default", { a: "modelpage", s: sid, p: safePage - 1 }));
  if (safePage + 1 < pageCount) {
    elements.push(button("➡️ 下一页", "default", { a: "modelpage", s: sid, p: safePage + 1 }));
  }
  elements.push(
    note("切换只影响后续回复。也可以发 `/model <关键词>`；点「切换推理强度」或发 `/effort <档位>` 可调推理强度。"),
  );
  return card({ title: "🧠 选择模型", template: "blue", elements });
}

export function permissionCard({ sid, current, perms }) {
  const elements = [];
  elements.push(md(current ? `当前权限预设：**${current}**` : "当前权限预设：未知"));
  for (const perm of perms) {
    elements.push(
      button(
        `${perm.value === current ? "✅ " : "🔐 "}${perm.name}${perm.description ? ` — ${perm.description}` : ""}`,
        perm.value === current ? "primary" : "default",
        { a: "perm", s: sid, v: perm.value },
      ),
    );
  }
  if (perms.length === 0) elements.push(md("当前部署没有配置权限预设。"));
  elements.push(note("权限预设同时设置沙箱模式与审批策略。切换后只影响后续工具调用。"));
  return card({ title: "🔐 选择权限预设", template: "orange", elements });
}

export function approvalCard({ toolName, reason, sessionTitle, ttlMinutes, approveToken, rejectToken, notice }) {
  const lines = [`**工具**：\`${truncate(toolName, 80)}\``];
  if (reason) lines.push(`**原因**：${truncate(reason, 500)}`);
  if (sessionTitle) lines.push(`**会话**：${truncate(sessionTitle, 80)}`);
  lines.push("", ttlMinutes > 0 ? `DSH 审批仅对本次调用生效（${ttlMinutes} 分钟内有效）。` : "DSH 审批仅对本次调用生效。");
  return card({
    title: "🔐 需要审批",
    template: "orange",
    elements: [
      md(lines.join("\n")),
      {
        tag: "column_set",
        flex_mode: "none",
        columns: [
          { tag: "column", width: "auto", elements: [button("✅ 允许一次", "primary", { a: "approve", t: approveToken })] },
          { tag: "column", width: "auto", elements: [button("❌ 拒绝", "danger", { a: "reject", t: rejectToken })] },
        ],
      },
      note(notice || "需要长期放行请在 Web 端切换权限预设；DSH 不提供「始终允许」。"),
    ],
  });
}

export function approvalResultCard({ approved, toolName }) {
  return card({
    title: approved ? "✅ 已允许本次调用" : "❌ 已拒绝本次调用",
    template: approved ? "green" : "red",
    elements: [md(`工具：\`${truncate(toolName, 100)}\``)],
  });
}

function markdownBlocks(text) {
  const lines = String(text).split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === "") {
      i += 1;
      continue;
    }
    if (/^\s*(```|~~~)/.test(lines[i])) {
      let j = i + 1;
      while (j < lines.length && !/^\s*(```|~~~)/.test(lines[j])) j += 1;
      blocks.push({ text: lines.slice(i, j + 1).join("\n"), tables: 0 });
      i = j + 1;
      continue;
    }
    if (i + 1 < lines.length && lines[i].includes("|") && isTableSeparator(lines[i + 1])) {
      let j = i + 1;
      while (j + 1 < lines.length && lines[j + 1].includes("|") && lines[j + 1].trim() !== "") j += 1;
      blocks.push({ text: lines.slice(i, j + 1).join("\n"), tables: 1 });
      i = j + 1;
      continue;
    }
    let j = i;
    const paragraph = [];
    while (j < lines.length && lines[j].trim() !== "") {
      if (j + 1 < lines.length && lines[j].includes("|") && isTableSeparator(lines[j + 1])) break;
      if (/^\s*(```|~~~)/.test(lines[j])) break;
      paragraph.push(lines[j]);
      j += 1;
    }
    if (paragraph.length === 0) {
      paragraph.push(lines[i]);
      j = i + 1;
    }
    blocks.push({ text: paragraph.join("\n"), tables: 0 });
    i = j;
  }
  return blocks;
}

function splitLongBlock(block, maxBytes) {
  const out = [];
  let current = "";
  for (const line of String(block.text).split("\n")) {
    const candidate = current ? `${current}\n${line}` : line;
    if (utf8Bytes(candidate) <= maxBytes) {
      current = candidate;
      continue;
    }
    if (current) out.push(current);
    current = "";
    if (utf8Bytes(line) <= maxBytes) {
      current = line;
      continue;
    }
    let piece = "";
    for (const char of line) {
      if (utf8Bytes(piece + char) > maxBytes) {
        out.push(piece);
        piece = "";
      }
      piece += char;
    }
    current = piece;
  }
  if (current) out.push(current);
  return out.map((text) => ({ text, tables: block.tables }));
}

/** Split a final answer into cards under Feishu's table/byte limits while
 * keeping each Markdown table intact. Live streaming still uses one card. */
export function splitAnswerForCards(answer, { maxTables = 5, maxBytes = 24_000 } = {}) {
  const blocks = markdownBlocks(String(answer));
  if (blocks.length === 0) return [];
  const chunks = [];
  let current = [];
  let tables = 0;
  let bytes = 0;
  const flush = () => {
    if (current.length === 0) return;
    chunks.push(current.join("\n\n"));
    current = [];
    tables = 0;
    bytes = 0;
  };
  for (const block of blocks) {
    const blockBytes = utf8Bytes(block.text);
    if (blockBytes > maxBytes) {
      flush();
      for (const piece of splitLongBlock(block, maxBytes)) {
        if (current.length > 0) flush();
        current = [piece.text];
        tables = piece.tables;
        bytes = utf8Bytes(piece.text);
        flush();
      }
      continue;
    }
    const nextTables = tables + block.tables;
    const nextBytes = bytes + (current.length ? 2 : 0) + blockBytes;
    if (current.length > 0 && (nextTables > maxTables || nextBytes > maxBytes)) flush();
    current.push(block.text);
    tables += block.tables;
    bytes += (current.length > 1 ? 2 : 0) + blockBytes;
  }
  flush();
  return chunks;
}

export function answerPartCard({ index, total, content }) {
  return card({
    title: `📄 回答（${index}/${total}）`,
    template: "blue",
    elements: [md(content), note(`这是第 ${index}/${total} 段，完整内容仍保存在 DSH 会话里。`)],
  });
}

export function questionCard({ question, index = 0, total = 1, token, selected = [], notice }) {
  const elements = [];
  const head = question.header ? `**${question.header}**\n` : "";
  elements.push(md(`${head}${question.question}`));
  if (question.detail) elements.push(md(truncate(question.detail, 4_000)));

  const options = Array.isArray(question.options)
    ? question.options.filter((option) => option && option.label)
    : [];
  const picked = new Set(Array.isArray(selected) ? selected : []);

  if (options.length > 0) {
    for (const option of options.slice(0, 10)) {
      const label = truncate(option.label, 60);
      elements.push(
        button(`${picked.has(option.label) ? "✅ " : ""}${label}`, picked.has(option.label) ? "primary" : "default", {
          a: "qpick",
          t: token,
          i: index,
          s: option.label,
        }),
      );
    }
    if (options.length > 10) {
      elements.push(note(`选项较多，仅展示前 10 个；其余请直接回复文字。`));
    }
    if (question.multiSelect) {
      elements.push(
        button(`✅ 提交${picked.size ? `（${picked.size}）` : ""}`, picked.size ? "primary" : "default", {
          a: "qsubmit",
          t: token,
          i: index,
        }),
      );
      elements.push(note("可多选：点选项切换选中，最后点「提交」；也可以直接回复文字，多个用逗号分隔。"));
    } else {
      elements.push(note("点选项即提交；也可以直接回复文字作为自定义答案。"));
    }
  } else {
    elements.push(note("直接在本话题回复文字作答。"));
  }
  if (options.length === 0) {
    elements.push(md("**文字回答**"));
    elements.push({
      tag: "form",
      name: "q_text_form",
      elements: [
        {
          tag: "input",
          name: "custom",
          width: "fill",
          required: false,
          placeholder: { tag: "plain_text", content: "在这里输入文字答案，或直接在本话题回复" },
        },
        {
          tag: "button",
          name: "submit",
          type: "primary",
          form_action_type: "submit",
          text: { tag: "plain_text", content: "✅ 提交" },
          behaviors: [{ type: "callback", value: { a: "qtextsubmit", t: token, i: index } }],
        },
      ],
    });
  } else {
    elements.push(note("也可以直接在本话题回复文字作为自定义答案。"));
  }
  if (notice) elements.push(note(notice));

  return card({
    title: `❓ 需要你的决定 (${index + 1}/${total})`,
    template: "orange",
    elements,
  });
}

export function questionAnsweredCard({ summary }) {
  return card({
    title: "✅ 已回答",
    template: "green",
    elements: [md(truncate(summary, 2_000))],
  });
}

function panelHeader(titleMd) {
  return {
    title: { tag: "markdown", content: titleMd },
    vertical_align: "center",
    icon: { tag: "standard_icon", token: "down-small-ccm_outlined", size: "16px 16px" },
    icon_position: "follow_text",
    icon_expanded_angle: -180,
  };
}

function collapsiblePanel({ title, expanded, border = "grey", body }) {
  return {
    tag: "collapsible_panel",
    expanded,
    header: panelHeader(title),
    border: { color: border, corner_radius: "5px" },
    vertical_spacing: "8px",
    padding: "8px 8px 8px 8px",
    elements: [{ tag: "markdown", content: body, text_size: "notation" }],
  };
}

function toolHeader(tool) {
  const icon = tool.status === "error" ? "❌" : tool.status === "done" ? "✅" : "🔧";
  const preview = truncate(tool.preview ?? "", 80);
  return preview ? `${icon} **${truncate(tool.name, 40)}** — ${preview}` : `${icon} **${truncate(tool.name, 40)}**`;
}

function toolLine(tool) {
  return `- ${toolHeader(tool)}`;
}

/** Keep the newest characters: streamed reasoning must not freeze on its head. */
function tailTruncate(text, max) {
  const value = String(text ?? "");
  if (value.length <= max) return value;
  return `…${value.slice(value.length - Math.max(0, max - 1))}`;
}

/** Fixed answer element: the typewriter pushes only this element. */
export const RUN_ANSWER_ELEMENT_ID = "run_answer";

export function runCard({ run, maxAnswerChars, streaming = false }) {
  const status = run.status;
  const title =
    status === "continued"
      ? "➡️ 回答已提交"
      : status === "done"
        ? "✅ 回合完成"
        : status === "error"
          ? "❌ 回合出错"
          : status === "stopped"
            ? "⏹ 已停止"
            : status === "starting"
              ? run.continued
                ? "🤖 继续处理"
                : "⏳ 正在开始"
              : "🤖 处理中";
  const template =
    status === "done"
      ? "green"
      : status === "error"
        ? "red"
        : status === "stopped" || status === "continued"
          ? "grey"
          : "blue";

  const finished = status === "done" || status === "error" || status === "stopped" || status === "continued";
  const answer =
    status === "continued" || run.answerHidden
      ? ""
      : String((finished ? run.text || run.streamingText : run.streamingText || run.text) || "").trim();
  const elapsed = run.startedAt ? Date.now() - run.startedAt : 0;
  const active = status === "starting" || status === "running";
  const tools = run.tools ?? [];
  const totalTools = run.toolTotal ?? tools.length;

  // Thinking is kept per step so one turn shows every reasoning round.
  const rawSteps = [...(run.reasoningSteps ?? [])];
  if (String(run.streamingReasoning ?? "").trim()) {
    rawSteps.push({ step: run.step || rawSteps.length + 1, text: String(run.streamingReasoning).trim() });
  }
  const stepList = [];
  for (const item of rawSteps) {
    const last = stepList[stepList.length - 1];
    if (last && last.step === item.step) last.text = `${last.text}\n${item.text}`;
    else stepList.push({ step: item.step, text: item.text });
  }
  const reasoningChars = stepList.reduce((total, item) => total + item.text.length, 0);

  const runningTool = [...tools].reverse().find((tool) => tool.status === "running");
  const reasoningTail = String(run.streamingReasoning ?? "").replace(/\s+/g, " ").trim().slice(-90);
  const statusLine =
    status === "continued"
      ? "✅ 回答已提交，后续输出见下方新卡片"
      : status === "done"
        ? "✅ 完成"
        : status === "error"
          ? "❌ 出错"
          : status === "stopped"
            ? "⏹ 已停止"
            : answer
              ? "✍️ 正在生成回答…"
              : runningTool
                ? `🔧 正在调用 ${truncate(runningTool.name, 30)}…`
                : run.continued
                  ? "💭 继续处理…"
                  : reasoningTail
                    ? `💭 思考中：${reasoningTail}`
                    : "💭 正在思考…";

  const elements = [];
  elements.push(md(statusLine));

  // The answer element exists from the first render: element content can only
  // be updated on an element that is already on the card.
  elements.push({
    tag: "markdown",
    element_id: RUN_ANSWER_ELEMENT_ID,
    content: answer ? truncate(answer, maxAnswerChars) : "",
  });
  if (answer.length > maxAnswerChars) {
    elements.push(note("回答过长，卡片已截断；完整内容可在 DSH Web 会话里查看。"));
  }

  // Unified bottom panel: thinking and tools interleaved by step.
  const byStep = new Map();
  const bucketOf = (step) => {
    const key = Number(step) || 0;
    if (!byStep.has(key)) byStep.set(key, { reasoning: "", tools: [] });
    return byStep.get(key);
  };
  for (const item of stepList) {
    const bucket = bucketOf(item.step);
    bucket.reasoning = bucket.reasoning ? `${bucket.reasoning}\n${item.text}` : item.text;
  }
  for (const tool of tools) bucketOf(tool.step ?? run.step).tools.push(tool);
  const sections = [];
  for (const [step, bucket] of [...byStep.entries()].sort((left, right) => left[0] - right[0])) {
    const reasoningText = bucket.reasoning.trim();
    if (reasoningText) sections.push(`**💭 第 ${step} 步**\n${tailTruncate(reasoningText, 800)}`);
    if (bucket.tools.length) {
      sections.push(`**🔧 工具（第 ${step} 步）**\n${bucket.tools.map((tool) => toolLine(tool)).join("\n")}`);
    }
  }
  if (totalTools > tools.length) sections.push(`- …已省略前 ${totalTools - tools.length} 次工具调用`);
  const PANEL_BUDGET = 2_800;
  const picked = [];
  let usedChars = 0;
  for (let index = sections.length - 1; index >= 0; index -= 1) {
    const sectionText = sections[index];
    if (picked.length > 0 && usedChars + sectionText.length > PANEL_BUDGET) break;
    picked.unshift(sectionText);
    usedChars += sectionText.length;
  }
  const omittedSections = sections.length - picked.length;
  let panelBody = picked.join("\n\n");
  if (omittedSections > 0) panelBody = `_…前 ${omittedSections} 段已省略_\n\n${panelBody}`;
  if (!panelBody) panelBody = active ? "_正在思考…_" : "_本回合没有思考或工具调用_";
  const panelBorder =
    status === "done" ? "green" : status === "error" ? "red" : status === "stopped" ? "yellow" : "grey";
  const showPanel = active || stepList.length > 0 || totalTools > 0 || Boolean(run.error);
  if (showPanel) {
    const panelParts = [];
    if (run.model) panelParts.push(`🍟 ${run.model}`);
    panelParts.push(`💭${stepList.length}`);
    panelParts.push(`🔧${totalTools}`);
    panelParts.push(`⏱ ${formatDuration(elapsed)}`);
    if (active) panelParts.push("进行中");
    elements.push(
      collapsiblePanel({
        title: panelParts.join(" · "),
        expanded: false,
        border: panelBorder,
        body: panelBody,
      }),
    );
  }

  const footerParts = [];
  if (run.perm) footerParts.push(`🔐 ${run.perm}`);
  if (answer.length > 0) footerParts.push(`✍️ ${answer.length} 字`);
  if (run.turn) footerParts.push(`第 ${run.turn} 轮`);
  if (run.error) footerParts.push(`⚠️ ${truncate(run.error, 200)}`);
  if (footerParts.length) elements.push(note(footerParts.join(" · ")));

  if (run.answerNote) elements.push(note(run.answerNote));
  if (run.canStop) {
    elements.push(button("⏹ 强制停止", "danger", { a: "stop", s: run.sessionId }));
  }
  return card({ title, template, elements, streaming });
}

/** Drop generated element ids and stale buttons before reusing card elements. */
export function stripTransientElements(value) {
  if (Array.isArray(value)) return value.map(stripTransientElements).filter((item) => item !== null);
  if (!value || typeof value !== "object") return value;
  if (value.tag === "button") return null;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "element_id") continue;
    out[key] = stripTransientElements(item);
  }
  return out;
}

/** Terminal card for a run that a restart killed before it could finish. */
export function interruptedRunCard(elements) {
  const body = Array.isArray(elements) && elements.length > 0
    ? elements
    : [
        md("上一轮回复因 DSH 重启而中断，本卡片未保留内容。"),
        note("完整过程见 DSH Web 的同一会话。"),
      ];
  const built = card({ title: "❌ 回合已中断", template: "grey", elements: body });
  built.config.summary = { content: "回合已中断（DSH 重启）" };
  return built;
}

export function stoppedCard() {
  return card({ title: "⏹ 已请求停止", template: "grey", elements: [md("已向 DSH 发送取消请求。")] });
}

export function errorCard(title, message) {
  return card({
    title: `❌ ${title}`,
    template: "red",
    elements: [md(truncate(message, 4_000))],
  });
}

export function compactResultCard({ title, lines, template = "grey" }) {
  return card({ title, template, elements: [md(lines.join("\n") || "(无)")] });
}

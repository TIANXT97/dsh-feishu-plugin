/** Turns DSH session events into one live Feishu card per turn. */
import { describeError, errorMessage, formatDuration, truncate, toolPreview } from "../utils.js";
import {
  RUN_ANSWER_ELEMENT_ID,
  answerPartCard,
  interruptedRunCard,
  runCard,
  splitAnswerForCards,
  stripTransientElements,
} from "../cards.js";
import { createCardKit } from "../feishu/cardkit.js";
import { CardStream } from "./streaming.js";

function textOfMessage(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  return blocks
    .filter((block) => block?.type === "text")
    .map((block) => block.text ?? "")
    .join("");
}

/** Answer text carried by the fixed answer element of a built card. */
function answerTextOf(card) {
  for (const element of card?.body?.elements ?? []) {
    if (element?.element_id === RUN_ANSWER_ELEMENT_ID) return String(element.content ?? "");
  }
  return "";
}

/** Everything on the card except the streamed answer and the elapsed counter. */
function chromeFingerprint(run) {
  return [
    run.status,
    run.canStop ? "s" : "-",
    `${(run.reasoningSteps ?? []).length}:${String(run.streamingReasoning ?? "").slice(-90)}`,
    run.error ?? "",
    run.toolTotal ?? 0,
    (run.tools ?? []).map((tool) => `${tool.callId}:${tool.status}`).join(","),
  ].join("|");
}

export class RunCards {
  constructor({ bridge, sender, cardkit, state, config, log }) {
    this.bridge = bridge;
    this.sender = sender;
    this.cardkit = cardkit;
    this.state = state;
    this.config = config;
    this.log = log;
    this.runs = new Map();
    this.heartbeat = setInterval(() => {
      for (const run of this.runs.values()) {
        if (run.status === "running" || run.status === "starting") this.schedule(run);
      }
    }, 5_000);
    this.heartbeat.unref?.();
  }

  dispose() {
    clearInterval(this.heartbeat);
    for (const run of this.runs.values()) {
      if (run.timer) clearTimeout(run.timer);
    }
    this.runs.clear();
  }

  active(sessionId) {
    const run = this.runs.get(sessionId);
    return run && !run.finished ? run : undefined;
  }

  async beginPrompt(sessionId, { anchorMessageId, chatId, threadId }) {
    const current = this.active(sessionId);
    if (current) {
      current.promptCount += 1;
      this.schedule(current);
      return current;
    }
    const view = await this.bridge.viewOf(sessionId);
    const run = {
      sessionId,
      chatId: chatId || view.chatId,
      anchorMessageId,
      threadId,
      messageId: "",
      status: "starting",
      startedAt: Date.now(),
      finishedAt: 0,
      tools: [],
      toolTotal: 0,
      reasoningSteps: [],
      sequence: 0,
      text: "",
      streamingText: "",
      streamingReasoning: "",
      turn: 0,
      step: 0,
      error: "",
      canStop: false,
      promptCount: 1,
      model: view.model ? `${view.model.provider}/${view.model.model}` : undefined,
      perm: view.perm,
      timer: undefined,
      patchTimer: undefined,
      finished: false,
    };
    this.runs.set(sessionId, run);
    await this.openCard(run, anchorMessageId, chatId);
    this.schedule(run, true);
    return run;
  }

  /**
   * Send the run card. With a card entity available the answer element streams
   * (typewriter); otherwise the card is patched as a whole, as upstream does.
   */
  async openCard(run, anchorMessageId, chatId) {
    const canStream = this.config.stream !== false && Boolean(this.cardkit);
    if (canStream) {
      const card = runCard({ run, maxAnswerChars: this.config.maxAnswerChars, streaming: true });
      const created = await this.cardkit.createCard(card);
      if (created.ok) {
        const sent = await this.cardkit.sendByReference({
          chatId,
          replyToMessageId: anchorMessageId,
          cardId: created.cardId,
          replyInThread: Boolean(run.threadId),
        });
        if (sent.ok) {
          run.messageId = sent.messageId;
          run.cardId = sent.cardId || created.cardId;
          run.streamingEnabled = true;
          run.sequence = 0;
          run.stream = new CardStream({
            cardkit: this.cardkit,
            log: this.log,
            cardId: run.cardId,
            elementId: RUN_ANSWER_ELEMENT_ID,
            baseThrottleMs: this.config.streamThrottleMs,
            maxChars: 30_000,
            onRollover: async () => {
              const fresh = runCard({
                run: { ...run, text: "", streamingText: "" },
                maxAnswerChars: this.config.maxAnswerChars,
                streaming: true,
              });
              const next = await this.cardkit.createCard(fresh);
              if (!next.ok) return undefined;
              const message = await this.cardkit.sendByReference({
                chatId: run.chatId,
                cardId: next.cardId,
                replyInThread: Boolean(run.threadId),
              });
              if (!message.ok) return undefined;
              run.rolloverMessageIds = [...(run.rolloverMessageIds ?? []), message.messageId];
              return { cardId: message.cardId || next.cardId, elementId: RUN_ANSWER_ELEMENT_ID };
            },
          });
          this.state.setLiveCard?.(run.sessionId, {
            messageId: run.messageId,
            cardId: run.cardId,
            chatId: run.chatId,
            threadId: run.threadId,
            turn: run.turn,
            startedAt: run.startedAt,
          });
          return run;
        }
        run.error = sent.error ?? "无法发送运行卡片";
        return run;
      }
      this.log.warn("创建卡片实体失败，回退整卡更新", { sessionId: run.sessionId, error: created.error });
    }
    const plain = runCard({ run, maxAnswerChars: this.config.maxAnswerChars });
    const sent = anchorMessageId
      ? await this.sender.replyCard(anchorMessageId, plain)
      : await this.sender.sendCard(chatId, plain);
    if (sent.ok) run.messageId = sent.messageId;
    else run.error = sent.error ?? "无法发送运行卡片";
    return run;
  }

  /**
   * Close the current run card and open a fresh one for the rest of the same
   * turn. Used after ask-user-question is answered: the model keeps working,
   * but its answer should appear under the user's reply, not inside the card
   * that was already on screen before the question.
   */
  async rotate(sessionId, { anchorMessageId, chatId, threadId } = {}) {
    const old = this.runs.get(sessionId);
    if (!old || old.finished) return undefined;
    old.finished = true;
    old.finishedAt = Date.now();
    old.status = "continued";
    old.canStop = false;
    if (old.patchTimer) {
      clearTimeout(old.patchTimer);
      old.patchTimer = undefined;
    }
    // Keep the tool/thinking history, but hide the partial answer in the old
    // card; the complete answer will be streamed into the new card.
    old.text = "";
    old.streamingText = "";
    void this.patch(old);

    const run = {
      sessionId,
      chatId: chatId || old.chatId,
      anchorMessageId,
      threadId: threadId || old.threadId,
      messageId: "",
      status: "starting",
      startedAt: Date.now(),
      finishedAt: 0,
      tools: [],
      toolTotal: 0,
      reasoningSteps: [],
      sequence: 0,
      text: "",
      streamingText: "",
      streamingReasoning: "",
      turn: old.turn,
      step: old.step,
      error: "",
      canStop: true,
      promptCount: old.promptCount,
      model: old.model,
      perm: old.perm,
      timer: undefined,
      patchTimer: undefined,
      finished: false,
      continued: true,
    };
    this.runs.set(sessionId, run);
    await this.openCard(run, anchorMessageId, chatId || run.chatId);
    this.schedule(run, true);
    return run;
  }

  schedule(run, immediate = false, delayOverride) {
    if (run.finished && !immediate) return;
    if (run.patchTimer) return;
    const delay = immediate ? 0 : (delayOverride ?? this.config.streamThrottleMs);
    run.patchTimer = setTimeout(() => {
      run.patchTimer = undefined;
      void this.patch(run);
    }, delay);
    run.patchTimer.unref?.();
  }

  async patch(run, force = false) {
    if (!run.messageId) return;
    // Serialize card updates. Streaming patches are async; without this, a
    // slow "处理中" update that started before turn/end can land after the
    // final "回合完成" update and revert the card to the running state.
    // `force` appends one final update after any in-flight/queued stale one.
    if (!force && run.patchQueued) return run.patchChain;
    run.patchQueued = true;
    run.patchChain = (run.patchChain ?? Promise.resolve())
      .then(async () => {
        const card = runCard({
          run,
          maxAnswerChars: this.config.maxAnswerChars,
          streaming: run.streamingEnabled === true && !run.finished,
        });
        run.contextWindow ??= this.bridge.contextWindowOf?.(run.sessionId);
        const answerText = answerTextOf(card);
        const chrome = chromeFingerprint(run);
        // Only the answer moved: let the typewriter carry it and skip a full
        // card replace, which would also re-render every other element.
        if (run.stream && !run.stream.failed && !force && chrome === run.lastChrome) {
          run.stream.push(answerText);
          run.lastAnswer = answerText;
          return;
        }
        const result =
          run.cardId && this.cardkit
            ? await this.cardkit.updateCard(
                run.cardId,
                card,
                (run.sequence = ((run.sequence ?? 0) % 2_147_483_647) + 1),
              )
            : await this.sender.patchCard(run.messageId, card);
        if (result.ok) {
          run.lastChrome = chrome;
          run.lastAnswer = answerText;
        } else {
          this.log.debug("运行卡片更新失败", { sessionId: run.sessionId, error: result.error });
        }
      })
      .catch((error) => {
        this.log.warn("运行卡片更新异常", { sessionId: run.sessionId, error: describeError(error) });
      })
      .finally(() => {
        run.patchQueued = false;
      });
    return run.patchChain;
  }

  finish(run, status, error = "") {
    if (run.finished) return;
    run.finished = true;
    run.finishedAt = Date.now();
    run.status = status;
    run.canStop = false;
    if (error) run.error = error;
    if (run.patchTimer) {
      clearTimeout(run.patchTimer);
      run.patchTimer = undefined;
    }
    let splitParts = [];
    if (status === "done" || status === "stopped") {
      const answer = String(run.text || run.streamingText || "").trim();
      if (answer) {
        // Keep three tables per card: the documented limit is five, but a
        // card that also carries reasoning/tool panels can push the renderer
        // over it. Dedicated part cards are the reliable delivery path.
        const chunks = splitAnswerForCards(answer, { maxTables: 3, maxBytes: 20_000 });
        if (chunks.length > 1) {
          const maxParts = 5;
          splitParts = chunks.slice(0, maxParts);
          run.answerHidden = true;
          run.splitParts = splitParts;
          const omitted = chunks.length - splitParts.length;
          run.answerNote =
            `回答较长，已分成 ${chunks.length} 段，见下方卡片。` +
            (omitted > 0 ? `另有 ${omitted} 段未发送，完整内容在 DSH Web 会话里。` : "");
        }
      }
    }
    void this.finalize(run).then(() => {
      if (splitParts.length > 0) void this.sendParts(run);
    });
    this.log.info("回合结束", {
      sessionId: run.sessionId,
      status,
      ms: run.finishedAt - run.startedAt,
      tools: run.tools.length,
      error,
    });
  }

  /** Close the typewriter, then write the terminal card exactly once. */
  async finalize(run) {
    if (run.stream) {
      const summary = String(run.text || run.streamingText || "").replace(/\s+/g, " ").trim();
      const preview = summary ? (summary.length > 60 ? `${summary.slice(0, 59)}…` : summary) : "完成";
      try {
        await run.stream.drain();
        await run.stream.close(preview);
      } catch (error) {
        this.log.debug("关闭流式卡片失败", { sessionId: run.sessionId, error: describeError(error) });
      }
      run.streamingEnabled = false;
    }
    await this.patch(run, true);
    this.state.clearLiveCard?.(run.sessionId);
  }

  /**
   * Close cards a previous process left running. A restart kills the turn
   * before finish(), so without this the card shows "generating" forever.
   */
  async reconcileOrphans() {
    const entries = this.state.takeLiveCards?.() ?? {};
    const sessionIds = Object.keys(entries);
    if (sessionIds.length === 0) return;
    if (!this.cardkit) {
      this.log.warn("没有卡片实体客户端，跳过遗留卡片收尾", { sessions: sessionIds.length });
      return;
    }
    this.log.info("收尾上次运行遗留的卡片", { sessions: sessionIds.length });
    for (const sessionId of sessionIds) {
      const info = entries[sessionId] ?? {};
      try {
        // The previous counter is unknown, so jump to the top of int32.
        const sequence = 2_147_483_646;
        if (info.cardId) {
          const closed = await this.cardkit.closeStreaming(info.cardId, sequence, "回合已中断（DSH 重启）");
          if (!closed.ok) this.log.warn("收尾遗留卡片：关闭流式失败", { sessionId, error: closed.error });
        }
        const card = await this.interruptedCard(info);
        let applied = info.cardId
          ? await this.cardkit.updateCard(info.cardId, card, sequence + 1)
          : { ok: false, error: "missing cardId" };
        if (!applied.ok && info.messageId) applied = await this.sender.patchCard(info.messageId, card);
        if (!applied.ok) throw new Error(applied.error ?? "card update failed");
        this.log.info("已收尾遗留卡片", { sessionId, cardId: info.cardId || undefined });
      } catch (error) {
        this.log.warn("收尾遗留卡片失败", { sessionId, error: describeError(error) });
      }
    }
  }

  /** Keep whatever partial output the message still carries; never blank a card. */
  async interruptedCard(info) {
    const existing = info.messageId ? await this.cardkit.cardContentOf(info.messageId) : undefined;
    const elements = stripTransientElements(existing?.body?.elements) ?? [];
    const statusLine = elements.find(
      (element) => element?.tag === "markdown" && typeof element.content === "string",
    );
    if (statusLine) {
      statusLine.content = statusLine.content.replace(
        /(^|\n)[^\n]*(?:正在生成回答|正在思考|正在调用)[^\n]*$/u,
        "$1⚠️ 上一轮因 DSH 重启而中断，以下内容可能不完整",
      );
    }
    return interruptedRunCard(elements);
  }

  onSessionEvent(session, event) {
    const sessionId = String(session?.id ?? "");
    const run = this.runs.get(sessionId);
    if (!run) return;
    const type = String(event?.type ?? "");
    const data = event?.data ?? {};

    switch (type) {
      case "turn/start":
        run.turn = Number(data.turn) || run.turn;
        run.status = "running";
        run.canStop = true;
        this.schedule(run, true);
        break;
      case "step/start":
        run.step = Number(data.step) || run.step;
        break;
      case "tool/call": {
        run.toolTotal = (run.toolTotal ?? 0) + 1;
        run.tools.push({
          callId: String(data.callId ?? ""),
          name: String(data.name ?? "tool"),
          step: run.step,
          preview: toolPreview(String(data.name ?? ""), data.arguments),
          status: "running",
        });
        if (run.tools.length > 12) run.tools.splice(0, run.tools.length - 12);
        this.schedule(run);
        break;
      }
      case "tool/result": {
        const callId = String(data.message?.toolCallId ?? "");
        const tool = [...run.tools].reverse().find((item) => item.callId === callId) ??
          [...run.tools].reverse().find((item) => item.status === "running");
        if (tool) tool.status = data.error || data.message?.isError ? "error" : "done";
        this.schedule(run);
        break;
      }
      case "assistant/message": {
        const text = textOfMessage(data.message);
        if (text.trim()) run.text = text;
        const usage = data.usage;
        if (usage?.outputTokens !== undefined) run.usage = usage;
        this.schedule(run);
        break;
      }
      case "assistant/attempt":
        if (!run.text) run.streamingText = "";
        break;
      case "turn/end": {
        const reason = data.reason ?? {};
        if (reason.kind === "error") {
          this.finish(run, "error", reason.error?.message ?? "模型请求失败");
        } else if (reason.kind === "aborted") {
          this.finish(run, "stopped");
        } else {
          this.finish(run, "done");
        }
        break;
      }
      default:
        break;
    }
  }

  onStream(payload) {
    const sessionId = String(payload?.agent?.id ?? "");
    const run = this.runs.get(sessionId);
    if (!run) return;
    const frame = payload?.frame;
    if (!frame) return;
    if (frame.type === "start") {
      const finishedStep = String(run.streamingReasoning ?? "").trim();
      if (finishedStep) {
        run.reasoningSteps = [...(run.reasoningSteps ?? []), { step: run.step, text: finishedStep }].slice(-12);
        run.streamingReasoning = "";
      }
      run.status = "running";
      run.canStop = true;
      run.turn = Number(frame.turn) || run.turn;
      run.step = Number(frame.step) || run.step;
      run.streamingText = "";
      // A turn can contain several model steps (tool loop). Do not clear the
      // previous step's reasoning here: if the next step has no thinking, the
      // drawer should keep showing the last reasoning instead of "暂无".
      this.schedule(run);
      return;
    }
    if (frame.type === "end") {
      this.schedule(run, true);
      return;
    }
    if (frame.type !== "chunk" || !this.config.stream) return;
    const chunk = frame.chunk;
    if (!chunk) return;
    if (chunk.type === "text-delta" && chunk.text) {
      run.streamingText = truncate(`${run.streamingText}${chunk.text}`, this.config.maxAnswerChars + 2_000);
      this.schedule(run);
    } else if (chunk.type === "reasoning-delta" && chunk.text) {
      // Keep the chain for the collapsed panel, but do not re-render the card
      // on every token. One status update per second keeps the height stable.
      const merged = `${run.streamingReasoning}${chunk.text}`;
      run.streamingReasoning = merged.length > 4_000 ? `…${merged.slice(merged.length - 3_999)}` : merged;
      this.schedule(run, false, 1_000);
    }
  }

  onStatus(payload) {
    const sessionId = String(payload?.agent?.id ?? "");
    const running = payload?.status === "running";
    this.bridge.setRunning(sessionId, running);
    const run = this.runs.get(sessionId);
    if (!run) return;
    run.canStop = running;
    if (running && run.status === "starting") run.status = "running";
    this.schedule(run);
  }

  onAgentError(payload) {
    const sessionId = String(payload?.agent?.id ?? "");
    const run = this.runs.get(sessionId);
    if (!run) return;
    this.finish(run, "error", errorMessage(payload?.error));
  }

  /** Stop and clear a run card without waiting for DSH turn events. */
  recover(sessionId) {
    const run = this.runs.get(sessionId);
    if (!run) return false;
    if (run.patchTimer) {
      clearTimeout(run.patchTimer);
      run.patchTimer = undefined;
    }
    run.finished = true;
    run.finishedAt = Date.now();
    run.status = "stopped";
    run.canStop = false;
    void this.patch(run);
    this.runs.delete(sessionId);
    this.log.info("运行卡片已恢复清理", { sessionId });
    return true;
  }

  async sendParts(run) {
    const parts = run.splitParts ?? [];
    run.splitParts = [];
    const total = parts.length;
    for (let i = 0; i < parts.length; i += 1) {
      const card = answerPartCard({ index: i + 1, total, content: parts[i] });
      let sent = run.messageId
        ? await this.sender.replyCard(run.messageId, card)
        : { ok: false, error: "missing run card" };
      if (!sent.ok && run.chatId) sent = await this.sender.sendCard(run.chatId, card);
      if (!sent.ok) this.log.warn("回答分段卡片发送失败", { sessionId: run.sessionId, index: i + 2, error: sent.error });
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  async stop(sessionId) {
    const run = this.runs.get(sessionId);
    if (run) {
      run.canStop = false;
      run.status = "stopped";
      this.schedule(run, true);
    }
    await this.bridge.cancel(sessionId);
  }
}

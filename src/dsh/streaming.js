/**
 * Typewriter controller for one run card.
 *
 * A card is a terminal surface for one answer: long answers are NOT rolled over
 * to a second card here. The card is byte-budgeted (see `runCard`) and the full
 * text is delivered as part cards by `RunCards.finish()`, so a rollover would
 * duplicate delivery. The old `maxChars`/`onRollover` path was unreachable
 * (the streamed text is already clamped to the card budget) and removed.
 *
 * Mirrors the throttling strategy of the fry-cards card engine: a fixed base
 * interval for small payloads, raised adaptively as the streamed element grows,
 * because one giant element update asks the Feishu client to re-render a lot.
 * At most one request is in flight; a newer text always wins over an older one.
 */

const LARGE_BYTES = 16 * 1024;
const HUGE_BYTES = 40 * 1024;
const LARGE_MS = 500;
const HUGE_MS = 800;

/** int32 ceiling for a card sequence; the counter itself lives in cardkit. */
export const MAX_SEQUENCE = 2_147_483_647;

function bytesOf(text) {
  return Buffer.byteLength(String(text ?? ""), "utf8");
}

export class CardStream {
  /**
   * @param options.cardkit - card entity client (`createCardKit`).
   * @param options.log - bridge logger.
   * @param options.cardId - card entity id.
   * @param options.elementId - element that receives the typewriter content.
   * @param options.baseThrottleMs - interval used while the payload is small.
   * @param options.onSequence - called after each accepted write with the
   *   card id and the sequence just consumed, so the caller can persist the
   *   counter and survive a restart.
   */
  constructor({
    cardkit,
    log,
    cardId,
    elementId,
    baseThrottleMs = 300,
    onSequence,
  }) {
    this.cardkit = cardkit;
    this.log = log;
    this.cardId = cardId;
    this.elementId = elementId;
    this.baseThrottleMs = Math.max(100, Number(baseThrottleMs) || 300);
    this.onSequence = onSequence;
    this.content = "";
    this.okCount = 0;
    this.failed = false;
    this.closed = false;
    this.timer = undefined;
    this.inflight = false;
    this.dirty = false;
  }

  /** Interval for the current payload size, never below the configured base. */
  delayFor(text) {
    const bytes = bytesOf(text);
    if (bytes > HUGE_BYTES) return Math.max(this.baseThrottleMs, HUGE_MS);
    if (bytes > LARGE_BYTES) return Math.max(this.baseThrottleMs, LARGE_MS);
    return this.baseThrottleMs;
  }

  /** Hand the newest full text to the stream; extra calls inside one window coalesce. */
  push(text) {
    if (this.closed || this.failed) return;
    this.content = String(text ?? "");
    if (this.timer) {
      this.dirty = true;
      return;
    }
    if (this.inflight) {
      this.dirty = true;
      return;
    }
    this.schedule(this.delayFor(this.content));
  }

  schedule(delay) {
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, delay);
    this.timer.unref?.();
  }

  async flush() {
    if (this.closed || this.failed || !this.cardId) return;
    this.inflight = true;
    this.dirty = false;
    try {
      const result = await this.cardkit.updateElement(this.cardId, this.elementId, this.content || "...");
      if (result.ok) {
        this.okCount += 1;
        this.onSequence?.(this.cardId, this.cardkit.last?.(this.cardId));
      } else this.markFailed(result.error);
    } catch (error) {
      this.markFailed(error instanceof Error ? error.message : String(error));
    } finally {
      this.inflight = false;
      if (this.dirty && !this.closed && !this.failed) this.schedule(this.delayFor(this.content));
    }
  }

  markFailed(error) {
    this.failed = true;
    this.log?.warn?.("卡片流式更新失败，回退为整卡更新", { cardId: this.cardId, error });
  }

  /** Stop the timer, push the final text, then leave streaming mode. */
  async close(summary) {
    if (this.closed) return { ok: true };
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.failed && this.cardId) {
      try {
        if (this.content) {
          await this.cardkit.updateElement(this.cardId, this.elementId, this.content);
          this.onSequence?.(this.cardId, this.cardkit.last?.(this.cardId));
        }
      } catch {
        /* the close below still fixes the preview */
      }
    }
    if (!this.cardId) return { ok: false, error: "missing cardId" };
    return this.cardkit.closeStreaming(this.cardId, summary);
  }

  /** Wait for an in-flight request (used before the terminal patch). */
  async drain() {
    while (this.inflight) await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export { bytesOf };

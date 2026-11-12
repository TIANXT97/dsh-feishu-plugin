/** CardKit card entities: create a streaming card, push partial updates, close it. */
import { describeLarkError } from "./sender.js";

/** Feishu rejects any sequence outside int32. */
export const MAX_SEQUENCE = 2_147_483_647;

function ok(res) {
  return !res?.code || res.code === 0;
}

function fail(error) {
  return { ok: false, error: describeLarkError(error) };
}

/**
 * Wrap the CardKit subset the bridge needs.
 *
 * Feishu compares `sequence` per card and rejects anything that does not
 * advance (code 300317), so this client is the single owner of one counter
 * per card: callers no longer pass sequence numbers, and whole-card updates
 * share the exact counter with element-level streaming writes.
 *
 * @param client - Lark SDK client.
 * @param log - bridge logger.
 */
export function createCardKit(client, log) {
  /** cardId -> last sequence this process issued for the card. */
  const sequences = new Map();

  /** Issue the next sequence for a card. */
  function take(cardId) {
    const next = (sequences.get(cardId) ?? 0) + 1;
    if (next > MAX_SEQUENCE) throw new Error(`sequence 用尽: ${cardId}`);
    sequences.set(cardId, next);
    return next;
  }

  /**
   * Seed the counter for a card created by a previous process (restart
   * recovery). Takes the larger of the saved and the local value, so a stale
   * snapshot can never move the counter backwards.
   */
  function adopt(cardId, last) {
    const value = Number(last);
    if (!Number.isInteger(value) || value <= 0) return false;
    if (value > (sequences.get(cardId) ?? 0)) sequences.set(cardId, value);
    return true;
  }

  return {
    /** Last sequence issued for a card (used to persist the counter). */
    last(cardId) {
      return sequences.get(cardId);
    },
    adopt,

    /** Create a card entity from card JSON 2.0 and return its id. */
    async createCard(card) {
      try {
        const res = await client.cardkit.v1.card.create({
          data: { type: "card_json", data: JSON.stringify(card) },
        });
        if (!ok(res)) return { ok: false, error: `code=${res.code} msg=${res.msg ?? ""}` };
        const cardId = res?.data?.card_id;
        return cardId ? { ok: true, cardId } : { ok: false, error: "missing card_id" };
      } catch (error) {
        return fail(error);
      }
    },

    /** Send a message that renders an already-created card entity. */
    async sendByReference({ chatId, replyToMessageId, cardId, replyInThread = false }) {
      if (!cardId) return { ok: false, error: "missing cardId" };
      const content = JSON.stringify({ type: "card", data: { card_id: cardId } });
      try {
        const res = replyToMessageId
          ? await client.im.message.reply({
              path: { message_id: replyToMessageId },
              data: {
                msg_type: "interactive",
                content,
                ...(replyInThread ? { reply_in_thread: true } : {}),
              },
            })
          : await client.im.message.create({
              params: { receive_id_type: "chat_id" },
              data: { receive_id: chatId, msg_type: "interactive", content },
            });
        if (!ok(res)) return { ok: false, error: `code=${res.code} msg=${res.msg ?? ""}` };
        const messageId = res?.data?.message_id;
        return messageId
          ? {
              ok: true,
              messageId,
              cardId: res.data.card_id || cardId,
              ...(res.data.thread_id ? { threadId: res.data.thread_id } : {}),
              ...(res.data.root_id ? { rootId: res.data.root_id } : {}),
            }
          : { ok: false, error: "missing message_id" };
      } catch (error) {
        return fail(error);
      }
    },

    /** Replace one element's content (the typewriter path). */
    async updateElement(cardId, elementId, content) {
      if (!cardId) return { ok: false, error: "missing cardId" };
      const sequence = take(cardId);
      try {
        const res = await client.cardkit.v1.cardElement.content({
          path: { card_id: cardId, element_id: elementId },
          data: {
            content,
            sequence,
            uuid: `e_${cardId}_${elementId}_${sequence}`,
          },
        });
        if (!ok(res)) return { ok: false, error: `code=${res.code} msg=${res.msg ?? ""}` };
        return { ok: true };
      } catch (error) {
        return fail(error);
      }
    },

    /**
     * Partial-update several elements in one request.
     *
     * @param updates - `[{ elementId, partial }]`; `partial` is merged into the element.
     */
    async patchElements(cardId, updates) {
      if (!cardId || updates.length === 0) return { ok: false, error: "nothing to patch" };
      const sequence = take(cardId);
      try {
        const res = await client.cardkit.v1.card.batchUpdate({
          path: { card_id: cardId },
          data: {
            actions: updates.map(({ elementId, partial }) => ({
              action: "partial_update_element",
              params: { element_id: elementId, partial_element: partial },
            })),
            sequence,
            uuid: `b_${cardId}_${sequence}`,
          },
        });
        if (!ok(res)) return { ok: false, error: `code=${res.code} msg=${res.msg ?? ""}` };
        return { ok: true };
      } catch (error) {
        return fail(error);
      }
    },

    /** Replace the whole card JSON of an existing entity (chrome updates). */
    async updateCard(cardId, card) {
      if (!cardId) return { ok: false, error: "missing cardId" };
      const sequence = take(cardId);
      try {
        const res = await client.cardkit.v1.card.update({
          path: { card_id: cardId },
          data: {
            card: { type: "card_json", data: JSON.stringify(card) },
            sequence,
            uuid: `u_${cardId}_${sequence}`,
          },
        });
        if (!ok(res)) return { ok: false, error: `code=${res.code} msg=${res.msg ?? ""}` };
        return { ok: true };
      } catch (error) {
        return fail(error);
      }
    },

    /** Leave streaming mode and refresh the chat-list preview. */
    async closeStreaming(cardId, summary) {
      if (!cardId) return { ok: false, error: "missing cardId" };
      const sequence = take(cardId);
      const config = { streaming_mode: false };
      if (summary !== undefined) config.summary = { content: summary };
      try {
        const res = await client.cardkit.v1.card.settings({
          path: { card_id: cardId },
          data: {
            settings: JSON.stringify({ config }),
            sequence,
            uuid: `s_${cardId}_${sequence}`,
          },
        });
        if (!ok(res)) return { ok: false, error: `code=${res.code} msg=${res.msg ?? ""}` };
        return { ok: true };
      } catch (error) {
        return fail(error);
      }
    },

    /** Read the current card JSON of a message, so a restart keeps partial output. */
    async cardContentOf(messageId) {
      if (!messageId) return undefined;
      try {
        const res = await client.im.message.get({
          path: { message_id: messageId },
          params: { card_msg_content_type: "user_card_content" },
        });
        if (!ok(res)) return undefined;
        const content = res?.data?.items?.[0]?.body?.content;
        if (typeof content !== "string" || !content) return undefined;
        return JSON.parse(content);
      } catch (error) {
        log?.debug?.("读取卡片内容失败", { messageId, error: describeLarkError(error) });
        return undefined;
      }
    },

    /** Resolve the card entity behind a message, for messages we did not create. */
    async cardIdOfMessage(messageId) {
      try {
        const res = await client.cardkit.v1.card.idConvert({ data: { message_id: messageId } });
        if (!ok(res)) return undefined;
        return res?.data?.card_id || undefined;
      } catch (error) {
        log?.debug?.("读取卡片 id 失败", { messageId, error: describeLarkError(error) });
        return undefined;
      }
    },
  };
}

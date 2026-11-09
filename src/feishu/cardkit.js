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
 * Every mutating call takes an explicit `sequence`: Feishu compares it per card
 * and rejects anything that does not advance, so the caller owns the counter.
 *
 * @param client - Lark SDK client.
 * @param log - bridge logger.
 */
export function createCardKit(client, log) {
  return {
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
    async updateElement(cardId, elementId, content, sequence) {
      if (!cardId) return { ok: false, error: "missing cardId" };
      try {
        const res = await client.cardkit.v1.cardElement.content({
          path: { card_id: cardId, element_id: elementId },
          data: {
            content,
            sequence: Math.min(sequence, MAX_SEQUENCE),
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
    async patchElements(cardId, updates, sequence) {
      if (!cardId || updates.length === 0) return { ok: false, error: "nothing to patch" };
      try {
        const res = await client.cardkit.v1.card.batchUpdate({
          path: { card_id: cardId },
          data: {
            actions: updates.map(({ elementId, partial }) => ({
              action: "partial_update_element",
              params: { element_id: elementId, partial_element: partial },
            })),
            sequence: Math.min(sequence, MAX_SEQUENCE),
            uuid: `b_${cardId}_${sequence}`,
          },
        });
        if (!ok(res)) return { ok: false, error: `code=${res.code} msg=${res.msg ?? ""}` };
        return { ok: true };
      } catch (error) {
        return fail(error);
      }
    },

    /** Leave streaming mode and refresh the chat-list preview. */
    async closeStreaming(cardId, sequence, summary) {
      if (!cardId) return { ok: false, error: "missing cardId" };
      const config = { streaming_mode: false };
      if (summary !== undefined) config.summary = { content: summary };
      try {
        const res = await client.cardkit.v1.card.settings({
          path: { card_id: cardId },
          data: {
            settings: JSON.stringify({ config }),
            sequence: Math.min(sequence, MAX_SEQUENCE),
            uuid: `s_${cardId}_${sequence}`,
          },
        });
        if (!ok(res)) return { ok: false, error: `code=${res.code} msg=${res.msg ?? ""}` };
        return { ok: true };
      } catch (error) {
        return fail(error);
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

// Refusal content of one Responses stream. The model's refusal arrives as
// `response.refusal.delta` / `response.refusal.done` and as a
// `{type:'refusal', refusal}` content part of the message item
// (output_item.done and the terminal output bundle). Parts are keyed by item
// id + content index so the streamed, item-done and terminal copies of one
// part fold into one text; a full (done / final-part) text replaces the
// accumulated deltas. Shared by the WS and HTTP/SSE collectors.
export function createRefusals() {
  const parts = new Map();
  const keyOf = (itemId, contentIndex) => `${itemId || ''}:${Number.isInteger(contentIndex) ? contentIndex : 0}`;

  return {
    /** response.refusal.delta */
    delta(event) {
      if (typeof event?.delta !== 'string') return;
      const key = keyOf(event.item_id, event.content_index);
      parts.set(key, (parts.get(key) || '') + event.delta);
    },
    /** response.refusal.done */
    done(event) {
      if (typeof event?.refusal !== 'string') return;
      parts.set(keyOf(event.item_id, event.content_index), event.refusal);
    },
    /** A message item's refusal parts. Returns whether it carried any. */
    absorbMessage(item) {
      if (item?.type !== 'message' || !Array.isArray(item.content)) return false;
      let found = false;
      item.content.forEach((part, index) => {
        if (part?.type !== 'refusal' || typeof part.refusal !== 'string') return;
        found = true;
        // An id-less item cannot be matched to its streamed copy; the
        // streamed text already stands for it.
        if (!item.id && parts.size > 0) return;
        parts.set(keyOf(item.id, index), part.refusal);
      });
      return found;
    },
    get seen() {
      return parts.size > 0;
    },
    get text() {
      return [...parts.values()].filter(Boolean).join('\n');
    },
  };
}

/** The typed stop reason of a refused turn (read by the agent loop). */
export const REFUSAL_STOP_REASON = 'refusal';

/** Result fields for a refused turn — the shared result shape:
 *    stopReason: REFUSAL_STOP_REASON
 *    refusal:    the refusal text (joined parts; may be '')
 *    content:    the output_text, or the refusal text when there was none
 *  so a refusal never reads as an empty successful answer. Empty object when
 *  the response carried no refusal. */
export function refusalResultFields(refusals, content) {
  if (!refusals.seen) return {};
  const refusal = refusals.text;
  return { content: content || refusal, refusal, stopReason: REFUSAL_STOP_REASON };
}

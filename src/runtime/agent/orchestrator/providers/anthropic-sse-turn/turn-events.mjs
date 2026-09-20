/**
 * anthropic-sse-turn/turn-events.mjs — how each Anthropic SSE event folds
 * into the turn record and the ordered block store. One handler module per
 * event family (see turn-events/*.mjs); this wires them over the shared
 * turn / blocks / state / leak-guard context.
 */
import { createContentBlockStart } from './turn-events/content-block-start.mjs';
import { createContentBlockDelta } from './turn-events/content-block-delta.mjs';
import { createContentBlockStop } from './turn-events/content-block-stop.mjs';
import { createMessageEvents } from './turn-events/message-events.mjs';

export function createTurnEvents({ turn, blocks, state, leak, relayText, progress, onToolCall }) {
  const { onMessageStart, onMessageDelta, onMessageStop } = createMessageEvents({ turn, blocks, state });
  return {
    onMessageStart,
    onContentBlockStart: createContentBlockStart({ turn, blocks, state, progress }),
    onContentBlockDelta: createContentBlockDelta({ turn, blocks, state, leak, relayText, progress }),
    onContentBlockStop: createContentBlockStop({ turn, blocks, state, leak, progress, onToolCall }),
    onMessageDelta,
    onMessageStop,
  };
}

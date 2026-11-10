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

export function createTurnEvents({
  turn,
  blocks,
  state,
  leak,
  relayText,
  progress,
  onToolCall,
  relayProgressUpdates,
  labels,
  onStreamItemStart,
}) {
  const { onMessageStart, onMessageDelta, onMessageStop } = createMessageEvents({ turn, blocks, state });
  const onContentBlockDelta = createContentBlockDelta({
    turn,
    blocks,
    state,
    leak,
    relayText,
    progress,
    relayProgressUpdates,
  });
  return {
    onMessageStart,
    onContentBlockStart: createContentBlockStart({
      turn,
      blocks,
      state,
      progress,
      seedText: onContentBlockDelta.seedText,
      onStreamItemStart,
    }),
    onContentBlockDelta,
    onContentBlockStop: createContentBlockStop({ turn, blocks, state, leak, progress, onToolCall, labels }),
    onMessageDelta,
    onMessageStop,
  };
}

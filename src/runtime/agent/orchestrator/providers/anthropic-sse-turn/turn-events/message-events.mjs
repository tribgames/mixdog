/**
 * turn-events/message-events.mjs — message-level SSE events: message_start
 * (model + usage), message_delta (stop reason/details, usage, and whether the
 * stream loop must stop reading) and message_stop.
 */
import { updateTurnUsage } from '../turn-state.mjs';

function stopDetailsFrom(delta) {
  const details = delta.stop_details;
  const category = delta.category != null ? { category: delta.category } : {};
  if (details && typeof details === 'object' && !Array.isArray(details)) return { ...details, ...category };
  return { ...(details != null ? { value: details } : {}), ...category };
}

export function createMessageEvents({ turn, blocks, state }) {
  const onMessageStart = (message) => {
    if (message.model) turn.model = message.model;
    if (message.usage) updateTurnUsage(turn.usage, message.usage);
  };

  // Returns true when the stream loop must stop reading.
  const onMessageDelta = (event) => {
    if (event.delta?.stop_reason) {
      turn.stopReason = event.delta.stop_reason;
    }
    if (event.delta && (event.delta.stop_details != null || event.delta.category != null)) {
      turn.stopDetails = stopDetailsFrom(event.delta);
    }
    if (event.usage) updateTurnUsage(turn.usage, event.usage);
    // A terminal stop_reason while ANY tool input is still streaming ends the
    // turn truncated, immediately: the model declared it stopped sampling, so
    // the pending tool arguments can never complete. Do not wait for
    // message_stop/EOF (which may never arrive, or would arrive as ping-only
    // wedge) — enter the canonical truncation failure now, with zero dispatch
    // for the incomplete call.
    if (event.delta?.stop_reason && blocks.toolInputInFlight()) {
      turn.sawTerminalFrameWithPendingInput = true;
      return true;
    }
    // Early terminal on a tool_use stop_reason is only valid when NO tool
    // input is still streaming — client (pendingToolInputs) or
    // Anthropic-native server tool (pendingNativeToolInputs). An in-flight
    // input means the arguments never completed, so the turn is truncated,
    // not finished (the guard after the loop owns it).
    if (turn.stopReason === 'tool_use' && turn.toolCalls.length > 0 && !blocks.toolInputInFlight()) {
      if (state) state.sawCompleted = true;
      return true;
    }
    return false;
  };

  const onMessageStop = () => {
    // A terminal frame does NOT finish a turn whose tool input is still
    // incomplete. `message_stop` while a tool_use/server_tool_use input_json
    // is mid-flight means the model's arguments were cut off: nothing was
    // dispatched for that call and no partial success may be promoted. Leave
    // sawCompleted false and fall through to the truncated-stream guard,
    // which throws the canonical TruncatedStreamError (pendingToolUse:true).
    if (blocks.toolInputInFlight()) {
      turn.sawTerminalFrameWithPendingInput = true;
    } else if (state) {
      state.sawCompleted = true;
    }
  };

  return { onMessageStart, onMessageDelta, onMessageStop };
}

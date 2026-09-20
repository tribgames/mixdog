import { performance } from 'node:perf_hooks';

// The per-event fold: text/reasoning/tool deltas and item lifecycle feed the
// response state, the text relay and the semantic watchdog; terminal frames
// route to the terminal-frame handlers.
export function createWsEventSwitch({ response, textRelay, watchdogs, midState, progress, terminal, streamingStart }) {
  let firstDeltaEmitted = false;

  function onResponseCreated(event) {
    midState.sawResponseCreated = true;
    if (midState.sendSpan && midState.sendStartedAt != null && midState.sendSpanAttemptResponseCreated !== true) {
      midState.sendSpanAttemptResponseCreated = true;
      midState.sendSpan.preResponseCreatedMs += performance.now() - midState.sendStartedAt;
    }
    response.noteCreated(event.response);
    // Server ack (first event). resetIdle() at the top of the message handler
    // already cleared the pre-stream watchdog and armed the single idle timer.
    // response.created is a MEANINGFUL frame, so it also satisfies the
    // first-meaningful watchdog (keepalive/metadata frames never reach here,
    // so they never clear it). Semantic idle is not armed until actual model
    // progress; transport-only reasoning heartbeats are bounded by the outer
    // first-visible ceiling instead.
    watchdogs.clearFirstMeaningful();
    progress('semantic');
  }

  function onOutputTextDelta(delta) {
    if (delta && !firstDeltaEmitted) {
      firstDeltaEmitted = true;
      if (process.env.MIXDOG_DEBUG_AGENT) {
        process.stderr.write(`[agent-trace] ws-first-delta sinceStreaming=${Date.now() - streamingStart}ms\n`);
      }
    }
    // Live text relay (gateway): forward the raw text chunk so the client
    // renders first tokens before the final replay. Tool-call/argument deltas
    // intentionally stay off this path. Invariant: once a non-empty chunk has
    // been relayed live it cannot be withdrawn, so a later mid-stream/truncated
    // failure is NOT retried (retry would concatenate a second attempt onto
    // rendered text).
    const relayed = textRelay.relay(delta || '');
    if (relayed.text || relayed.tool) watchdogs.bumpSemantic();
  }

  // Only non-empty reasoning text is model progress. Empty deltas remain
  // transport activity via resetIdle(). The text is suppressed; the progress
  // notification does not expose output and must not veto replay.
  function onReasoningDelta(kind, delta) {
    response.countReasoningDelta(kind);
    if (!delta) return;
    progress('reasoning');
    watchdogs.bumpSemantic();
  }

  function onToolInputDelta(event) {
    response.noteToolInputDelta(event.item_id, event.delta);
    progress('tool');
    watchdogs.bumpSemantic();
  }

  return function onEvent(event) {
    switch (event.type) {
      case 'response.created':
        onResponseCreated(event);
        break;
      case 'response.output_text.delta':
        onOutputTextDelta(event.delta);
        break;
      case 'response.reasoning_text.delta':
        onReasoningDelta('text', event.delta);
        break;
      case 'response.reasoning_summary_text.delta':
        onReasoningDelta('summary', event.delta);
        break;
      case 'response.output_item.added':
        response.noteItemAdded(event.item);
        // Item lifecycle is genuine progress: reset the semantic-idle timer so
        // long server-side tool latency after item-added (before any arg
        // delta) is not mistaken for a silent stall.
        watchdogs.resetSemantic();
        progress(response.toolInFlight ? 'tool' : 'semantic');
        break;
      case 'response.function_call_arguments.delta':
      case 'response.custom_tool_call_input.delta':
        onToolInputDelta(event);
        break;
      case 'response.function_call_arguments.done':
        response.completeFunctionCallArguments(event);
        progress('tool');
        watchdogs.bumpSemantic();
        break;
      case 'response.output_item.done': {
        const kind = response.completeOutputItem(event.item);
        // Item-done is genuine lifecycle progress — reset semantic idle so
        // latency before the next item/args does not stall.
        watchdogs.resetSemantic();
        progress(kind);
        break;
      }
      case 'response.completed':
        terminal.onResponseCompleted(event);
        break;
      case 'response.done':
        terminal.onResponseDone(event);
        break;
      case 'response.incomplete':
        terminal.onResponseIncomplete(event);
        break;
      case 'response.failed':
        terminal.onResponseFailed(event);
        break;
      case 'error':
        terminal.onErrorFrame(event);
        break;
      default:
        // Any other reasoning-delta variant (e.g. `response.reasoning.<sub>
        // .delta`) is counted and suppressed, never reaching the user content
        // buffer. response.in_progress and other trace-only events are
        // transport activity only; resetIdle() already kept the socket alive.
        if (event.type.startsWith('response.reasoning') && event.type.endsWith('.delta')) {
          onReasoningDelta('other', event.delta);
        }
        break;
    }
  };
}

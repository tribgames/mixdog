import {
  endTurnFromEvent as _endTurnFromEvent,
  incompleteReasonFromEvent as _incompleteReasonFromEvent,
  isMaxOutputIncompleteReason as _isMaxOutputIncompleteReason,
} from '../lib/responses-terminal-fields.mjs';
import {
  errorFrameError,
  responseDoneStatusError,
  responseFailedError,
  responseIncompleteError,
} from '../openai-ws-terminal.mjs';

// Terminal frames: response.completed / response.done / response.incomplete /
// response.failed / error. Each settles the stream exactly once through
// `finish`, after recording the outcome.
export function createTerminalFrameHandlers({ response, textRelay, midState, errLabel, progress, outcome, finish }) {
  const completeTurn = () => {
    midState.sawCompleted = true;
    outcome.done = true;
    finish();
  };
  const failWith = (error, { markDone = false } = {}) => {
    outcome.terminalError = error;
    if (markDone) outcome.done = true;
    finish();
  };

  // Most incomplete reasons are real failures. max_output_tokens maps cleanly
  // to Anthropic's stop_reason=max_tokens; treating it as an error makes
  // Claude retry the same over-budget turn — unless a tool call's input was
  // still streaming: its arguments were truncated, so the cutoff is a
  // stalled pending-tool turn (same guard as HTTP/SSE), never a clean length
  // completion that would surface the partial call as successful.
  function settleIncomplete(event, label, options) {
    const usage = response.noteTerminal(event.response);
    const reasonStr = _incompleteReasonFromEvent(event);
    if (_isMaxOutputIncompleteReason(reasonStr)) {
      response.holdIncompleteBundleItems(event.response);
      if (response.pendingToolUse) {
        const error = new Error(`${label} (max_output_tokens) with tool call in flight`);
        try {
          textRelay.flush();
        } catch {
          /* best-effort */
        }
        Object.assign(error, response.partialState());
        error.streamStalled = true;
        error.pendingToolUse = true;
        error.incompleteReason = reasonStr;
        if (usage) error.partialUsage = usage;
        failWith(error, options);
        return;
      }
      response.markMaxOutputIncomplete(reasonStr);
      completeTurn();
      return;
    }
    const error = responseIncompleteError(event, reasonStr, label);
    // The incomplete response was still billed; its reported usage is
    // recorded by the provider-boundary accounting.
    if (usage) error.partialUsage = usage;
    failWith(error, options);
  }

  // A failed frame's reported usage was still billed: carry it (and its model)
  // on the error for the provider-boundary accounting.
  function withFailedUsage(error, event) {
    const usage = response.noteTerminal(event.response);
    if (usage) {
      error.partialUsage = usage;
      error.partialModel = response.partialState().partialModel;
    }
    return error;
  }

  function onResponseCompleted(event) {
    const reported = response.noteCompleted(event.response, textRelay.relayFinal);
    if (!reported) progress('semantic');
    // Salvage validation. Any deferred call still missing id/name would
    // propagate to the next turn as a function_call_output the server can't
    // anchor. Fail the stream now so the caller sees a deterministic error
    // instead of a cryptic mismatch one turn later.
    const unresolved = response.unresolvedDeferredCall();
    if (unresolved) {
      failWith(
        new Error(
          `${errLabel} function_call salvage failed: missing call_id/name for item_id=${unresolved._pendingItemId || '?'}`
        )
      );
      return;
    }
    // Wire-level completion signal (optional). Captured after salvage
    // validation so a failed stream never reports a turn-completion hint.
    response.setEndTurn(_endTurnFromEvent(event));
    completeTurn();
  }

  // response.done is the terminal frame for some openai-oauth streams that
  // never emit a separate response.completed. Route through the same
  // completed/failed/incomplete normalization based on event.response.status
  // so a server-side abort (incomplete / failed) does not slip through as
  // success.
  function onResponseDone(event) {
    const status = event.response?.status || '';
    if (status === 'failed') {
      midState.responseFailedPayload = event;
      failWith(
        withFailedUsage(
          responseFailedError(event, {
            label: `${errLabel} response.done failed`,
            fallbackMessage: 'response.done failed',
          }),
          event
        ),
        { markDone: true }
      );
      return;
    }
    if (status === 'incomplete') {
      settleIncomplete(event, `${errLabel} response.done incomplete`, { markDone: true });
      return;
    }
    if (status && status !== 'completed') {
      failWith(responseDoneStatusError(status, `${errLabel} response.done unexpected status`), { markDone: true });
      return;
    }
    // Success-shaped response.done (status '' or 'completed') is the same
    // terminal as response.completed: usage, end_turn, and its output bundle
    // reconciled through the same deduplicated collectors (calls that appear
    // only in the bundle are created; unresolvable deferred calls fail).
    onResponseCompleted(event);
  }

  function onResponseIncomplete(event) {
    settleIncomplete(event, `${errLabel} response.incomplete`);
  }

  function onResponseFailed(event) {
    midState.responseFailedPayload = event;
    failWith(
      withFailedUsage(
        responseFailedError(event, {
          label: `${errLabel} response.failed`,
          fallbackMessage: 'response.failed',
          providerErrorCode: true,
        }),
        event
      )
    );
  }

  function onErrorFrame(event) {
    midState.responseFailedPayload = event;
    failWith(errorFrameError(event, `${errLabel} error`));
  }

  return { onResponseCompleted, onResponseDone, onResponseIncomplete, onResponseFailed, onErrorFrame };
}

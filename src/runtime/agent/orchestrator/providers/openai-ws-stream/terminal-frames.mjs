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

export { _endTurnFromEvent };

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
  // Claude retry the same over-budget turn.
  function settleIncomplete(event, label, options) {
    const reasonStr = _incompleteReasonFromEvent(event);
    if (_isMaxOutputIncompleteReason(reasonStr)) {
      response.markMaxOutputIncomplete(reasonStr);
      completeTurn();
      return;
    }
    failWith(responseIncompleteError(event, reasonStr, label), options);
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
        responseFailedError(event, {
          label: `${errLabel} response.done failed`,
          fallbackMessage: 'response.done failed',
        }),
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
    // Success-shaped response.done (status '' or 'completed') carries the
    // same optional end_turn.
    response.setEndTurn(_endTurnFromEvent(event));
    completeTurn();
  }

  function onResponseIncomplete(event) {
    settleIncomplete(event, `${errLabel} response.incomplete`);
  }

  function onResponseFailed(event) {
    midState.responseFailedPayload = event;
    failWith(
      responseFailedError(event, {
        label: `${errLabel} response.failed`,
        fallbackMessage: 'response.failed',
        providerErrorCode: true,
      })
    );
  }

  function onErrorFrame(event) {
    midState.responseFailedPayload = event;
    failWith(errorFrameError(event, `${errLabel} error`));
  }

  return { onResponseCompleted, onResponseDone, onResponseIncomplete, onResponseFailed, onErrorFrame };
}

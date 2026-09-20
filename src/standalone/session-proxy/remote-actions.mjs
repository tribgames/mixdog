// Session actions that cross the daemon: read/configure dispatch, prompt
// submission, abort and tool approval. Every call is fenced by the binding it
// observed, so a session-id move mid-flight never applies a stale result.
import { randomUUID } from 'node:crypto';
import { SESSION_CONFIGURE_ACTION_SET, SESSION_READ_ACTION_SET } from '../session-protocol.mjs';

export function createRemoteActions({
  binding,
  projection,
  openParams,
  sendCall,
  applyResult,
  afterPendingTransition,
  log,
}) {
  const assertLive = () => {
    if (binding.disposed) throw new Error('This session view is disposed.');
  };

  function remoteCall(method, args, callOptions = {}) {
    if (binding.disposed) return Promise.reject(new Error('This session view is disposed.'));
    let route = null;
    if (SESSION_READ_ACTION_SET.has(method)) route = 'session.read';
    else if (SESSION_CONFIGURE_ACTION_SET.has(method)) route = 'session.configure';
    if (!route) return Promise.reject(new TypeError(`session action ${method} is unavailable`));
    const stableCallId =
      typeof callOptions.callId === 'string' && callOptions.callId.trim() ? callOptions.callId.trim() : randomUUID();
    const dispatch = async () => {
      assertLive();
      const targetSessionId = binding.sessionId;
      const baseRevision = projection.baseRevisionFor(binding.attachment, targetSessionId);
      const result = await sendCall(
        route,
        { sessionId: targetSessionId, action: method, args, open: openParams, baseRevision },
        stableCallId
      );
      if (!binding.disposed && binding.sessionId === targetSessionId) await applyResult(result, method);
      return result?.value ?? null;
    };
    return route === 'session.configure' ? afterPendingTransition().then(dispatch) : dispatch();
  }

  let submitSeq = 0;
  async function submitAsync(prompt, submitOptions = {}) {
    assertLive();
    let submissionId = String(submitOptions?.id || '').trim();
    if (!submissionId) {
      submitSeq += 1;
      submissionId = `session-submit-${process.pid}-${Date.now()}-${submitSeq}`;
    }
    await afterPendingTransition();
    assertLive();
    const targetSessionId = binding.sessionId;
    const baseRevision = projection.baseRevisionFor(binding.attachment, targetSessionId);
    const result = await sendCall(
      'session.submit',
      {
        sessionId: targetSessionId,
        prompt,
        options: { ...(submitOptions || {}), id: submissionId },
        open: openParams,
        baseRevision,
      },
      `session-submit:${targetSessionId}:${submissionId}`
    );
    if (!binding.disposed && binding.sessionId === targetSessionId) await applyResult(result, 'submit');
    return result?.accepted === true;
  }

  async function abortAsync(abortOptions = {}) {
    if (binding.disposed) return { aborted: false };
    await afterPendingTransition();
    if (binding.disposed) return { aborted: false };
    const result = await sendCall(
      'session.abort',
      {
        sessionId: binding.sessionId,
        open: openParams,
        options: abortOptions,
        baseRevision: projection.baseRevisionFor(),
      },
      randomUUID()
    );
    return applyResult(result, 'abort');
  }

  return {
    remoteCall,
    submitAsync,
    submit(prompt, submitOptions) {
      if (binding.disposed) return false;
      void submitAsync(prompt, submitOptions).catch((error) => {
        log(`session submit failed: ${error?.message || error}`);
      });
      return true;
    },
    abortAsync,
    abort(abortOptions = {}) {
      void abortAsync(abortOptions).catch((error) => log(`session abort failed: ${error?.message || error}`));
      return true;
    },
    resolveToolApproval(id, decision) {
      void (async () => {
        if (binding.disposed) return;
        const result = await sendCall(
          'session.approve',
          {
            sessionId: binding.sessionId,
            approvalId: id,
            decision,
            open: openParams,
            baseRevision: projection.baseRevisionFor(),
          },
          randomUUID()
        );
        await applyResult(result, 'approval');
      })().catch((error) => log(`session approval failed: ${error?.message || error}`));
      return true;
    },
  };
}

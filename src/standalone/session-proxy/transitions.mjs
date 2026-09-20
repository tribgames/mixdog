/**
 * session-proxy/transitions.mjs — how a view moves between session ids:
 * applying a result that names another session, rebinding after create /
 * resume (unsubscribing the old id when this was its last local view), and
 * the transition chain that serializes those moves ahead of configure and
 * submit calls.
 */
import { randomUUID } from 'node:crypto';

export function createTransitions({ binding, projection, pool, sendCall, resync, openParams, log, getView }) {
  let transitionChain = Promise.resolve();

  function serializeTransition(task) {
    const run = transitionChain.then(task);
    transitionChain = run.then(
      () => {},
      () => {}
    );
    return run;
  }

  const afterPendingTransition = () => transitionChain;

  const assertLive = () => {
    if (binding.disposed) throw new Error('This session view is disposed.');
  };

  function moveView(previousSessionId, nextSessionId) {
    const view = getView();
    pool.addView(binding.attachment, nextSessionId, view);
    pool.removeView(binding.attachment, previousSessionId, view);
    binding.sessionId = nextSessionId;
  }

  async function applyResult(result, reason) {
    const nextSessionId = String(result?.sessionId || binding.sessionId);
    if (nextSessionId && nextSessionId !== binding.sessionId) moveView(binding.sessionId, nextSessionId);
    if (!projection.applyBody(result) && result?.revision !== undefined) {
      resync(`${reason} body gap`);
    }
    return result;
  }

  async function rebindTo(result, previousSessionId) {
    const nextSessionId = String(result?.sessionId || '');
    if (!nextSessionId) throw new Error('session route returned no sessionId');
    const lastLocalView = pool.viewCount(binding.attachment, previousSessionId) <= 1;
    moveView(previousSessionId, nextSessionId);
    if (!projection.applyBody(result) && result?.revision !== undefined) resync('session rebind body gap');
    if (previousSessionId && previousSessionId !== nextSessionId && lastLocalView) {
      try {
        await binding.attachment.client.unsubscribe({ sessionId: previousSessionId });
      } catch (error) {
        log(`session ${previousSessionId} unsubscribe failed: ${error?.message || error}`);
      }
    }
    return nextSessionId;
  }

  function createReservedSession() {
    return serializeTransition(async () => {
      assertLive();
      const previousSessionId = binding.sessionId;
      const result = await sendCall('session.create', openParams, `session-create:${process.pid}:${randomUUID()}`);
      return rebindTo(result, previousSessionId);
    });
  }

  async function resumeSession(targetSessionId, resumeOptions) {
    const target = String(targetSessionId || '');
    if (!target) return false;
    return serializeTransition(async () => {
      assertLive();
      if (target === binding.sessionId) {
        const result = await sendCall(
          'session.read',
          { sessionId: binding.sessionId, open: openParams, baseRevision: projection.baseRevisionFor() },
          randomUUID()
        );
        await applyResult(result, 'resume');
        return true;
      }
      const previousSessionId = binding.sessionId;
      const result = await sendCall(
        'session.subscribe',
        {
          sessionId: target,
          open: { ...openParams, resumeOptions: resumeOptions || undefined },
          baseRevision: null,
        },
        randomUUID()
      );
      await rebindTo(result, previousSessionId);
      return true;
    });
  }

  return { serializeTransition, afterPendingTransition, applyResult, createReservedSession, resumeSession };
}

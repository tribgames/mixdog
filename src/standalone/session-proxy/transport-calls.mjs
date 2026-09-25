/**
 * session-proxy/transport-calls.mjs — every daemon call the view issues goes
 * through sendCall: route → protocol-client method, result tagged with the
 * attachment that produced it, and transport loss (or an unknown client
 * token) handled by re-attaching, recovering the projection on the new
 * attachment and retrying with a short backoff.
 */
import { sleep as delay } from '../../runtime/shared/sleep.mjs';

const CALL_RECOVERY_BACKOFF_MS = Object.freeze([0, 150, 600]);

const ROUTE_METHODS = Object.freeze({
  'session.create': 'create',
  'session.read': 'read',
  'session.subscribe': 'subscribe',
  'session.submit': 'submit',
  'session.abort': 'abort',
  'session.approve': 'approve',
  'session.configure': 'configure',
  'project.list': 'projectList',
  'project.inspect': 'projectInspect',
  'project.add': 'projectAdd',
  'project.touch': 'projectTouch',
  'project.rename': 'projectRename',
  'project.remove': 'projectRemove',
  'project.ensureDirectory': 'projectEnsureDirectory',
});

const isRecoverable = (error) =>
  error?.daemonTransportError || /unknown client token/i.test(String(error?.message || ''));

export function createTransportCalls({ binding, projection, pool, openParams, cwd, log, getView }) {
  let recoveryPromise = null;

  // Re-subscribe on `nextAttachment` (a reservation that the daemon lost is
  // re-created) and take a fresh full snapshot; one recovery at a time.
  async function recover(nextAttachment) {
    if (binding.disposed) return;
    if (recoveryPromise) return recoveryPromise;
    recoveryPromise = (async () => {
      const view = getView();
      const previousAttachment = binding.attachment;
      if (previousAttachment !== nextAttachment) {
        pool.removeView(previousAttachment, binding.sessionId, view);
        binding.attachment = nextAttachment;
      }
      const recoveryAttachment = binding.attachment;
      pool.addView(recoveryAttachment, binding.sessionId, view);
      projection.resetRevisionOwner();
      let result;
      try {
        result = await recoveryAttachment.client.subscribe({
          sessionId: binding.sessionId,
          open: openParams,
          baseRevision: null,
        });
      } catch (error) {
        if (!projection.reservedOnly || !/session .* is not available/i.test(String(error?.message || error))) {
          throw error;
        }
        result = await recoveryAttachment.client.create(
          { ...openParams, sessionId: binding.sessionId },
          { callId: `session-recover-reservation:${binding.sessionId}` }
        );
      }
      if (binding.disposed || recoveryAttachment !== binding.attachment) return;
      projection.markResult(result, recoveryAttachment);
      if (!projection.applyBody(result, recoveryAttachment)) {
        const baseline = await recoveryAttachment.client.read({
          sessionId: binding.sessionId,
          open: openParams,
          baseRevision: null,
        });
        if (binding.disposed || recoveryAttachment !== binding.attachment) return;
        projection.markResult(baseline, recoveryAttachment);
        if (!projection.applyBody(baseline, recoveryAttachment)) {
          throw new Error(`session ${binding.sessionId} recovery returned no full snapshot`);
        }
      }
      log(`session ${binding.sessionId} projection recovered`);
    })();
    try {
      return await recoveryPromise;
    } finally {
      recoveryPromise = null;
    }
  }

  async function sendOnce(route, payload, callId) {
    const method = ROUTE_METHODS[route];
    if (!method) throw new TypeError(`session route ${route} is unavailable`);
    const sourceAttachment = binding.attachment;
    const result = await sourceAttachment.client[method](payload, { callId });
    projection.markResult(result, sourceAttachment);
    return result;
  }

  async function sendCall(route, payload, callId) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await sendOnce(route, payload, callId);
      } catch (error) {
        if (!isRecoverable(error) || binding.disposed || attempt >= CALL_RECOVERY_BACKOFF_MS.length) throw error;
        const waitMs = CALL_RECOVERY_BACKOFF_MS[attempt];
        if (waitMs > 0) await delay(waitMs);
        if (binding.disposed) throw error;
        pool.invalidate(binding.attachment);
        const next = await pool.ensure({ cwd, log });
        await recover(next);
        if (attempt > 0) {
          log(`session ${binding.sessionId} call ${route} re-attached (attempt ${attempt + 1})`);
        }
      }
    }
  }

  return { sendCall, recover };
}

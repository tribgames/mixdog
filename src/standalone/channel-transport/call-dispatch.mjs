/**
 * call-dispatch.mjs — one /call of the channel transport: the fair lanes
 * (ordinary vs. control/binding), the callId idempotency cache, and the
 * binding-aware run that moves the UI control pointer / durable pin around a
 * manual Remote ON/OFF or transcript rebind and rolls it back on failure.
 *
 * Shared transport state read/written here: clients, pointerToken,
 * remoteAcquired, stickyRemoteFrame, pinnedSessionId, closed.
 */
import { createFairCallScheduler } from '../fair-call-scheduler.mjs';
import { callSignature, callIdConflict, clientCallOwner } from '../rpc-call-identity.mjs';
import { isPidAlive } from '../../runtime/shared/pid-liveness.mjs';
import { positiveInt } from '../../runtime/shared/numbers.mjs';
import { ACTIVATE_TOOL, REBIND_TOOL, BINDING_TOOLS, remoteSessionIdFromBinding } from '../channel-binding.mjs';

const CALL_CACHE_TTL_MS = 60_000;

const configuredLaneLimit = (name) => positiveInt(process.env[name], Infinity);

export function createCallDispatch({
  state,
  handleCall,
  log,
  runExclusiveBinding,
  movePointer,
  writeRemoteStateTo,
  clearRemoteIntent,
  writeRemoteIntent,
  publishRemoteState,
}) {
  const { clients } = state;
  // Idempotency cache: callId -> { promise }. A retried /call with the SAME
  // callId awaits/returns the ORIGINAL run's result, so a transport-failure
  // retry never double-runs a non-idempotent tool (e.g. reply). Short TTL.
  const callCache = new Map();
  const CALL_QUEUE_MAX = Math.max(256, Number(process.env.MIXDOG_CHANNEL_CALL_QUEUE) || 256);
  const channelCalls = createFairCallScheduler({
    name: 'channel call',
    activeMax: configuredLaneLimit('MIXDOG_CHANNEL_ACTIVE_CALLS'),
    queueMax: CALL_QUEUE_MAX,
    minOwnerQueue: Math.max(8, Math.floor(CALL_QUEUE_MAX / 16)),
  });
  const channelControlCalls = createFairCallScheduler({
    name: 'channel control call',
    activeMax: configuredLaneLimit('MIXDOG_CHANNEL_CONTROL_RESERVE'),
    queueMax: Math.max(16, Math.min(64, CALL_QUEUE_MAX)),
    minOwnerQueue: 4,
  });

  // The binding-aware run of one call for client `c` (token `clientToken`).
  async function runCall(name, args, c, clientToken) {
    const activationCall = name === ACTIVATE_TOOL;
    const activating = activationCall && args.active === true;
    const deactivating = activationCall && args.active === false;
    const rebindCall = name === REBIND_TOOL;
    const bindingSessionId = remoteSessionIdFromBinding(name, args);
    // Auto/implicit activation is retired. A valid manual ON always carries
    // its target session and explicitly overrides the old one.
    if (activating && (args.claimIfVacant === true || !bindingSessionId)) {
      return {
        content: [{ type: 'text', text: 'channel bridge claim skipped: manual ON required' }],
        claimSkipped: true,
      };
    }
    const pinnedSessionMatch = Boolean(
      bindingSessionId && state.remoteAcquired && state.pinnedSessionId === bindingSessionId
    );
    if (deactivating && !pinnedSessionMatch) {
      return {
        content: [{ type: 'text', text: 'channel bridge release skipped: session is not pinned' }],
        releaseSkipped: true,
      };
    }
    if (rebindCall && !pinnedSessionMatch) {
      return {
        content: [{ type: 'text', text: 'transcript rebind skipped: session is not pinned' }],
        rebindSkipped: true,
      };
    }

    const previousPointerToken = state.pointerToken;
    const previousRemoteSessionId = c.remoteSessionId || null;
    const previousRemoteAcquired = state.remoteAcquired;
    const previousStickyRemoteFrame = state.stickyRemoteFrame;
    // A failed manual ON must leave ownership exactly as it was.
    const rollbackActivation = () => {
      if (!activating || state.pointerToken !== clientToken || c.remoteSessionId !== bindingSessionId) return;
      state.pointerToken = previousPointerToken && clients.has(previousPointerToken) ? previousPointerToken : null;
      c.remoteSessionId = previousRemoteSessionId;
      state.remoteAcquired = previousRemoteAcquired;
      state.stickyRemoteFrame = previousStickyRemoteFrame;
    };
    if (activating) {
      c.remoteSessionId = bindingSessionId;
      movePointer(clientToken, 'manual remote ON', { notifyDisplaced: false });
    }
    try {
      const result = await handleCall(name, args, {
        clientToken,
        leadPid: c?.leadPid ?? null,
        cwd: c?.cwd ?? null,
      });
      // A soft `{isError:true}` envelope is a FAILED call, not a result:
      // taking the success path here moved control ownership on a failed ON
      // and cleared the durable pin on a failed OFF while the runtime was
      // still bound.
      if (result?.isError === true) {
        rollbackActivation();
        log(`${name} failed (soft error); binding state unchanged for session=${bindingSessionId || '?'}`);
        publishRemoteState();
        return result;
      }
      if (activating && previousPointerToken && previousPointerToken !== clientToken) {
        const displaced = clients.get(previousPointerToken);
        if (displaced && isPidAlive(displaced.leadPid) && writeRemoteStateTo(displaced, 'superseded')) {
          log(`superseded -> displaced control client token=${previousPointerToken} lead=${displaced.leadPid}`);
        }
      }
      if (deactivating) {
        clearRemoteIntent('explicit Remote OFF', bindingSessionId);
        state.pointerToken = null;
        c.remoteSessionId = null;
        state.remoteAcquired = false;
        state.stickyRemoteFrame = null;
      }
      if (activating && state.pointerToken === clientToken && c.remoteSessionId === bindingSessionId) {
        state.remoteAcquired = true;
        writeRemoteIntent(args, bindingSessionId, c.cwd ?? null);
      }
      publishRemoteState();
      return result;
    } catch (err) {
      rollbackActivation();
      publishRemoteState();
      throw err;
    }
  }

  // Start the idempotency TTL only once the call SETTLES: an in-flight call
  // can outlive a fixed-from-dispatch TTL (e.g. a slow reply upload past 60s),
  // and expiring its entry mid-flight would let a transport retry replay-miss
  // and dispatch a second real side-effect.
  function rememberDispatch(cacheKey, dispatch, signature) {
    const record = { promise: dispatch, signature, timer: null };
    callCache.set(cacheKey, record);
    dispatch
      .then(
        () => {},
        () => {}
      )
      .then(() => {
        if (state.closed || callCache.get(cacheKey) !== record) return;
        record.timer = setTimeout(() => {
          if (callCache.get(cacheKey) === record) callCache.delete(cacheKey);
        }, CALL_CACHE_TTL_MS);
        record.timer.unref?.();
      });
  }

  /** Dispatch one /call body for a registered client; resolves to the result. */
  function dispatchCall(body, c, clientToken) {
    const name = String(body.name || '');
    const callId = body.callId ? String(body.callId) : null;
    const addressedSessionId =
      String(body.args?.sessionId || '').trim() || remoteSessionIdFromBinding(name, body.args || {});
    let ownerKey = `client:${clientToken}`;
    if (addressedSessionId) ownerKey = `session:${addressedSessionId}`;
    else if (c.leadPid) ownerKey = `pid:${c.leadPid}`;
    const cacheKey = callId ? `${clientCallOwner(c, clientToken)}\u0000${callId}` : null;
    const signature = callId ? callSignature(name, body.args) : null;
    const cached = cacheKey ? callCache.get(cacheKey) : null;
    if (cached) {
      // Replay of a retried call — dedup to the original run (exactly one
      // side-effect) instead of dispatching handleCall a second time.
      return signature && cached.signature === signature ? cached.promise : Promise.reject(callIdConflict(callId));
    }
    const run = () => runCall(name, body.args || {}, c, clientToken);
    const bindingCall = BINDING_TOOLS.has(name);
    const scheduler = bindingCall ? channelControlCalls : channelCalls;
    const dispatch = scheduler.enqueue(ownerKey, bindingCall ? () => runExclusiveBinding(run) : run);
    if (cacheKey) rememberDispatch(cacheKey, dispatch, signature);
    return dispatch;
  }

  function close(reason) {
    channelCalls.close(reason);
    channelControlCalls.close(reason);
    for (const record of callCache.values()) {
      if (record.timer) clearTimeout(record.timer);
    }
    callCache.clear();
  }

  return {
    dispatchCall,
    close,
    get active() {
      return channelCalls.active + channelControlCalls.active;
    },
    get queued() {
      return channelCalls.queued + channelControlCalls.queued;
    },
    get owners() {
      return channelCalls.snapshot().owners;
    },
  };
}

// Worker → parent IPC bridge. Extracted verbatim from channels/index.mjs
// (behavior-preserving). Groups the notify-to-parent path and the
// worker → parent → memory call bridge. Bound to live getters
// (getInstanceId) so runtime identity stays consistent.
function normalizeChannelNotifyParams(method, params) {
  if (method === 'notifications/claude/channel' && params && params.meta) {
    const m = {};
    for (const [k, v] of Object.entries(params.meta)) {
      if (v === undefined || v === null) continue;
      m[k] = k === 'silent_to_agent' ? (v === true || v === 'true') : String(v);
    }
    return { ...params, meta: m };
  }
  return params;
}

// Pluggable notify sink. Under the per-TUI fork model notifies flow over
// node-IPC to the parent (process.send). Under the machine-global daemon there
// is no IPC parent: the daemon entry installs a sink that routes each notify to
// the CORRECT attached TUI over the transport's SSE fan-out (targeted, never
// broadcast). When a sink is installed it fully replaces the process.send path.
let _notifySink = null;
function setChannelNotifySink(fn) {
  _notifySink = typeof fn === 'function' ? fn : null;
}

function createParentBridge({ getInstanceId }) {
  function sendNotifyToParent(method, params) {
    // CC channel schema requires meta: Record<string,string> (channelNotification.ts).
    // Coerce every meta value to string so a non-string (e.g. a Discord
    // interaction.type number) can't fail zod and silently drop the notify.
    // silent_to_agent stays boolean — an internal routing flag the daemon
    // router / agentNotify consume (=== true) before the CC zod boundary.
    const outParams = normalizeChannelNotifyParams(method, params);
    if (_notifySink) {
      try { _notifySink(method, outParams); }
      catch (err) { try { process.stderr.write(`mixdog channels: notify sink failed: ${err && err.message || err}\n`); } catch {} }
      return;
    }
    if (!process.send) {
      try { process.stderr.write(`mixdog channels: notify dropped (no IPC channel): ${method}\n`); } catch {}
      return;
    }
    try {
      process.send({ type: 'notify', method, params: outParams });
    } catch (err) {
      try { process.stderr.write(`mixdog channels: notify IPC send failed: ${err && err.message || err}\n`); } catch {}
    }
  }

  // ── Memory worker bridge (worker → parent → memory) ─────────────────
  // The channels worker does not own the memory worker handle. To trigger
  // memory tool actions (e.g. cycle1) we send `memory_call_request` to the
  // parent, which routes through callWorker('memory', ...) and ships the
  // result back as `memory_call_response`. The response listener is
  // integrated into the main IPC handler below (not a second listener).
  const _memoryCallPending = new Map();
  let _memoryCallSeq = 0;

  function callMemoryAction(action, args, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!process.send) return reject(new Error('not a worker process'));
      const callId = `mc_${getInstanceId()}_${++_memoryCallSeq}_${Math.random().toString(36).slice(2, 8)}`;
      const timer = setTimeout(() => {
        _memoryCallPending.delete(callId);
        reject(new Error(`memory_call ${action} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      _memoryCallPending.set(callId, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try {
        process.send({ type: 'memory_call_request', callId, action, args: args || {} });
      } catch (e) {
        _memoryCallPending.delete(callId);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  // Response side of the worker → parent → memory bridge. The caller routes
  // `memory_call_response` messages here from its single process IPC handler
  // (keeping IPC dispatch in one place). Returns true when the message was a
  // recognised memory_call_response (handled), false otherwise.
  function handleMemoryCallResponse(msg) {
    if (!(msg && msg.type === 'memory_call_response' && msg.callId)) return false;
    const pending = _memoryCallPending.get(msg.callId);
    if (!pending) return true;
    _memoryCallPending.delete(msg.callId);
    if (msg.ok) pending.resolve(msg.result);
    else pending.reject(new Error(msg.error || 'memory_call failed'));
    return true;
  }

  return {
    sendNotifyToParent,
    callMemoryAction,
    handleMemoryCallResponse,
  };
}

export { createParentBridge, normalizeChannelNotifyParams, setChannelNotifySink };

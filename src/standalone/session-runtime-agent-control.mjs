// A child's Agent control request, and the cancel that stops it.
//
// Agent control is executed ONCE, by the daemon's canonical controller: a
// shard child sends 'agent-control' up this channel, the canonical
// implementation runs it, and the result goes back to that same child. The
// controller's AbortController is the cancel handle, held here under the
// control id so a cancel arriving from ANY shard stops the run — and through
// the run's signal, the agent dispatch on whichever shard owns the work
// (agentDispatch forwards the abort as 'agent-dispatch-cancel' to that shard).
//
// Shard-local Agent execution ('agent-control-local' addressed by remembered
// task/tag/session owner) is retired: no runtime worker answers those frames
// any more, so nothing may route a control call by shard again.
import { safeIpcSend } from '../runtime/shared/safe-ipc-send.mjs';

export class AgentControlRouter {
  /** @param pool the shard pool that owns placement (`shardAt` and the session
   *  ownership map) for completion-notification routing. */
  constructor(pool, executeAgentControl) {
    this.pool = pool;
    this.executeCanonicalAgentControl = typeof executeAgentControl === 'function' ? executeAgentControl : null;
    this.agentControlRuns = new Map(); // controlId -> AbortController
    this.agentOwnerOrigins = new Map(); // owner sessionId -> source shard index
  }

  handleAgentControl(originShard, originChild, message) {
    const controlId = String(message?.controlId || '');
    if (!controlId) return;
    const controller = new AbortController();
    this.agentControlRuns.set(controlId, controller);
    const context = {
      ...(message.context || {}),
      signal: controller.signal,
    };
    const ownerSessionId = String(context?.callerSessionId || '');
    if (ownerSessionId) {
      this.agentOwnerOrigins.set(ownerSessionId, originShard.index);
    }
    const execution = this.executeCanonicalAgentControl
      ? this.executeCanonicalAgentControl(message.args || {}, context)
      : Promise.reject(new Error('canonical Agent control is unavailable'));
    // A superseded or dead origin child never receives the result.
    const replyResult = (body) => {
      if (originShard.child !== originChild || originChild?.killed) return;
      safeIpcSend(originChild, { type: 'agent-control-result', controlId, ...body }, { onError: () => {} });
    };
    void Promise.resolve(execution)
      .then((value) => replyResult({ ok: true, value }))
      .catch((error) =>
        replyResult({
          ok: false,
          error: {
            name: String(error?.name || 'Error'),
            message: String(error?.message || error || 'agent control failed'),
            stack: typeof error?.stack === 'string' ? error.stack : null,
            code: error?.code || null,
          },
        })
      )
      .finally(() => {
        this.agentControlRuns.delete(controlId);
      });
  }

  /** Abort the canonical run behind this control id. The run's signal is what
   *  carries the cancel outward — to the shard executing its agent dispatch —
   *  so an unknown id answers false instead of guessing a shard to tell. */
  cancelAgentControl(message) {
    const controlId = String(message?.controlId || '');
    const canonical = this.agentControlRuns.get(controlId);
    if (!canonical) return false;
    try {
      canonical.abort(new Error(String(message?.reason || 'agent control canceled')));
    } catch {}
    return true;
  }

  routeAgentControlNotification(message) {
    const ownerSessionId = String(message?.ownerSessionId || '');
    if (!ownerSessionId) return false;
    const index = this.agentOwnerOrigins.get(ownerSessionId) ?? this.pool.ownership.peek(ownerSessionId);
    if (index == null) return false;
    return this.pool.shardAt(index).sendAgentControlNotification(message);
  }
}

// The machine-wide child-spawn budget as one shard's child sees it.
//
// The gate itself is daemon-side and single-instance; a runtime child asks for
// a slot over IPC ('spawn-lease') and gives it back ('spawn-release'). This
// broker holds the leases granted on that child's behalf and guarantees the
// budget is returned exactly once — on release, on a superseded child, and on
// shard death.
import { acquire as acquireMachineSpawnSlot } from '../runtime/shared/child-spawn-gate.mjs';
import { safeIpcSend } from '../runtime/shared/safe-ipc-send.mjs';

export class ShardSpawnLeases {
  /** @param shard the owning shard; its current `child` and `closed` decide
   *  whether a granted slot still has a live requester. */
  constructor(shard) {
    this.shard = shard;
    this.leases = new Map(); // leaseId -> { release, controller, settled }
  }

  get size() {
    return this.leases.size;
  }

  /** Grant one machine-wide spawn lease from the daemon-side gate (the single
   *  budget authority; daemon-hosted work uses the same instance locally). */
  async grant(message) {
    const leaseId = String(message.leaseId || '');
    if (!leaseId || this.leases.has(leaseId)) return;
    const child = this.shard.child;
    const controller = new AbortController();
    const record = { release: null, controller, settled: false };
    this.leases.set(leaseId, record);
    const reply = (body) => {
      if (this.shard.child !== child || !child || child.killed) return false;
      return safeIpcSend(child, { type: 'spawn-lease-result', leaseId, ...body }, { onError: () => {} });
    };
    try {
      const release = await acquireMachineSpawnSlot(controller.signal, message.lane, {
        ownerKey: `runtime:${String(message.ownerKey || 'anonymous')}`,
        waitTimeoutMs: Number(message.waitTimeoutMs) > 0 ? Number(message.waitTimeoutMs) : undefined,
      });
      if (record.settled || this.shard.closed || this.shard.child !== child) {
        release();
        this.leases.delete(leaseId);
        return;
      }
      record.release = release;
      if (!reply({ ok: true })) this.settle(leaseId);
    } catch (error) {
      this.leases.delete(leaseId);
      if (!record.settled) {
        reply({
          ok: false,
          error: String(error?.message || error),
          code: error?.code || null,
          statusCode: Number(error?.statusCode) || null,
        });
      }
    }
  }

  settle(leaseId) {
    const record = this.leases.get(leaseId);
    if (!record || record.settled) return;
    record.settled = true;
    if (record.release) {
      try {
        record.release();
      } catch {
        /* idempotent */
      }
      this.leases.delete(leaseId);
      return;
    }
    // Still queued on the machine gate: cancel the waiter; grant's
    // catch path removes the record.
    record.controller.abort(new Error('spawn lease released while queued'));
  }

  releaseAll() {
    for (const leaseId of [...this.leases.keys()]) this.settle(leaseId);
  }
}

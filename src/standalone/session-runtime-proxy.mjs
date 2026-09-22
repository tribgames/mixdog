// One session's view of a runtime that lives in another process: the method
// surface it projects, the revision contract its state frames follow, the
// argument shape the IPC link can carry, and how that view is rebuilt after
// its shard recovers. The child process itself is owned by the shard.
import { SESSION_CONFIGURE_ACTIONS, SESSION_READ_ACTIONS } from './session-protocol.mjs';
import { applySessionStatePatch } from './session-state-patch.mjs';

const RUNTIME_METHODS = new Set([
  ...SESSION_READ_ACTIONS,
  ...SESSION_CONFIGURE_ACTIONS,
  'readModelMessages',
  'reserveSession',
  'resume',
  'submitAsync',
  'submitAndWait',
  'abort',
  'closeCanonicalSession',
  'resolveToolApproval',
  'dispose',
]);

function applyRuntimeStateFrame(previous, frame) {
  if (frame?.full && typeof frame.full === 'object') return frame.full;
  const patch = frame?.patch;
  if (!patch || typeof patch !== 'object') return previous || {};
  return applySessionStatePatch(previous, patch);
}

// Wire contract for runtime calls: the fork IPC link serializes frames
// as JSON, which cannot represent `undefined` and would fabricate `null` in
// its place — turning an omitted optional argument (e.g. `resume(id)`) into a
// bogus `resume(id, null)` that bypasses callee default parameters. Trim
// trailing `undefined` arguments before transport so an omitted argument stays
// omitted on the wire and worker-side defaults apply exactly as in-process.
// Interior `undefined` holes cannot be omitted positionally and keep their
// pre-existing JSON behavior.
function wireCallArgs(args) {
  const out = Array.isArray(args) ? [...args] : [];
  while (out.length > 0 && out[out.length - 1] === undefined) out.pop();
  return out;
}

export class SessionRuntimeProxy {
  constructor(id, shard, options, routingKey = '') {
    this.id = id;
    this.shard = shard;
    // Stable ownership key (sessionId when known): recovery, resume and every
    // later view of this session resolve to the same shard. The claim is
    // released exactly once, by whichever settle path runs first.
    this.routingKey = String(routingKey || id);
    this.ownershipReleased = false;
    this.options = { ...(options || {}) };
    this.state = {};
    this.revision = 0;
    this.listeners = new Set();
    this.failure = null;
    this.recovering = false;
    this.isWireSafe = true;
    for (const method of RUNTIME_METHODS) {
      this[method] = (...args) => this.call(method, args);
    }
  }

  getState() {
    return this.state;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  applyFrame(frame) {
    const revision = Number(frame.revision) || 0;
    if (revision <= this.revision) return;
    if (frame.patch && revision !== this.revision + 1) {
      void this.shard.request('snapshot', { runtimeId: this.id }, 5_000).catch(() => {});
      return;
    }
    this.state = applyRuntimeStateFrame(this.state, frame);
    this.revision = revision;
    this.failure = null;
    this.recovering = false;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {}
    }
  }

  fail(error) {
    this.failure = error instanceof Error ? error : new Error(String(error));
    this.recovering = false;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {}
    }
  }

  beginRecovery(error) {
    this.failure = error instanceof Error ? error : new Error(String(error));
    this.recovering = true;
  }

  async recreate() {
    const previousSessionId = String(this.state?.sessionId || this.options.sessionId || '');
    this.revision = 0;
    await this.shard.requestRaw(
      'create',
      {
        runtimeId: this.id,
        options: this.options,
      },
      120_000
    );
    if (previousSessionId) {
      const resumed = await this.shard.requestRaw(
        'call',
        {
          runtimeId: this.id,
          method: 'resume',
          args: [previousSessionId],
        },
        120_000
      );
      if (resumed !== true) {
        await this.shard.requestRaw(
          'call',
          {
            runtimeId: this.id,
            method: 'reserveSession',
            args: [previousSessionId],
          },
          30_000
        );
      }
    }
    await this.shard.requestRaw('snapshot', { runtimeId: this.id }, 5_000);
    this.failure = null;
    this.recovering = false;
  }

  async call(method, args) {
    if (this.recovering && this.shard.recovery) await this.shard.recovery;
    if (this.failure) throw this.failure;
    try {
      const value = await this.shard.request(
        'call',
        {
          runtimeId: this.id,
          method,
          args: wireCallArgs(args),
        },
        method === 'abort' ? 15_000 : 10 * 60_000
      );
      if (method === 'dispose') this.shard.releaseProxy(this.id);
      return value;
    } catch (error) {
      if (method === 'dispose') this.shard.releaseProxy(this.id);
      throw error;
    }
  }
}

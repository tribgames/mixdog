// Time-bounded "keep warm" lease for the embed worker. While embedding/cycle
// backlog is being worked, the parent renews the lease so the idle-dispose
// timer re-arms instead of unloading a model that is about to be needed again.
// The lease expires on its own, so a stopped backlog never pins the model.
export const EMBED_KEEP_WARM_MS = 6 * 60_000;

export function createIdleLease(now = Date.now) {
  let until = 0;
  return {
    hold(ms = EMBED_KEEP_WARM_MS) {
      const ttl = Number(ms);
      if (Number.isFinite(ttl) && ttl > 0) until = Math.max(until, now() + ttl);
    },
    active() {
      return now() < until;
    },
  };
}

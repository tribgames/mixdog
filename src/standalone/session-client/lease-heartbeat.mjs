// session-client/lease-heartbeat.mjs
// A remote attachment has no local pid the daemon can probe, so its liveness
// is a lease the client renews: POST /client/heartbeat every `heartbeatMs`,
// one request in flight at a time, each bounded by heartbeatMs / 2. A failed
// beat is only logged — the next tick retries, and the stream's own recovery
// decides when the attachment is truly lost.
import { clampLeaseMs } from '../session-transport/client-registry/client-grace.mjs';

export function createLeaseHeartbeat({ request, port, serverToken, clientToken, heartbeatMs = 10_000, leaseMs, log }) {
  // Always beat at least three times per (server-clamped) lease.
  heartbeatMs = Math.min(heartbeatMs, Math.floor(clampLeaseMs(leaseMs) / 3));
  let timer = null;
  let inFlight = false;

  async function beat() {
    if (inFlight) return;
    inFlight = true;
    try {
      await request({
        port,
        token: serverToken,
        method: 'POST',
        path: '/client/heartbeat',
        body: { token: clientToken },
        timeoutMs: heartbeatMs / 2,
        control: true,
      });
    } catch (error) {
      log(`heartbeat failed: ${error?.message || error}`);
    } finally {
      inFlight = false;
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(beat, heartbeatMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop };
}

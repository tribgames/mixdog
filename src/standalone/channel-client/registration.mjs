// This client's seat at the daemon: verifying the daemon behind the discovered
// port is the one discovery named, passive register / re-register, and the
// best-effort deregister on close. A passive registration observes the current
// owner and never claims the manual routing seat merely by opening transport.
import { randomUUID } from 'node:crypto';
import { probeChannelHealth, request } from './daemon-request.mjs';

export function staleDiscoveryError(reason) {
  const err = new Error(reason);
  err.daemonDiscoveryStale = true;
  return err;
}

export function createRegistrationClient({ port, serverToken, agent, expectedPid, leadPid, cwd, restoreSessionId }) {
  /** True while the daemon answering on `port` is still the discovered one. */
  async function probeExpectedDaemon() {
    const health = await probeChannelHealth({ port, token: serverToken, timeoutMs: 800 });
    return Number(health?.pid) === expectedPid;
  }

  /** First registration. A stable registration id even on the FIRST attach:
   *  if this response is lost, the daemon reaps the never-acknowledged token
   *  through its replay TTL instead of holding an unreapable client against a
   *  live pid forever (which blocks daemon self-shutdown). A token rejection
   *  means this port now belongs to a different daemon. */
  async function registerInitial() {
    let reg;
    try {
      reg = await request({
        port,
        token: serverToken,
        method: 'POST',
        path: '/client/register',
        body: { leadPid, cwd, passive: true, restoreSessionId, registrationId: randomUUID() },
        timeoutMs: 3000,
        agent,
      });
    } catch (err) {
      if (err?.statusCode === 401 || err?.statusCode === 403) {
        const stale = staleDiscoveryError(`daemon register rejected (${err.statusCode})`);
        stale.daemonAuthRejected = true;
        throw stale;
      }
      throw err;
    }
    const token = reg?.token;
    if (!token) throw new Error('daemon register returned no client token');
    return token;
  }

  /** Re-register after a stream loss (the daemon may have pruned us). Resolves
   *  to the fresh client token, or undefined when none was minted. */
  function reregister({ registrationId, replaceToken }) {
    return request({
      port,
      token: serverToken,
      method: 'POST',
      path: '/client/register',
      body: { leadPid, cwd, passive: true, replaceToken, registrationId, restoreSessionId },
      timeoutMs: 3000,
      agent,
    }).then((r) => r?.token);
  }

  async function deregister(token, { registrationId = null, replaceToken = null, preserveRemoteIntent = false } = {}) {
    if (!token) return;
    try {
      await request({
        port,
        token: serverToken,
        method: 'POST',
        path: '/client/deregister',
        body: {
          token,
          ...(registrationId ? { registrationId, replaceToken, leadPid, cwd, restoreSessionId } : {}),
          ...(preserveRemoteIntent ? { preserveRemoteIntent: true } : {}),
        },
        timeoutMs: 1500,
        agent,
      });
    } catch {
      /* best-effort; daemon sweep reaps us */
    }
  }

  return { probeExpectedDaemon, registerInitial, reregister, deregister };
}

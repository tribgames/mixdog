// channel-client/reconnect.mjs
// Bounded reconnect for a verified-live daemon's transient SSE loss. A
// stale/dead endpoint signals onFatal immediately so the owner re-reads
// discovery instead of spinning against the captured port. Owns the retry
// budget, the delay timer, the in-flight re-registration and the lifecycle
// generation that lets close()/fatal invalidate a re-register already on the
// wire (its fresh token is deregistered rather than adopted).
import { randomUUID } from 'node:crypto';

const RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECTS = 5;

export function createReconnectLoop({
  log,
  probeDaemon,
  reregister,
  deregister,
  getClientToken,
  adoptClientToken,
  openStream,
  onFatal,
}) {
  let stopped = false;
  let lifecycle = 0;
  let timer = null;
  let probing = false;
  let attempts = 0;
  let pending = null;
  let registrationId = null;
  let replaceToken = null;

  /** Stops retrying and reports what close() must still settle: a
   *  re-register in flight and the identity it was using. */
  function stop() {
    stopped = true;
    lifecycle++;
    if (timer) {
      try {
        clearTimeout(timer);
      } catch {}
      timer = null;
    }
    return { pending, registrationId, replaceToken };
  }

  /** Re-register mints a fresh client token (the old one was pruned); adopt it
   *  so the reopened stream and subsequent calls target the live entry. The
   *  registration id and replaced token stick across failed attempts so the
   *  daemon can dedup the retries. */
  function reregisterThenReopen() {
    const generation = lifecycle;
    registrationId ||= randomUUID();
    replaceToken ||= getClientToken();
    const registration = reregister({ registrationId, replaceToken })
      .then(async (freshToken) => {
        if (!freshToken) return false;
        if (stopped || generation !== lifecycle) {
          await deregister(freshToken);
          return false;
        }
        adoptClientToken(freshToken);
        registrationId = null;
        replaceToken = null;
        return true;
      })
      .catch(() => false);
    pending = registration;
    void registration.finally(() => {
      if (pending === registration) pending = null;
      if (!stopped && generation === lifecycle) openStream();
    });
  }

  function schedule(reason) {
    if (stopped || timer) return;
    if (++attempts > MAX_RECONNECTS) {
      onFatal(`giving up after ${attempts} attempts (${reason})`);
      return;
    }
    log(`sse reconnect scheduled (${reason}, attempt ${attempts})`);
    timer = setTimeout(() => {
      timer = null;
      if (stopped) return;
      reregisterThenReopen();
    }, RECONNECT_DELAY_MS);
    timer.unref?.();
  }

  /** A stream ending can be a transient connection loss, but must not leave
   *  this client retrying a dead discovery endpoint: verify the original
   *  daemon is still alive before spending the bounded budget on it. */
  function handleLoss(reason) {
    if (stopped || timer || probing) return;
    probing = true;
    void probeDaemon().then((live) => {
      probing = false;
      if (stopped) return;
      if (!live) {
        onFatal(reason);
        return;
      }
      schedule(reason);
    });
  }

  return {
    handleLoss,
    resetBudget: () => {
      attempts = 0;
    },
    isStopped: () => stopped,
    stop,
  };
}

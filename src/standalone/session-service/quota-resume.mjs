// session-service/quota-resume.mjs
// The daemon's clock for quota auto-resume. Waiting lives in the durable
// store (runtime/shared/quota-resume-store.mjs), never in a session runtime,
// so an evicted or not-yet-loaded session waits exactly like a live one. One
// timer is armed for the earliest due entry; when it fires, the addressed
// session is materialized under daemon ownership (the Goal-recovery pattern),
// a fresh usage reading decides whether its provider can serve the model
// again, and the session's own lane runs the retry under the entry's
// generation. Overdue entries run as soon as the scheduler starts.

/** A still-exhausted reading is re-taken once, this much later. */
export const QUOTA_RESUME_RETRY_MS = 5 * 60_000;
/** A busy session is re-checked this much later, without spending an attempt. */
export const QUOTA_RESUME_BUSY_RECHECK_MS = 30_000;
const MAX_TIMER_MS = 2 ** 31 - 1;

const isCurrent = (store, entry) => store.quotaResumeEntry(entry.sessionId)?.generation === entry.generation;

/** One due entry: load its session, take the fresh reading, then fire,
 *  re-check later, or clear it. Returns the outcome for the log. */
async function resumeDueEntry(entry, { store, materializeSession, readQuotaUsable, log, isClosed, now }) {
  const { sessionId, generation } = entry;
  let runtime;
  try {
    runtime = await materializeSession(sessionId);
  } catch (error) {
    if (isClosed()) return 'closed';
    log(`quota resume could not load session=${sessionId}: ${error?.message || error}`);
    store.cancelQuotaResumeEntry(sessionId, { generation });
    return 'unavailable';
  }
  if (!isCurrent(store, entry)) return 'cancelled';
  let usable = false;
  const currentRoute = () => {
    const snapshot = runtime.getState?.() ?? {};
    return {
      // The selected route is what the next turn runs on; sessionProvider /
      // sessionModel still hold the previous turn's after a deferred selection.
      provider: snapshot.provider || snapshot.sessionProvider || runtime.session?.provider || entry.provider,
      model: snapshot.model || snapshot.sessionModel || runtime.session?.model || entry.model,
    };
  };
  const { provider, model } = currentRoute();
  try {
    usable = await readQuotaUsable(provider, model);
  } catch (error) {
    // A disconnected PC supplies no quota reading. The scheduler's outer
    // deferral keeps this reservation without spending an exhaustion attempt.
    if (error?.code === 'MODEL_PROXY_UNAVAILABLE') throw error;
    log(`quota resume usage reading failed provider=${provider}: ${error?.message || error}`);
  }
  if (!isCurrent(store, entry)) return 'cancelled';
  const selected = currentRoute();
  if (selected.provider !== provider || selected.model !== model) {
    // The reading belongs to the old route. Preserve the reservation and
    // check the selected route on the normal busy-recheck cadence.
    store.deferQuotaResumeEntry(sessionId, generation, {
      resetAt: now() + QUOTA_RESUME_BUSY_RECHECK_MS,
      attempts: entry.attempts,
    });
    return 'route-changed';
  }
  if (!usable) {
    // One more reading five minutes on; after that the session falls back
    // to the user's own choice.
    if (entry.attempts < 1) {
      store.deferQuotaResumeEntry(sessionId, generation, {
        resetAt: now() + QUOTA_RESUME_RETRY_MS,
        attempts: entry.attempts + 1,
      });
      return 'exhausted-retry';
    }
    store.cancelQuotaResumeEntry(sessionId, { generation });
    return 'exhausted';
  }
  const outcome =
    typeof runtime?.fireQuotaResume === 'function' ? await runtime.fireQuotaResume({ generation }) : 'unsupported';
  if (outcome === 'busy' || outcome === 'rejected') {
    store.deferQuotaResumeEntry(sessionId, generation, {
      resetAt: now() + QUOTA_RESUME_BUSY_RECHECK_MS,
      attempts: entry.attempts,
    });
  } else if (isCurrent(store, entry)) {
    // Every other outcome settles the entry; one the session could not
    // address (it now holds another session id) must not stay due forever.
    store.cancelQuotaResumeEntry(sessionId, { generation });
  }
  return outcome;
}

export function createQuotaResumeScheduler({
  store,
  materializeSession,
  readQuotaUsable,
  log = () => {},
  isClosed = () => false,
  now = () => Date.now(),
  setTimer = (task, ms) => setTimeout(task, ms),
  clearTimer = (timer) => clearTimeout(timer),
}) {
  let started = false;
  let timer = null;
  let running = null;
  let unsubscribe = null;
  const deps = { store, materializeSession, readQuotaUsable, log, isClosed, now };

  // sessionId → { generation, at }: an entry whose store write failed is not
  // tried again before `at` (the scheduler's own retry spacing), so a full disk
  // is not retried in a loop. Only that entry waits; the one timer still goes
  // to the earliest time any entry may run.
  const notBefore = new Map();
  const runnableAt = (entry) => {
    const hold = notBefore.get(entry.sessionId);
    if (hold && hold.generation !== entry.generation) notBefore.delete(entry.sessionId);
    else if (hold) return Math.max(entry.resetAt, hold.at);
    return entry.resetAt;
  };
  const holdOff = (entry) => notBefore.set(entry.sessionId, { generation: entry.generation, at: now() + QUOTA_RESUME_RETRY_MS });

  function arm() {
    if (timer) clearTimer(timer);
    timer = null;
    if (!started || isClosed() || running) return;
    const entries = store.listQuotaResumeEntries();
    for (const id of [...notBefore.keys()]) if (!entries.some((entry) => entry.sessionId === id)) notBefore.delete(id);
    if (entries.length === 0) return;
    const due = Math.min(...entries.map(runnableAt));
    timer = setTimer(
      () => {
        timer = null;
        void tick();
      },
      Math.min(MAX_TIMER_MS, Math.max(0, due - now()))
    );
    timer?.unref?.();
  }

  function tick() {
    if (running) return running;
    running = (async () => {
      // The setting turned off anywhere (another process, a hand edit), not
      // only through setQuotaAutoResumeEnabled here: nothing pending resumes.
      if (store.quotaAutoResumeEnabled?.() === false) {
        if (store.listQuotaResumeEntries().length) {
          store.cancelAllQuotaResumeEntries();
          log('quota resume off: pending resumes cancelled');
        }
        return;
      }
      for (const entry of store.listQuotaResumeEntries()) {
        if (isClosed()) return;
        if (runnableAt(entry) > now() || !isCurrent(store, entry)) continue;
        try {
          const outcome = await resumeDueEntry(entry, deps);
          notBefore.delete(entry.sessionId);
          log(`quota resume session=${entry.sessionId} outcome=${outcome}`);
        } catch (error) {
          log(`quota resume failed session=${entry.sessionId}: ${error?.message || error}`);
          try {
            store.deferQuotaResumeEntry(entry.sessionId, entry.generation, {
              resetAt: now() + QUOTA_RESUME_RETRY_MS,
              attempts: entry.attempts,
            });
          } catch (storeError) {
            // The store keeps the entry as it was on disk (memory never gets ahead
            // of it): it stays due and is tried again by a later pass.
            holdOff(entry);
            log(`quota resume could not record the deferral session=${entry.sessionId}: ${storeError?.message || storeError}`);
          }
        }
      }
    })()
      // The store writes before it commits: a full disk throws from any of its
      // mutations and leaves its state unchanged. The pass reports it and ends;
      // the timer callback must not reject.
      .catch((error) => {
        // Not tied to one entry (the setting's cancel-all, the listing): all wait.
        try {
          for (const entry of store.listQuotaResumeEntries()) holdOff(entry);
        } catch {}
        log(`quota resume pass failed: ${error?.message || error}`);
      })
      .finally(() => {
        running = null;
        arm();
      });
    return running;
  }

  return {
    /** Start the clock; entries already due run right away. */
    start() {
      if (started || isClosed()) return;
      started = true;
      unsubscribe = store.subscribeQuotaResume(() => arm());
      arm();
    },
    /** Run every due entry now (the timer's own callback). */
    tick,
    stop() {
      started = false;
      unsubscribe?.();
      unsubscribe = null;
      if (timer) clearTimer(timer);
      timer = null;
    },
  };
}

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
  try {
    usable = await readQuotaUsable(entry.provider, entry.model);
  } catch (error) {
    log(`quota resume usage reading failed provider=${entry.provider}: ${error?.message || error}`);
  }
  if (!isCurrent(store, entry)) return 'cancelled';
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
    typeof runtime?.fireQuotaResume === 'function' ? runtime.fireQuotaResume({ generation }) : 'unsupported';
  if (outcome === 'busy') {
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

  function arm() {
    if (timer) clearTimer(timer);
    timer = null;
    if (!started || isClosed() || running) return;
    const entries = store.listQuotaResumeEntries();
    if (entries.length === 0) return;
    const due = Math.min(...entries.map((entry) => entry.resetAt));
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
      for (const entry of store.listQuotaResumeEntries()) {
        if (isClosed()) return;
        if (entry.resetAt > now() || !isCurrent(store, entry)) continue;
        try {
          const outcome = await resumeDueEntry(entry, deps);
          log(`quota resume session=${entry.sessionId} outcome=${outcome}`);
        } catch (error) {
          log(`quota resume failed session=${entry.sessionId}: ${error?.message || error}`);
          store.cancelQuotaResumeEntry(entry.sessionId, { generation: entry.generation });
        }
      }
    })().finally(() => {
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

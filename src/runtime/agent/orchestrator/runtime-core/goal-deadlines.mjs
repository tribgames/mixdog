import {
  GOAL_LIVE_HEARTBEAT_MS,
  activeElapsedMs,
  assertSessionId,
  discardSuspendedTime,
  normalizeDeadlineWarnedMs,
  stopActiveClock,
} from './goal-state.mjs';

// Wall time may outrun the monotonic clock by a little without any suspend.
const MIN_SUSPEND_EVIDENCE_MS = 5_000;

function normalizeDeadlineWarningMs(value) {
  const thresholds = (Array.isArray(value) ? value : [value])
    .map((entry) => Math.floor(Number(entry)))
    .filter((entry) => Number.isFinite(entry) && entry > 0);
  return [...new Set(thresholds)].sort((left, right) => right - left);
}

// Timers only observe crossings. Every durable transition joins the same
// mutation queue as user edits and re-checks the current committed record.
export function createGoalDeadlines({
  now,
  readRecord,
  withMutation,
  commit,
  stampLive,
  onStorageError,
  deadlineWarningMs,
  monotonicNow = null,
  // libuv's clock (Node's performance.now) stops during suspend on Linux and
  // macOS (CLOCK_MONOTONIC, mach_absolute_time) but typically keeps counting
  // on Windows (QueryPerformanceCounter), so there it proves nothing.
  suspendDetectable = process.platform !== 'win32',
}) {
  const warningThresholdsMs = normalizeDeadlineWarningMs(deadlineWarningMs);
  // Session -> wall and monotonic readings at the last moment the Goal was
  // known to be running. Wall time that outran the monotonic clock since then
  // is suspend: positive evidence. A stall of an awake process moves both
  // clocks, so it is never dropped; without evidence time is counted, because
  // overcounting is safer than a Goal running past its cap.
  const anchors = new Map();
  // Only a Goal that is still running keeps an anchor: an inactive one has its
  // entry retired by armDeadline, and recording it again would leak.
  const observe = (id, at, goal) => {
    if (goal?.status !== 'active') return;
    const mono = suspendDetectable ? monotonicNow?.() : null;
    if (mono == null) anchors.delete(id);
    else anchors.set(id, { wall: at, mono });
  };
  const suspendedMs = (id, at) => {
    const anchor = anchors.get(id);
    if (!anchor) return 0;
    const mono = monotonicNow?.();
    // No reading now: this interval has no evidence and is counted. The anchor
    // goes too, or a later valid reading would discard time already counted.
    if (mono == null) {
      anchors.delete(id);
      return 0;
    }
    const suspended = at - anchor.wall - (mono - anchor.mono);
    return suspended > MIN_SUSPEND_EVIDENCE_MS ? suspended : 0;
  };
  const dropSuspended = (id, goal, at) => discardSuspendedTime(goal, at, suspendedMs(id, at));
  const deadlineTimers = new Map();
  const warningTimers = new Map();
  const heartbeatTimers = new Map();
  const expiryPending = new Set();
  const warningPending = new Set();
  let closed = false;

  const clearDeadline = (sessionId) => {
    const timer = deadlineTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      deadlineTimers.delete(sessionId);
    }
    const warningTimer = warningTimers.get(sessionId);
    if (warningTimer) {
      clearTimeout(warningTimer);
      warningTimers.delete(sessionId);
    }
  };

  // The heartbeat has its own lifetime: re-arming the deadline (every snapshot
  // read does) must not restart its interval, or reads under a minute apart
  // would keep it from ever firing.
  const stopHeartbeat = (sessionId) => {
    const heartbeat = heartbeatTimers.get(sessionId);
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeatTimers.delete(sessionId);
    }
  };

  // An active Goal's clock runs only while a live runtime holds it. The beat
  // re-stamps the record so a later load can tell how long nothing ran it; a
  // beat that finds a long silence (the PC slept) drops that stretch from the
  // open segment and republishes. The stamp alone is a silent write.
  const beat = (sessionId) => {
    const id = assertSessionId(sessionId);
    void withMutation(id, async () => {
      if (closed) return;
      const goal = readRecord(id).goal;
      if (goal?.status !== 'active' || !goal.lastStartedAt) return;
      const at = now();
      if (dropSuspended(id, goal, at)) await commit(id, goal);
      else {
        goal.liveAt = at;
        await stampLive(id, goal);
      }
      observe(id, at, goal);
    }).catch(onStorageError);
  };

  const expiredProjection = (goal, at) => {
    if (goal?.status !== 'active' || !(goal.timeLimitMs > 0) || activeElapsedMs(goal, at) < goal.timeLimitMs)
      return false;
    stopActiveClock(goal, at);
    goal.status = 'duration_reached';
    // The cap is what was spent; a late observation must not report more.
    goal.timeUsedMs = goal.timeLimitMs;
    goal.updatedAt = at;
    return true;
  };

  // Every path that reads an open segment against the clock (expiry, warnings,
  // the next timer) first drops the suspended stretch, as the heartbeat does;
  // otherwise a read after the PC slept would charge the sleep to the budget.
  // `goal` is a working copy. Returns whether it changed.
  const settleProjection = (id, goal, at) => {
    const dropped = dropSuspended(id, goal, at);
    return expiredProjection(goal, at) || dropped;
  };

  const limitIfExpired = (sessionId) => {
    const id = assertSessionId(sessionId);
    const goal = readRecord(id).goal;
    if (settleProjection(id, goal, now()) && !closed && !expiryPending.has(id)) {
      expiryPending.add(id);
      void withMutation(id, async () => {
        if (closed) return;
        const current = readRecord(id).goal;
        const at = now();
        if (settleProjection(id, current, at)) {
          await commit(id, current);
          observe(id, at, current);
        }
      })
        .catch(onStorageError)
        .finally(() => expiryPending.delete(id));
    }
    return goal;
  };

  // Crossing several thresholds at once delivers only the most urgent one.
  const crossedWarningMs = (goal, remainingMs) => {
    const warned = normalizeDeadlineWarnedMs(goal?.deadlineWarnedMs);
    let urgent = 0;
    for (const threshold of warningThresholdsMs) {
      if (threshold < remainingMs || threshold >= warned) continue;
      urgent = urgent ? Math.min(urgent, threshold) : threshold;
    }
    return urgent;
  };

  const nextWarningDelayMs = (goal, remainingMs) => {
    const warned = normalizeDeadlineWarnedMs(goal?.deadlineWarnedMs);
    let delay = 0;
    for (const threshold of warningThresholdsMs) {
      if (threshold >= remainingMs || threshold >= warned) continue;
      const candidate = remainingMs - threshold;
      delay = delay ? Math.min(delay, candidate) : candidate;
    }
    return delay;
  };

  const warningState = (id, goal, at) => {
    if (goal?.status !== 'active' || !goal.lastStartedAt || !(Number(goal.timeLimitMs) > 0)) return null;
    dropSuspended(id, goal, at);
    const remainingMs = Math.max(0, Number(goal.timeLimitMs) - activeElapsedMs(goal, at));
    if (remainingMs <= 0) return null;
    return {
      remainingMs,
      crossedMs: crossedWarningMs(goal, remainingMs),
      nextDelayMs: nextWarningDelayMs(goal, remainingMs),
    };
  };

  const deliverDeadlineWarning = (sessionId, thresholdMs = 0) => {
    const id = assertSessionId(sessionId);
    if (closed || warningPending.has(id)) return;
    const pending = warningState(id, readRecord(id).goal, now());
    const target = thresholdMs || pending?.crossedMs || 0;
    if (!pending || !target || pending.crossedMs !== target) return;
    warningPending.add(id);
    void withMutation(id, async () => {
      if (closed) return;
      const current = readRecord(id).goal;
      const state = warningState(id, current, now());
      if (!state?.crossedMs || state.crossedMs !== target) return;
      current.deadlineWarnedMs = Math.min(normalizeDeadlineWarnedMs(current.deadlineWarnedMs), target);
      current.warningRevision = Math.max(0, Math.floor(Number(current.warningRevision) || 0)) + 1;
      current.updatedAt = now();
      await commit(id, current);
    })
      .catch(onStorageError)
      .finally(() => warningPending.delete(id));
  };

  // Timer and microtask callbacks report failures instead of throwing into the event loop.
  const reportingErrors = (fn) => {
    try {
      fn();
    } catch (error) {
      onStorageError(error);
    }
  };

  function armDeadline(sessionId) {
    if (closed) return;
    clearDeadline(sessionId);
    const goal = readRecord(sessionId).goal;
    if (goal?.status === 'active' && goal.lastStartedAt) {
      if (!anchors.has(sessionId)) observe(sessionId, now(), goal);
      if (!heartbeatTimers.has(sessionId)) {
        const timer = setInterval(() => beat(sessionId), GOAL_LIVE_HEARTBEAT_MS);
        timer.unref?.();
        heartbeatTimers.set(sessionId, timer);
      }
    } else {
      stopHeartbeat(sessionId);
      anchors.delete(sessionId);
    }
    if (goal?.status !== 'active' || !goal.lastStartedAt || !(Number(goal.timeLimitMs) > 0)) return;
    const at = now();
    dropSuspended(sessionId, goal, at);
    const remainingMs = Math.max(0, goal.timeLimitMs - activeElapsedMs(goal, at));
    if (remainingMs <= 0) {
      queueMicrotask(() => reportingErrors(() => limitIfExpired(sessionId)));
      return;
    }
    const warnings = warningState(sessionId, goal, at);
    if (warnings?.crossedMs) {
      const thresholdMs = warnings.crossedMs;
      queueMicrotask(() => reportingErrors(() => deliverDeadlineWarning(sessionId, thresholdMs)));
    } else if (warnings?.nextDelayMs > 0) {
      // Preserve the timer rounding margin used by the runtime.
      const delay = Math.min(remainingMs, warnings.nextDelayMs + 250);
      const warningTimer = setTimeout(() => {
        warningTimers.delete(sessionId);
        reportingErrors(() => deliverDeadlineWarning(sessionId));
      }, delay);
      warningTimer.unref?.();
      warningTimers.set(sessionId, warningTimer);
    }
    const timer = setTimeout(() => {
      deadlineTimers.delete(sessionId);
      // A timer that fires after the PC slept must not expire the Goal on
      // time nobody ran: settle the suspension first, then decide.
      reportingErrors(() => {
        void withMutation(sessionId, async () => {
          if (closed) return;
          const current = readRecord(sessionId).goal;
          const at = now();
          if (current && settleProjection(sessionId, current, at)) {
            await commit(sessionId, current);
            observe(sessionId, at, current);
          }
        }).catch(onStorageError);
      });
    }, remainingMs);
    timer.unref?.();
    deadlineTimers.set(sessionId, timer);
  }

  return {
    armDeadline,
    clearDeadline,
    limitIfExpired,
    // A write is about to stamp `liveAt`: charge the pending suspend to the
    // working copy first, so the stamp never hides it, and `refreshAnchor`
    // starts the next evidence window once the write has landed.
    settleSuspended: dropSuspended,
    refreshAnchor: observe,
    anchorCount: () => anchors.size,
    close() {
      closed = true;
      for (const timer of deadlineTimers.values()) clearTimeout(timer);
      deadlineTimers.clear();
      for (const timer of warningTimers.values()) clearTimeout(timer);
      warningTimers.clear();
      for (const timer of heartbeatTimers.values()) clearInterval(timer);
      heartbeatTimers.clear();
      warningPending.clear();
      expiryPending.clear();
      anchors.clear();
    },
  };
}

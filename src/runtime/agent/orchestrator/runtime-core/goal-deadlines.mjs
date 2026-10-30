import {
  GOAL_LIVE_HEARTBEAT_MS,
  GOAL_LIVE_STALE_MS,
  activeElapsedMs,
  assertSessionId,
  discardUnobservedTime,
  normalizeDeadlineWarnedMs,
  stopActiveClock,
} from './goal-state.mjs';

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
}) {
  const warningThresholdsMs = normalizeDeadlineWarningMs(deadlineWarningMs);
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
      if (discardUnobservedTime(goal, at, GOAL_LIVE_STALE_MS)) await commit(id, goal);
      else {
        goal.liveAt = at;
        await stampLive(id, goal);
      }
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

  const limitIfExpired = (sessionId) => {
    const id = assertSessionId(sessionId);
    const goal = readRecord(id).goal;
    if (expiredProjection(goal, now()) && !closed && !expiryPending.has(id)) {
      expiryPending.add(id);
      void withMutation(id, async () => {
        if (closed) return;
        const current = readRecord(id).goal;
        if (expiredProjection(current, now())) await commit(id, current);
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

  const warningState = (goal, at) => {
    if (goal?.status !== 'active' || !goal.lastStartedAt || !(Number(goal.timeLimitMs) > 0)) return null;
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
    const pending = warningState(readRecord(id).goal, now());
    const target = thresholdMs || pending?.crossedMs || 0;
    if (!pending || !target || pending.crossedMs !== target) return;
    warningPending.add(id);
    void withMutation(id, async () => {
      if (closed) return;
      const current = readRecord(id).goal;
      const state = warningState(current, now());
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
      if (!heartbeatTimers.has(sessionId)) {
        const timer = setInterval(() => beat(sessionId), GOAL_LIVE_HEARTBEAT_MS);
        timer.unref?.();
        heartbeatTimers.set(sessionId, timer);
      }
    } else stopHeartbeat(sessionId);
    if (goal?.status !== 'active' || !goal.lastStartedAt || !(Number(goal.timeLimitMs) > 0)) return;
    const at = now();
    const remainingMs = Math.max(0, goal.timeLimitMs - activeElapsedMs(goal, at));
    if (remainingMs <= 0) {
      queueMicrotask(() => reportingErrors(() => limitIfExpired(sessionId)));
      return;
    }
    const warnings = warningState(goal, at);
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
      // time nobody ran: settle the silence first, then decide.
      reportingErrors(() => {
        void withMutation(sessionId, async () => {
          if (closed) return;
          const current = readRecord(sessionId).goal;
          if (current && discardUnobservedTime(current, now(), GOAL_LIVE_STALE_MS)) await commit(sessionId, current);
          else limitIfExpired(sessionId);
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
    },
  };
}

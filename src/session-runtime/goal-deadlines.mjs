import { activeElapsedMs, assertSessionId, normalizeDeadlineWarnedMs, stopActiveClock } from './goal-state.mjs';

function normalizeDeadlineWarningMs(value) {
  const thresholds = (Array.isArray(value) ? value : [value])
    .map((entry) => Math.floor(Number(entry)))
    .filter((entry) => Number.isFinite(entry) && entry > 0);
  return [...new Set(thresholds)].sort((left, right) => right - left);
}

// Timers only observe crossings. Every durable transition joins the same
// mutation queue as user edits and re-checks the current committed record.
export function createGoalDeadlines({ now, readRecord, withMutation, commit, onStorageError, deadlineWarningMs }) {
  const warningThresholdsMs = normalizeDeadlineWarningMs(deadlineWarningMs);
  const deadlineTimers = new Map();
  const warningTimers = new Map();
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

  const expiredProjection = (goal, at) => {
    if (!goal || goal.status !== 'active' || !(goal.timeLimitMs > 0) || activeElapsedMs(goal, at) < goal.timeLimitMs)
      return false;
    stopActiveClock(goal, at);
    goal.status = 'duration_reached';
    goal.timeUsedMs = Math.max(goal.timeUsedMs, goal.timeLimitMs);
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
    if (!goal || goal.status !== 'active' || !goal.lastStartedAt || !(Number(goal.timeLimitMs) > 0)) return null;
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
      if (!state || !state.crossedMs || state.crossedMs !== target) return;
      current.deadlineWarnedMs = Math.min(normalizeDeadlineWarnedMs(current.deadlineWarnedMs), target);
      current.warningRevision = Math.max(0, Math.floor(Number(current.warningRevision) || 0)) + 1;
      current.updatedAt = now();
      await commit(id, current);
    })
      .catch(onStorageError)
      .finally(() => warningPending.delete(id));
  };

  function armDeadline(sessionId) {
    if (closed) return;
    clearDeadline(sessionId);
    const goal = readRecord(sessionId).goal;
    if (!goal || goal.status !== 'active' || !goal.lastStartedAt || !(Number(goal.timeLimitMs) > 0)) return;
    const at = now();
    const remainingMs = Math.max(0, goal.timeLimitMs - activeElapsedMs(goal, at));
    if (remainingMs <= 0) {
      queueMicrotask(() => {
        try {
          limitIfExpired(sessionId);
        } catch (error) {
          onStorageError(error);
        }
      });
      return;
    }
    const warnings = warningState(goal, at);
    if (warnings?.crossedMs) {
      const thresholdMs = warnings.crossedMs;
      queueMicrotask(() => {
        try {
          deliverDeadlineWarning(sessionId, thresholdMs);
        } catch (error) {
          onStorageError(error);
        }
      });
    } else if (warnings?.nextDelayMs > 0) {
      // Preserve the timer rounding margin used by the runtime.
      const delay = Math.min(remainingMs, warnings.nextDelayMs + 250);
      const warningTimer = setTimeout(() => {
        warningTimers.delete(sessionId);
        try {
          deliverDeadlineWarning(sessionId);
        } catch (error) {
          onStorageError(error);
        }
      }, delay);
      warningTimer.unref?.();
      warningTimers.set(sessionId, warningTimer);
    }
    const timer = setTimeout(() => {
      deadlineTimers.delete(sessionId);
      try {
        limitIfExpired(sessionId);
      } catch (error) {
        onStorageError(error);
      }
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
      warningPending.clear();
      expiryPending.clear();
    },
  };
}

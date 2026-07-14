function suppressed(value) {
  return typeof value === 'function' ? value() === true : value === true;
}

export function cancelPromptImmediateFlush(throttle, clearTimer = clearTimeout) {
  if (!throttle || throttle.timer === null) return false;
  clearTimer(throttle.timer);
  throttle.timer = null;
  return true;
}

export function schedulePromptImmediateFlush({
  throttle,
  isSuppressed = false,
  flush,
  intervalMs = 16,
  now = Date.now,
  enqueue = queueMicrotask,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  if (!throttle || typeof flush !== 'function') {
    throw new TypeError('schedulePromptImmediateFlush requires throttle state and a flush function');
  }
  if (suppressed(isSuppressed)) {
    cancelPromptImmediateFlush(throttle, clearTimer);
    return false;
  }

  const current = now();
  const elapsed = current - throttle.lastAt;
  if (elapsed >= intervalMs) {
    cancelPromptImmediateFlush(throttle, clearTimer);
    throttle.lastAt = current;
    enqueue(flush);
    return true;
  }
  if (throttle.timer !== null) return false;

  throttle.timer = setTimer(() => {
    throttle.timer = null;
    if (suppressed(isSuppressed)) return;
    throttle.lastAt = now();
    flush();
  }, intervalMs - elapsed);
  return true;
}

// Preserve the transport's existing retained-size accounting without recursive
// calls: deeply nested results must not crash a promise-settlement observer.
function estimateRetainedBytes(value, limit) {
  const seen = new Set();
  const stack = [{ value, limit }];
  let result = 0;
  const finish = (bytes) => {
    stack.pop();
    if (!stack.length) { result = bytes; return; }
    const parent = stack[stack.length - 1];
    parent.bytes += parent.overhead + bytes;
    parent.afterChild = true;
  };
  while (stack.length) {
    const frame = stack[stack.length - 1];
    if (!frame.iterator) {
      const value = frame.value;
      const type = typeof value;
      if (type === 'string') { finish(Math.min(frame.limit, value.length * 2 + 16)); continue; }
      if (type === 'number' || type === 'bigint') { finish(8); continue; }
      if (type === 'boolean' || value == null) { finish(4); continue; }
      if (type !== 'object' || seen.has(value)) { finish(0); continue; }
      seen.add(value);
      frame.array = Array.isArray(value);
      frame.bytes = frame.array ? 32 : 64;
      frame.iterator = frame.array ? value.values() : Object.entries(value)[Symbol.iterator]();
    }
    const next = frame.afterChild && frame.bytes >= frame.limit
      ? { done: true } : frame.iterator.next();
    if (next.done) {
      seen.delete(frame.value);
      finish(Math.min(frame.limit, frame.bytes));
      continue;
    }
    frame.overhead = frame.array ? 8 : String(next.value[0]).length * 2 + 16;
    frame.afterChild = false;
    stack.push({
      value: frame.array ? next.value : next.value[1],
      limit: frame.limit - frame.bytes,
    });
  }
  return result;
}

export function createSessionCallCache({
  ttlMs,
  maxEntries,
  maxBytes,
  log,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  const records = new Map();
  let retainedBytes = 0;
  let pressureLoggedAt = 0;
  let closed = false;

  function remove(key, record = records.get(key)) {
    if (!record || records.get(key) !== record) return false;
    if (record.timer) clearTimer(record.timer);
    record.timer = null;
    records.delete(key);
    retainedBytes = Math.max(0, retainedBytes - (record.bytes || 0));
    return true;
  }

  function prune() {
    if (records.size <= maxEntries && retainedBytes <= maxBytes) return;
    const at = now();
    // Identity cannot be removed inside the promised retry TTL.
    for (const [key, record] of records) {
      if (records.size <= maxEntries && retainedBytes <= maxBytes) return;
      if (!record.settled || !record.settledAt) continue;
      if (at - record.settledAt < ttlMs) continue;
      remove(key, record);
    }
    // Drop only results under byte pressure; replays of these tombstones fail
    // closed instead of executing an already-completed mutation again.
    for (const record of records.values()) {
      if (retainedBytes <= maxBytes) break;
      if (!record.settled || record.resultDropped) continue;
      retainedBytes = Math.max(0, retainedBytes - (record.bytes || 0));
      record.bytes = 0;
      record.resultDropped = true;
      record.promise = null;
    }
    if (records.size > maxEntries && at - pressureLoggedAt > 60_000) {
      pressureLoggedAt = at;
      log(
        `session call dedup cache above its entry budget (${records.size}/${maxEntries});`
        + ' every remaining entry is still inside its retry TTL',
      );
    }
  }

  function track(key, promise, signature) {
    if (closed) return;
    const record = {
      promise, signature, at: now(), settled: false, settledAt: 0,
      resultDropped: false, bytes: 0, timer: null,
    };
    records.set(key, record);
    prune();
    promise.then((result) => {
      if (records.get(key) !== record || closed) return;
      try {
        record.bytes = estimateRetainedBytes(result, maxBytes + 1);
        retainedBytes += record.bytes;
      } catch {
        // An unreadable result cannot be retained within a byte budget. Keep
        // its mutation identity, without altering the original call outcome.
        record.resultDropped = true;
        record.promise = null;
      }
    }, () => {}).then(() => {
      if (records.get(key) !== record || closed) return;
      record.settled = true;
      record.settledAt = now();
      prune();
      if (records.get(key) !== record) return;
      record.timer = setTimer(() => remove(key, record), ttlMs);
      record.timer.unref?.();
    });
  }

  function close() {
    closed = true;
    for (const [key, record] of records) remove(key, record);
  }

  return {
    get: (key) => records.get(key),
    track,
    close,
    get size() { return records.size; },
    get bytes() { return retainedBytes; },
  };
}

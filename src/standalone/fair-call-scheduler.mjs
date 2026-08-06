function positiveInt(value, fallback) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function activeLimit(value, fallback) {
  if (value === null || value === Infinity) return Infinity;
  return positiveInt(value, fallback);
}

function schedulerError(message, statusCode = 503) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function abortError(signal, fallback = 'scheduled call canceled') {
  return signal?.reason instanceof Error
    ? signal.reason
    : schedulerError(String(signal?.reason || fallback), 499);
}

/**
 * Owner-fair async dispatcher with an optional active limit.
 *
 * One owner may borrow the entire queue while it is alone. When another owner
 * appears, new admissions are divided by weight and a completely full queue
 * evicts one tail item from the largest borrower so the newcomer always gets a
 * seat. Running work is never revoked.
 */
export function createFairCallScheduler({
  name = 'daemon call',
  activeMax = 32,
  queueMax = 256,
  minOwnerQueue = 8,
  dispatchBurst = 8,
  yieldUnbounded = false,
  schedule = setImmediate,
  now = Date.now,
} = {}) {
  const maxActive = activeLimit(activeMax, 32);
  const maxQueued = positiveInt(queueMax, 256);
  const ownerFloor = Math.max(1, Math.min(maxQueued, positiveInt(minOwnerQueue, 8)));
  const maxBurst = positiveInt(dispatchBurst, 8);
  const groups = new Map();
  let active = 0;
  let queued = 0;
  let scheduled = false;
  let closed = false;

  function ownerId(value) {
    const clean = String(value || '').trim();
    return clean ? clean.slice(0, 240) : 'anonymous';
  }

  function groupFor(owner, weight = 1) {
    const id = ownerId(owner);
    let group = groups.get(id);
    if (!group) {
      group = {
        owner: id,
        weight: positiveInt(weight, 1),
        current: 0,
        active: 0,
        queue: [],
      };
      groups.set(id, group);
    } else if (weight !== undefined) {
      group.weight = positiveInt(weight, group.weight);
    }
    return group;
  }

  function maybeDeleteGroup(group) {
    if (group && group.active === 0 && group.queue.length === 0) groups.delete(group.owner);
  }

  function detach(item) {
    if (!item?.onAbort || !item.signal) return;
    try { item.signal.removeEventListener('abort', item.onAbort); } catch {}
    item.onAbort = null;
  }

  function queuedGroups(extra = null) {
    const out = [];
    for (const group of groups.values()) {
      if (group.queue.length > 0 || group === extra) out.push(group);
    }
    if (extra && !out.includes(extra)) out.push(extra);
    return out;
  }

  function rejectBorrowedTail(incoming) {
    let borrower = null;
    for (const group of groups.values()) {
      if (group === incoming || group.queue.length <= ownerFloor) continue;
      if (!borrower || group.queue.length > borrower.queue.length) borrower = group;
    }
    if (!borrower) return false;
    const displaced = borrower.queue.pop();
    queued = Math.max(0, queued - 1);
    detach(displaced);
    displaced.reject(schedulerError(
      `${name} queue rebalanced for another client; retry after running work completes`,
      503,
    ));
    maybeDeleteGroup(borrower);
    return true;
  }

  function fairQueueLimit(group) {
    const contenders = queuedGroups(group);
    if (contenders.length <= 1) return maxQueued;
    const totalWeight = contenders.reduce((sum, candidate) => sum + candidate.weight, 0);
    return Math.max(
      ownerFloor,
      Math.floor(maxQueued * group.weight / Math.max(1, totalWeight)),
    );
  }

  function pickGroup() {
    const ready = [...groups.values()].filter((group) => group.queue.length > 0);
    if (ready.length === 0) return null;
    const totalWeight = ready.reduce((sum, group) => sum + group.weight, 0);
    let chosen = null;
    for (const group of ready) {
      group.current += group.weight;
      if (!chosen || group.current > chosen.current) chosen = group;
    }
    chosen.current -= totalWeight;
    return chosen;
  }

  function scheduleDispatch() {
    if (closed || scheduled || active >= maxActive || queued === 0) return;
    scheduled = true;
    schedule(() => {
      scheduled = false;
      let started = 0;
      while (!closed && active < maxActive && queued > 0 && started < maxBurst) {
        const group = pickGroup();
        const item = group?.queue.shift();
        if (!group || !item) break;
        queued = Math.max(0, queued - 1);
        detach(item);
        active += 1;
        group.active += 1;
        started += 1;
        Promise.resolve()
          .then(item.run)
          .then(item.resolve, item.reject)
          .finally(() => {
            active = Math.max(0, active - 1);
            group.active = Math.max(0, group.active - 1);
            maybeDeleteGroup(group);
            scheduleDispatch();
          });
      }
      // A bounded burst amortizes loopback dispatch without letting synchronous
      // setup monopolize the supervisor's socket/control-plane turn.
      scheduleDispatch();
    });
  }

  function enqueue(owner, run, { weight = 1, signal = null } = {}) {
    if (closed) return Promise.reject(schedulerError(`${name} scheduler is closed`));
    if (typeof run !== 'function') return Promise.reject(new TypeError('scheduled call must be a function'));
    if (signal?.aborted) return Promise.reject(abortError(signal));
    const group = groupFor(owner, weight);
    // Default daemon lanes are unbounded. Do not enqueue them only to bounce
    // through setImmediate: independent loopback calls start in this microtask,
    // while finite operator-configured lanes retain the fair queue below.
    if (maxActive === Infinity && !yieldUnbounded && queued === 0) {
      active += 1;
      group.active += 1;
      return Promise.resolve()
        .then(run)
        .finally(() => {
          active = Math.max(0, active - 1);
          group.active = Math.max(0, group.active - 1);
          maybeDeleteGroup(group);
          scheduleDispatch();
        });
    }
    const hasCompetitor = queuedGroups(group).some((candidate) =>
      candidate !== group && candidate.queue.length > 0);
    if (hasCompetitor && group.queue.length >= fairQueueLimit(group)) {
      return Promise.reject(schedulerError(
        `${name} client queue is full; retry after this client's running work completes`,
        429,
      ));
    }
    if (queued >= maxQueued && !rejectBorrowedTail(group)) {
      return Promise.reject(schedulerError(`${name} queue is full`, 503));
    }
    let item;
    const promise = new Promise((resolve, reject) => {
      item = {
        run,
        resolve,
        reject,
        signal,
        onAbort: null,
        queuedAt: now(),
      };
      if (signal) {
        item.onAbort = () => {
          const index = group.queue.indexOf(item);
          if (index < 0) return;
          group.queue.splice(index, 1);
          queued = Math.max(0, queued - 1);
          detach(item);
          maybeDeleteGroup(group);
          reject(abortError(signal));
        };
        signal.addEventListener('abort', item.onAbort, { once: true });
      }
      group.queue.push(item);
      queued += 1;
    });
    scheduleDispatch();
    return promise;
  }

  function close(reason = `${name} scheduler is closed`) {
    if (closed) return;
    closed = true;
    const error = schedulerError(reason);
    for (const group of groups.values()) {
      for (const item of group.queue.splice(0)) {
        detach(item);
        item.reject(error);
      }
    }
    queued = 0;
    for (const group of [...groups.values()]) maybeDeleteGroup(group);
  }

  function snapshot() {
    let oldestQueuedAt = Infinity;
    for (const group of groups.values()) {
      for (const item of group.queue) {
        oldestQueuedAt = Math.min(oldestQueuedAt, Number(item.queuedAt) || Infinity);
      }
    }
    return {
      active,
      queued,
      owners: [...groups.values()].filter((group) => group.active || group.queue.length).length,
      activeMax: Number.isFinite(maxActive) ? maxActive : null,
      dispatchBurst: maxBurst,
      queueMax: maxQueued,
      oldestWaitMs: Number.isFinite(oldestQueuedAt) ? Math.max(0, now() - oldestQueuedAt) : 0,
    };
  }

  return {
    enqueue,
    close,
    snapshot,
    get active() { return active; },
    get queued() { return queued; },
  };
}

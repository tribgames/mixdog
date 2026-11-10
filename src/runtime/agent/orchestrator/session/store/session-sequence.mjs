/**
 * The order of a session's lifecycle operations in this process: one FIFO
 * per session id, like the recorder's queue one level up. A delete, a
 * close/detach barrier and an idle unload each take their place in it and
 * run one at a time, in acceptance order, each from start to end. While a
 * delete is queued or running, a save is accepted into the same order
 * behind it, instead of being refused: when its turn comes it runs exactly as
 * a save made right after a synchronous delete (v1.4.5) would, against what
 * the delete actually did — on the intact session when it did not delete,
 * creating the session anew from a copy of the deleted record when it did.
 * With no delete ahead, saves run at once; the recorder keeps their order.
 *
 * Leaf module: no store state, only the ordering.
 */

// id → { ops: [{ kind, run, resolve, reject }], running: op | null, deletes }
const _sequences = new Map();

function sequenceOf(id) {
  let sequence = _sequences.get(id);
  if (!sequence) {
    sequence = { ops: [], running: null, deletes: 0 };
    _sequences.set(id, sequence);
  }
  return sequence;
}

/**
 * Accepts `run` into `id`'s order as an operation of `kind` ('delete',
 * 'barrier', 'release' or 'save') and resolves with its result. A lifecycle
 * operation starts once everything accepted before it ended; with nothing
 * ahead it starts synchronously, here. A save starts as soon as everything
 * ahead of it has (its records then queue in the recorder in that order).
 */
export function inSessionOrder(id, kind, run) {
  const sequence = sequenceOf(id);
  if (kind === 'delete') sequence.deletes += 1;
  return new Promise((resolve, reject) => {
    sequence.ops.push({ kind, run, resolve, reject });
    advance(id, sequence);
  });
}

function start(op) {
  try {
    return Promise.resolve(op.run());
  } catch (err) {
    return Promise.reject(err);
  }
}

function advance(id, sequence) {
  while (!sequence.running && sequence.ops.length) {
    const op = sequence.ops.shift();
    if (op.kind === 'save') {
      start(op).then(op.resolve, op.reject);
      continue;
    }
    sequence.running = op;
    start(op)
      .then(op.resolve, op.reject)
      .finally(() => {
        if (op.kind === 'delete') sequence.deletes -= 1;
        sequence.running = null;
        advance(id, sequence);
      });
  }
  if (!sequence.running && !sequence.ops.length && _sequences.get(id) === sequence) _sequences.delete(id);
}

/** Whether a delete of `id` is queued or running: a save then waits behind it. */
export function deleteAhead(id) {
  return (_sequences.get(id)?.deletes ?? 0) > 0;
}

/** Whether a save of `id` is accepted but waiting behind a delete. */
export function hasWaitingSave(id) {
  return _sequences.get(id)?.ops.some((op) => op.kind === 'save') ?? false;
}

/**
 * Process exit: the saves still waiting behind a delete, taken out of every
 * order and started now, in order (the delete cannot finish any more; they
 * apply to the session as the process leaves it). Lifecycle operations not
 * started yet never run.
 */
export function startWaitingSaves() {
  for (const sequence of _sequences.values()) {
    const saves = sequence.ops.filter((op) => op.kind === 'save');
    sequence.ops = sequence.ops.filter((op) => op.kind !== 'save');
    for (const op of saves) start(op).then(op.resolve, op.reject);
  }
}

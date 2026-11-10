/**
 * worker-slots/slot-pick.mjs — owner-affine slot selection: a stream keeps
 * its worker, otherwise the least-loaded ready worker, or a fresh one while
 * the pool is below `workerMax` and every existing worker is busy.
 */

/** Pick a worker slot for `owner`, or null when none can be provided. */
export function pickSlot({ state, affinities, spawner }, owner) {
  const entry = affinities.entryFor(owner);
  if (entry?.slot && !entry.slot.failed) return entry.slot;
  const ready = state.slots.filter((slot) => !slot.failed);
  const least = ready.sort((left, right) => left.tasks.size - right.tasks.size)[0] || null;
  const wantsNew = ready.length < state.workerMax && (!least || least.tasks.size > 0);
  let slot;
  if (wantsNew) {
    // This task asked for its OWN worker. When the spawn fails (or the
    // failure latch is set) it settles INLINE instead of being queued
    // behind a worker it deliberately avoided: a broken spawn must
    // never serialize unrelated offload work onto one thread.
    slot = spawner.spawnAllowed() ? spawner.createSlot() : null;
    if (!slot) return null;
  } else {
    slot = least;
    if (!slot) return null;
  }
  if (entry) entry.slot = slot;
  return slot;
}

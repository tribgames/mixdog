// Main dispatches this event only while the window is unfocused with no turn running, so a registered
// task may drop only recomputable state: never a scroll measurement, a draft, or a preview that
// cannot be rebuilt from what is on screen.
export const IDLE_RECLAIM_EVENT = 'mixdog:idle-reclaim';

const tasks = new Set<() => void>();
let listening = false;

function runIdleReclaim(): void {
  for (const task of [...tasks]) {
    // One failing reclaimer must not strand the ones behind it.
    try {
      task();
    } catch {
      /* the cache keeps its entries until next idle */
    }
  }
}

/** Register a recomputable cache drop for the next idle window. Returns the
 *  unregister handle; module-level registrations simply never call it. */
export function registerIdleReclaim(task: () => void): () => void {
  tasks.add(task);
  if (!listening && typeof window !== 'undefined') {
    listening = true;
    window.addEventListener(IDLE_RECLAIM_EVENT, runIdleReclaim);
  }
  return () => {
    tasks.delete(task);
  };
}

export function _runIdleReclaimForTest(): void {
  runIdleReclaim();
}

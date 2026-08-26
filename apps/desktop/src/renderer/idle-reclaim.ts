// Idle memory reclaim (renderer half); main/idle-reclaim.ts owns the trigger.
//
// The renderer warms aggressively on purpose — markdown, panel chunks and
// sidebar reference data all stage themselves once the first frame is out —
// but nothing ever gave that memory back. Measured across an ordinary working
// day, the renderer idled at ~330 MB, climbed past 1.0 GB while sessions ran,
// and stayed there because the host still had free RAM for V8 to sit on.
//
// Main dispatches this event ONLY while the window is unfocused with no turn
// running, so a task registered here may drop nothing but purely recomputable
// state: never a scroll measurement, a draft, or a preview whose bytes cannot
// be rebuilt from what is still on screen.
export const IDLE_RECLAIM_EVENT = "mixdog:idle-reclaim";

const tasks = new Set<() => void>();
let listening = false;

function runIdleReclaim(): void {
  for (const task of [...tasks]) {
    // One failing reclaimer must not strand the ones behind it.
    try { task(); } catch { /* the cache keeps its entries until next idle */ }
  }
}

/** Register a recomputable cache drop for the next idle window. Returns the
 *  unregister handle; module-level registrations simply never call it. */
export function registerIdleReclaim(task: () => void): () => void {
  tasks.add(task);
  if (!listening && typeof window !== "undefined") {
    listening = true;
    window.addEventListener(IDLE_RECLAIM_EVENT, runIdleReclaim);
  }
  return () => { tasks.delete(task); };
}

export function _runIdleReclaimForTest(): void {
  runIdleReclaim();
}

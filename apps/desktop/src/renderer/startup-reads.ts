/** Reads that only fill secondary surfaces (usage statistics, subscription
 *  history, branch menus) cost the service seconds; at start they wait until
 *  the restored conversation is shown and the workspace takes input, so they
 *  never compete with it. Open unless a boot holds them. */
let held = false;
const waiting = new Set<() => void>();

/** Called by the renderer entry before its first render. */
export function holdStartupReads(): void {
  held = true;
}

/** Called once the boot cover has handed off and the first conversation has painted. */
export function releaseStartupReads(): void {
  if (!held) return;
  held = false;
  const runs = [...waiting];
  waiting.clear();
  for (const run of runs) run();
}

/** Runs `run` now, or once startup reads are released. Returns a cancel. */
export function afterStartupReads(run: () => void): () => void {
  if (!held) {
    run();
    return () => {};
  }
  waiting.add(run);
  return () => {
    waiting.delete(run);
  };
}

export function _resetStartupReadsForTest(): void {
  held = false;
  waiting.clear();
}

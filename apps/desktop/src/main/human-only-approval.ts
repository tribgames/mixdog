let activeComputerOperations = 0;
let activeHumanApproval = false;
let waitingHumanApprovals = 0;
/** What each waiting or active approval holds the screen for, oldest first. */
const pendingLabels: string[] = [];
const stateWaiters = new Set<() => void>();

function notifyStateChange(): void {
  for (const resolve of stateWaiters) resolve();
  stateWaiters.clear();
}

/** Resolves on the next state change, or at once when `signal` aborts. */
function waitForStateChange(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      stateWaiters.delete(done);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    stateWaiters.add(done);
    signal?.addEventListener('abort', done, { once: true });
  });
}

export function beginComputerOperation(): () => void {
  if (activeHumanApproval || waitingHumanApprovals > 0) {
    const label = pendingLabels.find(Boolean);
    throw new Error(`Computer Use is blocked while a human-only approval is pending${label ? `: ${label}` : ''}`);
  }
  activeComputerOperations += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeComputerOperations = Math.max(0, activeComputerOperations - 1);
    notifyStateChange();
  };
}

/** Runs `run` alone: after active Computer Use and any other human-only
 *  approval. An approval has no wait limit, so the one in line behind it must
 *  be able to leave: when `signal` aborts (the command was stopped) a waiting
 *  `run` is dropped and this rejects with the signal's reason. `label`: what
 *  it holds the screen for, named in Computer Use's refusal meanwhile. */
export async function withHumanOnlyApproval<T>(
  run: () => Promise<T>,
  signal?: AbortSignal,
  label = ''
): Promise<T> {
  pendingLabels.push(label);
  const dropLabel = () => {
    const index = pendingLabels.indexOf(label);
    if (index >= 0) pendingLabels.splice(index, 1);
  };
  waitingHumanApprovals += 1;
  try {
    while (activeComputerOperations > 0 || activeHumanApproval) {
      if (signal?.aborted) throw signal.reason ?? new Error('approval cancelled');
      await waitForStateChange(signal);
    }
    if (signal?.aborted) throw signal.reason ?? new Error('approval cancelled');
    activeHumanApproval = true;
  } catch (error) {
    dropLabel();
    throw error;
  } finally {
    waitingHumanApprovals = Math.max(0, waitingHumanApprovals - 1);
  }
  try {
    return await run();
  } finally {
    activeHumanApproval = false;
    dropLabel();
    notifyStateChange();
  }
}

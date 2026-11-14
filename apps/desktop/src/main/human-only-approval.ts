let activeComputerOperations = 0;
let activeHumanApproval = false;
let waitingHumanApprovals = 0;
/** What each waiting or active approval holds the screen for, oldest first. */
const pendingLabels: string[] = [];
const stateWaiters = new Set<() => void>();

/** The core's half of the lock (`host/humanOnly/*`): the core sends the agent's Computer Use input to its own
 *  helper, so that input never meets beginComputerOperation here. */
export interface CoreHumanOnlyHolds {
  /** Holds the core's Computer Use at once; resolves with the hold's id once its running operations ended. */
  begin(label: string): Promise<string>;
  /** Ends a hold (it also ends with the connection). */
  end(holdId: string): void;
}

let coreHolds: CoreHumanOnlyHolds | null = null;

/** Installs the core's half of the lock (the host role does, for this PC's core); null removes it. */
export function setCoreHumanOnlyHolds(holds: CoreHumanOnlyHolds | null): void {
  coreHolds = holds;
}

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
 *  it holds the screen for, named in Computer Use's refusal meanwhile. The
 *  core's Computer Use is held too from the moment the approval waits, as it
 *  is here, and `run` starts once the core's running operations ended as well;
 *  a hold the core refuses rejects without running `run`. */
export async function withHumanOnlyApproval<T>(run: () => Promise<T>, signal?: AbortSignal, label = ''): Promise<T> {
  pendingLabels.push(label);
  const dropLabel = () => {
    const index = pendingLabels.indexOf(label);
    if (index >= 0) pendingLabels.splice(index, 1);
  };
  const core = coreHolds;
  const begun = core && !signal?.aborted ? core.begin(label) : undefined;
  // A refused hold is answered when the approval's turn comes.
  void begun?.catch(() => undefined);
  waitingHumanApprovals += 1;
  try {
    while (activeComputerOperations > 0 || activeHumanApproval) {
      if (signal?.aborted) throw signal.reason ?? new Error('approval cancelled');
      await waitForStateChange(signal);
    }
    if (signal?.aborted) throw signal.reason ?? new Error('approval cancelled');
    activeHumanApproval = true;
  } catch (error) {
    // Stopped while it waited: the core's hold ends once it is declared.
    void begun?.then((holdId) => core?.end(holdId), () => undefined);
    dropLabel();
    throw error;
  } finally {
    waitingHumanApprovals = Math.max(0, waitingHumanApprovals - 1);
  }
  let holdId: string | undefined;
  try {
    if (begun) holdId = await begun;
    return await run();
  } finally {
    if (core && holdId !== undefined) core.end(holdId);
    activeHumanApproval = false;
    dropLabel();
    notifyStateChange();
  }
}

let activeComputerOperations = 0;
let activeHumanApproval = false;
let waitingHumanApprovals = 0;
const stateWaiters = new Set<() => void>();

function notifyStateChange(): void {
  for (const resolve of stateWaiters) resolve();
  stateWaiters.clear();
}

function waitForStateChange(): Promise<void> {
  return new Promise((resolve) => stateWaiters.add(resolve));
}

export function beginComputerOperation(): () => void {
  if (activeHumanApproval || waitingHumanApprovals > 0) {
    throw new Error('Computer Use is blocked while a human-only approval is pending');
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

export async function withHumanOnlyApproval<T>(run: () => Promise<T>): Promise<T> {
  waitingHumanApprovals += 1;
  try {
    while (activeComputerOperations > 0 || activeHumanApproval) {
      await waitForStateChange();
    }
    activeHumanApproval = true;
  } finally {
    waitingHumanApprovals = Math.max(0, waitingHumanApprovals - 1);
  }
  try {
    return await run();
  } finally {
    activeHumanApproval = false;
    notifyStateChange();
  }
}

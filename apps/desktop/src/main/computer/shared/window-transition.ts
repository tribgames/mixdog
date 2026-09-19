export interface ComputerWindowRecord {
  id: string;
  title: string;
  className: string;
  app: string;
  pid: number;
  parentPid?: number;
  ownerId: string;
  focused: boolean;
  minimized: boolean;
  maximized: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ComputerWindowTransition {
  observed: true;
  opened_windows: ComputerWindowRecord[];
  closed_windows: ComputerWindowRecord[];
  changed_windows: ComputerWindowRecord[];
  focused_before: string;
  focused_after: string;
  next_target?: ComputerWindowRecord;
  next_target_reason?:
    | 'owned_window_opened'
    | 'owner_window_restored'
    | 'child_process_window_opened'
    | 'single_same_process_window_opened'
    | 'launched_process_window'
    | 'launched_app_opened'
    | 'launched_app_focused'
    | 'launched_app_existing';
}

const CONFIRMED_LAUNCH_TRANSITIONS = new Set<NonNullable<ComputerWindowTransition['next_target_reason']>>([
  'launched_process_window',
  'launched_app_opened',
  'launched_app_focused',
]);

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function finiteNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizedAppName(value: unknown): string {
  const name = text(value).replaceAll('\\', '/').split('/').pop()?.toLowerCase() || '';
  return name.endsWith('.exe') ? name.slice(0, -4) : name;
}

export function launchTransitionConfirmsTarget(
  transition: ComputerWindowTransition | null,
  launchTarget: string
): boolean {
  const reason = transition?.next_target_reason;
  const nextTarget = transition?.next_target;
  if (!reason || !nextTarget) return false;
  if (CONFIRMED_LAUNCH_TRANSITIONS.has(reason)) return true;
  if (reason !== 'launched_app_existing') return false;

  const target = text(launchTarget)
    .trim()
    .replace(/^["']|["']$/g, '');
  const isWindowsPath = /^[a-z]:[\\/]/i.test(target);
  if (!isWindowsPath && /^[a-z][a-z0-9+.-]*:/i.test(target)) return false;
  const normalizedTarget = target.replaceAll('\\', '/');
  const leaf = normalizedTarget.split('/').pop()?.normalize('NFKC').toLocaleLowerCase() || '';
  if (!leaf) return false;
  if (/\.(?:exe|com)$/i.test(leaf) || (!normalizedTarget.includes('/') && !leaf.includes('.'))) {
    return true;
  }

  const title = nextTarget.title.normalize('NFKC').toLocaleLowerCase();
  const extensionAt = leaf.lastIndexOf('.');
  const stem = extensionAt > 0 ? leaf.slice(0, extensionAt) : leaf;
  return [leaf, stem].some((candidate) => candidate.length >= 3 && title.includes(candidate));
}

export function normalizeComputerWindowRecords(value: unknown): ComputerWindowRecord[] {
  let rows: unknown[] = [];
  if (Array.isArray(value)) rows = value;
  else if (value && typeof value === 'object') rows = [value];
  const records: ComputerWindowRecord[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const id = text(row.id);
    if (!id) continue;
    records.push({
      id,
      title: text(row.title),
      className: text(row.class_name ?? row.className),
      app: text(row.app),
      pid: finiteNumber(row.pid),
      parentPid: finiteNumber(row.parent_pid ?? row.parentPid),
      ownerId: text(row.owner_id ?? row.ownerId),
      focused: row.focused === true,
      minimized: row.minimized === true,
      maximized: row.maximized === true,
      x: finiteNumber(row.x),
      y: finiteNumber(row.y),
      width: finiteNumber(row.width),
      height: finiteNumber(row.height),
    });
  }
  return records;
}

function ownerChainContains(
  candidateId: string,
  expectedOwnerId: string,
  windowsById: Map<string, ComputerWindowRecord>
): boolean {
  const visited = new Set<string>();
  let current = windowsById.get(candidateId);
  while (current?.ownerId && !visited.has(current.ownerId)) {
    if (current.ownerId === expectedOwnerId) return true;
    visited.add(current.ownerId);
    current = windowsById.get(current.ownerId);
  }
  return false;
}

function changed(before: ComputerWindowRecord, after: ComputerWindowRecord): boolean {
  return (
    before.title !== after.title ||
    before.ownerId !== after.ownerId ||
    before.focused !== after.focused ||
    before.minimized !== after.minimized ||
    before.maximized !== after.maximized ||
    before.x !== after.x ||
    before.y !== after.y ||
    before.width !== after.width ||
    before.height !== after.height
  );
}

function uniquePreferred(candidates: ComputerWindowRecord[]): ComputerWindowRecord | undefined {
  if (candidates.length === 1) return candidates[0];
  const focused = candidates.filter((candidate) => candidate.focused);
  return focused.length === 1 ? focused[0] : undefined;
}

function preferredSuccessor(
  candidates: ComputerWindowRecord[],
  targetStillPresent: boolean
): ComputerWindowRecord | undefined {
  const focused = candidates.filter((candidate) => candidate.focused);
  if (focused.length === 1) return focused[0];
  return targetStillPresent ? undefined : uniquePreferred(candidates);
}

type ComputerWindowSuccessor = {
  window: ComputerWindowRecord;
  reason: NonNullable<ComputerWindowTransition['next_target_reason']>;
};

// The command launched a process or app rather than acting on a window: its
// successor is the window that opened for that process/app, else the app
// window that took focus, else an existing app window.
function launchedSuccessor(
  opened: ComputerWindowRecord[],
  after: ComputerWindowRecord[],
  focusedBefore: string,
  { targetPid, contextApp }: { targetPid: number; contextApp: string }
): ComputerWindowSuccessor | null {
  const launchedProcess = uniquePreferred(
    opened.filter((window) => targetPid > 0 && (window.pid === targetPid || window.parentPid === targetPid))
  );
  if (launchedProcess) return { window: launchedProcess, reason: 'launched_process_window' };
  const launchedApp = uniquePreferred(
    opened.filter((window) => Boolean(contextApp) && normalizedAppName(window.app) === contextApp)
  );
  if (launchedApp) return { window: launchedApp, reason: 'launched_app_opened' };
  const focusedApp = after.find(
    (window) =>
      window.focused &&
      window.id !== focusedBefore &&
      Boolean(contextApp) &&
      normalizedAppName(window.app) === contextApp
  );
  if (focusedApp) return { window: focusedApp, reason: 'launched_app_focused' };
  const existingApp = uniquePreferred(
    after.filter((window) => Boolean(contextApp) && normalizedAppName(window.app) === contextApp)
  );
  return existingApp ? { window: existingApp, reason: 'launched_app_existing' } : null;
}

// The target closed and nothing opened: the nearest surviving owner in its
// chain takes over.
function restoredOwner(
  beforeById: Map<string, ComputerWindowRecord>,
  afterById: Map<string, ComputerWindowRecord>,
  targetWindowId: string
): ComputerWindowRecord | null {
  const visited = new Set<string>([targetWindowId]);
  let ownerId = beforeById.get(targetWindowId)?.ownerId;
  while (ownerId && !visited.has(ownerId)) {
    visited.add(ownerId);
    const owner = afterById.get(ownerId);
    if (owner) return owner;
    ownerId = beforeById.get(ownerId)?.ownerId;
  }
  return null;
}

// Successor among the windows the target's action opened: one it owns, then
// its child process's window, then a single same-process window.
function openedSuccessor(
  opened: ComputerWindowRecord[],
  beforeById: Map<string, ComputerWindowRecord>,
  afterById: Map<string, ComputerWindowRecord>,
  targetWindowId: string
): ComputerWindowSuccessor | null {
  const owned = opened.filter((window) => ownerChainContains(window.id, targetWindowId, afterById));
  const ownedTarget = preferredSuccessor(owned, afterById.has(targetWindowId));
  if (ownedTarget) return { window: ownedTarget, reason: 'owned_window_opened' };
  const targetBefore = beforeById.get(targetWindowId);
  if (!targetBefore?.pid) return null;
  const childProcess = uniquePreferred(opened.filter((window) => window.parentPid === targetBefore.pid));
  if (childProcess) return { window: childProcess, reason: 'child_process_window_opened' };
  const sameProcess = opened.filter(
    (window) => window.pid === targetBefore.pid && !ownerChainContains(window.id, targetWindowId, afterById)
  );
  const processTarget = uniquePreferred(sameProcess);
  return processTarget ? { window: processTarget, reason: 'single_same_process_window_opened' } : null;
}

export function computeComputerWindowTransition(
  before: ComputerWindowRecord[],
  after: ComputerWindowRecord[],
  targetWindowId: string,
  targetPid = 0,
  targetApp = ''
): ComputerWindowTransition {
  const beforeById = new Map(before.map((window) => [window.id, window]));
  const afterById = new Map(after.map((window) => [window.id, window]));
  const contextPid =
    targetPid > 0 ? targetPid : beforeById.get(targetWindowId)?.pid || afterById.get(targetWindowId)?.pid || 0;
  const contextApp = normalizedAppName(targetApp);
  const belongsToTarget = (window: ComputerWindowRecord, windowsById: Map<string, ComputerWindowRecord>): boolean =>
    window.id === targetWindowId ||
    (contextPid > 0 && (window.pid === contextPid || window.parentPid === contextPid)) ||
    (!targetWindowId && Boolean(contextApp) && normalizedAppName(window.app) === contextApp) ||
    (Boolean(targetWindowId) && ownerChainContains(window.id, targetWindowId, windowsById));
  const allOpened = after.filter((window) => !beforeById.has(window.id));
  const opened = allOpened.filter((window) => belongsToTarget(window, afterById));
  const closed = before.filter((window) => !afterById.has(window.id) && belongsToTarget(window, beforeById));
  const changedWindows = after.filter((window) => {
    const previous = beforeById.get(window.id);
    return previous && belongsToTarget(window, afterById) ? changed(previous, window) : false;
  });
  const transition: ComputerWindowTransition = {
    observed: true,
    opened_windows: opened,
    closed_windows: closed,
    changed_windows: changedWindows,
    focused_before: before.find((window) => window.focused)?.id || '',
    focused_after: after.find((window) => window.focused)?.id || '',
  };

  let successor: ComputerWindowSuccessor | null = null;
  if (!targetWindowId && (targetPid > 0 || Boolean(contextApp))) {
    successor = launchedSuccessor(opened, after, transition.focused_before, { targetPid, contextApp });
  } else if (opened.length === 0) {
    const owner =
      targetWindowId && !afterById.has(targetWindowId) ? restoredOwner(beforeById, afterById, targetWindowId) : null;
    if (owner) successor = { window: owner, reason: 'owner_window_restored' };
  } else if (targetWindowId) {
    successor = openedSuccessor(opened, beforeById, afterById, targetWindowId);
  }
  if (successor) {
    transition.next_target = successor.window;
    transition.next_target_reason = successor.reason;
  }
  return transition;
}

export function relatedWindowIdsForFrame(windows: ComputerWindowRecord[], targetWindowId: string): string[] {
  if (!targetWindowId) return [];
  const windowsById = new Map(windows.map((window) => [window.id, window]));
  return [
    targetWindowId,
    ...windows
      .filter((window) => window.id !== targetWindowId && ownerChainContains(window.id, targetWindowId, windowsById))
      .map((window) => window.id),
  ];
}

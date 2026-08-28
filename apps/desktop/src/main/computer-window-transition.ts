export interface ComputerWindowRecord {
  id: string;
  title: string;
  className: string;
  app: string;
  pid: number;
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
  next_target_reason?: 'owned_window_opened'
    | 'single_same_process_window_opened'
    | 'launched_process_window'
    | 'launched_app_opened'
    | 'launched_app_focused'
    | 'launched_app_existing'
    | 'launched_focused_window'
    | 'launched_existing_window_changed';
}

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

export function normalizeComputerWindowRecords(value: unknown): ComputerWindowRecord[] {
  const rows = Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : [];
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
  windowsById: Map<string, ComputerWindowRecord>,
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
  return before.title !== after.title
    || before.ownerId !== after.ownerId
    || before.focused !== after.focused
    || before.minimized !== after.minimized
    || before.maximized !== after.maximized
    || before.x !== after.x
    || before.y !== after.y
    || before.width !== after.width
    || before.height !== after.height;
}

function changedBeyondFocus(
  before: ComputerWindowRecord,
  after: ComputerWindowRecord,
): boolean {
  return before.title !== after.title
    || before.ownerId !== after.ownerId
    || before.minimized !== after.minimized
    || before.maximized !== after.maximized
    || before.x !== after.x
    || before.y !== after.y
    || before.width !== after.width
    || before.height !== after.height;
}

function uniquePreferred(
  candidates: ComputerWindowRecord[],
): ComputerWindowRecord | undefined {
  if (candidates.length === 1) return candidates[0];
  const focused = candidates.filter((candidate) => candidate.focused);
  return focused.length === 1 ? focused[0] : undefined;
}

function preferredSuccessor(
  candidates: ComputerWindowRecord[],
  targetStillPresent: boolean,
): ComputerWindowRecord | undefined {
  const focused = candidates.filter((candidate) => candidate.focused);
  if (focused.length === 1) return focused[0];
  return targetStillPresent ? undefined : uniquePreferred(candidates);
}

export function computeComputerWindowTransition(
  before: ComputerWindowRecord[],
  after: ComputerWindowRecord[],
  targetWindowId: string,
  targetPid = 0,
  targetApp = '',
): ComputerWindowTransition {
  const beforeById = new Map(before.map((window) => [window.id, window]));
  const afterById = new Map(after.map((window) => [window.id, window]));
  const contextPid = targetPid > 0
    ? targetPid
    : beforeById.get(targetWindowId)?.pid || afterById.get(targetWindowId)?.pid || 0;
  const contextApp = normalizedAppName(targetApp);
  const belongsToTarget = (
    window: ComputerWindowRecord,
    windowsById: Map<string, ComputerWindowRecord>,
  ): boolean => window.id === targetWindowId
    || (contextPid > 0 && window.pid === contextPid)
    || (!targetWindowId && Boolean(contextApp)
      && normalizedAppName(window.app) === contextApp)
    || (Boolean(targetWindowId) && ownerChainContains(window.id, targetWindowId, windowsById));
  const allOpened = after.filter((window) => !beforeById.has(window.id));
  const opened = allOpened.filter((window) => belongsToTarget(window, afterById));
  const closed = before.filter(
    (window) => !afterById.has(window.id) && belongsToTarget(window, beforeById),
  );
  const changedWindows = after.filter((window) => {
    const previous = beforeById.get(window.id);
    return previous && belongsToTarget(window, afterById)
      ? changed(previous, window)
      : false;
  });
  const transition: ComputerWindowTransition = {
    observed: true,
    opened_windows: opened,
    closed_windows: closed,
    changed_windows: changedWindows,
    focused_before: before.find((window) => window.focused)?.id || '',
    focused_after: after.find((window) => window.focused)?.id || '',
  };

  if (!targetWindowId && (targetPid > 0 || Boolean(contextApp))) {
    const launchedProcessTarget = uniquePreferred(
      opened.filter((window) => targetPid > 0 && window.pid === targetPid),
    );
    if (launchedProcessTarget) {
      transition.next_target = launchedProcessTarget;
      transition.next_target_reason = 'launched_process_window';
      return transition;
    }
    const launchedAppTarget = uniquePreferred(
      opened.filter((window) =>
        Boolean(contextApp) && normalizedAppName(window.app) === contextApp),
    );
    if (launchedAppTarget) {
      transition.next_target = launchedAppTarget;
      transition.next_target_reason = 'launched_app_opened';
      return transition;
    }
    const focusedBefore = transition.focused_before;
    const focusedAppTarget = after.find((window) =>
      window.focused
      && window.id !== focusedBefore
      && Boolean(contextApp)
      && normalizedAppName(window.app) === contextApp);
    if (focusedAppTarget) {
      transition.next_target = focusedAppTarget;
      transition.next_target_reason = 'launched_app_focused';
      return transition;
    }
    const existingAppTarget = uniquePreferred(
      after.filter((window) =>
        Boolean(contextApp) && normalizedAppName(window.app) === contextApp),
    );
    if (existingAppTarget) {
      transition.next_target = existingAppTarget;
      transition.next_target_reason = 'launched_app_existing';
      return transition;
    }
    const focusedOpened = allOpened.filter((window) =>
      window.focused && window.id !== transition.focused_before);
    if (focusedOpened.length === 1) {
      transition.next_target = focusedOpened[0];
      transition.next_target_reason = 'launched_focused_window';
      return transition;
    }
    const focusedChanged = after.filter((window) => {
      const previous = beforeById.get(window.id);
      return window.focused
        && window.id !== transition.focused_before
        && Boolean(previous)
        && changedBeyondFocus(previous as ComputerWindowRecord, window);
    });
    if (focusedChanged.length === 1) {
      transition.next_target = focusedChanged[0];
      transition.next_target_reason = 'launched_existing_window_changed';
      transition.changed_windows = focusedChanged;
    }
    return transition;
  }
  if (opened.length === 0) return transition;
  if (!targetWindowId) return transition;
  const targetStillPresent = afterById.has(targetWindowId);
  const owned = opened.filter((window) => ownerChainContains(window.id, targetWindowId, afterById));
  const ownedTarget = preferredSuccessor(owned, targetStillPresent);
  if (ownedTarget) {
    transition.next_target = ownedTarget;
    transition.next_target_reason = 'owned_window_opened';
    return transition;
  }

  const targetBefore = beforeById.get(targetWindowId);
  if (!targetBefore?.pid) return transition;
  const sameProcess = opened.filter((window) =>
    window.pid === targetBefore.pid
    && !ownerChainContains(window.id, targetWindowId, afterById));
  const processTarget = uniquePreferred(sameProcess);
  if (processTarget) {
    transition.next_target = processTarget;
    transition.next_target_reason = 'single_same_process_window_opened';
  }
  return transition;
}

export function relatedWindowIdsForFrame(
  windows: ComputerWindowRecord[],
  targetWindowId: string,
): string[] {
  if (!targetWindowId) return [];
  const windowsById = new Map(windows.map((window) => [window.id, window]));
  return [
    targetWindowId,
    ...windows
      .filter((window) => window.id !== targetWindowId
        && ownerChainContains(window.id, targetWindowId, windowsById))
      .map((window) => window.id),
  ];
}

import {
  EMPTY_SNAPSHOT,
  hasActiveSnapshotWork,
  type Snapshot,
} from "./desktop-types";

export interface DesktopSnapshotStore {
  getSnapshot(): Snapshot;
  publish(snapshot: Snapshot): void;
  subscribe(listener: () => void): () => void;
}

export function createDesktopSnapshotStore(initial: Snapshot = EMPTY_SNAPSHOT): DesktopSnapshotStore {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => current,
    publish(snapshot) {
      current = snapshot;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const chromeSignatureCache = new WeakMap<object, string>();
const headerSignatureCache = new WeakMap<object, string>();
const dockSignatureCache = new WeakMap<object, string>();

function signature(
  cache: WeakMap<object, string>,
  snapshot: Snapshot,
  values: unknown[],
): string {
  const cached = cache.get(snapshot);
  if (cached !== undefined) return cached;
  let value: string;
  try {
    value = JSON.stringify(values);
  } catch {
    value = values.map((entry) => String(entry)).join("\n");
  }
  cache.set(snapshot, value);
  return value;
}

function preservesInitialBoundary(left: Snapshot, right: Snapshot): boolean {
  if (left === EMPTY_SNAPSHOT || right === EMPTY_SNAPSHOT) return left === right;
  return true;
}

// App-owned navigation/chrome excludes transcript text and live counters. A
// streaming-tail publication can therefore update Conversation without
// invalidating the titlebar, sidebar, overlays, and workspace routing tree.
export function desktopChromeSnapshotsEqual(left: Snapshot, right: Snapshot): boolean {
  if (left === right) return true;
  if (!preservesInitialBoundary(left, right)) return false;
  const values = (snapshot: Snapshot) => [
    snapshot.sessionId,
    snapshot.currentProject,
    snapshot.project,
    snapshot.recentProjects,
    snapshot.busy,
    snapshot.commandBusy,
    snapshot.toasts,
  ];
  return signature(chromeSignatureCache, left, values(left))
    === signature(chromeSignatureCache, right, values(right));
}

// Sidebar progress only needs the selected session and whether it is active;
// spinner wording and token counters belong to the isolated header selector.
export function desktopSidebarSnapshotsEqual(left: Snapshot, right: Snapshot): boolean {
  if (left === right) return true;
  if (!preservesInitialBoundary(left, right)) return false;
  return String(left.sessionId || "") === String(right.sessionId || "")
    && hasActiveSnapshotWork(left) === hasActiveSnapshotWork(right);
}

export function desktopConversationSnapshotsEqual(left: Snapshot, right: Snapshot): boolean {
  if (left === right) return true;
  if (!preservesInitialBoundary(left, right)) return false;
  return left.items === right.items
    && left.streamingTail === right.streamingTail
    && left.failedTurnKeys === right.failedTurnKeys
    && left.transcriptTurnKeys === right.transcriptTurnKeys
    && left.busy === right.busy
    && left.commandBusy === right.commandBusy
    && left.thinking === right.thinking
    && left.spinner === right.spinner
    && left.commandStatus === right.commandStatus
    && left.toolApproval === right.toolApproval
    && left.progressHint === right.progressHint
    && left.queued === right.queued
    && left.sessionId === right.sessionId
    && left.currentProject === right.currentProject
    && left.project === right.project
    && left.cwd === right.cwd
    && left.promptHistoryList === right.promptHistoryList
    && left.provider === right.provider
    && left.model === right.model
    && left.effort === right.effort
    && left.fast === right.fast
    && left.fastCapable === right.fastCapable
    && left.workflow === right.workflow;
}

export function desktopHeaderSnapshotsEqual(left: Snapshot, right: Snapshot): boolean {
  if (left === right) return true;
  if (!preservesInitialBoundary(left, right)) return false;
  const values = (snapshot: Snapshot) => [
    snapshot.sessionId,
    snapshot.busy,
    snapshot.commandBusy,
    snapshot.thinking,
    snapshot.spinner,
    snapshot.commandStatus,
    snapshot.stats,
    snapshot.contextWindow,
    snapshot.displayContextWindow,
    snapshot.autoCompactTokenLimit,
    snapshot.agentWorkers,
    snapshot.agentJobs,
    snapshot.activeTools,
    snapshot.shellJobs,
    snapshot.remoteEnabled,
    snapshot.remoteSessionId,
  ];
  return signature(headerSignatureCache, left, values(left))
    === signature(headerSignatureCache, right, values(right));
}

export function desktopDockSnapshotsEqual(left: Snapshot, right: Snapshot): boolean {
  if (left === right) return true;
  if (!preservesInitialBoundary(left, right)) return false;
  const values = (snapshot: Snapshot) => [
    snapshot.currentProject,
    snapshot.project,
    snapshot.agentWorkers,
    snapshot.agentJobs,
  ];
  return signature(dockSignatureCache, left, values(left))
    === signature(dockSignatureCache, right, values(right));
}

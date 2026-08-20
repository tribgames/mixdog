import {
  EMPTY_SNAPSHOT,
  type Snapshot,
} from "./desktop-types";
import { shellJobsStatusEqual } from "../shared/shell-jobs-status";

export interface DesktopSnapshotStore {
  getSnapshot(): Snapshot;
  publish(snapshot: Snapshot): void;
  subscribe(listener: () => void): () => void;
}

const URGENT_SNAPSHOT_FIELDS: ReadonlyArray<keyof Snapshot> = [
  "sessionId",
  "busy",
  "commandBusy",
  "commandStatus",
  "toolApproval",
  "queued",
  "toasts",
];

/** Command admission, retry/approval state, and route changes stay immediate;
 * transcript/timing-only publications may share the next render frame. */
export function desktopSnapshotUpdateIsUrgent(
  previous: Snapshot,
  next: Snapshot,
): boolean {
  if (previous === EMPTY_SNAPSHOT || next === EMPTY_SNAPSHOT) return previous !== next;
  return !snapshotFieldsEqual(previous, next, URGENT_SNAPSHOT_FIELDS);
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

const CHROME_SNAPSHOT_FIELDS: ReadonlyArray<keyof Snapshot> = [
  "sessionId",
  "currentProject",
  "project",
  "recentProjects",
  "busy",
  "commandBusy",
  "toasts",
];

const HEADER_SNAPSHOT_FIELDS: ReadonlyArray<keyof Snapshot> = [
  "sessionId",
  "busy",
  "commandBusy",
  "thinking",
  "spinner",
  "commandStatus",
  "stats",
  "contextWindow",
  "displayContextWindow",
  "autoCompactTokenLimit",
  "agentWorkers",
  "agentJobs",
  "activeTools",
  "remoteEnabled",
  "remoteSessionId",
];

const DOCK_SNAPSHOT_FIELDS: ReadonlyArray<keyof Snapshot> = [
  "currentProject",
  "project",
  "agentWorkers",
  "agentJobs",
  "activeTools",
];

function dockToolItem(snapshot: Snapshot) {
  const items = Array.isArray(snapshot.items) ? snapshot.items : [];
  const tail = snapshot.streamingTail;
  return tail?.kind === "tool"
    ? tail
    : items.length > 0 && items[items.length - 1]?.kind === "tool"
      ? items[items.length - 1]
      : null;
}

function snapshotFieldsEqual(
  left: Snapshot,
  right: Snapshot,
  fields: ReadonlyArray<keyof Snapshot>,
): boolean {
  for (const field of fields) {
    if (!Object.is(left[field], right[field])) return false;
  }
  return true;
}

function dockToolSignalsEqual(left: Snapshot, right: Snapshot): boolean {
  const previous = dockToolItem(left);
  const next = dockToolItem(right);
  if (previous === next) return true;
  if (!previous || !next) return false;
  return previous.id === next.id
    && previous.name === next.name
    && previous.count === next.count
    && previous.completedCount === next.completedCount
    && previous.startedAt === next.startedAt
    && previous.completedAt === next.completedAt
    && (previous.result != null) === (next.result != null)
    && (previous.rawResult != null) === (next.rawResult != null)
    && previous.status === next.status
    && previous.isError === next.isError;
}

function preservesInitialBoundary(left: Snapshot, right: Snapshot): boolean {
  if (left === EMPTY_SNAPSHOT || right === EMPTY_SNAPSHOT) return left === right;
  return true;
}

// The host polls background shell counts on its own cadence and every
// publication clones the bucket, so identity comparison would repaint the
// header and dock on each tick. Compare the two values instead.
function shellJobsEqual(left: Snapshot, right: Snapshot): boolean {
  return shellJobsStatusEqual(left.shellJobs, right.shellJobs);
}

// App-owned navigation/chrome excludes transcript text and live counters. A
// streaming-tail publication can therefore update Conversation without
// invalidating the titlebar, sidebar, overlays, and workspace routing tree.
export function desktopChromeSnapshotsEqual(left: Snapshot, right: Snapshot): boolean {
  if (left === right) return true;
  if (!preservesInitialBoundary(left, right)) return false;
  return snapshotFieldsEqual(left, right, CHROME_SNAPSHOT_FIELDS);
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

function streamingTailIdentityEqual(left: Snapshot, right: Snapshot): boolean {
  const previous = left.streamingTail;
  const next = right.streamingTail;
  if (previous === next) return true;
  if (!previous || !next || previous.id == null || next.id == null) return false;
  return previous.id === next.id
    && previous.kind === next.kind
    && Boolean(previous.streaming) === Boolean(next.streaming);
}

// The historical conversation shell needs tail presence/identity for layout,
// but token text is rendered by its own selector-driven live row.
export function desktopConversationShellSnapshotsEqual(left: Snapshot, right: Snapshot): boolean {
  if (left === right) return true;
  if (!preservesInitialBoundary(left, right)) return false;
  return left.items === right.items
    && streamingTailIdentityEqual(left, right)
    && left.failedTurnKeys === right.failedTurnKeys
    && left.transcriptTurnKeys === right.transcriptTurnKeys
    && left.busy === right.busy
    && left.commandBusy === right.commandBusy
    && left.toolApproval === right.toolApproval
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

function runtimeProgressText(snapshot: Snapshot): string {
  const progress = snapshot.progressHint;
  return progress && typeof progress === "object"
    ? String((progress as { text?: unknown }).text || "")
    : "";
}

export function desktopRuntimeProgressSnapshotsEqual(left: Snapshot, right: Snapshot): boolean {
  if (left === right) return true;
  if (!preservesInitialBoundary(left, right)) return false;
  return left.sessionId === right.sessionId
    && runtimeProgressText(left) === runtimeProgressText(right);
}

export function desktopStreamingTailSnapshotsEqual(left: Snapshot, right: Snapshot): boolean {
  if (left === right) return true;
  if (!preservesInitialBoundary(left, right)) return false;
  return left.items === right.items
    && left.streamingTail === right.streamingTail
    && left.sessionId === right.sessionId;
}

export function desktopHeaderSnapshotsEqual(left: Snapshot, right: Snapshot): boolean {
  if (left === right) return true;
  if (!preservesInitialBoundary(left, right)) return false;
  return snapshotFieldsEqual(left, right, HEADER_SNAPSHOT_FIELDS) && shellJobsEqual(left, right);
}

export function desktopDockSnapshotsEqual(left: Snapshot, right: Snapshot): boolean {
  if (left === right) return true;
  if (!preservesInitialBoundary(left, right)) return false;
  return snapshotFieldsEqual(left, right, DOCK_SNAPSHOT_FIELDS)
    && shellJobsEqual(left, right)
    && dockToolSignalsEqual(left, right);
}

import { EMPTY_SNAPSHOT, type Snapshot } from './desktop-types';
import { shellJobsStatusEqual } from '../shared/shell-jobs-status';

export interface DesktopSnapshotStore {
  getSnapshot(): Snapshot;
  publish(snapshot: Snapshot): void;
  subscribe(listener: () => void): () => void;
}

const URGENT_SNAPSHOT_FIELDS: ReadonlyArray<keyof Snapshot> = [
  'sessionId',
  'busy',
  'commandBusy',
  'commandStatus',
  'toolApproval',
  'queued',
  'toasts',
  'uiOpenRequest',
  'setupUiRequest',
  'setupChanged',
];

/** Command admission, retry/approval state, and route changes stay immediate;
 * transcript/timing-only publications may share the next render frame. */
export function desktopSnapshotUpdateIsUrgent(previous: Snapshot, next: Snapshot): boolean {
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
  'sessionId',
  'currentProject',
  'project',
  'recentProjects',
  'busy',
  'commandBusy',
  'toasts',
  'uiOpenRequest',
  'setupUiRequest',
  'setupChanged',
];

const HEADER_SNAPSHOT_FIELDS: ReadonlyArray<keyof Snapshot> = [
  'sessionId',
  'provider',
  'model',
  'sessionProvider',
  'sessionModel',
  'effort',
  'busy',
  'commandBusy',
  'toolApproval',
  'thinking',
  'spinner',
  'commandStatus',
  'contextWindow',
  'displayContextWindow',
  'contextTokens',
  'rawContextWindow',
  'usedTokens',
  'fallbackUsedTokens',
  'autoCompactTokenLimit',
  'agentWorkers',
  'agentJobs',
  'activeTools',
  'goal',
  'todo',
  'quotaResume',
];

const DOCK_SNAPSHOT_FIELDS: ReadonlyArray<keyof Snapshot> = [
  'currentProject',
  'project',
  'agentWorkers',
  'agentJobs',
  'activeTools',
];

// A mounted pane hands these views to React, not the store's publication.
// An alternate Fiber (or a callback from that render) can outlive the swap.
function snapshotView(fields: readonly string[]) {
  const views = new WeakMap<Snapshot, Snapshot>();
  return (snapshot: Snapshot): Snapshot => {
    if (snapshot === EMPTY_SNAPSHOT) return snapshot;
    let view = views.get(snapshot);
    if (!view) {
      view = {};
      for (const key of fields) if (key in snapshot) view[key] = snapshot[key];
      views.set(snapshot, view);
    }
    return view;
  };
}

export const paneHeaderView = snapshotView([...HEADER_SNAPSHOT_FIELDS, 'shellJobs', 'stats']);

const COMPOSER_ROUTE_FIELDS = [
  'sessionId',
  'busy',
  'commandBusy',
  'workspace',
  'promptRestore',
  'promptHistoryList',
  'provider',
  'model',
  'effort',
  'fast',
  'fastCapable',
  'autoEffort',
  'modelParameters',
  'contextPercent',
  'contextTokens',
  'workflow',
  'orchestrationMode',
  'pendingWorkflowSwitch',
  'pendingOrchestrationModeSwitch',
];
export const paneComposerRouteView = snapshotView(COMPOSER_ROUTE_FIELDS);

const CONVERSATION_FIELDS = [
  ...COMPOSER_ROUTE_FIELDS,
  'items',
  'transcriptHasOlder',
  'transcriptHistory',
  'transcriptWindowStart',
  'transcriptGeneration',
  // A positioned window's facts (use-transcript-history.ts positionedFactsOf).
  'transcriptPositioned',
  'transcriptWindowVersion',
  'transcriptViewItems',
  'transcriptHistoryBefore',
  'transcriptHistoryAfter',
  'transcriptPreview',
  'transcriptTurnKeys',
  'failedTurnKeys',
  'queued',
  'toolApproval',
  'toolApprovalResult',
  'toolApprovalsWaiting',
  'handoffQuestions',
  'quotaResume',
  'currentProject',
  'project',
  'cwd',
  'sessionProvider',
  'sessionModel',
  'turnEffort',
  'spinner',
  'commandStatus',
  'thinking',
  'agentWorkers',
  'agentJobs',
  'activeTools',
];
export const paneConversationView = snapshotView([...CONVERSATION_FIELDS, 'streamingTail', 'shellJobs']);

function dockToolItem(snapshot: Snapshot) {
  const items = Array.isArray(snapshot.items) ? snapshot.items : [];
  const tail = snapshot.streamingTail;
  if (tail?.kind === 'tool') return tail;
  const last = items[items.length - 1];
  return last?.kind === 'tool' ? last : null;
}

function snapshotFieldsEqual(left: Snapshot, right: Snapshot, fields: ReadonlyArray<keyof Snapshot>): boolean {
  for (const field of fields) {
    if (!Object.is(left[field], right[field])) return false;
  }
  return true;
}

const HEADER_STATS_FIELDS = [
  'currentContextTokens',
  'currentEstimatedContextTokens',
  'currentContextSource',
  'currentContextUpdatedAt',
  'costUsd',
  // The composer's usage readout: the session's cumulative cache/speed
  // totals, replaced (never mutated) on every model call.
  'usageReadout',
] as const;

function headerStatsEqual(left: Snapshot, right: Snapshot): boolean {
  if (left.stats === right.stats) return true;
  const previous = left.stats && typeof left.stats === 'object' ? left.stats : {};
  const next = right.stats && typeof right.stats === 'object' ? right.stats : {};
  return HEADER_STATS_FIELDS.every((field) => Object.is(previous[field], next[field]));
}

function dockToolSignalsEqual(left: Snapshot, right: Snapshot): boolean {
  const previous = dockToolItem(left);
  const next = dockToolItem(right);
  if (previous === next) return true;
  if (!previous || !next) return false;
  return (
    previous.id === next.id &&
    previous.name === next.name &&
    previous.count === next.count &&
    previous.completedCount === next.completedCount &&
    previous.startedAt === next.startedAt &&
    previous.completedAt === next.completedAt &&
    (previous.result != null) === (next.result != null) &&
    (previous.rawResult != null) === (next.rawResult != null) &&
    previous.status === next.status &&
    previous.isError === next.isError
  );
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

function streamingTailIdentityEqual(left: Snapshot, right: Snapshot): boolean {
  const previous = left.streamingTail;
  const next = right.streamingTail;
  if (previous === next) return true;
  if (!previous || !next || previous.id == null || next.id == null) return false;
  return (
    previous.id === next.id && previous.kind === next.kind && Boolean(previous.streaming) === Boolean(next.streaming)
  );
}

// The historical conversation shell needs tail presence/identity for layout,
// but token text is rendered by its own selector-driven live row.
export function desktopConversationShellSnapshotsEqual(left: Snapshot, right: Snapshot): boolean {
  if (left === right) return true;
  if (!preservesInitialBoundary(left, right)) return false;
  return (
    snapshotFieldsEqual(left, right, CONVERSATION_FIELDS) &&
    streamingTailIdentityEqual(left, right) &&
    shellJobsEqual(left, right)
  );
}

export function desktopStreamingTailSnapshotsEqual(left: Snapshot, right: Snapshot): boolean {
  if (left === right) return true;
  if (!preservesInitialBoundary(left, right)) return false;
  return left.items === right.items && left.streamingTail === right.streamingTail && left.sessionId === right.sessionId;
}

export function desktopHeaderSnapshotsEqual(left: Snapshot, right: Snapshot): boolean {
  if (left === right) return true;
  if (!preservesInitialBoundary(left, right)) return false;
  return (
    snapshotFieldsEqual(left, right, HEADER_SNAPSHOT_FIELDS) &&
    headerStatsEqual(left, right) &&
    shellJobsEqual(left, right)
  );
}

export function desktopDockSnapshotsEqual(left: Snapshot, right: Snapshot): boolean {
  if (left === right) return true;
  if (!preservesInitialBoundary(left, right)) return false;
  return (
    snapshotFieldsEqual(left, right, DOCK_SNAPSHOT_FIELDS) &&
    shellJobsEqual(left, right) &&
    dockToolSignalsEqual(left, right)
  );
}

// Renderer consumption of the per-session live lanes (mixdog:session-state).
// One process-wide store fans lane frames out per sessionId so a pane
// subscribed to session A never re-renders for session B's traffic.
import { useCallback, useRef, useSyncExternalStore } from 'react';

import type { DesktopSessionStateUpdate, DesktopStreamPosition } from '../shared/contract';
import { desktopAgentIdentity } from '../shared/agent-activity';
import type { Snapshot, TranscriptItem } from './desktop-types';
import { estimateSessionSnapshotBytes } from './app-session-snapshots';
import { SessionLaneCache } from './session-lane-cache';
import { reportSessionReadFrame } from './session-read-diagnostics';
import { sharedTranscriptSnapshotDecorator, type TranscriptSnapshotDecorator } from './snapshot-transcript-decoration';
import { cancelLayoutFrame, scheduleLayoutFrame } from './interaction-frame-scheduler';
import { noteStreamLaneFrame, noteStreamPublish } from './transcript-stream-metrics';
import { heldWindowGoesOn, transcriptWindowAlignment, windowAnchored } from './transcript-alignment';
import { reconcileSessionProjection } from '../main/state-delta';
import { noteCarried } from './list-carry';
import { rowsHeldFrom, streamPositionReached } from '../../../../packages/protocol-client/src/index.ts';
import { registerIdleReclaim } from './idle-reclaim';
import { sessionHasTab } from './transcript-list-reader-place';

type SessionLaneSource = (listener: (update: DesktopSessionStateUpdate) => void) => () => void;

interface SessionLaneStore {
  get(sessionId: string): Snapshot | null;
  /** The authoritative content revision the cached lane was accepted at. */
  revision(sessionId: string): number | null;
  subscribe(sessionId: string, listener: () => void): () => void;
  /** Wire the preload lane once; returns a stop function. Idempotent — a
   *  second start while wired returns the existing stop. */
  start(source?: SessionLaneSource | undefined): () => void;
  /** Test/manual injection of one lane frame. */
  apply(update: DesktopSessionStateUpdate): void;
  /** Paint a stored tail only if a real lane has not already landed. */
  seedPreview(sessionId: string, snapshot: NonNullable<DesktopSessionStateUpdate['snapshot']>): void;
  /** The first state of a session the caller's operation created (a new task, a fork), as that operation answered it. Only a
   *  creating operation seeds: a settings reply never does. A session whose stream already delivered a state, or ended as
   *  gone, is its stream's: the answer is not applied. */
  seedCreatedSession(sessionId: string, snapshot: DesktopSessionStateUpdate['snapshot']): void;
  /** Whether the session's shown state is current at or past `mark`, the position its connection had received on the session's
   *  feed once a call answered (`DesktopApi.sessionStreamPosition`): the state that call's mutation produced is shown. Both are
   *  the protocol client's positions, so the comparison needs nothing of this store's own history. */
  streamReached(sessionId: string, mark: DesktopStreamPosition): boolean;
  /** The feed position the state shown for the session is current at; a new value whenever a publication moves it. */
  streamPosition(sessionId: string): DesktopStreamPosition | null;
  /** Hears the session's shown position move (a publication that changes no state included). */
  subscribeStreamPosition(sessionId: string, listener: () => void): () => void;
  /** Rows held by the lanes no pane shows. */
  hiddenRows(): number;
  stats(): {
    entries: number;
    estimatedBytes: number;
    subscribedSessions: number;
    notificationKeys: number;
  };
  /** Session ids at least one mounted pane is currently subscribed to. */
  subscribedSessionIds(): string[];
  /** Sessions whose cached lane carries a pending tool approval; a new set
   *  identity only when membership changes. */
  approvalSessionIds(): ReadonlySet<string>;
  /** The subset of those whose pending request is an ask_user question. */
  questionSessionIds(): ReadonlySet<string>;
  subscribeApprovals(listener: () => void): () => void;
  /** The sessions this window shows in a pane (the host forwards their lane
   *  frames from now on). */
  setShownSessionIds(sessionIds: Iterable<string>): void;
  /** Shown sessions whose lane received a frame since they became shown: only
   *  their lane is current. Changes notify the approval listeners; a new set
   *  identity only when membership changes. */
  liveSessionIds(): ReadonlySet<string>;
  /** The core ended the session's lane for good (deleted, or lost to this connection) and nothing is held of it; heard
   *  with `subscribeApprovals`. */
  sessionEnded(sessionId: string): boolean;
  /** Drop cached lanes with no subscribers (remote sync-gap recovery: an
   *  emptied lane re-reads through session.read on its next open). */
  evictInactive(): void;
  /** Trims the lanes no pane shows to what their readers may come back to (`keptOfHiddenLane`). Runs on a timer, when
   *  the window is hidden and on an idle reclaim once the store is started. */
  sweepHidden(): void;
  clear(): void;
}

const SESSION_LANE_CACHE_LIMIT = 64;
const SESSION_LANE_CACHE_BYTE_LIMIT = 24 * 1024 * 1024;
const SESSION_LANE_ESTIMATE_INTERVAL_MS = 1_000;
/** The rows kept of a session no pane shows (its lane is the state it had when the core let it go: a return reads the
 *  session again, and rows that come back equal keep the objects, and so the rendered bodies, held here). */
export const HIDDEN_SESSION_ROW_BUDGET = 512;
/** How often the lanes no pane shows are swept while the window is in use; hiding the window and an idle reclaim
 *  sweep at once. */
const HIDDEN_SESSION_SWEEP_MS = 60_000;

/** What is kept of the state of a session no pane shows. A session no pane holds a tab of keeps nothing; one a pane may
 *  show again keeps its tail while it fits HIDDEN_SESSION_ROW_BUDGET, and otherwise none: a pane that shows it again
 *  enters it at its end (use-conversation-timeline.ts), and what is not kept is read again then. */
function keptOfHiddenLane(sessionId: string, snapshot: Snapshot): Snapshot | null {
  if (sessionHasTab(sessionId) === false) return null;
  const items = laneTranscript(snapshot) ?? [];
  if (items.length > HIDDEN_SESSION_ROW_BUDGET) return null;
  const { transcriptViewItems: stretch, transcriptViews: listed } = snapshot as {
    transcriptViewItems?: unknown;
    transcriptViews?: unknown;
  };
  const apart = Array.isArray(listed) ? listed.length > 0 : Array.isArray(stretch);
  if (!apart) return snapshot;
  // Part of a state is a preview of it: painted where nothing else is, never taken for the session's window.
  return {
    ...snapshot,
    items,
    transcriptViewItems: null,
    transcriptViews: [],
    transcriptHistory: 'older',
    transcriptHasOlder: true,
    transcriptPreview: true,
  } as Snapshot;
}

function queuedIdentity(snapshot: Snapshot): string {
  const queued = Array.isArray(snapshot.queued) ? snapshot.queued : [];
  return queued
    .map((entry) => String((entry as { id?: unknown; key?: unknown })?.id ?? (entry as { key?: unknown })?.key ?? ''))
    .join('\0');
}

function agentActivityIdentity(snapshot: Snapshot): string {
  return (['agentWorkers', 'agentJobs'] as const)
    .flatMap((field) => {
      const entries = Array.isArray(snapshot[field]) ? snapshot[field] : [];
      return entries.map((entry, index) =>
        [field, desktopAgentIdentity(entry) || index, String(entry?.stage || ''), String(entry?.status || '')].join(':')
      );
    })
    .join('\0');
}

function shellActivityCount(snapshot: Snapshot): number {
  return Math.max(
    Math.max(0, Number(snapshot.shellJobs?.count) || 0),
    Math.max(0, Number(snapshot.activeTools?.shell?.count) || 0)
  );
}

function surfacedToolActivityIdentity(snapshot: Snapshot): string {
  return (['agent', 'web_search', 'shell'] as const)
    .map((field) => {
      const activity = snapshot.activeTools?.[field];
      return `${field}:${Math.max(0, Number(activity?.count) || 0)}:${Number(activity?.startedAt) || 0}`;
    })
    .join('\0');
}

function laneUpdateIsUrgent(previous: Snapshot | null, next: Snapshot | null): boolean {
  if (!previous || !next) return true;
  return (
    previous.sessionId !== next.sessionId ||
    previous.busy !== next.busy ||
    previous.commandBusy !== next.commandBusy ||
    previous.commandStatus !== next.commandStatus ||
    previous.toolApproval !== next.toolApproval ||
    queuedIdentity(previous) !== queuedIdentity(next) ||
    agentActivityIdentity(previous) !== agentActivityIdentity(next) ||
    surfacedToolActivityIdentity(previous) !== surfacedToolActivityIdentity(next) ||
    shellActivityCount(previous) !== shellActivityCount(next)
  );
}

function laneTranscript(snapshot: Snapshot | null): TranscriptItem[] | null {
  const items = snapshot?.items;
  return Array.isArray(items) ? items : null;
}

// Presentation read-outs only: a windowed/disk projection that carries none
// of them must not push the pane back to "unknown" while it keeps painting
// the retained rows. Live/work fields are deliberately absent from this list.
const LANE_PRESENTATION_FIELDS: ReadonlyArray<keyof Snapshot> = [
  'stats',
  'contextWindow',
  'displayContextWindow',
  'autoCompactTokenLimit',
  'provider',
  'model',
  'effort',
  'fast',
  'fastCapable',
  'autoEffort',
  'modelParameters',
  'contextPercent',
  'workflow',
  'currentProject',
  'project',
  'cwd',
  'promptHistoryList',
  'desktopSessionTitle',
];

function mergedLaneFrame(
  prior: Snapshot,
  next: Snapshot,
  items: TranscriptItem[],
  retainedTurnModel: boolean
): Snapshot {
  const merged: Snapshot = { ...next, items };
  // The turn/failure model belongs to the transcript it was computed over:
  // only a fully retained transcript keeps the cached one. A merged superset
  // takes the frame's freshest model for its own window.
  if (retainedTurnModel) {
    if (prior.failedTurnKeys) merged.failedTurnKeys = prior.failedTurnKeys;
    if (prior.transcriptTurnKeys) merged.transcriptTurnKeys = prior.transcriptTurnKeys;
  }
  for (const field of LANE_PRESENTATION_FIELDS) {
    if (merged[field] == null && prior[field] != null) merged[field] = prior[field];
  }
  // The exact window travels with contextPercent: a frame that reports the
  // percent without it has cleared the exact value; only a frame with neither
  // (a partial projection) keeps the prior one.
  if (!Object.hasOwn(next, 'contextTokens') && next.contextPercent == null && prior.contextTokens != null) {
    merged.contextTokens = prior.contextTokens;
  }
  if (!Object.hasOwn(next, 'goal') && prior.goal != null) {
    merged.goal = prior.goal;
  }
  if (!Object.hasOwn(next, 'todo') && prior.todo != null) {
    merged.todo = prior.todo;
  }
  return merged;
}

function laneRouteText(snapshot: Snapshot | null, field: 'provider' | 'model' | 'effort'): string {
  const value = snapshot?.[field];
  return typeof value === 'string' ? value.trim() : '';
}

/** A retention merge stays inside one session: a frame naming a different
 *  session never inherits the prior lane's fields. */
function sameLaneSession(prior: Snapshot, next: Snapshot): boolean {
  const priorSessionId = String(prior.sessionId || '');
  const nextSessionId = String(next.sessionId || '');
  return !priorSessionId || !nextSessionId || priorSessionId === nextSessionId;
}

function laneFrameWithRetainedRoute(prior: Snapshot | null, next: Snapshot): Snapshot {
  if (!prior || !sameLaneSession(prior, next)) return next;
  const priorProvider = laneRouteText(prior, 'provider');
  const priorModel = laneRouteText(prior, 'model');
  const provider = laneRouteText(next, 'provider') || priorProvider;
  const model = laneRouteText(next, 'model') || priorModel;
  if (!provider || !model) return next;
  const merged: Snapshot = { ...next };
  let changed = false;
  if (laneRouteText(next, 'provider') !== provider) {
    merged.provider = provider;
    changed = true;
  }
  if (laneRouteText(next, 'model') !== model) {
    merged.model = model;
    changed = true;
  }
  // Effort/fast belong to the route they were chosen for: only a frame that
  // lands on the SAME provider+model may inherit them.
  if (provider === priorProvider && model === priorModel) {
    if (!laneRouteText(next, 'effort') && laneRouteText(prior, 'effort')) {
      merged.effort = laneRouteText(prior, 'effort');
      changed = true;
    }
    if (typeof next.fast !== 'boolean' && typeof prior.fast === 'boolean') {
      merged.fast = prior.fast;
      changed = true;
    }
    if (typeof next.autoEffort !== 'boolean' && typeof prior.autoEffort === 'boolean') {
      merged.autoEffort = prior.autoEffort;
      changed = true;
    }
    if (typeof next.fastCapable !== 'boolean' && typeof prior.fastCapable === 'boolean') {
      merged.fastCapable = prior.fastCapable;
      changed = true;
    }
    if (!next.modelParameters && prior.modelParameters) {
      merged.modelParameters = prior.modelParameters;
      changed = true;
    }
  }
  return changed ? merged : next;
}

const LANE_CONTEXT_WINDOW_FIELDS: ReadonlyArray<'contextWindow' | 'displayContextWindow' | 'autoCompactTokenLimit'> = [
  'contextWindow',
  'displayContextWindow',
  'autoCompactTokenLimit',
];

function laneFrameWithRetainedContextWindow(prior: Snapshot | null, next: Snapshot): Snapshot {
  if (!prior || !sameLaneSession(prior, next)) return next;
  if (
    laneRouteText(prior, 'provider') !== laneRouteText(next, 'provider') ||
    laneRouteText(prior, 'model') !== laneRouteText(next, 'model')
  )
    return next;
  let merged: Snapshot | null = null;
  for (const field of LANE_CONTEXT_WINDOW_FIELDS) {
    const value = Number(next[field]) || 0;
    const retained = Number(prior[field]) || 0;
    if (value > 0 || retained <= 0) continue;
    merged ??= { ...next };
    merged[field] = retained;
  }
  return merged ?? next;
}

function laneFrameWithRetainedShellJobs(prior: Snapshot | null, next: Snapshot): Snapshot {
  if (!prior || !sameLaneSession(prior, next)) return next;
  if (next.shellJobs != null || prior.shellJobs == null) return next;
  return { ...next, shellJobs: prior.shellJobs };
}

function laneFrameRetainingSettledRows(prior: Snapshot | null, next: Snapshot): Snapshot {
  if (!prior || !sameLaneSession(prior, next)) return next;
  // A positioned window states every row it holds: rows it let go are released, never kept above it.
  if ((next as Record<string, unknown>).transcriptPositioned === true) return next;
  const priorItems = laneTranscript(prior);
  if (!priorItems || priorItems.length === 0) return next;
  const nextItems = laneTranscript(next);
  if (nextItems === priorItems) return next;
  if (!nextItems) return next;
  const { inWindow, prepend, found } = transcriptWindowAlignment(priorItems, nextItems);
  // Legacy unkeyed frames can retain an exactly matching head even when
  // there is no id to adopt. Rank that overlap by the same canonical walk.
  const exact = found?.strongMatches === found?.overlap ? found : null;
  const offset = (inWindow ?? exact)?.offset ?? 0;
  // Lane frames own their tail. A window can omit only the cached head.
  if (prepend || offset === 0 || nextItems.length === 0) return next;
  return mergedLaneFrame(prior, next, [...priorItems.slice(0, offset), ...nextItems], false);
}

/** `laneFrameRetainingSettledRows` for a frame shown to align with the rows the lane shows below its first `head` (the
 *  rows of an earlier window it kept above), and nowhere else: the same result, with nothing aligned. That holds for the
 *  list the lane was handed last, handed again (every row of it is matched, so no other alignment ranks above), and for a
 *  list merged on from it whose rows after the held ones show it (`heldWindowGoesOn`); the caller passes no other frame.
 *  The frame's first `held` rows are the rows shown there, so the list is made once, of the shown rows and then the
 *  frame's others. */
function laneFrameUnderRetainedRows(prior: Snapshot | null, next: Snapshot, head: number, held: number): Snapshot {
  if (!prior || !sameLaneSession(prior, next)) return next;
  const priorItems = laneTranscript(prior);
  const nextItems = laneTranscript(next);
  if (!priorItems || !nextItems) return next;
  // A frame that changed no row stands on the rows shown, and keeps with them what the lane kept above a shorter window.
  if (held === nextItems.length && priorItems.length === head + held) {
    if (head > 0) return mergedLaneFrame(prior, next, priorItems, false);
    return nextItems === priorItems ? next : { ...next, items: priorItems };
  }
  if (head === 0) return next;
  const items = new Array<TranscriptItem>(head + nextItems.length);
  const shown = head + held;
  for (let at = 0; at < shown; at += 1) items[at] = priorItems[at] as TranscriptItem;
  for (let at = held; at < nextItems.length; at += 1) items[head + at] = nextItems[at] as TranscriptItem;
  return mergedLaneFrame(prior, next, items, false);
}

/** Host metadata travelling with one keyed lane frame. */
interface SessionLaneFrameProvenance {
  frameSource: 'live' | 'replay';
  contentRevision?: number;
}

type SessionLaneFrameDecision =
  | {
      accept: false;
      reason: 'stale-replay' | 'stale-live' | 'duplicate-replay';
      revision: number | null;
    }
  | {
      accept: true;
      snapshot: Snapshot;
      revision: number | null;
      reason: 'authoritative' | 'newer-generation' | 'same-generation' | 'adopted' | 'aligned';
    };

function rejectedSessionLaneRevision(
  priorRevision: number | null,
  provenance: SessionLaneFrameProvenance
): 'stale-replay' | 'stale-live' | 'duplicate-replay' | null {
  const revision = typeof provenance.contentRevision === 'number' ? provenance.contentRevision : null;
  if (revision === null || priorRevision === null) return null;
  if (revision < priorRevision) {
    return provenance.frameSource === 'replay' ? 'stale-replay' : 'stale-live';
  }
  if (revision === priorRevision && provenance.frameSource === 'replay') {
    return 'duplicate-replay';
  }
  return null;
}

/** The host lane mixes owner publications with durable replays. Ordering is
 * by authoritative CONTENT generation, never arrival. */
function decideSessionLaneFrame(
  prior: Snapshot | null,
  priorRevision: number | null,
  next: Snapshot,
  provenance: SessionLaneFrameProvenance,
  /** For a frame shown to align with the rows the lane shows below the rows it kept `above`, and nowhere else
   *  (`laneFrameUnderRetainedRows`): how many of the frame's leading rows are `held` there as they are. null for any
   *  other frame, which is aligned against the lane. */
  goesOn: { above: number; held: number } | null
): SessionLaneFrameDecision {
  const revision = typeof provenance.contentRevision === 'number' ? provenance.contentRevision : null;
  // Host-only read-outs and the unresolved context denominator are restored
  // BEFORE any branch decides, so every accepted frame carries the pane's live
  // work and a gauge limit it can actually divide by.
  let frame = laneFrameWithRetainedContextWindow(prior, laneFrameWithRetainedShellJobs(prior, next));
  // Execution cwd owns the Project, including same-generation tool updates.
  // Never retain a legacy alias pointing links and UI at the previous cwd.
  if (frame.cwd && (frame.currentProject !== frame.cwd || frame.project !== frame.cwd)) {
    frame = { ...frame, currentProject: frame.cwd, project: frame.cwd };
  }
  if (prior) {
    const rejected = rejectedSessionLaneRevision(priorRevision, provenance);
    if (rejected) return { accept: false, reason: rejected, revision: priorRevision };
    if (revision !== null && priorRevision !== null && revision > priorRevision) {
      // A newer durable generation (the owner process wrote the session
      // file), or a newer owner generation: clear, trailing deletion, rewrite
      // and growth land as published.
      return {
        accept: true,
        snapshot: laneFrameWithRetainedRoute(prior, frame),
        revision,
        reason: 'newer-generation',
      };
    }
    if (revision !== null && priorRevision !== null && revision === priorRevision) {
      const priorItems = laneTranscript(prior);
      const snapshot = priorItems ? mergedLaneFrame(prior, frame, priorItems, true) : frame;
      // Same-generation OWNER frames still carry fresh busy/queue/tail state,
      // but their settled transcript is byte-for-byte the generation already
      // painted. Reuse its array identity so focus churn cannot remount rows.
      return {
        accept: true,
        snapshot: laneFrameWithRetainedRoute(prior, snapshot),
        revision,
        reason: 'same-generation',
      };
    }
  }
  const snapshot =
    goesOn === null
      ? laneFrameRetainingSettledRows(prior, frame)
      : laneFrameUnderRetainedRows(prior, frame, goesOn.above, goesOn.held);
  const reason = snapshot === frame ? 'adopted' : 'aligned';
  return {
    accept: true,
    snapshot: laneFrameWithRetainedRoute(prior, snapshot),
    revision: revision ?? priorRevision,
    reason,
  };
}

// Bounded, opt-in DEV diagnostics: set window.__mixdogLaneDiagnostics = true
// to log one decision per session per second through the existing perf log.
// Nothing is emitted otherwise — no production console traffic.
const laneDiagnosticAt = new Map<string, number>();
function reportLaneDecision(
  sessionId: string,
  provenance: SessionLaneFrameProvenance,
  decision: SessionLaneFrameDecision
): void {
  const flag = (globalThis as { __mixdogLaneDiagnostics?: boolean }).__mixdogLaneDiagnostics;
  if (flag !== true) return;
  const now = Date.now();
  if (now - (laneDiagnosticAt.get(sessionId) || 0) < 1_000) return;
  laneDiagnosticAt.delete(sessionId);
  laneDiagnosticAt.set(sessionId, now);
  while (laneDiagnosticAt.size > 16) {
    const oldest = laneDiagnosticAt.keys().next().value;
    if (oldest === undefined) break;
    laneDiagnosticAt.delete(oldest);
  }
  try {
    window.mixdogDesktop?.perfLog?.(
      `lane-frame id=${sessionId} frame=${provenance.frameSource}` +
        ` rev=${provenance.contentRevision ?? '-'} decision=${decision.reason}`
    );
  } catch {
    // Diagnostics never affect the lane.
  }
}

export function createSessionLaneStore({
  maxEntries = SESSION_LANE_CACHE_LIMIT,
  maxBytes = SESSION_LANE_CACHE_BYTE_LIMIT,
  decorator = sharedTranscriptSnapshotDecorator,
}: {
  maxEntries?: number;
  maxBytes?: number;
  /** Shared with the focused pipeline by default: separate decorator
   *  instances re-issued row identities on pane focus swaps (rows remounted,
   *  transcript jumped). */
  decorator?: TranscriptSnapshotDecorator;
} = {}): SessionLaneStore {
  const listeners = new Map<string, Set<() => void>>();
  const snapshots = new SessionLaneCache({
    maxEntries,
    maxBytes,
    subscribed: (sessionId) => (listeners.get(sessionId)?.size || 0) > 0,
  });
  const notificationKeys = new Map<string, object>();
  /** Each session's shown feed position and who hears it move, and the sessions whose lane ended as gone. */
  const positions = new Map<string, DesktopStreamPosition>();
  const positionListeners = new Map<string, Set<() => void>>();
  const movePosition = (sessionId: string, position: DesktopStreamPosition): void => {
    const held = positions.get(sessionId);
    if (held && streamPositionReached(held, position)) return;
    positions.set(sessionId, { epoch: position.epoch, seq: position.seq, order: position.order });
    for (const listener of [...(positionListeners.get(sessionId) ?? [])]) listener();
  };
  /** The position of an accepted state whose notification is still scheduled. */
  const notifiedAt = new Map<string, DesktopStreamPosition>();
  const ended = new Set<string>();
  let stop: (() => void) | null = null;
  let approvals: ReadonlySet<string> = new Set();
  let questions: ReadonlySet<string> = new Set();
  const approvalListeners = new Set<() => void>();
  let shown: ReadonlySet<string> = new Set();
  let live: ReadonlySet<string> = new Set();
  const setLive = (next: ReadonlySet<string>): void => {
    if (next.size === live.size && [...next].every((id) => live.has(id))) return;
    live = next;
    for (const listener of [...approvalListeners]) listener();
  };
  // Membership follows the lane's own toolApproval, so it costs one check per
  // frame and notifies only when a session starts or stops waiting.
  // A lane that left the cache (eviction, pruning, release) no longer carries
  // its approval, so every path that can drop one reconciles here too.
  const syncApprovals = (sessionId?: string): void => {
    const next = new Set(approvals);
    const nextQuestions = new Set(questions);
    for (const id of approvals) {
      if (snapshots.get(id)) continue;
      next.delete(id);
      nextQuestions.delete(id);
    }
    if (sessionId !== undefined) {
      const pending = snapshots.get(sessionId)?.snapshot.toolApproval;
      if (pending) next.add(sessionId);
      else next.delete(sessionId);
      if (pending?.kind === 'question') nextQuestions.add(sessionId);
      else nextQuestions.delete(sessionId);
    }
    const same = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
      a.size === b.size && [...a].every((id) => b.has(id));
    if (same(next, approvals) && same(nextQuestions, questions)) return;
    if (!same(next, approvals)) approvals = next;
    if (!same(nextQuestions, questions)) questions = nextQuestions;
    for (const listener of [...approvalListeners]) listener();
  };
  const notificationKey = (sessionId: string): object => {
    let key = notificationKeys.get(sessionId);
    if (!key) {
      key = {};
      notificationKeys.set(sessionId, key);
    }
    return key;
  };
  const notify = (sessionId: string): void => {
    // A state's position is shown with the state: both are heard in this one notification, so a preview that ends at the
    // position never ends before its pane holds the state that reached it.
    const position = notifiedAt.get(sessionId);
    notifiedAt.delete(sessionId);
    const bucket = listeners.get(sessionId);
    if (bucket) {
      noteStreamPublish();
      for (const listener of [...bucket]) listener();
    }
    if (position) movePosition(sessionId, position);
  };
  const apply = (update: DesktopSessionStateUpdate): void => {
    const sessionId = String(update?.sessionId || '');
    if (!sessionId) return;
    const readFrameStartedAt = performance.now();
    reportSessionReadFrame(update, 'received');
    const prior = snapshots.get(sessionId);
    const priorSnapshot = prior?.snapshot ?? null;
    // The lane handed on the state this entry already shows, current at a later feed position (a frame or a note that changed
    // nothing shown): only the position moves; nothing is decorated, decided or re-rendered.
    if (update.snapshot && prior?.incoming?.deref() === update.snapshot) {
      // Behind a state not yet notified, the position waits for that notification too.
      if (update.streamPosition) {
        if (notifiedAt.has(sessionId)) notifiedAt.set(sessionId, update.streamPosition);
        else movePosition(sessionId, update.streamPosition);
      }
      if (shown.has(sessionId) && !live.has(sessionId)) setLive(new Set([...live, sessionId]));
      return;
    }
    if (!update.snapshot && live.has(sessionId)) setLive(new Set([...live].filter((id) => id !== sessionId)));
    if (!update.snapshot && update.laneEnd !== 'gone' && prior) {
      reportSessionReadFrame(update, 'rejected');
      return;
    }
    const provenance: SessionLaneFrameProvenance = {
      frameSource: update.frameSource,
      ...(typeof update.contentRevision === 'number' ? { contentRevision: update.contentRevision } : {}),
    };
    // Gate BEFORE touching the cache or decorating: a rejected replay must
    // leave the entry, its byte accounting and its listeners untouched, and
    // must not disturb the shared transcript identity baseline either.
    if (update.snapshot && priorSnapshot) {
      const rejected = rejectedSessionLaneRevision(prior?.revision ?? null, provenance);
      if (rejected) {
        reportLaneDecision(sessionId, provenance, {
          accept: false,
          reason: rejected,
          revision: prior?.revision ?? null,
        });
        reportSessionReadFrame(update, 'rejected');
        return;
      }
    }
    // A read of a thread not followed (its newest rows, no window) never takes the place of the window a shown
    // session's subscription holds or held: the panes keep the session followed, the window is what they read (a
    // reader may be far from those newest rows), and the subscription's own frame is the one that brings it up to date.
    if (
      update.snapshot &&
      update.frameSource === 'replay' &&
      shown.has(sessionId) &&
      (priorSnapshot as Record<string, unknown> | null)?.transcriptPositioned === true &&
      (update.snapshot as Record<string, unknown>).transcriptPositioned !== true
    ) {
      reportSessionReadFrame(update, 'rejected');
      return;
    }
    if (prior) snapshots.delete(sessionId);
    // A genuine teardown ends the session's identity baseline and failure scope, and no answer seeds it again.
    if (!update.snapshot && update.laneEnd === 'gone') {
      decorator.forget?.(sessionId);
      positions.delete(sessionId);
      notifiedAt.delete(sessionId);
      if (!ended.has(sessionId)) {
        ended.add(sessionId);
        for (const listener of [...approvalListeners]) listener();
      }
    }
    if (update.snapshot) {
      // A stored preview may predate a rewind. Reuse equal row objects below, but never retain its rows or fields over a real frame.
      const baseline = priorSnapshot?.transcriptPreview ? null : priorSnapshot;
      const raw = laneTranscript(update.snapshot as Snapshot);
      const shownRaw = baseline ? prior?.rawItems?.deref() : undefined;
      const shownItems = laneTranscript(baseline);
      // The rows the lane shows above the ones made from its last list (rows of an earlier window it kept).
      const above = prior?.rawOffset ?? 0;
      // How many leading rows of the frame are the rows it brought last, in place (the client merges a list on from the one
      // before): those rows are the ones shown below the rows kept above. That alone says nothing of where the frame
      // aligns with the rows shown, which is ranked over every row the two overlap; see `goesOn` below.
      const sameList = raw !== null && raw === shownRaw;
      const heldCount =
        raw && shownRaw && shownItems && shownItems.length === above + shownRaw.length
          ? (rowsHeldFrom(raw, shownRaw) ?? 0)
          : 0;
      const decorated = decorator.decorate(
        update.snapshot,
        shownRaw && heldCount > 0 ? { held: { rows: shownRaw, count: heldCount } } : undefined
      );
      // The same list again: the frame changed no row since the last one. Whether the rows shown stand is still the
      // decision's: a newer generation is shown as published, without what an earlier window kept above its rows, so the
      // frame is handed over as it came and only the retention it reaches (`laneFrameUnderRetainedRows`) stands on them.
      const unchangedRows = sameList && heldCount > 0 && shownItems !== null && decorated.items === raw;
      // A list merged on from the last one aligns with the rows shown where that one did only if the rows it did not
      // leave in place say so: the window shown is anchored by its first row's id, and the frame's other rows match the
      // rows they overlap by id (`heldWindowGoesOn`). A frame shown under adopted ids, or one whose other rows moved,
      // appeared or left in the middle, is aligned against the lane whole, like a frame of which nothing is known.
      const anchored =
        !sameList && heldCount > 0 && shownItems !== null && decorated.items === raw
          ? (prior?.anchored ?? windowAnchored(shownItems, above))
          : undefined;
      const mergedOn =
        anchored === true && raw !== null && shownItems !== null && heldWindowGoesOn(shownItems, raw, above, heldCount);
      const decision = decideSessionLaneFrame(
        baseline,
        prior?.revision ?? null,
        decorated,
        provenance,
        unchangedRows || mergedOn ? { above, held: heldCount } : null
      );
      reportLaneDecision(sessionId, provenance, decision);
      const accepted = decision.accept ? decision.snapshot : (priorSnapshot ?? decorated);
      // The decision left the rows shown standing under a list that changed none of them.
      const stood = unchangedRows && decision.accept && accepted.items === shownItems;
      // How many rows the lane shows above the frame's own (`under`); -1 when it does not show the frame's rows (a frame
      // refused, or one of the generation already painted, whose rows stand).
      const under =
        decision.accept && decision.reason !== 'same-generation' && accepted.items && decorated.items
          ? accepted.items.length - decorated.items.length
          : -1;
      // The rows the lane shows after this frame that are the rows it showed, in place: true of any frame shown under its
      // own ids below the same rows kept above, however it was aligned. They are the very objects when the lane made the
      // list of the rows shown (`laneFrameUnderRetainedRows`) or shows the list it was handed.
      const heldRows =
        !stood && heldCount > 0 && decorated.items === raw && under === above
          ? { count: above + heldCount, same: (mergedOn && above > 0) || (above === 0 && shownItems === shownRaw) }
          : undefined;
      // A row (or field) that did not change keeps the object the pane holds, whatever lane delivered the frame: the core
      // publishes whole states, a snapshot or a read is a new object graph, and the row renderers treat a new object as a
      // changed row.
      const snapshot =
        priorSnapshot && sameLaneSession(priorSnapshot, accepted)
          ? reconcileSessionProjection(priorSnapshot, accepted, heldRows)
          : accepted;
      // What the panes derive from the rows is carried on from the rows left in place.
      if (heldRows && priorSnapshot?.items && snapshot.items && snapshot.items !== priorSnapshot.items) {
        noteCarried(snapshot.items, priorSnapshot.items, heldRows.count);
      }
      const now = Date.now();
      const subscribed = (listeners.get(sessionId)?.size || 0) > 0;
      const refreshEstimate = !prior || (!subscribed && now - prior.estimatedAt >= SESSION_LANE_ESTIMATE_INTERVAL_MS);
      const bytes = refreshEstimate ? estimateSessionSnapshotBytes(snapshot) : prior.bytes;
      snapshots.set(sessionId, {
        snapshot,
        bytes,
        estimatedAt: refreshEstimate ? now : prior.estimatedAt,
        revision: decision.accept ? decision.revision : (prior?.revision ?? null),
        incoming: decision.accept ? new WeakRef(update.snapshot) : prior?.incoming,
        // What the next frame is carried on from: the list handed over, only when the rows shown from `rawOffset` on are
        // its rows one for one under their own ids. A generation's own rows are not, and neither are rows shown under
        // other ids (`decorated.items !== raw`): which rows adopt which ids is decided over the whole of both lists and
        // is not carried, so the frame after is reconciled whole.
        ...(!decision.accept
          ? { rawItems: prior?.rawItems, rawOffset: prior?.rawOffset }
          : raw && stood
            ? { rawItems: new WeakRef(raw), rawOffset: above }
            : raw && under >= 0 && decorated.items === raw
              ? { rawItems: new WeakRef(raw), rawOffset: under }
              : {}),
        // Whether the window shown is anchored (`windowAnchored`): a frame decided from its held rows leaves it so, the
        // same rows again leave it as it was read, and after any other frame it is read when next asked.
        ...(!decision.accept || stood || (unchangedRows && under === above)
          ? { anchored: prior?.anchored }
          : mergedOn && under === above
            ? { anchored: true }
            : {}),
      });
      if (decision.accept && update.streamPosition) notifiedAt.set(sessionId, update.streamPosition);
    }
    snapshots.prune();
    const nextSnapshot = snapshots.get(sessionId)?.snapshot ?? null;
    syncApprovals(sessionId);
    if (update.snapshot && !nextSnapshot?.transcriptPreview && shown.has(sessionId) && !live.has(sessionId)) {
      setLive(new Set([...live, sessionId]));
    }
    reportSessionReadFrame({ ...update, snapshot: nextSnapshot }, 'applied', performance.now() - readFrameStartedAt);
    noteStreamLaneFrame(sessionId, nextSnapshot?.streamingTail);
    if ((listeners.get(sessionId)?.size || 0) === 0) {
      const key = notificationKeys.get(sessionId);
      if (key) cancelLayoutFrame(key);
      notificationKeys.delete(sessionId);
      // No pane holds a state to catch up with: the position shows at once.
      notify(sessionId);
      return;
    }
    const key = notificationKey(sessionId);
    if (laneUpdateIsUrgent(priorSnapshot, nextSnapshot)) {
      cancelLayoutFrame(key);
      notify(sessionId);
    } else {
      scheduleLayoutFrame(key, () => notify(sessionId));
    }
  };
  const sweepHidden = (): void => {
    snapshots.sweep((sessionId, snapshot) => {
      const kept = keptOfHiddenLane(sessionId, snapshot);
      if (!kept) decorator.forget?.(sessionId);
      return kept;
    });
    syncApprovals();
  };
  return {
    get(sessionId) {
      const entry = snapshots.get(sessionId);
      if (!entry) return null;
      snapshots.touch(sessionId);
      return entry.snapshot;
    },
    revision(sessionId) {
      return snapshots.get(sessionId)?.revision ?? null;
    },
    subscribe(sessionId, listener) {
      let bucket = listeners.get(sessionId);
      if (!bucket) {
        bucket = new Set();
        listeners.set(sessionId, bucket);
      }
      bucket.add(listener);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        bucket.delete(listener);
        if (bucket.size === 0) {
          listeners.delete(sessionId);
          const key = notificationKeys.get(sessionId);
          if (key) cancelLayoutFrame(key);
          notificationKeys.delete(sessionId);
          // The cancelled notification carried the deferred position: with no pane left to catch up, it shows at once, as in
          // `apply` without a listener.
          notify(sessionId);
          snapshots.release(sessionId);
          syncApprovals();
          // An unmounted lane that is no longer cached has nothing displayed
          // to keep stable; a cached one keeps its baseline for re-entry.
          if (!snapshots.get(sessionId)) decorator.forget?.(sessionId);
        }
      };
    },
    subscribedSessionIds: () => [...listeners.keys()],
    approvalSessionIds: () => approvals,
    questionSessionIds: () => questions,
    setShownSessionIds(sessionIds) {
      shown = new Set(sessionIds);
      // A newly shown session waits for its first frame; one no longer shown leaves.
      setLive(new Set([...live].filter((id) => shown.has(id))));
    },
    liveSessionIds: () => live,
    sessionEnded: (sessionId) => ended.has(sessionId) && !snapshots.get(sessionId),
    subscribeApprovals(listener) {
      approvalListeners.add(listener);
      return () => {
        approvalListeners.delete(listener);
      };
    },
    evictInactive() {
      snapshots.evictInactive();
      syncApprovals();
    },
    start(source = window.mixdogDesktop?.subscribeSessionState?.bind(window.mixdogDesktop)) {
      if (stop) return stop;
      if (typeof source !== 'function') return () => {};
      const unsubscribe = source(apply);
      const timer = window.setInterval(sweepHidden, HIDDEN_SESSION_SWEEP_MS);
      const onHidden = (): void => {
        if (document.visibilityState === 'hidden') sweepHidden();
      };
      document.addEventListener('visibilitychange', onHidden);
      const offReclaim = registerIdleReclaim(sweepHidden);
      const halt = (): void => {
        if (stop !== halt) return;
        stop = null;
        window.clearInterval(timer);
        document.removeEventListener('visibilitychange', onHidden);
        offReclaim();
        try {
          unsubscribe();
        } catch {
          // The bridge may already be torn down during window unload.
        }
      };
      stop = halt;
      return halt;
    },
    apply,
    seedPreview(sessionId, snapshot) {
      if (ended.has(sessionId) || snapshots.get(sessionId)) return;
      apply({ sessionId, snapshot: { ...snapshot, transcriptPreview: true }, frameSource: 'replay' });
    },
    seedCreatedSession(sessionId, snapshot) {
      if (ended.has(sessionId) || snapshots.get(sessionId)) return;
      apply({ sessionId, snapshot, frameSource: 'live' });
    },
    streamReached(sessionId, mark) {
      const shown = positions.get(sessionId);
      return shown !== undefined && streamPositionReached(shown, mark);
    },
    streamPosition: (sessionId) => positions.get(sessionId) ?? null,
    subscribeStreamPosition(sessionId, listener) {
      let bucket = positionListeners.get(sessionId);
      if (!bucket) {
        bucket = new Set();
        positionListeners.set(sessionId, bucket);
      }
      bucket.add(listener);
      return () => {
        bucket.delete(listener);
        if (bucket.size === 0) positionListeners.delete(sessionId);
      };
    },
    sweepHidden,
    hiddenRows: () => snapshots.inactiveRows,
    stats: () => ({
      entries: snapshots.size,
      estimatedBytes: snapshots.bytes,
      subscribedSessions: listeners.size,
      notificationKeys: notificationKeys.size,
    }),
    clear() {
      for (const key of notificationKeys.values()) cancelLayoutFrame(key);
      notificationKeys.clear();
      snapshots.clear();
      positions.clear();
      notifiedAt.clear();
      ended.clear();
      decorator.clear();
      if (approvals.size > 0) {
        approvals = new Set();
        questions = new Set();
        for (const listener of [...approvalListeners]) listener();
      }
      setLive(new Set());
    },
  };
}

/** Shared store for the app renderer; components use the hook below. */
export const defaultSessionLaneStore = createSessionLaneStore();

/** The lane's authoritative content revision (the publication envelope's,
 *  not anything inside the snapshot); re-renders only when it moves. */
export function useSessionLaneRevision(
  sessionId: string,
  store: SessionLaneStore = defaultSessionLaneStore,
  enabled = true
): number | null {
  const subscribe = useCallback(
    (listener: () => void) => (enabled && sessionId ? store.subscribe(sessionId, listener) : () => {}),
    [enabled, sessionId, store]
  );
  return useSyncExternalStore(subscribe, () => (enabled && sessionId ? store.revision(sessionId) : null));
}

/** The feed position of the session's shown state; re-renders when a publication moves it. An empty id hears nothing. */
export function useSessionLaneStreamPosition(
  sessionId: string,
  store: SessionLaneStore = defaultSessionLaneStore
): DesktopStreamPosition | null {
  const subscribe = useCallback(
    (listener: () => void) => (sessionId ? store.subscribeStreamPosition(sessionId, listener) : () => {}),
    [sessionId, store]
  );
  return useSyncExternalStore(subscribe, () => (sessionId ? store.streamPosition(sessionId) : null));
}

export function useSessionLane(
  sessionId: string,
  store: SessionLaneStore = defaultSessionLaneStore,
  isEqual: (left: Snapshot, right: Snapshot) => boolean = Object.is,
  enabled = true
): Snapshot | null {
  // Only the current selection owns its lane. React also keeps the return
  // value of getSnapshot on the alternate Fiber after a session switch.
  const cached = useRef<{ sessionId: string; value: Snapshot | null; token: WeakRef<Snapshot> | null } | null>(null);
  const subscribe = useCallback(
    (listener: () => void) => (enabled && sessionId ? store.subscribe(sessionId, listener) : () => {}),
    [enabled, sessionId, store]
  );
  const read = useCallback(() => {
    // The cache belongs to one session. A comparator scoped to a few fields
    // would otherwise call another session "equal" and keep returning (and
    // pinning) the snapshot this hook read before its id changed.
    if (cached.current && cached.current.sessionId !== sessionId) cached.current = null;
    if (!enabled) return cached.current?.token ?? null;
    const next = sessionId ? store.get(sessionId) : null;
    const previous = cached.current;
    if (
      previous &&
      (previous.value === next || (previous.value !== null && next !== null && isEqual(previous.value, next)))
    )
      return previous.token;
    const token = next ? new WeakRef(next) : null;
    cached.current = { sessionId, value: next, token };
    return token;
  }, [enabled, isEqual, sessionId, store]);
  return useSyncExternalStore(subscribe, read)?.deref() ?? null;
}

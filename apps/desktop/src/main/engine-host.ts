import { mkdirSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import { appendFile, mkdir, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import type {
  DesktopAgentPoolRow,
  DesktopCapability,
  DesktopCapabilityReadRequest,
  DesktopCapabilityReadResult,
  DesktopCapabilityResult,
  DesktopModelCatalogOptions,
  DesktopModelOption,
  DesktopModelSelection,
  DesktopNewTaskDraft,
  DesktopNewTaskSubmitResult,
  DesktopProjectSummary,
  DesktopPromptContent,
  DesktopSessionSummary,
  DesktopSubmitOptions,
  EngineSnapshot,
  ToolApprovalDecision
} from '../shared/contract';
import { DESKTOP_READ_CAPABILITIES } from '../shared/contract';
import { sessionCatalogRowsEqual } from '../shared/session-catalog';
import {
  compactedSessionTitle,
  generatedSessionTitle,
  isMediaSessionTitlePlaceholder,
  normalizeSessionTitle,
  promptTitle
} from '../shared/session-title.mjs';
import { desktopSessionSummaries, desktopSnapshot } from './desktop-state';
import type { DesktopSessionScope, EngineFactory, EngineHostOptions, MixdogEngine, MixdogProjectsModule, MixdogSessionStoreModule, SnapshotListener, StoredSessionLiveViewer } from "./engine-host-support";
import { DESKTOP_CAPABILITY_SET, DESKTOP_PERF_ENABLED, DESKTOP_TRANSCRIPT_ITEM_LIMIT, ENGINE_PUBLICATION_INTERVAL_MS, FOREGROUND_SESSION_PUBLICATION_INTERVAL_MS, SESSIONS_CHANGED_DEBOUNCE_MS, copyCapabilityValue, copySnapshot, isInternalTranscriptItem, normalizedProjectKey, normalizedProviderModels, projectsModuleUrl, recordValue, requiredApplicationPath, sessionStoreModuleUrl, statuslineSegmentsModuleUrl } from "./engine-host-support";
import {
  createEngineLifecycle,
  engineHasActiveWork,
  type ParkedEngine,
  type PendingSubmitLease,
} from './engine-lifecycle';
import { DesktopProjectRegistry } from './engine-projects';
import { DesktopSessionMetadata } from './engine-session-metadata';
import { createOAuthFlowRegistry, oauthFlowStatus } from './oauth-flows';
import { readOnboardingStatusFromDisk } from './onboarding-status-file';
import { searchProjectDirectory } from './project-file-search';
import {
  codeGraphQueryIn,
  copyProjectEntryIn,
  createProjectEntryIn,
  listProjectDirIn,
  moveProjectEntryIn,
  projectEntryPathIn,
  readProjectTextFileIn,
  renameProjectEntryIn,
  statProjectFileIn,
  writeProjectTextFileIn,
} from './project-files';
import { createSessionLiveLanes, type SessionStateUpdate } from './session-live-lanes';
import { createShellJobsPoller } from './shell-jobs-poller';
export * from "./engine-host-support";

const CHANNEL_REMOTE_STATE_FILE = 'channel-remote-state.json';
const DESKTOP_READ_CAPABILITY_SET = new Set<DesktopCapability>(DESKTOP_READ_CAPABILITIES);
// A detached child heartbeat only proves "the turn is still alive" (it bumps
// every <=5s), while each refresh costs a full session+checkpoint parse on the
// main process. Beat-driven refreshes therefore run at most this often per
// session, trailing edge, so the last beat still lands. Checkpoint/session
// .json writes — the events that actually carry new transcript — keep the
// fast ENGINE_PUBLICATION_INTERVAL_MS debounce.
const DETACHED_HEARTBEAT_REFRESH_INTERVAL_MS = 2_000;

type VisibleSessionRetainedFrame = {
  snapshot: EngineSnapshot;
  live: boolean;
};

const VISIBLE_SESSION_CONTEXT_FIELDS = [
  'contextWindow',
  'rawContextWindow',
  'effectiveContextWindowPercent',
  'displayContextWindow',
  'compactBoundaryTokens',
  'autoCompactTokenLimit',
] as const;
const VISIBLE_SESSION_CONTEXT_STAT_FIELDS = [
  'currentContextTokens',
  'currentEstimatedContextTokens',
  'currentContextSource',
  'currentContextUpdatedAt',
] as const;

/** Keep transcript/activity authority with a live owner while applying the
 * local runtime's prepared-session context projection. */
function withVisibleSessionContextProjection(
  snapshot: EngineSnapshot,
  projection: EngineSnapshot,
): EngineSnapshot {
  if (!snapshot || !projection) return snapshot;
  const target = snapshot as Record<string, unknown>;
  const source = projection as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...target };
  for (const field of VISIBLE_SESSION_CONTEXT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(source, field)) merged[field] = source[field];
  }
  const sourceStats = source.stats && typeof source.stats === 'object' && !Array.isArray(source.stats)
    ? source.stats as Record<string, unknown>
    : null;
  if (sourceStats) {
    const targetStats = target.stats && typeof target.stats === 'object' && !Array.isArray(target.stats)
      ? target.stats as Record<string, unknown>
      : {};
    const stats = { ...targetStats };
    for (const field of VISIBLE_SESSION_CONTEXT_STAT_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(sourceStats, field)) stats[field] = sourceStats[field];
    }
    merged.stats = stats;
  }
  return merged as EngineSnapshot;
}

/** The pane frame a resume hold protects. Authority over it moves only on the
 *  exact containment proof in `sessionSnapshotPreservesRetained`, so no hash or
 *  summary of it is kept: an identity can never order two frames. */
type VisibleSessionResumeFrame = {
  snapshot: EngineSnapshot;
};

type SessionLaneResumeHold = {
  sessionId: string;
  /** The visible pane frame that stays authoritative until the handoff. */
  retained: VisibleSessionResumeFrame;
  /** True once a read-only viewer is the pane's live source — at hold time or
   *  from a later install/publication (see markVisibleResumeHoldViewerBacked).
   *  Such a frame stays authoritative only while that viewer (or its in-flight
   *  reinstall) exists, which bounds the suppression. */
  viewerBacked: boolean;
};

// How many sessions keep a content-generation entry. Bounded like every other
// per-visible-session map; an evicted session simply restarts at revision 1.
const SESSION_CONTENT_REVISION_LIMIT = 32;

/** Identity of one authoritative transcript GENERATION. Deliberately derived
 * from the settled transcript only: growth, clear, trailing deletion and
 * rewrite all change it, while re-projecting the same content does not. */
export function sessionTranscriptGeneration(snapshot: EngineSnapshot): string {
  const items = snapshotTranscriptItems(snapshot);
  const serialized = JSON.stringify(items);
  // Two independent 32-bit rolling hashes keep the retained generation
  // compact while covering every rendered transcript field. The old
  // length/head/tail summary missed same-length rewrites and middle-row tool
  // updates, incorrectly labelling different frames as one generation.
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < serialized.length; index += 1) {
    const code = serialized.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${items.length}:${(first >>> 0).toString(36)}:${(second >>> 0).toString(36)}`;
}

function snapshotTranscriptItems(snapshot: EngineSnapshot): Array<Record<string, unknown>> {
  const value = snapshot && typeof snapshot === 'object'
    ? snapshot as Record<string, unknown>
    : {};
  return (Array.isArray(value.items) ? value.items : [])
    .filter((item): item is Record<string, unknown> =>
      Boolean(item && typeof item === 'object' && !Array.isArray(item)));
}

/** Order-independent, complete serialization of ONE transcript row: every
 *  rendered field (text, status, args, result, nested agent/tool payloads)
 *  participates, so a rewritten middle row or a replaced non-empty payload can
 *  never serialize as the row it replaced. */
function stableTranscriptValue(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableTranscriptValue).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableTranscriptValue(entry)}`)
    .join(',')}}`;
}

/** THE authority-handoff proof: does `candidate` still contain the complete
 *  retained transcript, unchanged, as its leading rows?
 *
 *  A generation hash equates frames but never orders them, and a
 *  length/tail/missing-payload heuristic accepts frames that rewrote a middle
 *  row or swapped one non-empty payload for another. Both let a delayed, older
 *  or diverged engine emission steal a pane that is painting newer content.
 *  This compares the retained rows position by position against the candidate's
 *  prefix using the complete stable serialization of each row, so only two
 *  outcomes pass: the candidate IS the retained content, or it is a superset
 *  that left every retained row untouched. The transient streaming tail is
 *  deliberately excluded: it is re-derived by whichever source owns the lane
 *  and never a settled authority row. */
export function sessionSnapshotPreservesRetained(
  retained: EngineSnapshot,
  candidate: EngineSnapshot,
): boolean {
  const retainedItems = snapshotTranscriptItems(retained);
  if (retainedItems.length === 0) return true;
  const candidateItems = snapshotTranscriptItems(candidate);
  if (candidateItems.length < retainedItems.length) return false;
  for (let index = 0; index < retainedItems.length; index += 1) {
    if (stableTranscriptValue(retainedItems[index])
      !== stableTranscriptValue(candidateItems[index])) return false;
  }
  return true;
}

/** A completed owner can close before its final durable save is observable.
 * Never replace the already-rendered live frame with an older disk projection;
 * a later equal/newer disk read may still take ownership normally. */
export function storedVisibleSessionSnapshotRegresses(
  current: EngineSnapshot,
  stored: EngineSnapshot,
): boolean {
  const currentItems = snapshotTranscriptItems(current);
  const storedItems = snapshotTranscriptItems(stored);
  if (currentItems.length === 0) return false;
  if (storedItems.length < currentItems.length) return true;
  const currentTail = currentItems.at(-1);
  const storedTail = storedItems.at(-1);
  const currentTailId = String(currentTail?.id ?? '');
  if (currentTailId && !storedItems.some((item) => String(item.id ?? '') === currentTailId)) {
    return true;
  }
  if (currentTailId && currentTailId === String(storedTail?.id ?? '')) {
    const currentText = String(currentTail?.text ?? '');
    const storedText = String(storedTail?.text ?? '');
    if (storedText.length < currentText.length) return true;
  }
  // Same ids and tail are NOT enough: a disk projection can carry the full
  // item list while individual tool/agent rows lost their result/args payload
  // (persisted transcripts trail the in-memory engine). Publishing that frame
  // degraded rendered cards — an agent "Response Worker" row collapsed back
  // to its bare Spawn row on an unfocused pane and visibly "vanished" until
  // the next live replay (user report, intermittent). Any per-id payload loss
  // is a regression; the caller then keeps the richer retained items.
  const storedById = new Map<string, Record<string, unknown>>();
  for (const item of storedItems) {
    const id = String(item.id ?? '');
    if (id) storedById.set(id, item);
  }
  const payloadSize = (value: unknown): number => (typeof value === 'string'
    ? value.length
    : value == null ? 0 : 1);
  for (const item of currentItems) {
    const id = String(item.id ?? '');
    if (!id) continue;
    const counterpart = storedById.get(id);
    if (!counterpart) continue;
    if (payloadSize(item.result) > 0 && payloadSize(counterpart.result) === 0) return true;
    if (item.args != null && counterpart.args == null) return true;
  }
  return false;
}

type NewTaskNavigationCheckpoint = {
  sessionId: string;
  workspace: string | null;
  desktopSession: DesktopSessionScope | null;
  currentProject: string | null;
  pendingFastPreference: boolean | null;
};

function hasPromptContent(prompt: DesktopPromptContent): boolean {
  return typeof prompt === 'string'
    ? Boolean(prompt.trim())
    : prompt.some((part) => part.type === 'image' || part.type === 'file' ||
      (part.type === 'text' && Boolean(part.text.trim())));
}

export function channelRemoteStatePath(runtimeRoot?: string): string {
  const root = runtimeRoot
    ? resolve(runtimeRoot)
    : process.env.MIXDOG_RUNTIME_ROOT
      ? resolve(process.env.MIXDOG_RUNTIME_ROOT)
      : join(tmpdir(), 'mixdog');
  return join(root, CHANNEL_REMOTE_STATE_FILE);
}

export function normalizedChannelRemoteState(value: unknown): {
  enabled: boolean;
  sessionId: string;
  daemonPid: number | null;
} {
  const source = recordValue(value);
  const sessionId = String(source?.sessionId || '').trim();
  const daemonPid = Number(source?.daemonPid);
  const validSessionId = /^[A-Za-z0-9_-]+$/.test(sessionId) ? sessionId : '';
  return {
    enabled: source?.enabled === true && Boolean(validSessionId),
    sessionId: source?.enabled === true ? validSessionId : '',
    daemonPid: Number.isInteger(daemonPid) && daemonPid > 0 ? daemonPid : null,
  };
}

function liveProcess(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

const PROJECT_DIRECTORY_CACHE_TTL_MS = 30_000;
const PROJECT_DIRECTORY_CACHE_LIMIT = 64;

export class EngineHost {
  private engine: MixdogEngine | null = null;
  private currentProject: string | null = null;
  private recentProjects: string[] = [];
  private readonly listeners = new Set<SnapshotListener>();
  private readonly sessionListeners = new Set<(sessions: DesktopSessionSummary[]) => void>();
  private lastSessionPublicationRows: DesktopSessionSummary[] | null = null;
  private sessionsWatcher: FSWatcher | null = null;
  private sessionsWatchedDir: string | null = null;
  private sessionsChangedTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly agentPoolListeners = new Set<(agents: DesktopAgentPoolRow[]) => void>();
  private lastAgentPoolPublication = '';
  private readonly agentPoolWatchers = new Set<FSWatcher>();
  private agentPoolWatcherStart: Promise<void> | null = null;
  private agentPoolChangedTimer: ReturnType<typeof setTimeout> | null = null;
  private remoteStateWatcher: FSWatcher | null = null;
  private remoteStateChangedTimer: ReturnType<typeof setTimeout> | null = null;
  private remoteStateInitialized = false;
  private remoteState = { enabled: false, sessionId: '' };
  private readonly remoteStatePath: string;
  private disposed = false;
  private transition: Promise<void> = Promise.resolve();
  private readonly userDataPath: string | null;
  private readonly getUserDataPath: (() => string) | null;
  private readonly createEngineOverride: EngineFactory | null;
  private readonly loadProjectsModule: () => Promise<MixdogProjectsModule>;
  private readonly projects: DesktopProjectRegistry;
  private readonly loadSessionStoreOverride: (() => Promise<MixdogSessionStoreModule>) | null;
  private sessionStoreModule: Promise<MixdogSessionStoreModule> | null = null;
  // Newest raw session rows seen by any listing. Resuming only needs ONE row
  // (classification, workspace, desktop marker), and re-scanning the whole
  // store for it cost ~340ms INSIDE the transition lock on a 1k-session store
  // — paid by the click the user just made. A miss still rescans storage.
  private lastSessionRows: Array<Record<string, unknown>> | null = null;
  private readonly packaged: boolean;
  private readonly resourcesPath: string;
  private readonly appPath: string | undefined;
  // Desktop-only titles/names/archive tombstones: engine-session-metadata.ts.
  private readonly sessionMetadata = new DesktopSessionMetadata(() => this.userDataRoot());
  private engineWorkspace: string | null = null;
  private engineDesktopSession: DesktopSessionScope | null = null;
  private readonly parkedEngines = new Map<string, ParkedEngine>();
  private readonly parkedEngineDisposals = new Set<Promise<void>>();
  private readonly visibleSessionIds = new Set<string>();
  private readonly visibleSessionViewers = new Map<string, StoredSessionLiveViewer>();
  // The pane key a viewer's callbacks publish under. Held in a mutable box so a
  // fork-on-resume migration can retarget a LIVE viewer instead of stranding
  // callbacks bound to the origin id.
  private readonly visibleSessionViewerPanes = new WeakMap<
    StoredSessionLiveViewer,
    { sessionId: string }
  >();
  private readonly visibleSessionStarts = new Map<string, Promise<void>>();
  private readonly visibleSessionFrames = new Map<string, VisibleSessionRetainedFrame>();
  private readonly visibleSessionContextProjections = new Map<string, EngineSnapshot>();
  // Authoritative transcript content generation per session. Only an owner
  // publication — or a durable read that does NOT regress the retained frame
  // — advances it, so a stale disk projection re-emitted later carries the
  // same or a lower revision than the frame it raced (renderer lane gate).
  private readonly sessionContentRevisions = new Map<string, {
    revision: number;
    generation: string;
  }>();
  // Resuming an already visible session reconstructs the same transcript
  // through runtime/disk namespaces. Those initial engine frames are a route
  // replay, not new content, and must not replace what the pane is painting.
  // The hold opens only when that engine later publishes a different content
  // generation (real append/clear/rewrite).
  private readonly sessionLaneResumeHolds = new WeakMap<MixdogEngine, SessionLaneResumeHold>();
  // One lane emission is projected and then stamped back to back for the same
  // engine, so a held handoff records its decision here instead of re-deriving
  // it from a snapshot it may have substituted.
  private pendingSessionLaneFrame: {
    engine: MixdogEngine;
    snapshot: EngineSnapshot;
    contentRevision: number;
  } | null = null;
  private readonly visibleSessionStorageWatchers = new Set<FSWatcher>();
  private visibleSessionStorageWatcherStart: Promise<void> | null = null;
  private readonly visibleSessionStorageTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Scheduled fire time of each pending storage-refresh timer: an urgent
  // checkpoint event must be able to pull a slow heartbeat trailing run in.
  private readonly visibleSessionStorageTimerDueAt = new Map<string, number>();
  private readonly visibleSessionStorageRefreshes = new Map<string, Promise<void>>();
  // Per-visible-session identity token. A refresh captures it when scheduled;
  // hiding the pane drops it, so an in-flight run orphaned by hide -> quick
  // re-add can no longer emit into (or re-arm the budget of) the new pane.
  private readonly visibleSessionStorageTokens = new Map<string, object>();
  // Completion time of the last stored refresh per session (heartbeat budget).
  private readonly visibleSessionStorageRefreshedAt = new Map<string, number>();
  // Visible sessions whose last stored peek was a read-only detached child
  // agent. Those sessions have no live-share owner pipe, so their in-progress
  // turn is only observable through the durable checkpoint plus the session
  // heartbeat mtime; a lead session with an owner pipe never enters this set.
  private readonly detachedAgentSessions = new Set<string>();
  // Engine submit is intentionally synchronous, while its auto-clear preflight
  // can defer enqueue/busy publication to a later microtask. Protect the
  // accepted engine across that gap so an immediate tab switch cannot treat it
  // as idle and close the just-started turn through runtime.resume().
  private readonly pendingSubmitLeases = new WeakMap<MixdogEngine, PendingSubmitLease>();
  private readonly newTaskSubmitRequests = new Map<string, Promise<DesktopNewTaskSubmitResult>>();
  private readonly postSubmitTasks = new Set<Promise<void>>();
  private readonly modelCatalogCache = new Map<string, DesktopModelOption>();
  private readonly modelCatalogRequests = new Map<string, {
    engine: MixdogEngine;
    promise: Promise<DesktopModelOption[]>;
  }>();
  // File hydration starts the disk read and crash-backup read together. Both
  // resolve the same registered project root, so without a shared cache they
  // immediately serialized behind the transition lock and repeated
  // realpath/stat. Keep a short verified-root cache and join cold misses.
  private readonly projectDirectoryCache = new Map<string, {
    directory: string;
    expiresAt: number;
  }>();
  private readonly projectDirectoryRequests = new Map<string, Promise<string>>();
  private pendingFastPreference: boolean | null = null;
  private publicationHoldDepth = 0;
  private publicationPending = false;
  private publicationPendingSnapshot: EngineSnapshot | undefined;
  private publicationTimer: NodeJS.Timeout | null = null;
  // Last published snapshot session id (publish-session-change diagnostics).
  private lastPublishedSessionId = '';
  private perfLogQueue: Promise<void> = Promise.resolve();
  // Adaptive background-job polling (no engine push event for job counts).
  private readonly shellJobsPoller = createShellJobsPoller({
    getEngineState: () => (this.engine?.getState() as Record<string, unknown> | undefined) ?? null,
    moduleUrl: () => statuslineSegmentsModuleUrl(this.packaged, this.resourcesPath, this.appPath),
    onChange: () => this.publishEngineEvent(),
  });
  // Provider login flows in flight; the registry owns ids, expiry and cancel.
  private readonly oauthFlows = createOAuthFlowRegistry();
  private readonly searchProjectDirectory: typeof searchProjectDirectory;
  // Per-session live snapshot lanes: EVERY visible pane is foreground, so
  // active and parked engines publish through the identical lane. Focused
  // mixdog:state is App/chrome state only; it never changes pane ownership.
  private readonly sessionLanes = createSessionLiveLanes({
    intervalMs: FOREGROUND_SESSION_PUBLICATION_INTERVAL_MS,
    projectSnapshot: (engine) => this.projectSessionLaneFrame(engine),
    describeLiveFrame: (sessionId, snapshot, engine) => this.stampSessionLaneFrame(
      sessionId,
      snapshot,
      engine,
    ),
    onAfterEmit: (engine) => {
      this.releaseSettledParkedEngine(engine);
    },
  });
  // Engine park/activate/dispose/replace + module preload: engine-lifecycle.ts.
  private readonly engineLifecycle: ReturnType<typeof createEngineLifecycle>;

  constructor(options: EngineHostOptions = {}) {
    this.userDataPath = options.userDataPath ?? null;
    this.getUserDataPath = options.getUserDataPath ?? null;
    this.createEngineOverride = options.createEngine ?? null;
    this.packaged = options.packaged === true;
    this.resourcesPath = options.resourcesPath ?? process.resourcesPath;
    this.appPath = options.appPath;
    this.remoteStatePath = channelRemoteStatePath(options.runtimeRoot);
    this.searchProjectDirectory = options.searchProjectDirectory ?? searchProjectDirectory;
    this.loadSessionStoreOverride = options.loadSessionStore ?? null;
    this.engineLifecycle = createEngineLifecycle({
      getEngine: () => this.engine,
      setEngine: (engine) => { this.engine = engine; },
      requireEngine: () => this.requireEngine(),
      getEngineWorkspace: () => this.engineWorkspace,
      setEngineWorkspace: (workspace) => { this.engineWorkspace = workspace; },
      getEngineDesktopSession: () => this.engineDesktopSession,
      setEngineDesktopSession: (scope) => { this.engineDesktopSession = scope; },
      clearCurrentProject: () => { this.currentProject = null; },
      parkedEngines: this.parkedEngines,
      pendingSubmitLeases: this.pendingSubmitLeases,
      sessionLanes: {
        attach: (engine) => this.sessionLanes.attach(engine),
        detach: (engine) => this.sessionLanes.detach(engine),
        replay: (engine) => { this.sessionLanes.replay(engine); },
      },
      cancelOAuthFlows: () => this.oauthFlows.cancelAll(),
      cancelScheduledPublication: () => this.cancelScheduledPublication(),
      shellJobsPoller: this.shellJobsPoller,
      stopSessionsWatcher: () => this.stopSessionsWatcher(),
      ensureSessionsWatcher: () => this.ensureSessionsWatcher(),
      publish: () => this.publish(),
      publishEngineEvent: () => this.publishEngineEvent(),
      onEngineReady: (_engine, options) => {
        // A resume boot has not resumed its destination yet. Its established
        // completion path reconciles lanes after engine.resume(), so emitting a
        // stored frame here would interleave a replay before the live handoff.
        if (options?.forResume === true) return;
        // Visible panes may have painted durable fallback estimates while the
        // first runtime was still loading. Re-project every lane now that the
        // prepared-session/live-context calculator is available; no focus or
        // resume is required to make the numbers authoritative.
        for (const sessionId of this.visibleSessionIds) {
          void this.refreshVisibleSessionContextProjection(sessionId);
        }
      },
      perfLog: (line) => this.perfLog(line),
      withPublicationsHeld: (action) => this.withPublicationsHeld(action),
      createEngineOverride: this.createEngineOverride,
      packaged: this.packaged,
      resourcesPath: this.resourcesPath,
      appPath: this.appPath,
    });
    this.loadProjectsModule = options.loadProjects ?? (async () => import(
      /* @vite-ignore */ projectsModuleUrl(this.packaged, this.resourcesPath, this.appPath)
    ) as Promise<MixdogProjectsModule>);
    // Project registry/preferences live in engine-projects.ts; this host keeps
    // the transition lock and calls it inside `exclusive`.
    this.projects = new DesktopProjectRegistry({
      loadProjectsModule: () => this.loadProjectsModule(),
      userDataRoot: () => this.userDataRoot(),
    });
    if (!this.packaged && !this.createEngineOverride) requiredApplicationPath(this.appPath);
    // Start compiling the runtime graph while Chromium is still bringing the
    // window up: the first engine boot then starts from a warm module cache.
    setTimeout(() => this.preloadEngineModule(), 0)?.unref?.();
  }

  subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    this.ensureRemoteStateWatcher();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stopRemoteStateWatcher();
    };
  }

  subscribeSessions(listener: (sessions: DesktopSessionSummary[]) => void): () => void {
    if (this.sessionListeners.size === 0) this.lastSessionPublicationRows = null;
    this.sessionListeners.add(listener);
    this.ensureSessionsWatcher();
    return () => {
      this.sessionListeners.delete(listener);
      if (this.sessionListeners.size === 0) {
        this.lastSessionPublicationRows = null;
        this.stopSessionsWatcher();
      }
    };
  }

  subscribeAgentPool(listener: (agents: DesktopAgentPoolRow[]) => void): () => void {
    if (this.agentPoolListeners.size === 0) this.lastAgentPoolPublication = '';
    this.agentPoolListeners.add(listener);
    this.ensureAgentPoolWatcher();
    void this.emitAgentPoolChanged();
    return () => {
      this.agentPoolListeners.delete(listener);
      if (this.agentPoolListeners.size === 0) {
        this.lastAgentPoolPublication = '';
        this.stopAgentPoolWatcher();
      }
    };
  }

  async listAgentPool(): Promise<DesktopAgentPoolRow[]> {
    const store = await this.loadSessionStoreModule();
    if (typeof store.listStoredAgentWorkers !== 'function') return [];
    const rows = store.listStoredAgentWorkers();
    return Array.isArray(rows) ? rows.slice() : [];
  }

  private ensureAgentPoolWatcher(): void {
    if (this.agentPoolListeners.size === 0 || this.agentPoolWatchers.size > 0
      || this.agentPoolWatcherStart) return;
    const start = (async () => {
      const store = await this.loadSessionStoreModule();
      const file = String(store.storedAgentWorkerIndexPath?.() || '');
      if (!file || this.agentPoolListeners.size === 0
        || this.agentPoolWatchers.size > 0) return;
      const target = basename(file);
      const sources = [
        {
          directory: dirname(file),
          accepts: (changed: string) => !changed || changed === target,
        },
        {
          directory: join(dirname(file), 'sessions'),
          accepts: (changed: string) => !changed
            || changed.endsWith('.hb') || changed.endsWith('.json'),
        },
      ];
      for (const source of sources) {
        try {
          const watcher = watch(
            source.directory,
            { persistent: false },
            (_event, filename) => {
              const changed = String(filename || '');
              if (source.accepts(changed)) this.scheduleAgentPoolChanged();
            },
          );
          watcher.on('error', () => {
            if (this.agentPoolWatchers.has(watcher)) this.stopAgentPoolWatcher();
          });
          this.agentPoolWatchers.add(watcher);
        } catch {
          // A later subscription/host restart retries without polling.
        }
      }
    })().finally(() => {
      if (this.agentPoolWatcherStart === start) this.agentPoolWatcherStart = null;
    });
    this.agentPoolWatcherStart = start;
  }

  private stopAgentPoolWatcher(): void {
    for (const watcher of this.agentPoolWatchers) {
      try { watcher.close(); } catch { /* already closed */ }
    }
    this.agentPoolWatchers.clear();
    if (this.agentPoolChangedTimer) {
      clearTimeout(this.agentPoolChangedTimer);
      this.agentPoolChangedTimer = null;
    }
  }

  private scheduleAgentPoolChanged(): void {
    if (this.agentPoolListeners.size === 0 || this.agentPoolChangedTimer) return;
    this.agentPoolChangedTimer = setTimeout(() => {
      this.agentPoolChangedTimer = null;
      void this.emitAgentPoolChanged();
    }, SESSIONS_CHANGED_DEBOUNCE_MS);
    this.agentPoolChangedTimer.unref?.();
  }

  private async emitAgentPoolChanged(): Promise<void> {
    try {
      const rows = await this.listAgentPool();
      const publication = JSON.stringify(rows);
      if (publication === this.lastAgentPoolPublication) return;
      this.lastAgentPoolPublication = publication;
      for (const listener of [...this.agentPoolListeners]) {
        try { listener(rows.slice()); } catch { /* subscriber isolation */ }
      }
    } catch {
      // A concurrent atomic replacement is retried by the next filesystem event.
    }
  }

  /** Split panes: per-session live snapshots from every pooled engine. The
   *  focused mixdog:state channel keeps its single-active-session contract;
   *  this lane is additive and keyed by sessionId. */
  subscribeSessionStates(listener: (update: SessionStateUpdate) => void): () => void {
    return this.sessionLanes.subscribe(listener);
  }

  /** Advance (or reuse) this session's authoritative content generation. */
  private advanceSessionContentRevision(sessionId: string, snapshot: EngineSnapshot): number {
    const generation = sessionTranscriptGeneration(snapshot);
    const current = this.sessionContentRevisions.get(sessionId);
    const revision = !current
      ? 1
      : current.generation === generation ? current.revision : current.revision + 1;
    this.sessionContentRevisions.delete(sessionId);
    this.sessionContentRevisions.set(sessionId, { revision, generation });
    while (this.sessionContentRevisions.size > SESSION_CONTENT_REVISION_LIMIT) {
      const oldest = this.sessionContentRevisions.keys().next().value;
      if (oldest === undefined) break;
      this.sessionContentRevisions.delete(oldest);
    }
    return revision;
  }

  /** The generation a REPLAY carries: the last accepted authoritative one. */
  private retainedSessionContentRevision(sessionId: string): number {
    return this.sessionContentRevisions.get(sessionId)?.revision ?? 0;
  }

  /** Live-lane projection for ONE engine emission.
   *
   *  Every visible pane renders its own lane continuously, so focus must never
   *  expose a live -> disk/replay -> live display transition. While a resume
   *  hold is open for a pane that already shows a NEWER live frame, the lane
   *  keeps re-projecting that retained frame (stamped as a replay carrying the
   *  already accepted revision, which the renderer's stale-replay gate drops)
   *  instead of the resuming engine's older disk state. Authority moves
   *  atomically the first time the engine is PROVEN to carry at least the
   *  retained content: every retained row, unchanged and in order, is the
   *  candidate's prefix (`sessionSnapshotPreservesRetained`). A delayed empty,
   *  older, diverged, middle-row-rewritten or payload-rewritten engine frame
   *  therefore never wins the lane. */
  private projectSessionLaneFrame(engine: MixdogEngine): EngineSnapshot {
    const snapshot = desktopSnapshot(copySnapshot(engine), null, []);
    this.pendingSessionLaneFrame = null;
    const hold = this.sessionLaneResumeHolds.get(engine);
    if (!hold) return snapshot;
    let sessionId = '';
    try {
      sessionId = String(engine.getState()?.sessionId || '');
    } catch {
      sessionId = '';
    }
    if (!sessionId) sessionId = hold.sessionId;
    const retained = this.heldVisibleResumeFrame(sessionId, hold);
    // Containment proof, not identity: the engine takes the lane only when its
    // frame IS the retained content or an unchanged superset of it.
    const converged = !retained
      || sessionSnapshotPreservesRetained(retained.snapshot, snapshot);
    if (!converged && retained) {
      const frame = retained.snapshot;
      this.pendingSessionLaneFrame = {
        engine,
        snapshot: frame,
        contentRevision: this.retainedSessionContentRevision(sessionId),
      };
      return frame;
    }
    this.sessionLaneResumeHolds.delete(engine);
    // Authority handoff completed: the engine now owns this pane's content, so
    // the read-only viewer that kept it painted through the resume is released.
    this.disposeVisibleSessionViewer(sessionId);
    return snapshot;
  }

  /** Stamps provenance/generation onto the frame `projectSessionLaneFrame`
   *  produced for this same emission. */
  private stampSessionLaneFrame(
    sessionId: string,
    snapshot: EngineSnapshot,
    engine: MixdogEngine,
  ): { frameSource: 'live' | 'replay'; contentRevision: number } {
    const pending = this.pendingSessionLaneFrame;
    this.pendingSessionLaneFrame = null;
    if (pending && pending.engine === engine && pending.snapshot === snapshot) {
      return { frameSource: 'replay', contentRevision: pending.contentRevision };
    }
    if (this.visibleSessionIds.has(sessionId)) {
      this.visibleSessionContextProjections.delete(sessionId);
      this.visibleSessionFrames.set(sessionId, { snapshot, live: true });
    }
    return {
      frameSource: 'live',
      contentRevision: this.advanceSessionContentRevision(sessionId, snapshot),
    };
  }

  /** The pane frame that must stay on screen while `sessionId` resumes: the
   *  live frame retained at focus, or a newer one the still-connected visible
   *  viewer published after the hold opened. */
  private heldVisibleResumeFrame(
    sessionId: string,
    hold: SessionLaneResumeHold,
  ): VisibleSessionResumeFrame | null {
    if (!this.visibleSessionIds.has(sessionId)) return null;
    // A viewer-backed retained frame is only authoritative while that viewer
    // (or the reconcile run reinstalling one) still exists. Once the live
    // owner is gone for good, the engine is the pane's only remaining source
    // and must not be suppressed forever.
    if (hold.viewerBacked
      && !this.visibleSessionViewers.has(sessionId)
      && !this.visibleSessionStarts.has(sessionId)) return null;
    const current = this.visibleSessionFrames.get(sessionId);
    if (current?.live && current.snapshot !== hold.retained.snapshot) {
      return { snapshot: current.snapshot };
    }
    return hold.retained;
  }

  /** A viewer that installs — or publishes — into an OPEN hold becomes this
   *  pane's live source, even when the hold opened without one (an overlapping
   *  creation, or a fork that carried its viewer along). Marking it keeps the
   *  bounded exit honest: the suppression now ends if that viewer disappears
   *  for good instead of lasting until an engine convergence that may never
   *  come. */
  private markVisibleResumeHoldViewerBacked(sessionId: string): void {
    if (!sessionId || !this.visibleSessionViewers.has(sessionId)) return;
    const engine = this.sessionEngineFor(sessionId);
    if (!engine) return;
    const hold = this.sessionLaneResumeHolds.get(engine);
    if (!hold || hold.viewerBacked) return;
    this.sessionLaneResumeHolds.set(engine, { ...hold, viewerBacked: true });
  }

  /** Move one pane identity from `fromId` to `toId` in a single step
   *  (fork-on-resume publishes under a NEW session id while every visible-pane
   *  map is still keyed by the origin). Visibility, retained frame, viewer —
   *  including the pane key its callbacks publish under — content revision and
   *  the detached marker travel together: a partial move leaves the fork lane
   *  publishing unheld frames while the origin viewer is never released. */
  private migrateVisibleSessionIdentity(fromId: string, toId: string): void {
    if (!fromId || !toId || fromId === toId) return;
    const visible = this.visibleSessionIds.delete(fromId);
    if (visible) this.visibleSessionIds.add(toId);
    const frame = this.visibleSessionFrames.get(fromId);
    this.visibleSessionFrames.delete(fromId);
    if (visible && frame && !this.visibleSessionFrames.has(toId)) {
      this.visibleSessionFrames.set(toId, frame);
    }
    const contextProjection = this.visibleSessionContextProjections.get(fromId);
    this.visibleSessionContextProjections.delete(fromId);
    if (visible && contextProjection && !this.visibleSessionContextProjections.has(toId)) {
      this.visibleSessionContextProjections.set(toId, contextProjection);
    }
    const viewer = this.visibleSessionViewers.get(fromId);
    if (viewer) {
      this.visibleSessionViewers.delete(fromId);
      if (visible && !this.visibleSessionViewers.has(toId)) {
        this.visibleSessionViewers.set(toId, viewer);
        const pane = this.visibleSessionViewerPanes.get(viewer);
        if (pane) pane.sessionId = toId;
      } else {
        try { viewer.dispose(); } catch { /* already disconnected */ }
      }
    }
    const revision = this.sessionContentRevisions.get(fromId);
    this.sessionContentRevisions.delete(fromId);
    if (revision && !this.sessionContentRevisions.has(toId)) {
      this.sessionContentRevisions.set(toId, revision);
    }
    if (this.detachedAgentSessions.delete(fromId) && visible) {
      this.detachedAgentSessions.add(toId);
    }
    // Drop the origin's storage-follow bookkeeping: an in-flight read or viewer
    // creation for it now fails its token check and aborts instead of writing
    // into the migrated pane.
    const timer = this.visibleSessionStorageTimers.get(fromId);
    if (timer) {
      clearTimeout(timer);
      this.visibleSessionStorageTimers.delete(fromId);
    }
    this.visibleSessionStorageTimerDueAt.delete(fromId);
    this.visibleSessionStorageRefreshedAt.delete(fromId);
    this.visibleSessionStorageRefreshes.delete(fromId);
    this.visibleSessionStorageTokens.delete(fromId);
  }

  /** True while a visible pane's own live frame still owns the lane because
   *  the resuming engine has not reached that content yet. */
  private visibleResumeHandoffPending(sessionId: string): boolean {
    const engine = this.sessionEngineFor(sessionId);
    if (!engine) return false;
    const hold = this.sessionLaneResumeHolds.get(engine);
    return Boolean(hold && this.heldVisibleResumeFrame(sessionId, hold));
  }

  async setVisibleSessions(sessionIds: string[]): Promise<boolean> {
    if (!Array.isArray(sessionIds)) throw new TypeError('sessionIds must be an array.');
    const previous = new Set(this.visibleSessionIds);
    const desired = [...new Set(sessionIds
      .map((value) => String(value || ''))
      .filter((value) => /^[A-Za-z0-9_-]+$/.test(value)))];
    this.visibleSessionIds.clear();
    for (const sessionId of desired) this.visibleSessionIds.add(sessionId);
    for (const sessionId of [...this.visibleSessionViewers.keys()]) {
      if (!this.visibleSessionIds.has(sessionId)) this.disposeVisibleSessionViewer(sessionId);
    }
    for (const sessionId of [...this.visibleSessionFrames.keys()]) {
      if (!this.visibleSessionIds.has(sessionId)) this.visibleSessionFrames.delete(sessionId);
    }
    for (const sessionId of [...this.visibleSessionContextProjections.keys()]) {
      if (!this.visibleSessionIds.has(sessionId)) this.visibleSessionContextProjections.delete(sessionId);
    }
    for (const sessionId of [...this.detachedAgentSessions]) {
      if (!this.visibleSessionIds.has(sessionId)) this.detachedAgentSessions.delete(sessionId);
    }
    this.pruneVisibleSessionStorageState();
    for (const sessionId of previous) {
      if (this.visibleSessionIds.has(sessionId)) continue;
      this.sessionLanes.emitPeek({
        sessionId,
        snapshot: null,
        frameSource: 'replay',
        contentRevision: this.retainedSessionContentRevision(sessionId),
      });
    }
    if (desired.length > 0) await this.ensureVisibleSessionStorageWatcher();
    else this.stopVisibleSessionStorageWatcher();
    await Promise.all(desired.map((sessionId) => this.reconcileVisibleSession(sessionId)));
    return true;
  }

  /** External child agents do not host a live-share owner pipe. While their
   * read-only tab is visible, project atomic session/checkpoint writes through
   * the same per-session lane as every other pane — event-driven, no polling. */
  private ensureVisibleSessionStorageWatcher(): Promise<void> {
    if (this.visibleSessionStorageWatchers.size > 0) return Promise.resolve();
    if (this.visibleSessionStorageWatcherStart) return this.visibleSessionStorageWatcherStart;
    const start = (async () => {
      const store = await this.loadSessionStoreModule();
      const workerIndex = String(store.storedAgentWorkerIndexPath?.() || '');
      if (!workerIndex || this.visibleSessionIds.size === 0
        || this.visibleSessionStorageWatchers.size > 0) return;
      const dataRoot = dirname(workerIndex);
      for (const directory of [
        join(dataRoot, 'sessions'),
        join(dataRoot, 'turn-checkpoints'),
      ]) {
        try {
          const watcher = watch(directory, { persistent: false }, (_event, filename) => {
            const changed = String(filename || '');
            if (!changed) {
              for (const sessionId of this.visibleSessionIds) {
                this.scheduleVisibleSessionStorageRefresh(sessionId);
              }
              return;
            }
            // Heartbeat: the only guaranteed (<=5s) signal that a detached
            // child turn is still producing output. Its checkpoint write can
            // land without a rename event on some filesystems, so follow the
            // beat too instead of freezing at the open-time projection.
            if (changed.endsWith('.hb')) {
              const beating = changed.slice(0, -3);
              if (this.detachedAgentSessions.has(beating)
                && this.visibleSessionIds.has(beating)) {
                this.scheduleVisibleSessionStorageRefresh(beating, 'heartbeat');
              }
              return;
            }
            if (!changed.endsWith('.json')) return;
            const sessionId = changed.slice(0, -5);
            if (this.visibleSessionIds.has(sessionId)) {
              this.scheduleVisibleSessionStorageRefresh(sessionId);
            }
          });
          watcher.on('error', () => {
            if (this.visibleSessionStorageWatchers.has(watcher)) {
              this.stopVisibleSessionStorageWatcher();
            }
          });
          this.visibleSessionStorageWatchers.add(watcher);
        } catch {
          // The next visible-session registration retries a missing directory.
        }
      }
    })().finally(() => {
      if (this.visibleSessionStorageWatcherStart === start) {
        this.visibleSessionStorageWatcherStart = null;
      }
    });
    this.visibleSessionStorageWatcherStart = start;
    return start;
  }

  private stopVisibleSessionStorageWatcher(): void {
    for (const watcher of this.visibleSessionStorageWatchers) {
      try { watcher.close(); } catch { /* already closed */ }
    }
    this.visibleSessionStorageWatchers.clear();
    for (const timer of this.visibleSessionStorageTimers.values()) clearTimeout(timer);
    this.visibleSessionStorageTimers.clear();
    this.visibleSessionStorageTimerDueAt.clear();
    this.visibleSessionStorageRefreshedAt.clear();
    this.visibleSessionStorageTokens.clear();
    this.detachedAgentSessions.clear();
  }

  /** Drop every storage-follow bookkeeping entry whose pane is gone. Timestamps
   * and settled refresh promises outlive their timer, so pruning only the
   * timer map leaked one entry per replaced pane. */
  private pruneVisibleSessionStorageState(): void {
    for (const [sessionId, timer] of [...this.visibleSessionStorageTimers]) {
      if (this.visibleSessionIds.has(sessionId)) continue;
      clearTimeout(timer);
      this.visibleSessionStorageTimers.delete(sessionId);
    }
    for (const sessionId of [...this.visibleSessionStorageTimerDueAt.keys()]) {
      if (!this.visibleSessionIds.has(sessionId)) {
        this.visibleSessionStorageTimerDueAt.delete(sessionId);
      }
    }
    for (const sessionId of [...this.visibleSessionStorageRefreshedAt.keys()]) {
      if (!this.visibleSessionIds.has(sessionId)) {
        this.visibleSessionStorageRefreshedAt.delete(sessionId);
      }
    }
    for (const sessionId of [...this.visibleSessionStorageRefreshes.keys()]) {
      if (!this.visibleSessionIds.has(sessionId)) {
        this.visibleSessionStorageRefreshes.delete(sessionId);
      }
    }
    // Dropping the token invalidates any run already in flight for that pane;
    // a re-added pane mints a fresh one at its next schedule.
    for (const sessionId of [...this.visibleSessionStorageTokens.keys()]) {
      if (!this.visibleSessionIds.has(sessionId)) {
        this.visibleSessionStorageTokens.delete(sessionId);
      }
    }
  }

  private visibleSessionStorageToken(sessionId: string): object {
    const existing = this.visibleSessionStorageTokens.get(sessionId);
    if (existing) return existing;
    const token = {};
    this.visibleSessionStorageTokens.set(sessionId, token);
    return token;
  }

  private visibleSessionStorageRunnable(sessionId: string, token: object): boolean {
    return this.visibleSessionIds.has(sessionId)
      && this.visibleSessionStorageTokens.get(sessionId) === token;
  }

  private scheduleVisibleSessionStorageRefresh(
    sessionId: string,
    source: 'storage' | 'heartbeat' = 'storage',
  ): void {
    if (!this.visibleSessionIds.has(sessionId)) return;
    const token = this.visibleSessionStorageToken(sessionId);
    const now = Date.now();
    const budgetedAt = source === 'heartbeat'
      ? (this.visibleSessionStorageRefreshedAt.get(sessionId) ?? 0)
        + DETACHED_HEARTBEAT_REFRESH_INTERVAL_MS
      : 0;
    const delay = Math.max(ENGINE_PUBLICATION_INTERVAL_MS, budgetedAt - now);
    const dueAt = now + delay;
    const pending = this.visibleSessionStorageTimers.get(sessionId);
    if (pending) {
      // At most one trailing run per session. Duplicate beats collapse into the
      // already-scheduled one; only a strictly earlier deadline (a checkpoint
      // write arriving inside a heartbeat window) reschedules it.
      if ((this.visibleSessionStorageTimerDueAt.get(sessionId) ?? 0) <= dueAt) return;
      clearTimeout(pending);
      this.visibleSessionStorageTimers.delete(sessionId);
      this.visibleSessionStorageTimerDueAt.delete(sessionId);
    }
    const timer = setTimeout(() => {
      this.visibleSessionStorageTimers.delete(sessionId);
      this.visibleSessionStorageTimerDueAt.delete(sessionId);
      const previous = this.visibleSessionStorageRefreshes.get(sessionId)
        ?? Promise.resolve();
      let parsed = false;
      const refresh = previous.catch(() => undefined).then(async () => {
        if (!this.visibleSessionStorageRunnable(sessionId, token)) return;
        // A queued run starts the instant the previous refresh settles, so the
        // completion budget has to be rechecked HERE, not only at schedule
        // time — otherwise chained beats still ran back-to-back full parses.
        // Checkpoint/session writes keep their fast lane and never defer.
        if (source === 'heartbeat') {
          // The preceding parse may have cleared the detached marker (turn
          // ended). A queued beat must then stop instead of re-arming one more
          // parse a budget window after the final frame.
          if (!this.detachedAgentSessions.has(sessionId)) return;
          if (Date.now() < (this.visibleSessionStorageRefreshedAt.get(sessionId) ?? 0)
            + DETACHED_HEARTBEAT_REFRESH_INTERVAL_MS) {
            this.scheduleVisibleSessionStorageRefresh(sessionId, 'heartbeat');
            return;
          }
        }
        const pooledEngine = this.sessionEngineFor(sessionId);
        if (pooledEngine) {
          this.sessionLanes.replay(pooledEngine);
          return;
        }
        if (this.visibleSessionFrames.get(sessionId)?.live) {
          parsed = true;
          await this.refreshVisibleSessionContextProjection(sessionId);
          return;
        }
        parsed = true;
        const peek = await this.storedSessionPeek(sessionId);
        if (!this.visibleSessionStorageRunnable(sessionId, token)) return;
        this.applyDetachedAgentMarker(sessionId, peek.readOnlyDetachedAgent);
        if (peek.snapshot && !this.visibleSessionFrames.get(sessionId)?.live) {
          this.emitVisibleSessionSnapshot(sessionId, peek.snapshot, 'stored');
        }
      });
      this.visibleSessionStorageRefreshes.set(sessionId, refresh);
      void refresh.finally(() => {
        // Budget from completion of an actual parse: a slow read must not
        // immediately re-arm, and a deferred run must not extend the window.
        if (parsed && this.visibleSessionStorageRunnable(sessionId, token)) {
          this.visibleSessionStorageRefreshedAt.set(sessionId, Date.now());
        }
        if (this.visibleSessionStorageRefreshes.get(sessionId) === refresh) {
          this.visibleSessionStorageRefreshes.delete(sessionId);
        }
      });
    }, delay);
    timer.unref?.();
    this.visibleSessionStorageTimers.set(sessionId, timer);
    this.visibleSessionStorageTimerDueAt.set(sessionId, dueAt);
  }

  // Sidebar freshness: watch the on-disk session store so activity from ANY
  // mixdog process (channel workers, schedules, another window) pushes a fresh
  // catalog instead of waiting out the renderer's safety-net poll.
  private ensureSessionsWatcher(): void {
    if (this.sessionListeners.size === 0) return;
    const dir = String(this.engine?.sessionStoreDir?.() || '');
    if (!dir || this.sessionsWatchedDir === dir) return;
    this.stopSessionsWatcher();
    try {
      const watcher = watch(dir, { persistent: false }, (_event, filename) => {
        // Session JSON changes update titles/counts; heartbeat create/touch/
        // delete changes cross-process working state. Both are catalog-visible
        // and the existing debounce absorbs duplicate fs events.
        const changed = String(filename || '');
        if (changed && !changed.endsWith('.json') && !changed.endsWith('.hb')) return;
        this.scheduleSessionsChanged();
      });
      watcher.on('error', () => this.stopSessionsWatcher());
      this.sessionsWatcher = watcher;
      this.sessionsWatchedDir = dir;
    } catch {
      // The store directory may not exist until the first session save; the
      // next ensure call (engine swap / listSessions) retries.
    }
  }

  private stopSessionsWatcher(): void {
    try { this.sessionsWatcher?.close(); } catch { /* already closed */ }
    this.sessionsWatcher = null;
    this.sessionsWatchedDir = null;
    if (this.sessionsChangedTimer) {
      clearTimeout(this.sessionsChangedTimer);
      this.sessionsChangedTimer = null;
    }
  }

  private scheduleSessionsChanged(): void {
    if (this.sessionListeners.size === 0 || this.sessionsChangedTimer) return;
    this.sessionsChangedTimer = setTimeout(() => {
      this.sessionsChangedTimer = null;
      void this.emitSessionsChanged();
    }, SESSIONS_CHANGED_DEBOUNCE_MS);
    this.sessionsChangedTimer.unref?.();
  }

  private async emitSessionsChanged(): Promise<void> {
    try {
      const started = DESKTOP_PERF_ENABLED ? performance.now() : 0;
      const rows = await this.pushSessionRows();
      const changed = !this.lastSessionPublicationRows
        || !sessionCatalogRowsEqual(this.lastSessionPublicationRows, rows);
      if (DESKTOP_PERF_ENABLED) {
        this.perfLog(
          `sessions-push rows=${rows.length} changed=${changed ? 1 : 0}`
          + ` ms=${(performance.now() - started).toFixed(0)}`,
        );
      }
      if (!changed) return;
      this.lastSessionPublicationRows = rows;
      for (const listener of [...this.sessionListeners]) {
        try { listener(rows); } catch { /* subscriber fault must not break others */ }
      }
    } catch {
      // Listing is best-effort here; the renderer poll remains the safety net.
    }
  }

  /** Rows for a store-watcher push. The watcher already fired BECAUSE a save
   *  landed, and every writer updates the summary sidecar, so this reads the
   *  index instead of rescanning the whole store — that scan cost ~340ms of
   *  transition lock per push on a 1k-session store, right where the user's
   *  next click waits. An empty index falls back to the authoritative path. */
  private async pushSessionRows(): Promise<DesktopSessionSummary[]> {
    if (!this.engine) return await this.listSessions();
    let rows: DesktopSessionSummary[] = [];
    await this.exclusive(async () => {
      await this.sessionMetadata.load();
      // A warm engine may be scoped to the active workspace. Its local
      // listSessions() is not a complete sidebar catalog and used to replace
      // Recent/Archived with only the current row after every save.
      const store = await this.loadSessionStoreModule();
      const stored = store.listStoredSessionSummaries({ rebuildIfMissing: true });
      rows = this.sessionSummaries(false, stored);
    });
    return rows.length > 0 ? rows : await this.listSessions();
  }

  private ensureRemoteStateWatcher(): void {
    if (this.disposed || this.remoteStateWatcher) return;
    const dir = dirname(this.remoteStatePath);
    try {
      mkdirSync(dir, { recursive: true });
      this.refreshRemoteState(false);
      const watcher = watch(dir, { persistent: false }, (_event, filename) => {
        const changed = String(filename || '');
        if (changed && changed !== CHANNEL_REMOTE_STATE_FILE) return;
        if (this.remoteStateChangedTimer) clearTimeout(this.remoteStateChangedTimer);
        this.remoteStateChangedTimer = setTimeout(() => {
          this.remoteStateChangedTimer = null;
          this.refreshRemoteState(true);
        }, 20);
        this.remoteStateChangedTimer.unref?.();
      });
      watcher.on('error', () => this.stopRemoteStateWatcher());
      this.remoteStateWatcher = watcher;
    } catch {
      // The next snapshot/subscription retries after runtime-root creation.
    }
  }

  private stopRemoteStateWatcher(): void {
    try { this.remoteStateWatcher?.close(); } catch { /* already closed */ }
    this.remoteStateWatcher = null;
    if (this.remoteStateChangedTimer) {
      clearTimeout(this.remoteStateChangedTimer);
      this.remoteStateChangedTimer = null;
    }
  }

  private refreshRemoteState(publishOnChange: boolean): void {
    let next = { enabled: false, sessionId: '' };
    try {
      const parsed = normalizedChannelRemoteState(JSON.parse(readFileSync(this.remoteStatePath, 'utf8')));
      if (parsed.enabled && liveProcess(parsed.daemonPid)) {
        next = { enabled: true, sessionId: parsed.sessionId };
      }
    } catch {
      // Missing/torn/retired state is remote OFF. Atomic writer events retry
      // through the debounce above, avoiding a long-running poll loop.
    }
    const changed = !this.remoteStateInitialized
      || next.enabled !== this.remoteState.enabled
      || next.sessionId !== this.remoteState.sessionId;
    this.remoteStateInitialized = true;
    this.remoteState = next;
    if (changed && publishOnChange) this.publish();
  }

  private currentSessionDisplayTitle(sessionId: string): string {
    const durableRow = this.lastSessionRows?.find((row) => String(row?.id || '') === sessionId);
    return this.sessionMetadata.displayTitle(sessionId, String(durableRow?.title || ''));
  }

  getSnapshot(): EngineSnapshot {
    this.ensureRemoteStateWatcher();
    if (!this.remoteStateInitialized) this.refreshRemoteState(false);
    const cloneStarted = DESKTOP_PERF_ENABLED ? performance.now() : 0;
    const snapshot = desktopSnapshot(copySnapshot(this.engine), this.currentProject, this.recentProjects);
    if (DESKTOP_PERF_ENABLED) {
      const ms = performance.now() - cloneStarted;
      if (ms >= 5) {
        const items = Array.isArray(snapshot?.items) ? snapshot.items.length : 0;
        this.perfLog(`snapshot-clone ms=${ms.toFixed(1)} items=${items}`);
      }
    }
    const sessionId = String(snapshot?.sessionId || '');
    const desktopSessionTitle = this.currentSessionDisplayTitle(sessionId);
    const localRemoteEnabled = snapshot?.remoteEnabled === true;
    const localRemoteSessionId = String(snapshot?.remoteSessionId || '');
    const remoteSessionId = localRemoteEnabled && localRemoteSessionId
      ? localRemoteSessionId
      : this.remoteState.enabled
        ? this.remoteState.sessionId
        : '';
    const decorated = {
      ...snapshot,
      ...(desktopSessionTitle ? { desktopSessionTitle } : {}),
      shellJobs: { ...this.shellJobsPoller.status },
      remoteEnabled: Boolean(remoteSessionId),
      remoteSessionId: remoteSessionId || null,
    };
    if (this.pendingFastPreference === null) return decorated;
    // Engine session state can lag one event-loop turn behind an applied Fast
    // preference. Keep overriding the snapshot until the engine reflects it,
    // then drop the pending marker instead of hard-failing the mutation.
    if (typeof snapshot?.fast === 'boolean' && snapshot.fast === this.pendingFastPreference) {
      this.pendingFastPreference = null;
      return decorated;
    }
    return { ...decorated, fast: this.pendingFastPreference };
  }

  async startProject(projectPath: string): Promise<EngineSnapshot> {
    const requestedPath = projectPath.trim();
    if (!requestedPath) throw new TypeError('A project folder is required.');

    let result: EngineSnapshot = null;
    await this.exclusive(async () => {
      await this.sessionMetadata.load();
      const canonicalPath = await realpath(requestedPath);
      const info = await stat(canonicalPath);
      if (!info.isDirectory()) throw new TypeError('The selected project is not a directory.');

      await this.replaceEngineForNavigation(canonicalPath, {
        classification: 'project',
        projectPath: canonicalPath,
      }, 'desktop-project-switch');
      this.currentProject = canonicalPath;
      this.recentProjects = await this.projects.enter(canonicalPath);
      this.rememberProjectDirectory(requestedPath, canonicalPath);
      // Return the same decorated state that is published. Returning the raw
      // engine snapshot here lets a renderer invoke response overwrite the
      // navigation metadata from the richer state publication.
      result = this.getSnapshot();
      this.publish();
    });
    return result;
  }

  async startProjectTask(projectPath: string): Promise<EngineSnapshot> {
    const requestedPath = projectPath.trim();
    if (!requestedPath) throw new TypeError('A project folder is required.');
    let result: EngineSnapshot = null;
    const started = DESKTOP_PERF_ENABLED ? performance.now() : 0;
    let stageNote = '';
    const stage = (label: string, from: number) => {
      if (DESKTOP_PERF_ENABLED) stageNote += ` ${label}=${(performance.now() - from).toFixed(0)}ms`;
    };
    await this.exclusive(async () => {
      let stageStarted = DESKTOP_PERF_ENABLED ? performance.now() : 0;
      await this.sessionMetadata.load();
      stage('titles', stageStarted);
      stageStarted = DESKTOP_PERF_ENABLED ? performance.now() : 0;
      const registeredPath = await this.projects.knownPath(requestedPath);
      stage('known-project', stageStarted);
      stageStarted = DESKTOP_PERF_ENABLED ? performance.now() : 0;
      const canonicalPath = await this.canonicalDirectory(registeredPath);
      stage('canonical', stageStarted);
      stageStarted = DESKTOP_PERF_ENABLED ? performance.now() : 0;
      await this.replaceEngineForNavigation(canonicalPath, {
        classification: 'project',
        projectPath: canonicalPath,
      }, 'desktop-new-project-task');
      stage('replace-engine', stageStarted);
      stageStarted = DESKTOP_PERF_ENABLED ? performance.now() : 0;
      this.currentProject = canonicalPath;
      this.recentProjects = await this.projects.touchSelected(registeredPath);
      this.rememberProjectDirectory(requestedPath, canonicalPath);
      result = this.getSnapshot();
      this.publish();
      stage('finalize', stageStarted);
    });
    if (DESKTOP_PERF_ENABLED) {
      this.perfLog(`start-project-task total=${(performance.now() - started).toFixed(0)}ms${stageNote}`);
    }
    return result;
  }

  /** Register a folder in the shared project store WITHOUT entering it: the
   *  Projects page adds projects in place (user decision), so no engine
   *  replacement or navigation happens here. */
  async addProject(projectPath: string): Promise<void> {
    const requestedPath = projectPath.trim();
    if (!requestedPath) throw new TypeError('A project folder is required.');
    await this.exclusive(async () => {
      const canonicalPath = await realpath(requestedPath);
      const info = await stat(canonicalPath);
      if (!info.isDirectory()) throw new TypeError('The selected project is not a directory.');
      this.recentProjects = await this.projects.register(canonicalPath);
      this.rememberProjectDirectory(requestedPath, canonicalPath);
    });
  }

  async listProjects(): Promise<DesktopProjectSummary[]> {
    let projects: DesktopProjectSummary[] = [];
    await this.exclusive(async () => {
      const listed = await this.projects.list();
      projects = listed.projects;
      this.recentProjects = listed.recents;
    });
    return projects;
  }

  async projectDirectory(projectPath: string): Promise<string> {
    const requestedPath = projectPath.trim();
    if (!requestedPath) throw new TypeError('A project folder is required.');
    const key = normalizedProjectKey(requestedPath);
    const active = this.currentProject;
    if (active && normalizedProjectKey(active) === key) return active;
    const cached = this.projectDirectoryCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.directory;
    if (cached) this.projectDirectoryCache.delete(key);
    const existing = this.projectDirectoryRequests.get(key);
    if (existing) return existing;

    let request: Promise<string>;
    request = (async () => {
      let directory = '';
      await this.exclusive(async () => {
        directory = await this.canonicalDirectory(await this.projects.knownPath(requestedPath));
      });
      this.rememberProjectDirectory(requestedPath, directory);
      return directory;
    })().finally(() => {
      if (this.projectDirectoryRequests.get(key) === request) {
        this.projectDirectoryRequests.delete(key);
      }
    });
    this.projectDirectoryRequests.set(key, request);
    return request;
  }

  // Project file operations (traversal-guarded FS + editor + code-graph):
  // bodies live in project-files.ts; the class resolves the project root
  // (exclusive-locked) and delegates.
  async listProjectDir(projectPath: string, relDir: string): Promise<Array<{ name: string; dir: boolean }>> {
    return listProjectDirIn(await this.projectDirectory(projectPath), relDir);
  }

  async projectEntryPath(projectPath: string, relPath: string): Promise<string> {
    return projectEntryPathIn(await this.projectDirectory(projectPath), relPath);
  }

  async readProjectTextFile(projectPath: string, relPath: string): Promise<{
    content: string;
    mtimeMs: number;
    binary: boolean;
    tooLarge: boolean;
    encoding: import('./project-files').ProjectTextEncoding;
  }> {
    return readProjectTextFileIn(await this.projectDirectory(projectPath), relPath);
  }

  async statProjectFile(projectPath: string, relPath: string): Promise<{ mtimeMs: number; size: number }> {
    return statProjectFileIn(await this.projectDirectory(projectPath), relPath);
  }

  async codeGraphQuery(
    projectPath: string,
    mode: 'find_symbol' | 'references' | 'symbols',
    query: string,
  ): Promise<string> {
    return codeGraphQueryIn(await this.projectDirectory(projectPath), mode, query, {
      packaged: this.packaged,
      resourcesPath: this.resourcesPath,
      appPath: this.appPath,
    });
  }

  async writeProjectTextFile(
    projectPath: string,
    relPath: string,
    content: string,
    expectedContent: string,
    encoding?: import('./project-files').ProjectTextEncoding,
  ): Promise<{ mtimeMs: number }> {
    return writeProjectTextFileIn(
      await this.projectDirectory(projectPath),
      relPath,
      content,
      expectedContent,
      encoding,
    );
  }

  async createProjectEntry(projectPath: string, relDir: string, name: string, dir: boolean): Promise<void> {
    return createProjectEntryIn(await this.projectDirectory(projectPath), relDir, name, dir);
  }

  async renameProjectEntry(projectPath: string, relPath: string, newName: string): Promise<void> {
    return renameProjectEntryIn(await this.projectDirectory(projectPath), relPath, newName);
  }

  async moveProjectEntry(projectPath: string, relPath: string, targetDirRel: string): Promise<void> {
    return moveProjectEntryIn(await this.projectDirectory(projectPath), relPath, targetDirRel);
  }

  async copyProjectEntry(projectPath: string, relPath: string, targetDirRel: string): Promise<{ name: string }> {
    return copyProjectEntryIn(await this.projectDirectory(projectPath), relPath, targetDirRel);
  }

  async renameProject(projectPath: string, alias: string): Promise<void> {
    const displayAlias = alias.trim();
    if (displayAlias.length > 120 || /[\u0000-\u001f\u007f]/.test(displayAlias)) {
      throw new TypeError('Project name is invalid.');
    }
    await this.exclusive(() => this.projects.rename(projectPath, displayAlias));
  }

  async removeProject(projectPath: string): Promise<void> {
    await this.exclusive(async () => {
      this.recentProjects = await this.projects.remove(projectPath);
      this.projectDirectoryCache.clear();
    });
  }

  async startTask(): Promise<EngineSnapshot> {
    let result: EngineSnapshot = null;
    await this.exclusive(async () => {
      await this.sessionMetadata.load();
      const workspace = await this.taskWorkspace();
      await this.replaceEngineForNavigation(workspace, {
        classification: 'task',
        projectPath: null,
      }, 'desktop-new-task');
      this.currentProject = null;
      result = this.getSnapshot();
      this.publish();
    });
    return result;
  }

  async listSessions(): Promise<DesktopSessionSummary[]> {
    // The sidebar is process-global even when a warm engine is scoped to one
    // workspace. Always use the lightweight store index in the real app:
    // falling back to warm engine.listSessions() briefly replaced the complete
    // list with one workspace, then the watcher restored it (visible flicker).
    // This path also stays outside `exclusive`, so startup listing never queues
    // behind engine/model hydration. Explicit test engines retain the legacy
    // path unless they provide a store override.
    if (this.loadSessionStoreOverride || !this.createEngineOverride) {
      try {
        await this.sessionMetadata.load();
        const store = await this.loadSessionStoreModule();
        // Startup must never turn a sidebar read into a full transcript scan.
        // The renderer already has its persisted catalog; this call only
        // reconciles the lightweight sidecar after visible panes have mounted.
        const rows = store.listStoredSessionSummaries({ rebuildIfMissing: false });
        const summaries = this.sessionSummaries(false, rows);
        this.ensureSessionsWatcher();
        return summaries;
      } catch {
        // A broken optional cold reader must not boot the full runtime ahead
        // of visible panes. The renderer's bounded catalog cache remains.
        this.ensureSessionsWatcher();
        return [];
      }
    }
    let summaries: DesktopSessionSummary[] = [];
    await this.exclusive(async () => {
      await this.sessionMetadata.load();
      if (!this.engine) {
        const workspace = await this.taskWorkspace();
        await this.replaceEngine(workspace, {
          classification: 'task',
          projectPath: null,
        }, 'desktop-session-browser');
      }
      // Once warm, refresh authoritatively so cross-process activity remains
      // visible through the existing engine/store ownership boundary.
      summaries = this.sessionSummaries(true);
    });
    this.ensureSessionsWatcher();
    return summaries;
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new TypeError('session id is invalid.');
    const normalized = normalizeSessionTitle(title, '');
    if (!normalized) throw new TypeError('Session title is invalid.');
    await this.exclusive(async () => {
      await this.sessionMetadata.load();
      if (!this.engine) {
        const workspace = await this.taskWorkspace();
        await this.replaceEngine(workspace, {
          classification: 'task',
          projectPath: null,
        }, 'desktop-session-rename');
      }
      if (!this.sessionSummaries().some((session) => session.id === sessionId)) {
        throw new Error('Session is not available.');
      }
      const titleEngine = this.sessionEngineFor(sessionId) ?? this.engine;
      if (typeof titleEngine?.renameSessionTitle === 'function') {
        await titleEngine.renameSessionTitle(sessionId, normalized);
      }
      await this.sessionMetadata.setName(sessionId, normalized);
      this.scheduleSessionsChanged();
      if (String(this.engine?.getState()?.sessionId || '') === sessionId) this.publish();
    });
  }

  // Archive: hide from Recent without touching the on-disk
  // session file. Persisted in desktop-session-metadata.json — the optimistic
  // renderer flip previously had NO backend, so the next catalog push
  // resurrected every archived row (user bug).
  async setSessionArchived(sessionId: string, archived: boolean): Promise<void> {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new TypeError('session id is invalid.');
    let changed = false;
    await this.exclusive(async () => {
      await this.sessionMetadata.load();
      changed = await this.sessionMetadata.setArchived(sessionId, archived);
    });
    // Reconcile every window through the normal catalog push channel.
    if (changed) this.scheduleSessionsChanged();
  }

  async deleteSession(sessionId: string): Promise<EngineSnapshot> {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new TypeError('session id is invalid.');
    let result: EngineSnapshot = null;
    await this.exclusive(async () => {
      await this.withPublicationsHeld(async () => {
        await this.sessionMetadata.load();
        if (!this.engine) {
          const workspace = await this.taskWorkspace();
          await this.replaceEngine(workspace, {
            classification: 'task',
            projectPath: null,
          }, 'desktop-session-delete');
        }
        const engine = this.requireEngine();
        const state = engine.getState();
        if (state.busy === true || state.commandBusy === true) {
          throw new Error('Engine is busy.');
        }
        let rawSessions = engine.listSessions() || [];
        let available = desktopSessionSummaries(
          rawSessions,
          String(state.sessionId || ''),
          this.sessionMetadata.titles,
          this.sessionMetadata.names,
        ).some((session) => session.id === sessionId);
        if (!available) {
          rawSessions = engine.listSessions({ refreshFromStorage: true }) || [];
          available = desktopSessionSummaries(
            rawSessions,
            String(state.sessionId || ''),
            this.sessionMetadata.titles,
            this.sessionMetadata.names,
          ).some((session) => session.id === sessionId);
        }
        if (!available) throw new Error('Session is not available.');
        if (await engine.deleteSession(sessionId) !== true) {
          throw new Error('Session could not be deleted.');
        }
        await this.sessionMetadata.forget(sessionId);
        result = this.getSnapshot();
        this.publish();
      });
    });
    return result;
  }

  async searchProjectFiles(
    projectIdOrWorkspaceId: string,
    query: string,
    limit = 50,
  ): Promise<string[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new TypeError('File search limit is invalid.');
    }
    const requested = projectIdOrWorkspaceId.trim();
    if (!requested) throw new TypeError('Project or workspace id is invalid.');
    if (typeof query !== 'string' || query.length > 1_024) {
      throw new TypeError('File search query is invalid.');
    }
    let root = '';
    await this.exclusive(async () => {
      const active = this.currentProject ?? this.engineWorkspace;
      if (!active || normalizedProjectKey(active) !== normalizedProjectKey(requested)) {
        throw new Error('Project or workspace is not active.');
      }
      root = await this.canonicalDirectory(active);
    });
    const results = await this.searchProjectDirectory(root, query, limit);
    await this.exclusive(async () => {
      const active = this.currentProject ?? this.engineWorkspace;
      if (!active || normalizedProjectKey(active) !== normalizedProjectKey(root)) {
        throw new Error('Project or workspace changed during file search.');
      }
    });
    return results;
  }

  async listProviderModels(options: DesktopModelCatalogOptions = {}): Promise<DesktopModelOption[]> {
    const started = DESKTOP_PERF_ENABLED ? performance.now() : 0;
    if (!this.engine) {
      await this.exclusive(async () => {
        if (this.engine) return;
        const workspace = await this.taskWorkspace();
        await this.replaceEngine(workspace, {
          classification: 'task',
          projectPath: null,
        }, 'desktop-model-selector');
      });
    }
    const engine = this.requireEngine();
    if (DESKTOP_PERF_ENABLED) {
      this.perfLog(`model-catalog engine-ready ms=${(performance.now() - started).toFixed(0)}`);
    }
    const requestKey = options.force === true || options.refresh === true
      ? 'refresh'
      : options.quick === true ? 'quick' : 'full';
    const existing = this.modelCatalogRequests.get(requestKey);
    if (existing?.engine === engine) {
      if (DESKTOP_PERF_ENABLED) {
        this.perfLog(`model-catalog joined mode=${requestKey} ms=${(performance.now() - started).toFixed(0)}`);
      }
      return existing.promise;
    }
    // Catalog reads run OUTSIDE the host transition lock. The secrets-aware
    // full load is network-bound and used to hold `exclusive` for its entire
    // duration, so a session clicked during startup hydration queued behind it
    // (user: the first session open takes far too long). The engine reference
    // is captured under the lock; the core joins/caches concurrent catalog
    // reads, and a catalog rejection after a context switch surfaces through
    // the picker's inline failure path instead of blocking navigation.
    let request: Promise<DesktopModelOption[]>;
    request = (async () => {
      let models: DesktopModelOption[] = [];
      const refresh = options.force === true || options.refresh === true;
      if (refresh) {
        models = normalizedProviderModels(await engine.listProviderModels({ force: true, quick: false }));
      } else if (options.quick === true) {
        // Match the TUI picker: seed the authoritative secrets-aware request
        // before reading quick route rows so the following full desktop read
        // joins this core promise instead of starting a second network load.
        try {
          void Promise.resolve(engine.listProviderModels({ quick: false })).catch((error: unknown) => {
            console.warn('Desktop model catalog background refresh failed:', error);
          });
        } catch (error) {
          // Quick rows remain useful, but a synchronous setup failure should
          // still be diagnosable rather than disappearing into the warmup path.
          console.warn('Desktop model catalog background refresh could not start:', error);
        }
        models = normalizedProviderModels(await engine.listProviderModels({ quick: true }));
      } else {
        // A quick request starts the core's advisory no-secrets warmup. If a
        // full request arrives while that warmup is in flight, the first call
        // can legally join it and receive its partial provider set. A second
        // non-quick read is free when the first call was authoritative (the
        // core cache answers it), while after an advisory warmup it starts the
        // required secrets-aware load. This keeps the desktop catalog aligned
        // with /model without forcing a network refresh on every open.
        await engine.listProviderModels({ quick: false });
        models = normalizedProviderModels(await engine.listProviderModels({ quick: false }));
      }
      if (DESKTOP_PERF_ENABLED) {
        this.perfLog(`model-catalog total ms=${(performance.now() - started).toFixed(0)} quick=${options.quick === true}`);
      }
      if (options.quick !== true) this.modelCatalogCache.clear();
      for (const model of models) {
        this.modelCatalogCache.set(`${model.provider}\n${model.model}`, model);
      }
      return models;
    })().finally(() => {
      if (this.modelCatalogRequests.get(requestKey)?.promise === request) {
        this.modelCatalogRequests.delete(requestKey);
      }
    });
    this.modelCatalogRequests.set(requestKey, { engine, promise: request });
    return request;
  }

  /** SESSION-SCOPED model route memory (user requirement): sessions resumed
   *  through the switchContext fast path / engine reuse inherit whatever
   *  route the shared engine last had, silently showing (and submitting
   *  with) another session's model. Every switch-away and every explicit
   *  route change records the session's route; resume restores it. Parked
   *  engines keep their own route and never need the restore. */
  private readonly sessionRoutes = new Map<string, DesktopModelSelection>();

  private rememberEngineRoute(engine: MixdogEngine | null | undefined): void {
    const state = engine?.getState?.() as Record<string, unknown> | undefined;
    const sessionId = String(state?.sessionId || '');
    const provider = String(state?.provider || '');
    const model = String(state?.model || '');
    if (!sessionId || !provider || !model) return;
    this.sessionRoutes.set(sessionId, {
      provider,
      model,
      ...(typeof state?.effort === 'string' && state.effort ? { effort: state.effort } : {}),
      ...(typeof state?.fast === 'boolean' ? { fast: state.fast } : {}),
    });
  }

  private async applyModelSelection(
    engine: MixdogEngine,
    selection: DesktopModelSelection,
    cachedModel?: DesktopModelOption,
  ): Promise<void> {
    const state = engine.getState();
    // Match the TUI: a model change during an active turn is a preference for
    // the next session and must not rewrite the in-flight session. Concurrent
    // command mutations remain blocked.
    if (state.commandBusy === true) {
      throw new Error('Engine is busy.');
    }
    const model = cachedModel
      || normalizedProviderModels(await engine.listProviderModels({ quick: false }))
        .find((option) => option.provider === selection.provider && option.model === selection.model);
    if (!model) throw new Error('Selected provider/model is unavailable.');
    if (selection.effort !== undefined &&
      !model.effortOptions.some((option) => option.value === selection.effort)) {
      throw new Error('Selected effort is unavailable.');
    }
    if (selection.fast === true && !model.fastCapable) {
      throw new Error('Fast mode is unavailable for the selected provider/model.');
    }
    const latestState = engine.getState();
    if (latestState.commandBusy === true) {
      throw new Error('Engine is busy.');
    }
    if (await engine.setRoute(selection) !== true) {
      throw new Error('Engine is busy.');
    }
    const routeState = engine.getState();
    this.pendingFastPreference = !routeState.sessionId && typeof selection.fast === 'boolean'
      ? selection.fast
      : null;
  }

  async setModelRoute(selection: DesktopModelSelection): Promise<EngineSnapshot> {
    let result: EngineSnapshot = null;
    await this.exclusive(async () => {
      const engine = this.requireEngine();
      await this.applyModelSelection(engine, selection);
      this.rememberEngineRoute(engine);
      result = this.getSnapshot();
      this.publish();
    });
    return result;
  }

  async setFast(enabled: boolean): Promise<EngineSnapshot> {
    let result: EngineSnapshot = null;
    await this.exclusive(async () => {
      if (!this.engine) {
        const workspace = await this.taskWorkspace();
        await this.replaceEngine(workspace, {
          classification: 'task',
          projectPath: null,
        }, 'desktop-fast-preference');
      }
      const engine = this.requireEngine();
      const state = engine.getState();
      if (state.busy === true || state.commandBusy === true) {
        throw new Error('Engine is busy.');
      }
      // The runtime owns capability resolution (including metadata that may
      // have arrived after the last renderer snapshot), so its setFast return
      // value is authoritative. A stale desktop fastCapable field must not
      // prevent the backend from applying a valid stored preference.
      const applied = await engine.setFast(enabled);
      if (applied !== enabled) {
        const latest = engine.getState();
        if (latest.busy === true || latest.commandBusy === true) {
          throw new Error('Engine is busy.');
        }
        throw new Error('Fast mode preference was not applied.');
      }
      const latest = engine.getState();
      const hasActiveSession = Boolean(latest.sessionId);
      // The route API is authoritative: `applied === enabled` here. Session-
      // derived state may lag one event-loop turn (or not exist yet), so a
      // mismatch is reconciled via the pending override instead of throwing —
      // the previous hard error surfaced as a user-facing toast on a state
      // race even though the preference was applied successfully.
      const reflected = hasActiveSession
        && typeof latest.fast === 'boolean' && latest.fast === applied;
      this.pendingFastPreference = reflected ? null : applied;
      this.rememberEngineRoute(this.engine);
      result = this.getSnapshot();
      this.publish();
    });
    return result;
  }

  async resumeSession(sessionId: string): Promise<EngineSnapshot> {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new TypeError('session id is invalid.');
    let result: EngineSnapshot = null;
    const totalStarted = DESKTOP_PERF_ENABLED ? performance.now() : 0;
    let stageNote = '';
    // Focus switches command/input ownership only. A pane that is already
    // painting its own live frame keeps that frame AND its viewer until the
    // resumed engine reaches the same content, so no live -> disk/replay ->
    // live transition is ever exposed (see projectSessionLaneFrame).
    const visibleFrame = this.visibleSessionIds.has(sessionId)
      ? this.visibleSessionFrames.get(sessionId)
      : undefined;
    const retainedResumeFrame: VisibleSessionResumeFrame | null = visibleFrame?.live
      ? { snapshot: visibleFrame.snapshot }
      : null;
    try {
      await this.exclusive(async () => {
      await this.withPublicationsHeld(async () => {
        await this.sessionMetadata.load();
        if (!this.engine) {
          const workspace = await this.taskWorkspace();
          await this.replaceEngine(workspace, {
            classification: 'task',
            projectPath: null,
          }, 'desktop-session-browser', { forResume: true });
        }
        if (String(this.engine?.getState()?.sessionId || '') === sessionId) {
          result = this.getSnapshot();
          return;
        }
        const lookupStarted = DESKTOP_PERF_ENABLED ? performance.now() : 0;
        // Reuse the rows the sidebar listing already produced; a stale or
        // missing row falls through to the storage rescan below.
        const readSessionRows = (refreshFromStorage = false) => {
          const rows = this.engine?.listSessions(
            refreshFromStorage ? { refreshFromStorage: true } : undefined,
          ) || [];
          if (Array.isArray(rows) && rows.length) this.lastSessionRows = rows;
          return rows;
        };
        let rawSessions = this.lastSessionRows || readSessionRows();
        if (DESKTOP_PERF_ENABLED) stageNote += ` list=${(performance.now() - lookupStarted).toFixed(0)}ms`;
        let selected = desktopSessionSummaries(
          rawSessions,
          String(this.engine?.getState()?.sessionId || ''),
          this.sessionMetadata.titles,
          this.sessionMetadata.names,
        ).find((row) => row.id === sessionId);
        // Session navigation is populated from this same cached catalog. Only
        // rescan storage if the requested row is absent (for example, a session
        // created by another process since the sidebar was loaded).
        if (!selected) {
          rawSessions = readSessionRows(true);
          selected = desktopSessionSummaries(
            rawSessions,
            String(this.engine?.getState()?.sessionId || ''),
            this.sessionMetadata.titles,
            this.sessionMetadata.names,
          ).find((row) => row.id === sessionId);
        }
        if (DESKTOP_PERF_ENABLED) stageNote += ` lookup=${(performance.now() - lookupStarted).toFixed(0)}ms`;
        // Cross-process create race: a webhook/schedule session another
        // process is MID-SAVE can scan as absent for one beat (atomic rename
        // in flight). One short retry absorbs it instead of surfacing a
        // "Session is not available." toast on a row the sidebar just showed.
        if (!selected) {
          await new Promise((resolve) => setTimeout(resolve, 300));
          rawSessions = readSessionRows(true);
          selected = desktopSessionSummaries(
            rawSessions,
            String(this.engine?.getState()?.sessionId || ''),
            this.sessionMetadata.titles,
            this.sessionMetadata.names,
          ).find((row) => row.id === sessionId);
        }
        if (!selected) throw new Error('Session is not available.');
        const rawSelected = rawSessions.find((row) => String(row.id || '') === sessionId);
        const storedDesktop = rawSelected?.desktopSession && typeof rawSelected.desktopSession === 'object'
          ? rawSelected.desktopSession as Record<string, unknown>
          : null;
        const isDesktopManaged = storedDesktop?.classification === 'task' ||
          storedDesktop?.classification === 'project';

        const workspaceStarted = DESKTOP_PERF_ENABLED ? performance.now() : 0;
        const workspace = selected.classification === 'task'
          ? await this.taskWorkspace()
          : await this.canonicalDirectory(selected.projectPath || selected.cwd);
        if (DESKTOP_PERF_ENABLED) stageNote += ` workspace=${(performance.now() - workspaceStarted).toFixed(0)}ms`;
        const desktopSession: DesktopSessionScope = selected.classification === 'project'
          ? { classification: 'project', projectPath: workspace }
          : { classification: 'task', projectPath: null };
        // Legacy CLI/TUI Lead sessions intentionally resume without a desktop
        // capability marker. The core then follows its historical resume path;
        // desktop-created rows still pass their durable marker and retain the
        // cross-class tamper guard.
        const targetDesktopSession = isDesktopManaged ? desktopSession : null;
        const sameManagedContext = Boolean(this.engine && this.engineWorkspace === workspace && (
          targetDesktopSession === null
            ? this.engineDesktopSession === null
            : this.engineDesktopSession?.classification === targetDesktopSession.classification &&
              this.engineDesktopSession?.projectPath === targetDesktopSession.projectPath
        ));
        // Capture the OUTGOING session's route before any engine handoff, so
        // returning to it later restores its own model (not the last one the
        // shared engine happened to carry).
        this.rememberEngineRoute(this.engine);
        let parkedOutgoingId: string | null = null;
        let needsResume = true;
        let cleanupOnResumeFailure = !sameManagedContext;
        let nextEngine: MixdogEngine;
        if (this.parkedEngines.has(sessionId)) {
          const parkedOutgoing = this.parkCurrentEngine();
          if (parkedOutgoing) {
            parkedOutgoingId = parkedOutgoing;
          } else {
            await this.disposeCurrent('desktop-session-activate-parked', { keepBackgroundWork: true });
          }
          try {
            nextEngine = this.activateParkedEngine(sessionId);
          } catch (error) {
            if (parkedOutgoingId) this.activateParkedEngine(parkedOutgoingId);
            throw error;
          }
          needsResume = false;
          cleanupOnResumeFailure = true;
        } else if (this.currentEngineIsRunning()) {
          parkedOutgoingId = this.parkCurrentEngine();
          cleanupOnResumeFailure = true;
          try {
            const replaceStarted = DESKTOP_PERF_ENABLED ? performance.now() : 0;
            const engine = await this.replaceEngine(
              workspace,
              targetDesktopSession,
              'desktop-session-resume',
              { forResume: true },
            );
            if (DESKTOP_PERF_ENABLED) stageNote += ` replace-engine=${(performance.now() - replaceStarted).toFixed(0)}ms`;
            nextEngine = engine;
          } catch (error) {
            if (parkedOutgoingId) this.activateParkedEngine(parkedOutgoingId);
            throw error;
          }
        } else {
          nextEngine = sameManagedContext
            ? this.requireEngine()
            : await (async () => {
              const replaceStarted = DESKTOP_PERF_ENABLED ? performance.now() : 0;
              const engine = await this.replaceEngine(
                workspace,
                targetDesktopSession,
                'desktop-session-resume',
                { forResume: true },
              );
              if (DESKTOP_PERF_ENABLED) stageNote += ` replace-engine=${(performance.now() - replaceStarted).toFixed(0)}ms`;
              return engine;
            })();
        }
        const resumeStarted = DESKTOP_PERF_ENABLED ? performance.now() : 0;
        // The hold exists ONLY to protect a retained visible frame. A cold or
        // hidden resume has nothing to protect, so its publications stay
        // ordinary/live and immediate. Any unsuccessful, superseded or
        // mismatched resume restores the pre-resume hold state: a stale hold on
        // a reused engine would suppress every later live frame and strand the
        // pane's read-only viewer.
        const previousResumeHold = this.sessionLaneResumeHolds.get(nextEngine);
        let installedResumeHold: SessionLaneResumeHold | null = null;
        const restoreResumeHold = (): void => {
          installedResumeHold = null;
          if (previousResumeHold) this.sessionLaneResumeHolds.set(nextEngine, previousResumeHold);
          else this.sessionLaneResumeHolds.delete(nextEngine);
        };
        if (needsResume) {
          // A reused engine can still carry the OUTGOING session's hold. It
          // protects another lane's frame, so this resume either replaces it
          // with its own or clears it outright; rekeying a previous session's
          // retained snapshot onto the incoming lane is never correct.
          if (retainedResumeFrame) {
            installedResumeHold = {
              sessionId,
              retained: retainedResumeFrame,
              viewerBacked: this.visibleSessionViewers.has(sessionId),
            };
            this.sessionLaneResumeHolds.set(nextEngine, installedResumeHold);
          } else {
            this.sessionLaneResumeHolds.delete(nextEngine);
          }
          let resumed = false;
          try {
            resumed = await nextEngine.resume(sessionId, {
              transcriptItemLimit: DESKTOP_TRANSCRIPT_ITEM_LIMIT,
            }) === true;
          } catch (error) {
            restoreResumeHold();
            throw error;
          }
          if (!resumed) {
            restoreResumeHold();
            if (cleanupOnResumeFailure) {
              try {
                await this.disposeCurrent('desktop-session-resume-failed', { keepBackgroundWork: true });
              } finally {
                if (parkedOutgoingId) this.activateParkedEngine(parkedOutgoingId);
              }
            }
            throw new Error('Session could not be resumed.');
          }
        }
        if (DESKTOP_PERF_ENABLED) stageNote += ` engine-resume=${(performance.now() - resumeStarted).toFixed(0)}ms`;
        // Fork-on-resume: resuming a session actively driven by another live
        // process opens a transcript fork under a fresh id. The engine marks
        // it via sessionForkedFrom — accept the fork as a successful resume of
        // the clicked session; any other id mismatch remains a hard failure.
        const resumedState = nextEngine.getState();
        const resumedId = String(resumedState?.sessionId || '');
        const resumedForkedFrom = String(resumedState?.sessionForkedFrom || '');
        if (resumedId !== sessionId && resumedForkedFrom !== sessionId) {
          restoreResumeHold();
          if (cleanupOnResumeFailure) {
            try {
              await this.disposeCurrent('desktop-session-resume-mismatch', { keepBackgroundWork: true });
            } finally {
              if (parkedOutgoingId) this.activateParkedEngine(parkedOutgoingId);
            }
          }
          throw new Error('Session resume returned an unexpected session.');
        }
        // Restore THIS session's remembered route onto the reused engine
        // (best-effort; parked engines already own their route). A fork
        // inherits the origin session's route memory.
        if (needsResume) {
          const remembered = this.sessionRoutes.get(sessionId);
          if (remembered) {
            const stateView = resumedState as Record<string, unknown> | null;
            const differs = String(stateView?.provider || '') !== remembered.provider
              || String(stateView?.model || '') !== remembered.model
              || (remembered.effort !== undefined && String(stateView?.effort || '') !== remembered.effort)
              || (typeof remembered.fast === 'boolean' && stateView?.fast !== remembered.fast);
            if (differs) {
              try { await nextEngine.setRoute(remembered); } catch { /* best-effort */ }
            }
            if (resumedId && resumedId !== sessionId) this.sessionRoutes.set(resumedId, remembered);
          }
        }
        this.currentProject = selected.classification === 'project' ? workspace : null;
        const finalizeStarted = DESKTOP_PERF_ENABLED ? performance.now() : 0;
        this.rememberCurrentSessionTitle();
        result = this.getSnapshot();
        const resultSessionId = String(
          (result as Record<string, unknown> | null)?.sessionId || '',
        );
        if (resultSessionId && resultSessionId !== sessionId) {
          // Fork-on-resume publishes under a NEW id while every visible-pane map
          // is keyed by the origin. Move the whole pane identity first, so the
          // fork lane finds its retained frame/viewer and stays held until it
          // converges — instead of seeing a non-visible id, dropping the hold and
          // publishing unconverged fork content while the origin viewer leaks.
          this.migrateVisibleSessionIdentity(sessionId, resultSessionId);
        }
        const resumeHold = this.sessionLaneResumeHolds.get(nextEngine);
        // Only the hold THIS resume installed may be re-keyed: a hold left by
        // another session's lane never inherits this pane's identity.
        if (resumeHold && resumeHold === installedResumeHold
          && resultSessionId && resultSessionId !== resumeHold.sessionId) {
          this.sessionLaneResumeHolds.set(nextEngine, {
            ...resumeHold,
            sessionId: resultSessionId,
            viewerBacked: resumeHold.viewerBacked
              || this.visibleSessionViewers.has(resultSessionId),
          });
        }
        // The result is already a detached, renderer-safe snapshot. Reuse it
        // for the held publication instead of cloning a long transcript twice.
        this.publish(result);
        // Session panes never read the focused channel. Route completion
        // therefore replays the active engine through the SAME per-session
        // lane used before/after focus; no focus-specific projection exists.
        this.sessionLanes.replay(nextEngine);
        if (DESKTOP_PERF_ENABLED) stageNote += ` finalize=${(performance.now() - finalizeStarted).toFixed(0)}ms`;
        });
      });
      if (DESKTOP_PERF_ENABLED) {
        this.perfLog(`resume-session id=${sessionId} total=${(performance.now() - totalStarted).toFixed(0)}ms${stageNote}`);
      }
      return result;
    } finally {
      for (const visibleSessionId of this.visibleSessionIds) {
        void this.reconcileVisibleSession(visibleSessionId);
      }
    }
  }

  async prefetchSession(sessionId: string): Promise<boolean> {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new TypeError('session id is invalid.');
    // Hover warmth only: a cold host must not boot an engine (and hold the
    // transition lock) for a prefetch — that queued the click the user then
    // actually made behind two speculative boots.
    const engine = this.engine;
    if (!engine) return false;
    const started = DESKTOP_PERF_ENABLED ? performance.now() : 0;
    // Preparation only fills the manager's bounded read cache; it does not
    // mutate the active engine. Keep it OUTSIDE the navigation lock so a slow
    // transcript parse can never queue the click it was meant to accelerate.
    const prefetched = await Promise.resolve(engine.prefetchSession?.(sessionId)) === true;
    if (DESKTOP_PERF_ENABLED) {
      this.perfLog(`prefetch-session id=${sessionId} ok=${prefetched} total=${(performance.now() - started).toFixed(0)}ms`);
    }
    return prefetched;
  }

  /** Pane peek: every visible pane is FOREGROUND (user requirement). A
   *  session with no pooled engine gets a one-shot read-only lane frame
   *  (transcript + route + context projection) built from its session file,
   *  so the pane paints complete state instead of sitting blank or showing
   *  0% context until first focus. Also seeds the per-session route memory
   *  across app restarts. */
  async peekSession(sessionId: string): Promise<boolean> {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new TypeError('session id is invalid.');
    const pooledEngine = this.sessionEngineFor(sessionId);
    if (pooledEngine) {
      this.sessionLanes.replay(pooledEngine);
      return true;
    }
    const retained = this.visibleSessionFrames.get(sessionId);
    if (retained?.live) {
      this.sessionLanes.emitPeek(this.retainedPeekUpdate(sessionId, retained.snapshot));
      return true;
    }
    // Only a visible pane owns a follow marker, and only the pane lifecycle
    // this read belongs to: capture the identity BEFORE the await so a peek
    // that started pre-registration (no token) or across a hide -> re-add
    // cannot stamp a stale verdict onto the new pane. Registration installs
    // the marker through reconcileVisibleSessionNow anyway.
    const token = this.visibleSessionIds.has(sessionId)
      ? this.visibleSessionStorageToken(sessionId)
      : null;
    const peeked = await this.storedSessionPeek(sessionId);
    const snapshot = peeked.snapshot;
    const pooledAfterPeek = this.sessionEngineFor(sessionId);
    if (pooledAfterPeek) {
      this.sessionLanes.replay(pooledAfterPeek);
      return true;
    }
    if (token && this.visibleSessionStorageRunnable(sessionId, token)) {
      this.applyDetachedAgentMarker(sessionId, peeked.readOnlyDetachedAgent);
    }
    // A live owner may connect while the read-only refresh is in flight.
    // Its frame is authoritative and must never be replaced by the disk/
    // in-process peek that started before the owner publication arrived.
    const current = this.visibleSessionFrames.get(sessionId);
    if (current?.live) {
      this.sessionLanes.emitPeek(this.retainedPeekUpdate(sessionId, current.snapshot));
      return true;
    }
    if (snapshot) {
      this.emitVisibleSessionSnapshot(sessionId, snapshot, 'stored');
      return true;
    }
    if (retained) {
      this.sessionLanes.emitPeek(this.retainedPeekUpdate(sessionId, retained.snapshot));
      return true;
    }
    if (this.visibleSessionViewers.has(sessionId)) return true;
    return false;
  }

  private sessionEngineFor(sessionId: string): MixdogEngine | null {
    const activeEngine = String(this.engine?.getState?.()?.sessionId || '') === sessionId
      ? this.engine
      : null;
    return activeEngine ?? this.parkedEngines.get(sessionId)?.engine ?? null;
  }

  private async refreshVisibleSessionContextProjection(sessionId: string): Promise<void> {
    if (!this.visibleSessionIds.has(sessionId)) return;
    const pooledEngine = this.sessionEngineFor(sessionId);
    if (pooledEngine) {
      this.visibleSessionContextProjections.delete(sessionId);
      this.sessionLanes.replay(pooledEngine);
      return;
    }
    const peeked = await this.storedSessionPeek(sessionId);
    if (!peeked.snapshot || !peeked.preparedContextProjection
      || !this.visibleSessionIds.has(sessionId)) return;
    this.visibleSessionContextProjections.set(sessionId, peeked.snapshot);
    const current = this.visibleSessionFrames.get(sessionId);
    if (!current) {
      this.emitVisibleSessionSnapshot(sessionId, peeked.snapshot, 'stored');
      return;
    }
    const snapshot = withVisibleSessionContextProjection(current.snapshot, peeked.snapshot);
    this.visibleSessionFrames.set(sessionId, { snapshot, live: current.live });
    this.sessionLanes.emitPeek({
      sessionId,
      snapshot,
      frameSource: current.live ? 'live' : 'replay',
      contentRevision: this.advanceSessionContentRevision(sessionId, snapshot),
    });
  }

  /** Read-only projection plus the durable reader's detached-child verdict.
   * The marker itself is NEVER mutated here: an orphaned run (pane hidden and
   * re-added while this read was in flight) would otherwise overwrite the new
   * lifecycle's follow state. Callers apply it behind their own guards. */
  private async storedSessionPeek(sessionId: string): Promise<{
    snapshot: EngineSnapshot | null;
    readOnlyDetachedAgent: boolean;
    preparedContextProjection: boolean;
  }> {
    const engine = this.engine as (MixdogEngine & {
      peekSessionTranscript?: (
        id: string,
        options?: { transcriptItemLimit?: number },
      ) => Record<string, unknown> | null;
    }) | null;
    const started = DESKTOP_PERF_ENABLED ? performance.now() : 0;
    const options = { transcriptItemLimit: DESKTOP_TRANSCRIPT_ITEM_LIMIT };
    const store = await this.loadSessionStoreModule();
    const storedPeek = await store.readStoredSessionTranscript?.(sessionId, options) ?? null;
    // The follower tells an owner-less child turn from a lead session by this
    // flag. It falls away as soon as the reader stops projecting a live
    // checkpoint (turn finished / worker terminal), which is what stops the
    // heartbeat follow after the final frame.
    const readOnlyDetachedAgent = storedPeek?.readOnlyDetachedAgent === true;
    const storedPreparedContextProjection = storedPeek?.preparedContextProjection === true;
    // A detached child is owned by an external worker/shard, not this desktop
    // engine. Its durable reader merges the live checkpoint read-only; the
    // engine runtime only sees the detached Task row and must not mask it.
    const enginePeek = !readOnlyDetachedAgent && engine?.peekSessionTranscript
      ? engine.peekSessionTranscript(sessionId, options)
      : null;
    let peek = readOnlyDetachedAgent
      ? storedPeek
      : enginePeek;
    peek ??= storedPeek;
    if (!peek) {
      return {
        snapshot: null,
        readOnlyDetachedAgent,
        preparedContextProjection: false,
      };
    }
    const provider = String(peek.provider || '');
    const model = String(peek.model || '');
    if (provider && model && !this.sessionRoutes.has(sessionId)) {
      this.sessionRoutes.set(sessionId, {
        provider,
        model,
        ...(typeof peek.effort === 'string' && peek.effort ? { effort: peek.effort } : {}),
        ...(typeof peek.fast === 'boolean' ? { fast: peek.fast } : {}),
      });
    }
    const stats = peek.stats && typeof peek.stats === 'object' && !Array.isArray(peek.stats)
      ? peek.stats
      : null;
    const contextWindow = Math.max(0, Number(peek.contextWindow || 0));
    const rawContextWindow = Math.max(0, Number(peek.rawContextWindow || 0));
    const displayContextWindow = Math.max(0, Number(peek.displayContextWindow || 0));
    const compactBoundaryTokens = Math.max(0, Number(peek.compactBoundaryTokens || 0));
    const autoCompactTokenLimit = Math.max(0, Number(peek.autoCompactTokenLimit || 0));
    const effectiveContextWindowPercent = Math.max(
      0,
      Number(peek.effectiveContextWindowPercent || 0),
    );
    const snapshot = {
      sessionId,
      items: Array.isArray(peek.items) ? peek.items : [],
      provider,
      model,
      effort: String(peek.effort || ''),
      fast: peek.fast === true,
      busy: false,
      commandBusy: false,
      queued: [],
      currentProject: String(
        (peek.desktopSession as Record<string, unknown> | null)?.projectPath || '',
      ) || null,
      cwd: String(peek.cwd || ''),
      workflow: peek.workflow ?? null,
      ...(stats ? { stats } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      ...(rawContextWindow ? { rawContextWindow } : {}),
      ...(displayContextWindow ? { displayContextWindow } : {}),
      ...(compactBoundaryTokens ? { compactBoundaryTokens } : {}),
      ...(autoCompactTokenLimit ? { autoCompactTokenLimit } : {}),
      ...(effectiveContextWindowPercent ? { effectiveContextWindowPercent } : {}),
    } as EngineSnapshot;
    const preparedContextProjection = Boolean(
      (enginePeek && peek === enginePeek)
      || (peek === storedPeek && storedPreparedContextProjection),
    );
    if (preparedContextProjection) {
      this.visibleSessionContextProjections.set(sessionId, snapshot);
    }
    if (DESKTOP_PERF_ENABLED) {
      this.perfLog(`peek-session id=${sessionId} total=${(performance.now() - started).toFixed(0)}ms`);
    }
    return { snapshot, readOnlyDetachedAgent, preparedContextProjection };
  }

  private applyDetachedAgentMarker(sessionId: string, detached: boolean): void {
    if (detached) this.detachedAgentSessions.add(sessionId);
    else this.detachedAgentSessions.delete(sessionId);
  }

  private emitVisibleSessionSnapshot(
    sessionId: string,
    snapshot: EngineSnapshot,
    source: 'stored' | 'live',
  ): void {
    // A pooled engine may appear while a disk read or external-viewer callback
    // is in flight. Its lane/focused stream is now authoritative; the older
    // callback must not mint a newer revision for stale storage content.
    // Exception: while that engine is still resuming BEHIND this pane's own
    // live frame, the viewer remains the authoritative source until handoff.
    if (this.sessionEngineFor(sessionId) && !this.visibleResumeHandoffPending(sessionId)) return;
    // A live viewer publication into an open hold makes that hold viewer-backed
    // even when it opened without one.
    if (source === 'live') this.markVisibleResumeHoldViewerBacked(sessionId);
    const current = this.visibleSessionFrames.get(sessionId);
    let projected = snapshot;
    let live = source === 'live';
    const regressed = source === 'stored' && current !== undefined
      && storedVisibleSessionSnapshotRegresses(current.snapshot, snapshot);
    if (regressed && current) {
      projected = {
        ...(snapshot && typeof snapshot === 'object' ? snapshot : {}),
        ...(current.snapshot && typeof current.snapshot === 'object' ? current.snapshot : {}),
        sessionId,
        busy: false,
        commandBusy: false,
        spinner: null,
        queued: [],
        activeToolSummary: null,
        agentWorkers: [],
        agentJobs: [],
        ownerClientHostPid: 0,
      } as EngineSnapshot;
      live = current.live;
    }
    this.visibleSessionFrames.set(sessionId, { snapshot: projected, live });
    // An owner publication and a durable read that does NOT regress the
    // retained frame both express a new authoritative generation; a regressing
    // read is a stale projection and re-carries the accepted revision.
    this.sessionLanes.emitPeek({
      sessionId,
      snapshot: projected,
      frameSource: source === 'live' ? 'live' : 'replay',
      contentRevision: regressed
        ? this.retainedSessionContentRevision(sessionId)
        : this.advanceSessionContentRevision(sessionId, projected),
    });
  }

  /** Re-emitting a frame this host already published is a REPLAY: it carries
   *  the accepted generation so a pane that already shows it can ignore the
   *  duplicate instead of swapping its rendered rows. */
  private retainedPeekUpdate(sessionId: string, snapshot: EngineSnapshot): SessionStateUpdate {
    return {
      sessionId,
      snapshot,
      frameSource: 'replay',
      contentRevision: this.retainedSessionContentRevision(sessionId),
    };
  }

  private disposeVisibleSessionViewer(sessionId: string): void {
    const viewer = this.visibleSessionViewers.get(sessionId);
    if (!viewer) return;
    this.visibleSessionViewers.delete(sessionId);
    try { viewer.dispose(); } catch { /* already disconnected */ }
  }

  private reconcileVisibleSession(sessionId: string): Promise<void> {
    const existing = this.visibleSessionStarts.get(sessionId);
    if (existing) return existing;
    const task = this.reconcileVisibleSessionNow(sessionId).catch(() => undefined);
    this.visibleSessionStarts.set(sessionId, task);
    void task.finally(() => {
      if (this.visibleSessionStarts.get(sessionId) === task) {
        this.visibleSessionStarts.delete(sessionId);
      }
    });
    return task;
  }

  private async reconcileVisibleSessionNow(sessionId: string): Promise<void> {
    if (!this.visibleSessionIds.has(sessionId)) return;
    const pooledEngine = this.sessionEngineFor(sessionId);
    if (pooledEngine) {
      // A pending handoff keeps the viewer: its frame is what the pane shows.
      if (!this.visibleResumeHandoffPending(sessionId)) this.disposeVisibleSessionViewer(sessionId);
      this.detachedAgentSessions.delete(sessionId);
      this.sessionLanes.replay(pooledEngine);
      return;
    }
    if (this.visibleSessionViewers.has(sessionId)) return;
    // Capture the pane identity BEFORE the read so a hide -> re-add during it
    // cannot let this run touch the new lifecycle's frame or follow marker.
    const token = this.visibleSessionStorageToken(sessionId);
    const peeked = await this.storedSessionPeek(sessionId);
    const snapshot = peeked.snapshot;
    if (!snapshot || !this.visibleSessionStorageRunnable(sessionId, token)) return;
    const pooledAfterRead = this.sessionEngineFor(sessionId);
    if (pooledAfterRead) {
      if (!this.visibleResumeHandoffPending(sessionId)) this.disposeVisibleSessionViewer(sessionId);
      this.detachedAgentSessions.delete(sessionId);
      this.sessionLanes.replay(pooledAfterRead);
      return;
    }
    this.applyDetachedAgentMarker(sessionId, peeked.readOnlyDetachedAgent);
    this.emitVisibleSessionSnapshot(sessionId, snapshot, 'stored');
    const store = await this.loadSessionStoreModule();
    if (typeof store.createStoredSessionLiveViewer !== 'function'
      || !this.visibleSessionIds.has(sessionId)
      // An engine that appeared mid-read owns the lane UNLESS it is still
      // resuming behind this pane's own live frame: that pane needs its live
      // source until the atomic handoff.
      || (this.sessionEngineFor(sessionId) && !this.visibleResumeHandoffPending(sessionId))) return;
    let installed: StoredSessionLiveViewer | null = null;
    // The pane this viewer publishes into. A fork-on-resume migration rewrites
    // this box so the same viewer keeps feeding the same pane under its new id.
    const pane = { sessionId };
    const viewer = await store.createStoredSessionLiveViewer(sessionId, {
      initialSnapshot: snapshot,
      onSnapshot: (next) => {
        if (!this.visibleSessionIds.has(pane.sessionId)) return;
        const current = this.visibleSessionViewers.get(pane.sessionId);
        if (installed && current && current !== installed) return;
        const ownerSnapshot = { ...next, sessionId: pane.sessionId } as EngineSnapshot;
        const contextProjection = this.visibleSessionContextProjections.get(pane.sessionId);
        this.emitVisibleSessionSnapshot(
          pane.sessionId,
          contextProjection
            ? withVisibleSessionContextProjection(ownerSnapshot, contextProjection)
            : ownerSnapshot,
          'live',
        );
      },
      onOwnerClosed: () => {
        const expected = installed;
        const timer = setTimeout(() => {
          if (!expected || this.visibleSessionViewers.get(pane.sessionId) !== expected) return;
          this.disposeVisibleSessionViewer(pane.sessionId);
          void this.reconcileVisibleSession(pane.sessionId);
        }, 1_500);
        timer.unref?.();
      },
    });
    installed = viewer;
    if (!viewer) return;
    // Dispose only when this viewer is genuinely superseded: the pane is gone
    // or re-added under a new token, another viewer is already installed, or a
    // pooled engine owns the lane with NO handoff still pending. A viewer whose
    // creation overlapped a focus resume stays authoritative and keeps
    // publishing until that handoff completes.
    const current = this.visibleSessionViewers.get(sessionId);
    if (!this.visibleSessionStorageRunnable(sessionId, token)
      || (current && current !== viewer)
      || (this.sessionEngineFor(sessionId) && !this.visibleResumeHandoffPending(sessionId))) {
      try { viewer.dispose(); } catch { /* superseded during startup */ }
      return;
    }
    this.visibleSessionViewers.set(sessionId, viewer);
    this.visibleSessionViewerPanes.set(viewer, pane);
    // An installation that lands INTO an open hold is this pane's live source:
    // the hold becomes viewer-backed, so its suppression stays bounded.
    this.markVisibleResumeHoldViewerBacked(sessionId);
  }

  private async submitActiveEngine(
    prompt: DesktopPromptContent,
    options: DesktopSubmitOptions,
    forceNewSession = false,
  ): Promise<{ accepted: boolean; sessionId: string }> {
    const engine = this.requireEngine();
    // A blank desktop task owns only its workspace and route preferences.
    // Materialize the persisted runtime session at the first real submit. An
    // atomic New-task submit also forces this reset when it can safely reuse an
    // idle engine in the same context instead of paying for switchContext.
    const materializedSession = forceNewSession
      || !String(engine.getState()?.sessionId || '');
    if (materializedSession) {
      if (await engine.newSession() !== true) {
        throw new Error('Unable to create a task session for the first message.');
      }
      await this.applyPendingFastPreference(engine);
    }
    const submitState = engine.getState();
    const accepted = engine.submit(prompt, options);
    let sessionId = String(engine.getState()?.sessionId || '');
    if (accepted && !sessionId) {
      // engine.newSession() clears the runtime session id and submit defers
      // its enqueue behind the auto-clear preflight microtask, so a
      // materialized draft only receives its session id when the first turn
      // actually starts. Reading '' here broke everything downstream: no
      // heuristic/LLM title, and the renderer stayed on the New task screen
      // until a later live publication promoted it (user report: 세션 이름
      // 미부여 + 대기화면 와리가리). Wait the id out — bounded — before
      // titling and before acknowledging the submit.
      sessionId = await this.waitForSubmittedSessionId(engine);
    }
    if (accepted) {
      // A materialized draft commits its staged route to the NEW session id.
      this.rememberEngineRoute(engine);
      const items = Array.isArray(submitState.items) ? submitState.items : [];
      this.recordSubmitLease(engine, submitState, sessionId);
      const hasPriorUser = items.some((item) => (
        item && typeof item === 'object'
        && (item as Record<string, unknown>).kind === 'user'
        && !isInternalTranscriptItem(item)
      ));
      const firstUserTurn = materializedSession || !hasPriorUser;
      // Publish ownership before optional desktop bookkeeping. This lets the
      // renderer promote the New-task draft as soon as the local turn exists,
      // independently of metadata I/O or a later catalog refresh.
      this.publish();
      if (firstUserTurn) this.scheduleSubmittedSessionTitle(
        sessionId,
        promptTitle(prompt, options.displayText || ''),
      );
    } else {
      this.publish();
    }
    return { accepted, sessionId };
  }

  private scheduleSubmittedSessionTitle(sessionId: string, title: string): void {
    if (!sessionId || !title) return;
    if (this.sessionMetadata.loaded) {
      if (this.sessionMetadata.rememberGeneratedTitle(sessionId, title)) {
        this.scheduleSessionsChanged();
      }
      return;
    }
    this.deferPostSubmit('session title', async () => {
      await this.sessionMetadata.load();
      const changed = this.sessionMetadata.rememberGeneratedTitle(sessionId, title);
      if (changed && !this.disposed) this.scheduleSessionsChanged();
    });
  }

  private deferPostSubmit(label: string, action: () => Promise<void>): void {
    let task: Promise<void>;
    task = new Promise<void>((resolve) => setImmediate(resolve))
      .then(action)
      .catch((error: unknown) => {
        console.error(`Failed to complete post-submit ${label}:`, error);
      })
      .finally(() => {
        this.postSubmitTasks.delete(task);
      });
    this.postSubmitTasks.add(task);
  }

  /** Bounded wait for an accepted first submit to start its turn: resolves
   *  once the engine state carries the materialized session id (and its
   *  first transcript item, so the returned snapshot paints the prompt).
   *  Turn start is local work — typically <100ms; the cap only guards a
   *  wedged route so the transition lock is never held indefinitely. */
  private async waitForSubmittedSessionId(engine: MixdogEngine): Promise<string> {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && !this.disposed) {
      const state = engine.getState();
      const sessionId = String(state?.sessionId || '');
      if (sessionId && Array.isArray(state?.items) && state.items.length > 0) {
        return sessionId;
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    return String(engine.getState()?.sessionId || '');
  }

  private logSubmitAcceptance(
    startedAt: number,
    accepted: boolean,
    options: DesktopSubmitOptions,
  ): void {
    if (DESKTOP_PERF_ENABLED) {
      const submittedAt = Number(options.submittedAt);
      const queueAgeMs = Number.isFinite(submittedAt) && submittedAt > 0
        ? Math.max(0, Date.now() - submittedAt)
        : 0;
      this.perfLog(
        `prompt-submit phase=host-accepted id=${String(options.id || '-')}`
        + ` accepted=${accepted ? 1 : 0} queueAgeMs=${queueAgeMs}`
        + ` total=${(performance.now() - startedAt).toFixed(0)}ms`,
      );
    }
  }

  async submit(prompt: DesktopPromptContent, options: DesktopSubmitOptions = {}): Promise<boolean> {
    if (!hasPromptContent(prompt)) return false;
    const submitStartedAt = DESKTOP_PERF_ENABLED ? performance.now() : 0;
    let accepted = false;
    await this.exclusive(async () => {
      ({ accepted } = await this.submitActiveEngine(prompt, options));
    });
    this.logSubmitAcceptance(submitStartedAt, accepted, options);
    return accepted;
  }

  private recordSubmitLease(
    engine: MixdogEngine,
    submitState: Record<string, unknown>,
    sessionId: string,
  ): void {
    const items = Array.isArray(submitState.items) ? submitState.items : [];
    const lastItem = items.at(-1);
    this.pendingSubmitLeases.set(engine, {
      sessionId: String(submitState.sessionId || sessionId),
      structureRevision: submitState.structureRevision ?? null,
      itemsLength: items.length,
      lastItemId: lastItem && typeof lastItem === 'object'
        ? (lastItem as Record<string, unknown>).id ?? null
        : null,
    });
  }

  /** The pooled engine that owns sessionId — the active engine first, then
   *  the park registry. Null when that session has no live engine. */
  private pooledEngineById(sessionId: string): MixdogEngine | null {
    if (this.engine && String(this.engine.getState()?.sessionId || '') === sessionId) {
      return this.engine;
    }
    return this.parkedEngines.get(sessionId)?.engine ?? null;
  }

  /** Split panes: submit addressed to any pooled live session. The active
   *  session takes the full first-submit path; a parked engine accepts the
   *  prompt directly — it already owns a materialized session — and records
   *  the same submit lease so the next park decision sees it as running. */
  async submitToSession(
    sessionId: string,
    prompt: DesktopPromptContent,
    options: DesktopSubmitOptions = {},
  ): Promise<boolean> {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new TypeError('session id is invalid.');
    if (!hasPromptContent(prompt)) return false;
    let accepted = false;
    await this.exclusive(async () => {
      if (this.engine && String(this.engine.getState()?.sessionId || '') === sessionId) {
        ({ accepted } = await this.submitActiveEngine(prompt, options));
        return;
      }
      const parked = this.parkedEngines.get(sessionId)?.engine;
      if (!parked) throw new Error('Session engine is not live.');
      const submitState = parked.getState();
      accepted = parked.submit(prompt, options);
      if (accepted) this.recordSubmitLease(parked, submitState, sessionId);
    });
    return accepted;
  }

  abortSession(sessionId: string): unknown {
    const engine = this.pooledEngineById(sessionId);
    if (!engine) throw new Error('Session engine is not live.');
    return engine.abort();
  }

  resolveToolApprovalForSession(
    sessionId: string,
    id: string,
    decision: ToolApprovalDecision,
  ): boolean {
    const engine = this.pooledEngineById(sessionId);
    if (!engine) throw new Error('Session engine is not live.');
    return engine.resolveToolApproval(id, decision);
  }

  submitNewTask(
    prompt: DesktopPromptContent,
    options: DesktopSubmitOptions = {},
    draft: DesktopNewTaskDraft = {},
  ): Promise<DesktopNewTaskSubmitResult> {
    const requestId = String(options.id || '').trim();
    const existing = requestId ? this.newTaskSubmitRequests.get(requestId) : undefined;
    if (existing) return existing;
    const request = this.submitNewTaskOnce(prompt, options, draft);
    if (!requestId) return request;
    this.newTaskSubmitRequests.set(requestId, request);
    while (this.newTaskSubmitRequests.size > 256) {
      const oldest = this.newTaskSubmitRequests.keys().next().value;
      if (typeof oldest !== 'string') break;
      this.newTaskSubmitRequests.delete(oldest);
    }
    void request.catch(() => {
      if (this.newTaskSubmitRequests.get(requestId) === request) {
        this.newTaskSubmitRequests.delete(requestId);
      }
    });
    return request;
  }

  private newTaskNavigationCheckpoint(): NewTaskNavigationCheckpoint {
    return {
      sessionId: String(this.engine?.getState()?.sessionId || ''),
      workspace: this.engineWorkspace,
      desktopSession: this.engineDesktopSession,
      currentProject: this.currentProject,
      pendingFastPreference: this.pendingFastPreference,
    };
  }

  private async restoreNewTaskNavigation(
    checkpoint: NewTaskNavigationCheckpoint,
  ): Promise<void> {
    this.pendingFastPreference = checkpoint.pendingFastPreference;
    if (checkpoint.sessionId && this.parkedEngines.has(checkpoint.sessionId)) {
      await this.disposeCurrent('desktop-submit-new-task-rollback', { keepBackgroundWork: true });
      this.activateParkedEngine(checkpoint.sessionId);
      this.currentProject = checkpoint.currentProject;
      this.publish();
      return;
    }
    if (!checkpoint.workspace) {
      await this.disposeCurrent('desktop-submit-new-task-rollback', { keepBackgroundWork: true });
      this.currentProject = checkpoint.currentProject;
      this.publish();
      return;
    }
    await this.replaceEngine(
      checkpoint.workspace,
      checkpoint.desktopSession,
      'desktop-submit-new-task-rollback',
    );
    this.currentProject = checkpoint.currentProject;
    const engine = this.requireEngine();
    if (checkpoint.sessionId &&
      String(engine.getState()?.sessionId || '') !== checkpoint.sessionId &&
      await engine.resume(checkpoint.sessionId) !== true) {
      throw new Error('Unable to restore the previous task after draft submission failed.');
    }
    this.publish();
  }

  private async submitNewTaskOnce(
    prompt: DesktopPromptContent,
    options: DesktopSubmitOptions,
    draft: DesktopNewTaskDraft,
  ): Promise<DesktopNewTaskSubmitResult> {
    if (!hasPromptContent(prompt)) {
      return { accepted: false, sessionId: '', snapshot: this.getSnapshot() };
    }
    const submitStartedAt = DESKTOP_PERF_ENABLED ? performance.now() : 0;
    const cachedModel = draft.route
      ? this.modelCatalogCache.get(`${draft.route.provider}\n${draft.route.model}`)
      : undefined;
    let accepted = false;
    let sessionId = '';
    let snapshot: EngineSnapshot = null;
    let reusedEngineContext = false;
    const criticalStartedAt = DESKTOP_PERF_ENABLED ? performance.now() : 0;
    await this.exclusive(async () => {
      const checkpoint = this.newTaskNavigationCheckpoint();
      let rollbackHandled = false;
      try {
        const projectPath = String(draft.projectPath || '').trim();
        if (projectPath) {
          const registeredPath = await this.projects.knownPath(projectPath);
          const canonicalPath = await this.canonicalDirectory(registeredPath);
          const desktopSession: DesktopSessionScope = {
            classification: 'project',
            projectPath: canonicalPath,
          };
          reusedEngineContext = this.canReuseEngineForNewTask(canonicalPath, desktopSession);
          if (!reusedEngineContext) {
            await this.replaceEngineForNavigation(
              canonicalPath,
              desktopSession,
              'desktop-submit-new-project-task',
            );
          }
          this.currentProject = canonicalPath;
          this.recentProjects = await this.projects.touchSelected(registeredPath);
        } else {
          const workspace = await this.taskWorkspace();
          const desktopSession: DesktopSessionScope = {
            classification: 'task',
            projectPath: null,
          };
          reusedEngineContext = this.canReuseEngineForNewTask(workspace, desktopSession);
          if (!reusedEngineContext) {
            await this.replaceEngineForNavigation(
              workspace,
              desktopSession,
              'desktop-submit-new-task',
            );
          }
          this.currentProject = null;
        }
        const engine = this.requireEngine();
        if (draft.workflowId) {
          const setWorkflow = engine.setWorkflow;
          if (typeof setWorkflow !== 'function') {
            throw new Error('The active Mixdog engine does not support setWorkflow.');
          }
          await (setWorkflow as (id: string) => unknown).call(engine, draft.workflowId);
        }
        if (draft.route) await this.applyModelSelection(engine, draft.route, cachedModel);
        ({ accepted, sessionId } = await this.submitActiveEngine(prompt, options, true));
        if (!accepted) {
          rollbackHandled = true;
          try {
            await this.restoreNewTaskNavigation(checkpoint);
          } catch (rollbackError) {
            throw new AggregateError(
              [rollbackError],
              'Draft submission was rejected and the previous task could not be restored.',
            );
          }
          sessionId = '';
        }
        // One-shot remote reservation: claim the relay seat the moment the
        // session exists (user bug: the renderer's post-accept claim attached
        // the remote seconds late). The claim runs detached so channel-worker
        // boot never holds the accepted submit; the engine state publication
        // flips the indicator once the seat is actually acquired.
        if (accepted && draft.remote === true) {
          const claimRemote = engine.claimRemote;
          if (typeof claimRemote === 'function') {
            void Promise.resolve()
              .then(() => (claimRemote as () => unknown).call(engine))
              .catch(() => { /* best-effort: the header toggle can re-claim */ });
          }
        }
        snapshot = this.getSnapshot();
      } catch (error) {
        if (rollbackHandled) throw error;
        try {
          await this.restoreNewTaskNavigation(checkpoint);
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            'Draft submission failed and the previous task could not be restored.',
          );
        }
        throw error;
      }
    });
    if (DESKTOP_PERF_ENABLED) {
      this.perfLog(
        `prompt-submit phase=new-task-critical reusedContext=${reusedEngineContext ? 1 : 0}`
        + ` ms=${(performance.now() - criticalStartedAt).toFixed(0)}`,
      );
    }
    this.logSubmitAcceptance(submitStartedAt, accepted, options);
    return { accepted, sessionId, snapshot };
  }

  private canReuseEngineForNewTask(
    workspace: string,
    desktopSession: DesktopSessionScope,
  ): boolean {
    const engine = this.engine;
    const currentScope = this.engineDesktopSession;
    if (!engine || !this.engineWorkspace || !currentScope
      || engineHasActiveWork(engine, this.pendingSubmitLeases)) return false;
    if (normalizedProjectKey(this.engineWorkspace) !== normalizedProjectKey(workspace)
      || currentScope.classification !== desktopSession.classification) return false;
    if (desktopSession.classification !== 'project') return true;
    return normalizedProjectKey(String(currentScope.projectPath || ''))
      === normalizedProjectKey(String(desktopSession.projectPath || ''));
  }

  async invokeCapability<T = unknown>(
    capability: DesktopCapability,
    args: unknown[] = [],
  ): Promise<DesktopCapabilityResult<T>> {
    if (!DESKTOP_CAPABILITY_SET.has(capability)) {
      throw new TypeError('Desktop capability is unavailable.');
    }
    if (capability === 'getOAuthProviderLoginStatus' ||
      capability === 'completeOAuthProviderLogin' || capability === 'cancelOAuthProviderLogin') {
      return this.invokeOAuthCapability<T>(capability, args);
    }
    // Boot probe: the window asks whether onboarding is done before the user
    // does anything. Booting an engine under the transition lock just to answer
    // it made the first session click wait out the whole cold boot (measured
    // ~3s of blank screen), so a cold host answers from the config file and the
    // first real engine boot belongs to the navigation that needs it.
    if (capability === 'getOnboardingStatus' && !this.engine) {
      const status = await readOnboardingStatusFromDisk();
      if (status) return { value: status as T, snapshot: this.getSnapshot() };
    }
    // Read-only provider/status probes must not hold the transition lock for
    // their network round-trips. Startup hydration fires getProviderSetup the
    // moment the window is up and it held `exclusive` for ~5s, so the user's
    // first session click queued behind it (user: first open takes forever).
    // The engine lease is still acquired under the lock; the probe itself
    // neither mutates session state nor needs a publication (readCapabilities
    // follows the same read-only rationale).
    // getChannelSetup reads OS keychain secrets (measured ~2.9s on a cold
    // Windows boot) and listWorkflows queued right behind it, so the window's
    // startup probes owned the transition lock while the user's first session
    // click waited. Both are reads; only the engine lease needs the lock.
    if (DESKTOP_READ_CAPABILITY_SET.has(capability)) {
      await this.exclusive(async () => {
        if (this.engine) return;
        const workspace = await this.taskWorkspace();
        await this.replaceEngine(workspace, {
          classification: 'task',
          projectPath: null,
        }, `desktop-capability-${capability}`);
      });
      const engine = this.requireEngine();
      const method = engine[capability];
      if (typeof method !== 'function') {
        throw new Error(`The active Mixdog engine does not support ${capability}.`);
      }
      const started = DESKTOP_PERF_ENABLED ? performance.now() : 0;
      const rawValue = await (method as (...values: unknown[]) => unknown).apply(engine, args);
      if (DESKTOP_PERF_ENABLED) {
        this.perfLog(`capability-unlocked ${capability} ms=${(performance.now() - started).toFixed(0)}`);
      }
      return { value: copyCapabilityValue(rawValue) as T, snapshot: this.getSnapshot() };
    }
    let result: DesktopCapabilityResult<T> = { value: undefined as T, snapshot: null };
    const lockedStarted = DESKTOP_PERF_ENABLED ? performance.now() : 0;
    await this.exclusive(async () => {
      if (!this.engine) {
        const workspace = await this.taskWorkspace();
        await this.replaceEngine(workspace, {
          classification: 'task',
          projectPath: null,
        }, `desktop-capability-${capability}`);
      }
      const engine = this.requireEngine();
      const method = engine[capability];
      if (typeof method !== 'function') {
        throw new Error(`The active Mixdog engine does not support ${capability}.`);
      }
      const rawValue = await (method as (...values: unknown[]) => unknown).apply(engine, args);
      const value = capability === 'beginOAuthProviderLogin'
        ? this.oauthFlows.register(rawValue)
        : rawValue;
      // A run-now schedule spawns a fresh visible session; name it after the
      // schedule so Recent shows "daily-briefing" instead of a prompt slice.
      if (capability === 'runScheduleNow') {
        const run = rawValue as { sessionId?: unknown; name?: unknown } | null;
        const scheduleSessionId = String(run?.sessionId || '');
        const scheduleName = String(run?.name || '');
        if (scheduleSessionId && scheduleName) {
          await this.sessionMetadata.load();
          this.sessionMetadata.rememberGeneratedTitle(scheduleSessionId, scheduleName);
        }
      }
      result = { value: copyCapabilityValue(value) as T, snapshot: this.getSnapshot() };
      this.publish();
    });
    if (DESKTOP_PERF_ENABLED) {
      // Attribution for boot-time lock contention: which capability made the
      // user's first navigation wait.
      this.perfLog(`capability-locked ${capability} ms=${(performance.now() - lockedStarted).toFixed(0)}`);
    }
    return result;
  }

  async readCapabilities(
    requests: ReadonlyArray<DesktopCapabilityReadRequest>,
  ): Promise<DesktopCapabilityReadResult[]> {
    // Only a MISSING engine needs the transition lock. Taking it unconditionally
    // queued read sweeps behind any lock holder — including the settings sweep's
    // own memoryControl call — so the second batch of a hydration could wait on
    // the memory daemon and leave those sections empty for seconds.
    if (!this.engine) {
      await this.exclusive(async () => {
        if (this.engine) return;
        const workspace = await this.taskWorkspace();
        await this.replaceEngine(workspace, {
          classification: 'task',
          projectPath: null,
        }, 'desktop-capability-read');
      });
    }
    const engine = this.requireEngine();
    const started = DESKTOP_PERF_ENABLED ? performance.now() : 0;
    const results: DesktopCapabilityReadResult[] = [];
    // The batch runs OUTSIDE the transition lock: startup settings hydration
    // held `exclusive` for its entire multi-second read sweep, so the first
    // session click queued behind it (user: first open takes far too long).
    // Reads stay ordered in one sequential sweep — some getters lazily warm
    // shared caches, so parallel execution would turn a UI optimization into
    // a new backend concurrency contract. If a context switch lands mid-sweep,
    // the affected getters surface per-request errors instead of blocking
    // navigation.
    for (const request of requests) {
      try {
        const method = engine[request.capability];
        if (typeof method !== 'function') {
          throw new Error(`The active Mixdog engine does not support ${request.capability}.`);
        }
        const rawValue = await (method as (...values: unknown[]) => unknown)
          .apply(engine, request.args || []);
        results.push({ ok: true, value: copyCapabilityValue(rawValue) });
      } catch (reason) {
        results.push({
          ok: false,
          error: reason instanceof Error ? reason.message : String(reason),
        });
      }
    }
    if (DESKTOP_PERF_ENABLED) {
      this.perfLog(`capability-read batch=${requests.length} ms=${(performance.now() - started).toFixed(0)}`);
    }
    // Read-only settings inspection neither mutates visible engine state nor
    // publishes it. This avoids cloning and serializing a long transcript
    // twice for every row in a settings section.
    return results;
  }

  abort(): unknown {
    return this.requireEngine().abort();
  }

  resolveToolApproval(id: string, decision: ToolApprovalDecision): boolean {
    return this.requireEngine().resolveToolApproval(id, decision);
  }

  private releaseSettledParkedEngine(engine: MixdogEngine): void {
    if (this.disposed) return;
    let sessionId = '';
    try {
      sessionId = String(engine.getState()?.sessionId || '');
      if (!sessionId || engineHasActiveWork(engine, this.pendingSubmitLeases)) return;
    } catch {
      return;
    }
    const parked = this.parkedEngines.get(sessionId);
    if (!parked || parked.engine !== engine) return;
    // The lane has already emitted this settled frame. Drop ownership before
    // awaiting disposal so a simultaneous resume reloads durable state instead
    // of reconnecting to an engine that is already closing.
    this.parkedEngines.delete(sessionId);
    this.sessionLanes.detach(engine);
    // A visible pane keeps painting this session after the pool lets go. The
    // lane's last frame must survive as the retained baseline: without it the
    // storage watcher's next disk projection is published with NO comparison
    // frame (the guard in emitVisibleSessionSnapshot is skipped entirely) and
    // a trailing session file rolled the pane's content BACK several turns
    // until the next live replay (user: pane content flips to older text).
    if (this.visibleSessionIds.has(sessionId)
      && !this.visibleSessionFrames.get(sessionId)?.live) {
      try {
        this.visibleSessionFrames.set(sessionId, {
          snapshot: desktopSnapshot(copySnapshot(engine), null, []),
          live: false,
        });
      } catch {
        // A disposing engine that cannot project simply leaves stored reads
        // to own the pane as before.
      }
    }
    let disposal: Promise<void>;
    disposal = Promise.resolve(
      engine.dispose('desktop-parked-settled', { keepBackgroundWork: true }),
    ).catch((error) => {
      console.error('Failed to release a settled parked engine:', error);
    }).finally(() => {
      this.parkedEngineDisposals.delete(disposal);
    });
    this.parkedEngineDisposals.add(disposal);
    this.perfLog(`parked-engine-release session=${sessionId} remaining=${this.parkedEngines.size}`);
    if (this.visibleSessionIds.has(sessionId)) void this.reconcileVisibleSession(sessionId);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.stopAgentPoolWatcher();
    this.stopVisibleSessionStorageWatcher();
    this.visibleSessionIds.clear();
    for (const sessionId of [...this.visibleSessionViewers.keys()]) {
      this.disposeVisibleSessionViewer(sessionId);
    }
    this.visibleSessionFrames.clear();
    this.visibleSessionContextProjections.clear();
    this.detachedAgentSessions.clear();
    await this.exclusive(async () => this.disposeAllEngines('desktop-dispose'));
    await Promise.allSettled([
      ...this.parkedEngineDisposals,
      ...this.postSubmitTasks,
    ]);
    await this.sessionMetadata.flush();
    await this.perfLogQueue;
    this.cancelScheduledPublication();
    this.shellJobsPoller.stop();
    this.publish();
    this.stopRemoteStateWatcher();
    this.listeners.clear();
    this.sessionListeners.clear();
    this.agentPoolListeners.clear();
    this.sessionLanes.detachAll();
  }

  private requireEngine(): MixdogEngine {
    if (!this.engine) throw new Error('No Mixdog project is active.');
    return this.engine;
  }

  private async applyPendingFastPreference(engine: MixdogEngine): Promise<void> {
    const preference = this.pendingFastPreference;
    if (preference === null) return;
    const current = engine.getState();
    if (typeof current.fast === 'boolean' && current.fast === preference) {
      this.pendingFastPreference = null;
      return;
    }
    const applied = await engine.setFast(preference);
    if (applied !== preference) {
      throw new Error('Fast mode preference was not applied to the new session.');
    }
    const latest = engine.getState();
    if (typeof latest.fast === 'boolean' && latest.fast !== preference) {
      throw new Error('Fast mode preference was not reflected by the new session.');
    }
    this.pendingFastPreference = null;
  }

  protected publish(snapshot?: EngineSnapshot): void {
    this.cancelScheduledPublication();
    if (this.publicationHoldDepth > 0) {
      this.publicationPending = true;
      this.publicationPendingSnapshot = snapshot;
      return;
    }
    this.publishNow(snapshot);
  }

  private publishEngineEvent(): void {
    if (this.publicationHoldDepth > 0) {
      this.publicationPending = true;
      // An engine event after a prepared snapshot means that prepared value
      // may be stale. Fall back to a fresh snapshot when the hold is released.
      this.publicationPendingSnapshot = undefined;
      return;
    }
    if (this.listeners.size === 0 || this.publicationTimer) return;
    this.publicationTimer = setTimeout(() => {
      this.publicationTimer = null;
      if (this.publicationHoldDepth > 0) {
        this.publicationPending = true;
        this.publicationPendingSnapshot = undefined;
        return;
      }
      this.publishNow();
    }, ENGINE_PUBLICATION_INTERVAL_MS);
    this.publicationTimer.unref?.();
  }

  private cancelScheduledPublication(): void {
    if (!this.publicationTimer) return;
    clearTimeout(this.publicationTimer);
    this.publicationTimer = null;
  }

  private publishNow(snapshot?: EngineSnapshot): void {
    // Once a window has released its subscription, engine events have nowhere
    // to go. Avoid cloning a potentially long transcript until another window
    // subscribes.
    if (this.listeners.size === 0) return;
    const publishStarted = DESKTOP_PERF_ENABLED ? performance.now() : 0;
    const published = snapshot === undefined ? this.getSnapshot() : snapshot;
    // Origin diagnostics for the "window force-switched to a background
    // session" report: every published session-id flip is logged so a
    // spontaneous flip (one without an adjacent user-initiated resume/new/
    // delete entry in this log) pinpoints the leaking publication path.
    if (DESKTOP_PERF_ENABLED) {
      const publishedSessionId = String((published as Record<string, unknown> | null)?.sessionId || '');
      if (publishedSessionId !== this.lastPublishedSessionId) {
        this.perfLog(`publish-session-change from=${this.lastPublishedSessionId || '(none)'} to=${publishedSessionId || '(blank)'}`);
        this.lastPublishedSessionId = publishedSessionId;
      }
    }
    for (const listener of this.listeners) listener(published);
    if (DESKTOP_PERF_ENABLED) {
      const ms = performance.now() - publishStarted;
      if (ms >= 10) this.perfLog(`publish ms=${ms.toFixed(1)}`);
    }
  }

  perfLog(line: string): void {
    if (!DESKTOP_PERF_ENABLED) return;
    const entry = `${new Date().toISOString()} ${line}\n`;
    this.perfLogQueue = this.perfLogQueue
      .then(() => appendFile(join(this.userDataRoot(), 'desktop-perf.log'), entry))
      .catch(() => { /* diagnostics only */ });
  }

  private async withPublicationsHeld<T>(action: () => Promise<T>): Promise<T> {
    this.publicationHoldDepth += 1;
    try {
      return await action();
    } finally {
      this.publicationHoldDepth -= 1;
      if (this.publicationHoldDepth === 0 && this.publicationPending) {
        this.publicationPending = false;
        const snapshot = this.publicationPendingSnapshot;
        this.publicationPendingSnapshot = undefined;
        this.publishNow(snapshot);
      }
    }
  }

  // Engine lifecycle (park/activate/dispose/replace/preload): bodies live in
  // engine-lifecycle.ts; these thin delegates keep every internal call site
  // and test seam unchanged.
  private currentEngineIsRunning(): boolean {
    return this.engineLifecycle.currentEngineIsRunning();
  }

  private parkCurrentEngine(): string | null {
    return this.engineLifecycle.parkCurrentEngine();
  }

  private activateParkedEngine(sessionId: string): MixdogEngine {
    return this.engineLifecycle.activateParkedEngine(sessionId);
  }

  private disposeAllEngines(reason: string): Promise<void> {
    return this.engineLifecycle.disposeAllEngines(reason);
  }

  private disposeCurrent(reason: string, options?: { keepBackgroundWork?: boolean }): Promise<void> {
    return this.engineLifecycle.disposeCurrent(reason, options);
  }

  private replaceEngineForNavigation(
    cwd: string,
    desktopSession: DesktopSessionScope | null,
    reason: string,
  ): Promise<MixdogEngine> {
    return this.engineLifecycle.replaceEngineForNavigation(cwd, desktopSession, reason);
  }

  private async invokeOAuthCapability<T>(
    capability: 'getOAuthProviderLoginStatus' | 'completeOAuthProviderLogin' | 'cancelOAuthProviderLogin',
    args: unknown[],
  ): Promise<DesktopCapabilityResult<T>> {
    const id = String(args[0] || '').trim();
    if (!/^oauth_[a-z0-9_]+$/i.test(id)) throw new TypeError('OAuth flow id is invalid.');
    const flow = this.oauthFlows.get(id);
    if (!flow) throw new Error('OAuth login flow is no longer available.');
    if (capability === 'completeOAuthProviderLogin') {
      if (!flow.completeCode) throw new Error('This OAuth provider does not accept a manual code.');
      const code = String(args[1] || '').trim();
      if (!code || code.length > 16_384) throw new TypeError('OAuth code is invalid.');
      try {
        const completed = await flow.completeCode(code);
        flow.result = Boolean(completed);
        flow.state = completed ? 'complete' : 'failed';
        flow.error = completed ? null : 'OAuth code did not complete the login.';
      } catch (error) {
        flow.state = 'failed';
        flow.error = error instanceof Error ? error.message : String(error);
        throw error;
      }
    } else if (capability === 'cancelOAuthProviderLogin') {
      try { await flow.cancel?.(); } finally {
        flow.state = 'cancelled';
        clearTimeout(flow.timeout);
      }
    }
    const value = oauthFlowStatus(flow) as T;
    if (capability === 'cancelOAuthProviderLogin') this.oauthFlows.remove(id);
    this.publish();
    return { value, snapshot: this.getSnapshot() };
  }

  private async taskWorkspace(): Promise<string> {
    const root = this.userDataPath ?? this.getUserDataPath?.();
    if (!root) throw new Error('Electron userData path is unavailable.');
    const workspace = join(root, 'workspace', 'unclassified');
    await mkdir(workspace, { recursive: true });
    return realpath(workspace);
  }

  private async canonicalDirectory(input: string): Promise<string> {
    if (!input) throw new TypeError('Session workspace is unavailable.');
    const canonical = await realpath(input);
    if (!(await stat(canonical)).isDirectory()) throw new TypeError('Session workspace is not a directory.');
    return canonical;
  }

  private rememberProjectDirectory(requestedPath: string, directory: string): void {
    const entry = {
      directory,
      expiresAt: Date.now() + PROJECT_DIRECTORY_CACHE_TTL_MS,
    };
    for (const key of new Set([
      normalizedProjectKey(requestedPath),
      normalizedProjectKey(directory),
    ])) {
      this.projectDirectoryCache.delete(key);
      this.projectDirectoryCache.set(key, entry);
    }
    while (this.projectDirectoryCache.size > PROJECT_DIRECTORY_CACHE_LIMIT) {
      const oldest = this.projectDirectoryCache.keys().next().value;
      if (!oldest) break;
      this.projectDirectoryCache.delete(oldest);
    }
  }

  private userDataRoot(): string {
    const root = this.userDataPath ?? this.getUserDataPath?.();
    if (!root) throw new Error('Electron userData path is unavailable.');
    return root;
  }

  private preloadEngineModule(): void {
    this.engineLifecycle.preloadEngineModule();
  }

  private loadSessionStoreModule(): Promise<MixdogSessionStoreModule> {
    this.sessionStoreModule ??= this.loadSessionStoreOverride
      ? this.loadSessionStoreOverride()
      : import(
        /* @vite-ignore */ sessionStoreModuleUrl(this.packaged, this.resourcesPath, this.appPath)
      ) as Promise<MixdogSessionStoreModule>;
    return this.sessionStoreModule;
  }

  private replaceEngine(
    cwd: string,
    desktopSession: DesktopSessionScope | null,
    reason: string,
    options: { forResume?: boolean } = {},
  ): Promise<MixdogEngine> {
    return this.engineLifecycle.replaceEngine(cwd, desktopSession, reason, options);
  }

  private sessionSummaries(
    refreshFromStorage = false,
    rowsOverride?: Array<Record<string, unknown>>,
  ): DesktopSessionSummary[] {
    const currentId = String(this.engine?.getState()?.sessionId || '');
    const rows = rowsOverride
      ?? this.engine?.listSessions(refreshFromStorage ? { refreshFromStorage: true } : undefined)
      ?? [];
    // Every listing refreshes the row cache the resume path reads from.
    if (Array.isArray(rows) && rows.length) this.lastSessionRows = rows;
    const summaries = desktopSessionSummaries(
      rows,
      currentId,
      this.sessionMetadata.titles,
      this.sessionMetadata.names,
    );
    return this.sessionMetadata.withArchiveFlags(summaries);
  }

  private rememberCurrentSessionTitle(): void {
    const state = this.engine?.getState();
    const sessionId = String(state?.sessionId || '');
    const rows = this.lastSessionRows || this.engine?.listSessions?.() || [];
    const durableRow = Array.isArray(rows)
      ? rows.find((row) => String(row?.id || '') === sessionId)
      : null;
    const sharedTitle = generatedSessionTitle(durableRow?.title || '', '');
    if (sharedTitle) {
      if (this.sessionMetadata.promoteGeneratedTitle(sessionId, sharedTitle)) {
        this.scheduleSessionsChanged();
      }
      if (this.sessionMetadata.displayTitle(sessionId, sharedTitle)) return;
    }
    const durableTitle = generatedSessionTitle(durableRow?.preview || '', '');
    if (durableTitle) {
      const repaired = this.sessionMetadata.repairRewrittenGeneratedTitle(sessionId, durableTitle);
      const remembered = this.sessionMetadata.rememberGeneratedTitle(sessionId, durableTitle);
      if (repaired || remembered) this.scheduleSessionsChanged();
      // A durable summary sees the full stored conversation. Never replace it
      // with the first item of the bounded resume window, which may be a much
      // later reply/session-transition envelope.
      if (this.sessionMetadata.displayTitle(sessionId, sharedTitle)) return;
    }
    let title = '';
    if (Array.isArray(state?.items)) {
      for (const item of state.items) {
        if (!item || typeof item !== 'object') continue;
        const candidate = item as Record<string, unknown>;
        if (candidate.kind !== 'user') continue;
        const text = String(candidate.text || '');
        const next = compactedSessionTitle(text, '') || generatedSessionTitle(text, '');
        if (!next) continue;
        if (!title) title = next;
        if (!isMediaSessionTitlePlaceholder(next)) {
          title = next;
          break;
        }
      }
    }
    if (this.sessionMetadata.rememberGeneratedTitle(sessionId, title)) {
      this.scheduleSessionsChanged();
    }
  }

  private async exclusive(action: () => Promise<void>): Promise<void> {
    // Perf triage (MIXDOG_DESKTOP_PERF=1): any action holding the transition
    // lock long enough to delay a session click gets attributed by caller.
    const instrumented = DESKTOP_PERF_ENABLED
      ? (() => {
        const caller = (new Error().stack || '').split('\n')
          .slice(2, 4).map((line) => line.trim()).join(' <- ');
        return async () => {
          const started = performance.now();
          try {
            await action();
          } finally {
            const ms = performance.now() - started;
            if (ms >= 300) this.perfLog(`exclusive-hold ms=${ms.toFixed(0)} by=${caller}`);
          }
        };
      })()
      : action;
    const run = this.transition.then(instrumented, instrumented);
    this.transition = run.catch(() => undefined);
    await run;
  }
}

// Renderer consumption of the per-session live lanes (mixdog:session-state).
// One process-wide store fans lane frames out per sessionId so a pane
// subscribed to session A never re-renders for session B's traffic.
import { useCallback, useRef, useSyncExternalStore } from "react";

import type { DesktopSessionStateUpdate } from "../shared/contract";
import { desktopAgentIdentity } from "../shared/agent-activity";
import type { Snapshot, TranscriptItem } from "./desktop-types";
import { estimateSessionSnapshotBytes } from "./app-session-snapshots";
import {
  sharedTranscriptSnapshotDecorator,
  type TranscriptSnapshotDecorator,
} from "./snapshot-transcript-decoration";
import {
  cancelLayoutFrame,
  scheduleLayoutFrame,
} from "./interaction-frame-scheduler";

export type SessionLaneSource =
  (listener: (update: DesktopSessionStateUpdate) => void) => () => void;

export interface SessionLaneStore {
  get(sessionId: string): Snapshot | null;
  subscribe(sessionId: string, listener: () => void): () => void;
  getRemoteSessionId(): string;
  subscribeRemoteSession(listener: () => void): () => void;
  /** Wire the preload lane once; returns a stop function. Idempotent — a
   *  second start while wired returns the existing stop. */
  start(source?: SessionLaneSource | undefined): () => void;
  /** Test/manual injection of one lane frame. */
  apply(update: DesktopSessionStateUpdate): void;
  stats(): {
    entries: number;
    estimatedBytes: number;
    subscribedSessions: number;
    notificationKeys: number;
  };
  /** Session ids at least one mounted pane is currently subscribed to. */
  subscribedSessionIds(): string[];
  /** Drop cached lanes with no subscribers (remote sync-gap recovery: an
   *  emptied lane re-reads through session.read on its next open). */
  evictInactive(): void;
  clear(): void;
}

const SESSION_LANE_CACHE_LIMIT = 64;
const SESSION_LANE_CACHE_BYTE_LIMIT = 24 * 1024 * 1024;
const SESSION_LANE_ESTIMATE_INTERVAL_MS = 1_000;

interface SessionLaneEntry {
  snapshot: Snapshot;
  bytes: number;
  estimatedAt: number;
  /** Authoritative content generation this cached transcript was accepted at. */
  revision: number | null;
}

function queuedIdentity(snapshot: Snapshot): string {
  const queued = Array.isArray(snapshot.queued) ? snapshot.queued : [];
  return queued.map((entry) => String(
    (entry as { id?: unknown; key?: unknown })?.id
      ?? (entry as { key?: unknown })?.key
      ?? "",
  )).join("\0");
}

function agentActivityIdentity(snapshot: Snapshot): string {
  return (["agentWorkers", "agentJobs"] as const).flatMap((field) => {
    const entries = Array.isArray(snapshot[field]) ? snapshot[field] : [];
    return entries.map((entry, index) => [
      field,
      desktopAgentIdentity(entry) || index,
      String(entry?.stage || ""),
      String(entry?.status || ""),
    ].join(":"));
  }).join("\0");
}

function shellActivityCount(snapshot: Snapshot): number {
  return Math.max(
    Math.max(0, Number(snapshot.shellJobs?.count) || 0),
    Math.max(0, Number(snapshot.activeTools?.shell?.count) || 0),
  );
}

function surfacedToolActivityIdentity(snapshot: Snapshot): string {
  return (["agent", "web_search", "shell"] as const).map((field) => {
    const activity = snapshot.activeTools?.[field];
    return `${field}:${Math.max(0, Number(activity?.count) || 0)}:${Number(activity?.startedAt) || 0}`;
  }).join("\0");
}

function laneUpdateIsUrgent(previous: Snapshot | null, next: Snapshot | null): boolean {
  if (!previous || !next) return true;
  return previous.sessionId !== next.sessionId
    || previous.busy !== next.busy
    || previous.commandBusy !== next.commandBusy
    || previous.commandStatus !== next.commandStatus
    || previous.toolApproval !== next.toolApproval
    || queuedIdentity(previous) !== queuedIdentity(next)
    || agentActivityIdentity(previous) !== agentActivityIdentity(next)
    || surfacedToolActivityIdentity(previous) !== surfacedToolActivityIdentity(next)
    || shellActivityCount(previous) !== shellActivityCount(next);
}

// Only the transcript's completeness is reconciled here:
//   * alignment failure          -> replace (host/channel clear, genuine
//     deletion, compaction, branch resume, retry/edit rewrite).
//   * settled source, aligned but missing the HEAD this cache still holds
//     -> restore that head only; the frame keeps owning its tail, so trailing
//     removal and streaming settle are never blocked.
// Every LIVE field (busy, spinner, queued, approvals, agent activity,
// streaming tail) is always taken from the incoming frame. A frame that omits
// transcript history also tends to omit the presentation read-outs derived
// from it (usage/context, route, workflow, project): those are filled from
// the last known value ONLY when the frame carries none — never pinned.
function laneTranscript(snapshot: Snapshot | null): TranscriptItem[] | null {
  const items = snapshot?.items;
  return Array.isArray(items) ? items : null;
}

function sameLaneRow(left?: TranscriptItem, right?: TranscriptItem): boolean {
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.id != null && right.id != null) return String(left.id) === String(right.id);
  return String(left.kind || "") === String(right.kind || "")
    && String(left.text ?? "") === String(right.text ?? "");
}

/** Index in `prior` where the incoming transcript window starts, or -1 when
 *  the frame carries a genuinely different transcript. An empty frame aligns
 *  past the end: it adds nothing and removes nothing. */
function laneWindowOffset(prior: TranscriptItem[], next: TranscriptItem[]): number {
  if (next.length === 0) return prior.length;
  for (let offset = 0; offset < prior.length; offset += 1) {
    if (!sameLaneRow(prior[offset], next[0])) continue;
    const overlap = Math.min(prior.length - offset, next.length);
    let aligned = true;
    for (let index = 1; index < overlap; index += 1) {
      if (!sameLaneRow(prior[offset + index], next[index])) {
        aligned = false;
        break;
      }
    }
    if (aligned) return offset;
  }
  return -1;
}

// Presentation read-outs only: a windowed/disk projection that carries none
// of them must not push the pane back to "unknown" while it keeps painting
// the retained rows. Live/work fields are deliberately absent from this list.
const LANE_PRESENTATION_FIELDS: ReadonlyArray<keyof Snapshot> = [
  "stats",
  "contextWindow",
  "displayContextWindow",
  "autoCompactTokenLimit",
  "provider",
  "model",
  "effort",
  "fast",
  "fastCapable",
  "modelParameters",
  "contextPercent",
  "workflow",
  "currentProject",
  "project",
  "cwd",
  "promptHistoryList",
  "desktopSessionTitle",
];

function mergedLaneFrame(
  prior: Snapshot,
  next: Snapshot,
  items: TranscriptItem[],
  retainedTurnModel: boolean,
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
  return merged;
}

// The ROUTE (provider/model/effort/fast) is session state, not transcript
// state, and a disk projection or a partial delta publishes it as an EMPTY
// string instead of omitting the field — so the null-only fill above let such
// a frame blank a pane's model controls to "Select model" on every focus swap
// (user report: 판 3개가 "모델 선택"으로 비었다). The last route a lane knew
// for a session survives until a frame names a real one.
function laneRouteText(snapshot: Snapshot | null, field: "provider" | "model" | "effort"): string {
  const value = snapshot?.[field];
  return typeof value === "string" ? value.trim() : "";
}

export function laneFrameWithRetainedRoute(prior: Snapshot | null, next: Snapshot): Snapshot {
  if (!prior) return next;
  const priorSessionId = String(prior.sessionId || "");
  const nextSessionId = String(next.sessionId || "");
  if (priorSessionId && nextSessionId && priorSessionId !== nextSessionId) return next;
  const priorProvider = laneRouteText(prior, "provider");
  const priorModel = laneRouteText(prior, "model");
  const provider = laneRouteText(next, "provider") || priorProvider;
  const model = laneRouteText(next, "model") || priorModel;
  if (!provider || !model) return next;
  const merged: Snapshot = { ...next };
  let changed = false;
  if (laneRouteText(next, "provider") !== provider) {
    merged.provider = provider;
    changed = true;
  }
  if (laneRouteText(next, "model") !== model) {
    merged.model = model;
    changed = true;
  }
  // Effort/fast belong to the route they were chosen for: only a frame that
  // lands on the SAME provider+model may inherit them.
  if (provider === priorProvider && model === priorModel) {
    if (!laneRouteText(next, "effort") && laneRouteText(prior, "effort")) {
      merged.effort = laneRouteText(prior, "effort");
      changed = true;
    }
    if (typeof next.fast !== "boolean" && typeof prior.fast === "boolean") {
      merged.fast = prior.fast;
      changed = true;
    }
    if (typeof next.fastCapable !== "boolean" && typeof prior.fastCapable === "boolean") {
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

// The context WINDOW fields are DERIVED session state, and the session runtime
// republishes them as 0 — not absent — whenever its own route comparison misses
// (context-state.mjs: routeState). A 0 therefore means "not resolved on this
// frame", never "this session has no window": adopting it dropped the gauge's
// denominator, and the gauge then fell back to its last complete reading and
// froze on the PRE-compact number for the rest of the session (user: 오토
// 컴팩트 이후에 컨텍스트 원형바가 동기화가 안됨). Only a frame that stays on
// the SAME provider+model may inherit them, so a real model switch still drops
// the previous window instead of painting it against a new one.
const LANE_CONTEXT_WINDOW_FIELDS: ReadonlyArray<
  "contextWindow" | "displayContextWindow" | "autoCompactTokenLimit"
> = ["contextWindow", "displayContextWindow", "autoCompactTokenLimit"];

export function laneFrameWithRetainedContextWindow(
  prior: Snapshot | null,
  next: Snapshot,
): Snapshot {
  if (!prior) return next;
  const priorSessionId = String(prior.sessionId || "");
  const nextSessionId = String(next.sessionId || "");
  if (priorSessionId && nextSessionId && priorSessionId !== nextSessionId) return next;
  if (laneRouteText(prior, "provider") !== laneRouteText(next, "provider")
    || laneRouteText(prior, "model") !== laneRouteText(next, "model")) return next;
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

// Background shell jobs are HOST-injected (session-host: snapshotWithShellJobs):
// the session runtime state carries none, so every snapshot returned by a
// runtime CALL — slash command, model/Fast switch, workflow change, new-task
// submit — reaches this lane with the field absent. Adopting such a frame
// whole blanked the work card to "No background work" while a shell was still
// running, until the next host frame refilled it (user: 간헐적으로 작업중인
// 셸이 있는데 호버하면 작업중인게 없다고 뜸). A host frame ALWAYS names the
// bucket, empty ones included, so retaining the last known jobs for a frame
// that omits the field entirely can never keep a finished shell on screen.
export function laneFrameWithRetainedShellJobs(
  prior: Snapshot | null,
  next: Snapshot,
): Snapshot {
  if (!prior) return next;
  const priorSessionId = String(prior.sessionId || "");
  const nextSessionId = String(next.sessionId || "");
  if (priorSessionId && nextSessionId && priorSessionId !== nextSessionId) return next;
  if (next.shellJobs != null || prior.shellJobs == null) return next;
  return { ...next, shellJobs: prior.shellJobs };
}

export function laneFrameRetainingSettledRows(
  prior: Snapshot | null,
  next: Snapshot,
): Snapshot {
  if (!prior) return next;
  const priorSessionId = String(prior.sessionId || "");
  const nextSessionId = String(next.sessionId || "");
  if (priorSessionId && nextSessionId && priorSessionId !== nextSessionId) return next;
  const priorItems = laneTranscript(prior);
  if (!priorItems || priorItems.length === 0) return next;
  const nextItems = laneTranscript(next);
  if (nextItems === priorItems) return next;
  if (!nextItems) return next;
  const offset = laneWindowOffset(priorItems, nextItems);
  if (offset < 0) return next;
  // Lane frames own their tail. A window can omit only the cached head.
  if (offset === 0 || nextItems.length === 0) return next;
  return mergedLaneFrame(prior, next, [...priorItems.slice(0, offset), ...nextItems], false);
}

/** Host metadata travelling with one keyed lane frame. */
export interface SessionLaneFrameProvenance {
  frameSource: "live" | "replay";
  contentRevision?: number;
}

export type SessionLaneFrameDecision =
  | {
    accept: false;
    reason: "stale-replay" | "stale-live" | "duplicate-replay";
    revision: number | null;
  }
  | {
    accept: true;
    snapshot: Snapshot;
    revision: number | null;
    reason: "authoritative" | "newer-generation" | "same-generation" | "adopted" | "aligned";
  };

function rejectedSessionLaneRevision(
  priorRevision: number | null,
  provenance: SessionLaneFrameProvenance,
): "stale-replay" | "stale-live" | "duplicate-replay" | null {
  const revision = typeof provenance.contentRevision === "number"
    ? provenance.contentRevision
    : null;
  if (revision === null || priorRevision === null) return null;
  if (revision < priorRevision) {
    return provenance.frameSource === "replay" ? "stale-replay" : "stale-live";
  }
  if (revision === priorRevision && provenance.frameSource === "replay") {
    return "duplicate-replay";
  }
  return null;
}

/** Content-generation gate for host lane frames. A replay carries the
 *  generation it was derived from, so it can only be older than or equal to
 *  the frame it raced; both are rejected whole (transcript AND the stale
 *  route/usage/work read-outs travelling with them). */
export function staleSessionLaneReplay(
  priorRevision: number | null,
  provenance: SessionLaneFrameProvenance,
): "stale-replay" | "duplicate-replay" | null {
  const rejected = rejectedSessionLaneRevision(priorRevision, provenance);
  return rejected === "stale-replay" || rejected === "duplicate-replay"
    ? rejected
    : null;
}

/** The host lane mixes owner publications with durable replays. Ordering is
 * by authoritative CONTENT generation, never arrival. */
export function decideSessionLaneFrame(
  prior: Snapshot | null,
  priorRevision: number | null,
  next: Snapshot,
  provenance: SessionLaneFrameProvenance,
): SessionLaneFrameDecision {
  const revision = typeof provenance.contentRevision === "number"
    ? provenance.contentRevision
    : null;
  // Host-only read-outs and the unresolved context denominator are restored
  // BEFORE any branch decides, so every accepted frame carries the pane's live
  // work and a gauge limit it can actually divide by.
  const frame = laneFrameWithRetainedContextWindow(
    prior,
    laneFrameWithRetainedShellJobs(prior, next),
  );
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
        reason: "newer-generation",
      };
    }
    if (revision !== null && priorRevision !== null && revision === priorRevision) {
      const priorItems = laneTranscript(prior);
      const snapshot = priorItems
        ? mergedLaneFrame(prior, frame, priorItems, true)
        : frame;
      // Same-generation OWNER frames still carry fresh busy/queue/tail state,
      // but their settled transcript is byte-for-byte the generation already
      // painted. Reuse its array identity so focus churn cannot remount rows.
      return {
        accept: true,
        snapshot: laneFrameWithRetainedRoute(prior, snapshot),
        revision,
        reason: "same-generation",
      };
    }
  }
  const snapshot = laneFrameRetainingSettledRows(prior, frame);
  const reason = snapshot === frame ? "adopted" : "aligned";
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
  decision: SessionLaneFrameDecision,
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
    window.mixdogDesktop?.perfLog?.(`lane-frame id=${sessionId} frame=${provenance.frameSource}`
      + ` rev=${provenance.contentRevision ?? "-"} decision=${decision.reason}`);
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
  const snapshots = new Map<string, SessionLaneEntry>();
  const listeners = new Map<string, Set<() => void>>();
  const remoteSessionListeners = new Set<() => void>();
  const notificationKeys = new Map<string, object>();
  let remoteSessionId = "";
  let retainedBytes = 0;
  let stop: (() => void) | null = null;
  const removeSnapshot = (sessionId: string): void => {
    const entry = snapshots.get(sessionId);
    if (entry) retainedBytes -= entry.bytes;
    snapshots.delete(sessionId);
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
    const bucket = listeners.get(sessionId);
    if (!bucket) return;
    for (const listener of [...bucket]) listener();
  };
  const prune = (): void => {
    while (snapshots.size > Math.max(0, maxEntries)
      || retainedBytes > Math.max(0, maxBytes)) {
      let oldestInactive = "";
      for (const sessionId of snapshots.keys()) {
        if ((listeners.get(sessionId)?.size || 0) === 0) {
          oldestInactive = sessionId;
          break;
        }
      }
      // A mounted pane owns its live frame even when one unusually large
      // transcript exceeds the background cache budget. It becomes evictable
      // as soon as that pane unsubscribes.
      if (!oldestInactive) break;
      removeSnapshot(oldestInactive);
    }
  };
  const applyUpdate = (
    update: DesktopSessionStateUpdate,
  ): void => {
    const sessionId = String(update?.sessionId || "");
    if (!sessionId) return;
    const prior = snapshots.get(sessionId);
    const priorSnapshot = prior?.snapshot ?? null;
    // A lane that merely STOPPED PUBLISHING must never erase what a pane is
    // already showing. The daemon evicts an unwatched idle session to reclaim
    // memory and its transport can drop; both reload on demand, so the cached
    // transcript stays authoritative until a real frame replaces it. Without
    // this, switching away for two minutes and back repainted a live task as
    // an empty New Task (user: 진행중인 TASK창이 갑자기 NEWTASK처럼 아예
    // 비어버린다). Only a genuine teardown ('gone') clears the entry.
    //
    // The reason is OPTIONAL on the wire, and the transport baseline release
    // (ipc.ts: releaseHiddenSessionStateEntries) omits it. Requiring a reason
    // here therefore left THAT frame free to erase a pane that was on screen
    // and mid-turn (user: 데스크탑 세션 pane이 완전히 비어졌다 다시 나옴): one
    // registration that momentarily omits a mounted session id releases its
    // baseline, and the lane went blank until the next live frame refilled it.
    // An unnamed null is a baseline release, never a teardown — the decoder
    // baseline is dropped in preload and this cache is bounded by prune(), so
    // holding the frame costs nothing and keeps the pane painted.
    if (!update.snapshot && update.laneEnd !== "gone" && prior) return;
    const provenance: SessionLaneFrameProvenance = {
      frameSource: update.frameSource,
      ...(typeof update.contentRevision === "number"
        ? { contentRevision: update.contentRevision }
        : {}),
    };
    // Gate BEFORE touching the cache or decorating: a rejected replay must
    // leave the entry, its byte accounting and its listeners untouched, and
    // must not disturb the shared transcript identity baseline either.
    if (update.snapshot && priorSnapshot) {
      const rejected = rejectedSessionLaneRevision(prior?.revision ?? null, provenance);
      if (rejected) {
        reportLaneDecision(sessionId, provenance,
          { accept: false, reason: rejected, revision: prior?.revision ?? null });
        return;
      }
    }
    if (prior) {
      snapshots.delete(sessionId);
      retainedBytes -= prior.bytes;
    }
    if (update.snapshot) {
      const incoming = decorator.decorate(update.snapshot);
      if (Object.prototype.hasOwnProperty.call(incoming, "remoteEnabled")
        || Object.prototype.hasOwnProperty.call(incoming, "remoteSessionId")) {
        const nextRemoteSessionId = incoming.remoteEnabled === true
          ? String(incoming.remoteSessionId || "")
          : "";
        if (nextRemoteSessionId !== remoteSessionId) {
          remoteSessionId = nextRemoteSessionId;
          for (const listener of [...remoteSessionListeners]) listener();
        }
      }
      const decision = decideSessionLaneFrame(
        priorSnapshot,
        prior?.revision ?? null,
        incoming,
        provenance,
      );
      reportLaneDecision(sessionId, provenance, decision);
      const snapshot = decision.accept ? decision.snapshot : priorSnapshot ?? incoming;
      const now = Date.now();
      const subscribed = (listeners.get(sessionId)?.size || 0) > 0;
      const refreshEstimate = !prior
        || (!subscribed && now - prior.estimatedAt >= SESSION_LANE_ESTIMATE_INTERVAL_MS);
      const bytes = refreshEstimate ? estimateSessionSnapshotBytes(snapshot) : prior.bytes;
      snapshots.set(sessionId, {
        snapshot,
        bytes,
        estimatedAt: refreshEstimate ? now : prior.estimatedAt,
        revision: decision.accept
          ? decision.revision
          : prior?.revision ?? null,
      });
      retainedBytes += bytes;
    }
    prune();
    const nextSnapshot = snapshots.get(sessionId)?.snapshot ?? null;
    if ((listeners.get(sessionId)?.size || 0) === 0) {
      const key = notificationKeys.get(sessionId);
      if (key) cancelLayoutFrame(key);
      notificationKeys.delete(sessionId);
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
  const apply = (update: DesktopSessionStateUpdate): void => applyUpdate(update);
  return {
    get(sessionId) {
      const entry = snapshots.get(sessionId);
      if (!entry) return null;
      snapshots.delete(sessionId);
      snapshots.set(sessionId, entry);
      return entry.snapshot;
    },
    subscribe(sessionId, listener) {
      let bucket = listeners.get(sessionId);
      if (!bucket) {
        bucket = new Set();
        listeners.set(sessionId, bucket);
      }
      bucket.add(listener);
      return () => {
        bucket.delete(listener);
        if (bucket.size === 0) {
          listeners.delete(sessionId);
          const key = notificationKeys.get(sessionId);
          if (key) cancelLayoutFrame(key);
          notificationKeys.delete(sessionId);
          prune();
        }
      };
    },
    getRemoteSessionId: () => remoteSessionId,
    subscribeRemoteSession(listener) {
      remoteSessionListeners.add(listener);
      return () => remoteSessionListeners.delete(listener);
    },
    subscribedSessionIds: () => [...listeners.keys()],
    evictInactive() {
      for (const sessionId of [...snapshots.keys()]) {
        if ((listeners.get(sessionId)?.size || 0) === 0) removeSnapshot(sessionId);
      }
    },
    start(source = window.mixdogDesktop?.subscribeSessionState?.bind(window.mixdogDesktop)) {
      if (stop) return stop;
      if (typeof source !== "function") return () => {};
      const unsubscribe = source(apply);
      const halt = (): void => {
        if (stop !== halt) return;
        stop = null;
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
    stats: () => ({
      entries: snapshots.size,
      estimatedBytes: retainedBytes,
      subscribedSessions: listeners.size,
      notificationKeys: notificationKeys.size,
    }),
    clear() {
      for (const key of notificationKeys.values()) cancelLayoutFrame(key);
      notificationKeys.clear();
      snapshots.clear();
      retainedBytes = 0;
      remoteSessionId = "";
      decorator.clear();
    },
  };
}

/** Shared store for the app renderer; components use the hook below. */
export const defaultSessionLaneStore = createSessionLaneStore();

export function useSessionLane(
  sessionId: string,
  store: SessionLaneStore = defaultSessionLaneStore,
  isEqual: (left: Snapshot, right: Snapshot) => boolean = Object.is,
  enabled = true,
): Snapshot | null {
  const cached = useRef<{ value: Snapshot | null } | null>(null);
  const subscribe = useCallback(
    (listener: () => void) => (enabled && sessionId
      ? store.subscribe(sessionId, listener)
      : () => {}),
    [enabled, sessionId, store],
  );
  const read = useCallback(
    () => {
      if (!enabled) return cached.current?.value ?? null;
      const next = sessionId ? store.get(sessionId) : null;
      const previous = cached.current;
      if (previous && (
        previous.value === next
        || (previous.value !== null && next !== null && isEqual(previous.value, next))
      )) return previous.value;
      cached.current = { value: next };
      return next;
    },
    [enabled, isEqual, sessionId, store],
  );
  return useSyncExternalStore(subscribe, read);
}

export function usePinnedRemoteSession(
  store: SessionLaneStore = defaultSessionLaneStore,
): string {
  return useSyncExternalStore(
    store.subscribeRemoteSession,
    store.getRemoteSessionId,
    store.getRemoteSessionId,
  );
}

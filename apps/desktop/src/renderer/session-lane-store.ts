// Renderer consumption of the per-session live lanes (mixdog:session-state).
// One process-wide store fans lane frames out per sessionId so a pane
// subscribed to session A never re-renders for session B's traffic; the
// focused mixdog:state pipeline stays untouched.
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
  /** Wire the preload lane once; returns a stop function. Idempotent — a
   *  second start while wired returns the existing stop. */
  start(source?: SessionLaneSource | undefined): () => void;
  /** Test/manual injection of one lane frame. */
  apply(update: DesktopSessionStateUpdate): void;
  /** Reuse an already decorated focused-state frame without a second
   * transcript identity/failure reconciliation pass. `source` names the call
   * boundary the frame came from (see SessionLaneFrameSource). */
  applyDecorated(sessionId: string, snapshot: Snapshot, source?: SessionLaneFrameSource): void;
  stats(): { entries: number; estimatedBytes: number; subscribedSessions: number };
  clear(): void;
}

const SESSION_LANE_CACHE_LIMIT = 64;
const SESSION_LANE_CACHE_BYTE_LIMIT = 24 * 1024 * 1024;
const SESSION_LANE_ESTIMATE_INTERVAL_MS = 1_000;

interface SessionLaneEntry {
  snapshot: Snapshot;
  bytes: number;
  estimatedAt: number;
  /** Authoritative content generation this cached transcript was accepted at
   *  (null while the host publishes unversioned frames). */
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

function laneUpdateIsUrgent(previous: Snapshot | null, next: Snapshot | null): boolean {
  if (!previous || !next) return true;
  return previous.sessionId !== next.sessionId
    || previous.busy !== next.busy
    || previous.commandBusy !== next.commandBusy
    || previous.commandStatus !== next.commandStatus
    || previous.toolApproval !== next.toolApproval
    || queuedIdentity(previous) !== queuedIdentity(next)
    || agentActivityIdentity(previous) !== agentActivityIdentity(next);
}

/** Where a lane frame came from. These are the renderer's OWN call
 *  boundaries — not a guess about the frame's content:
 *  - "session-lane": mixdog:session-state, the session's own publication
 *    (its pooled engine's live frame, or the one-shot disk/replay peek used
 *    for a session with no pooled engine). Authoritative for that session's
 *    live state; its transcript may be a tail WINDOW because both
 *    projections cap at the host transcript item limit.
 *  - "focused-state": the settled focused mixdog:state stream — the same
 *    authority for the session it names.
 *  - "focused-transition": the focused stream WHILE a renderer-initiated
 *    session route (resumeSession) is in flight. Such a frame describes a
 *    host transition: an empty/partial transcript there is the engine
 *    loading, not the session losing rows.
 *  - "renderer-result": a renderer-initiated answer (submit, /clear, the
 *    resume RPC result). Always replaces the cache. */
export type SessionLaneFrameSource =
  | "session-lane"
  | "focused-state"
  | "focused-transition"
  | "renderer-result";

// ONE session reaches this cache through all four boundaries above, and they
// do not carry the same completeness. Overwriting the cache with whichever
// frame arrived last collapsed the clicked pane's transcript (rows unmounted,
// scrollTop clamped to 0, every row id reissued) and made the previously
// focused pane grow and shrink again (user report, CDP-attributed).
//
// Only the TRANSCRIPT's completeness is reconciled here:
//   * alignment failure          -> replace (host/channel clear, genuine
//     deletion, compaction, branch resume, retry/edit rewrite).
//   * settled source, aligned but missing the HEAD this cache still holds
//     -> restore that head only; the frame keeps owning its tail, so trailing
//     removal and streaming settle are never blocked.
//   * transition source, aligned but shorter/empty -> keep the settled rows
//     until the route settles.
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
  }
  return changed ? merged : next;
}

export function laneFrameRetainingSettledRows(
  prior: Snapshot | null,
  next: Snapshot,
  source: SessionLaneFrameSource = "session-lane",
): Snapshot {
  if (!prior || source === "renderer-result") return next;
  const priorSessionId = String(prior.sessionId || "");
  const nextSessionId = String(next.sessionId || "");
  if (priorSessionId && nextSessionId && priorSessionId !== nextSessionId) return next;
  const priorItems = laneTranscript(prior);
  if (!priorItems || priorItems.length === 0) return next;
  const nextItems = laneTranscript(next);
  if (nextItems === priorItems) return next;
  const transitional = source === "focused-transition";
  // A frame without any transcript field makes no completeness claim at all.
  if (!nextItems) {
    return transitional ? mergedLaneFrame(prior, next, priorItems, true) : next;
  }
  const offset = laneWindowOffset(priorItems, nextItems);
  if (offset < 0) return next;
  const keepsTail = offset + nextItems.length >= priorItems.length;
  if (!transitional) {
    // Settled sources own their own tail, and an EMPTY frame carries no
    // window at all: it states the session has no transcript (host/channel
    // clear). Only the head this cache still holds, which a windowed frame
    // no longer carries, is restored.
    if (offset === 0 || nextItems.length === 0) return next;
    return mergedLaneFrame(prior, next, [...priorItems.slice(0, offset), ...nextItems], false);
  }
  if (offset === 0 && keepsTail) return next;
  // Reuse the cached array identity for a pure replay so no consumer even
  // re-renders; a window that reaches the settled tail keeps its live rows.
  const retainAll = nextItems.length === 0 || !keepsTail;
  const items = retainAll ? priorItems : [...priorItems.slice(0, offset), ...nextItems];
  return mergedLaneFrame(prior, next, items, retainAll);
}

/** What the store was told about ONE incoming frame. `source` is the
 *  renderer's own call boundary; `frameSource`/`contentRevision` are the
 *  host's optional lane metadata (absent on remote/legacy hosts). */
export interface SessionLaneFrameProvenance {
  source: SessionLaneFrameSource;
  frameSource?: "live" | "replay";
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
  if (provenance.source === "renderer-result") return null;
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
 *  route/usage/work read-outs travelling with them). Unversioned hosts and
 *  the focused pipeline return null and keep the compatibility path. */
export function staleSessionLaneReplay(
  priorRevision: number | null,
  provenance: SessionLaneFrameProvenance,
): "stale-replay" | "duplicate-replay" | null {
  const rejected = rejectedSessionLaneRevision(priorRevision, provenance);
  return rejected === "stale-replay" || rejected === "duplicate-replay"
    ? rejected
    : null;
}

/** The multi-writer rule for one lane cache entry. The store has three
 *  writers (the focused pipeline, renderer results, and the host lane, which
 *  itself mixes owner publications with durable replays), so "last write
 *  wins" repeatedly swapped a pane's rendered rows for an older projection.
 *  Ordering is by authoritative CONTENT generation, never arrival. */
export function decideSessionLaneFrame(
  prior: Snapshot | null,
  priorRevision: number | null,
  next: Snapshot,
  provenance: SessionLaneFrameProvenance,
): SessionLaneFrameDecision {
  const revision = typeof provenance.contentRevision === "number"
    ? provenance.contentRevision
    : null;
  if (provenance.source === "renderer-result") {
    // Explicit authoritative answer, epoch/target guarded by its caller. It
    // replaces the content and leaves the recorded generation untouched, so
    // the next owner publication still orders normally against it.
    return {
      accept: true,
      snapshot: laneFrameWithRetainedRoute(prior, next),
      revision: priorRevision,
      reason: "authoritative",
    };
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
        snapshot: laneFrameWithRetainedRoute(prior, next),
        revision,
        reason: "newer-generation",
      };
    }
    if (revision !== null && priorRevision !== null && revision === priorRevision) {
      const priorItems = laneTranscript(prior);
      const snapshot = priorItems
        ? mergedLaneFrame(prior, next, priorItems, true)
        : next;
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
  const snapshot = laneFrameRetainingSettledRows(prior, next, provenance.source);
  const reason = snapshot === next ? "adopted" : "aligned";
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
    window.mixdogDesktop?.perfLog?.(`lane-frame id=${sessionId} source=${provenance.source}`
      + ` frame=${provenance.frameSource || "unversioned"}`
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
  const notificationKeys = new Map<string, object>();
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
    decorated = false,
    source: SessionLaneFrameSource = "session-lane",
  ): void => {
    const sessionId = String(update?.sessionId || "");
    if (!sessionId) return;
    const prior = snapshots.get(sessionId);
    const priorSnapshot = prior?.snapshot ?? null;
    const provenance: SessionLaneFrameProvenance = {
      source,
      ...(update.frameSource ? { frameSource: update.frameSource } : {}),
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
      const incoming = decorated
        ? update.snapshot as Snapshot
        : decorator.decorate(update.snapshot);
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
          prune();
        }
      };
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
    applyDecorated(sessionId, snapshot, source = "focused-state") {
      applyUpdate({
        sessionId,
        snapshot: snapshot as DesktopSessionStateUpdate["snapshot"],
      }, true, source);
    },
    stats: () => ({
      entries: snapshots.size,
      estimatedBytes: retainedBytes,
      subscribedSessions: listeners.size,
    }),
    clear() {
      for (const key of notificationKeys.values()) cancelLayoutFrame(key);
      notificationKeys.clear();
      snapshots.clear();
      retainedBytes = 0;
      decorator.clear();
    },
  };
}

/** Shared store for the app renderer; components use the hook below. */
export const defaultSessionLaneStore = createSessionLaneStore();

export function applyFocusedSnapshotToSessionLane(
  snapshot: Snapshot,
  store: SessionLaneStore = defaultSessionLaneStore,
  { source = "focused-state" }: { source?: SessionLaneFrameSource } = {},
): void {
  const sessionId = String(snapshot?.sessionId || "");
  if (!sessionId) return;
  store.applyDecorated(sessionId, snapshot, source);
}

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

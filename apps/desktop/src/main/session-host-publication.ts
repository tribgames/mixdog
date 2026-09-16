import type {
  DesktopAgentPoolRow,
  DesktopSessionFrameSource,
  DesktopSessionLaneEnd,
  DesktopSessionStateUpdate,
  DesktopSessionSummary,
  SessionSnapshot,
} from '../shared/contract';
import { isSessionId } from './desktop-state';
import { reconcileSessionProjection } from './state-delta';

type SessionProjection = {
  revision: number;
  snapshot: SessionSnapshot;
  /** Stored views refresh until a live publication takes ownership. */
  cold: boolean;
  /** Identity of the stored (cold) projection this snapshot was read from.
   *  Sent back on the refresh clock so an unchanged view answers bodiless. */
  projectionStamp?: string;
};

interface SessionHostPublicationOwner {
  isDisposed(): boolean;
  controlSessionId(): string;
  setControlSessionId(sessionId: string): void;
  visibleSessionIds(): ReadonlySet<string>;
  readSession(sessionId: string): Promise<SessionSnapshot>;
  snapshotWithShellJobs(sessionId: string, snapshot: SessionSnapshot): SessionSnapshot;
  trackShellJobsEngineState(snapshot: SessionSnapshot): void;
  onShellPublished(): void;
}

function sessionIdOf(value: unknown): string {
  const id = String(value || '');
  if (!isSessionId(id)) throw new TypeError('session id is invalid.');
  return id;
}

function statePatch(snapshot: SessionSnapshot, patch: Record<string, unknown>): SessionSnapshot {
  const base = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const set =
    patch.set && typeof patch.set === 'object' && !Array.isArray(patch.set)
      ? (patch.set as Record<string, unknown>)
      : {};
  const next: Record<string, unknown> = { ...base, ...set };
  const append =
    patch.itemsAppend && typeof patch.itemsAppend === 'object' ? (patch.itemsAppend as Record<string, unknown>) : null;
  if (append) {
    const items = Array.isArray(base.items) ? base.items : [];
    const from = Math.max(0, Math.floor(Number(append.from) || 0));
    next.items = items.slice(0, from).concat(Array.isArray(append.values) ? append.values : []);
  }
  for (const key of Array.isArray(patch.remove) ? patch.remove : []) {
    if (typeof key === 'string') delete next[key];
  }
  return next as SessionSnapshot;
}

function emitIsolated<T>(listeners: Set<(value: T) => void>, value: T): void {
  for (const listener of [...listeners]) {
    try {
      listener(value);
    } catch {
      /* a presentation listener owns its failure */
    }
  }
}

/** Listener sets, projection map, and live-frame application. SessionHost
 *  remains the service facade; this object owns publication side effects. */
export class SessionHostPublication {
  readonly projections = new Map<string, SessionProjection>();
  private readonly recoveringSessionIds = new Set<string>();
  private readonly listeners = new Set<(snapshot: SessionSnapshot) => void>();
  private readonly sessionListeners = new Set<(sessions: DesktopSessionSummary[]) => void>();
  private readonly agentPoolListeners = new Set<(agents: DesktopAgentPoolRow[]) => void>();
  private readonly sessionStateListeners = new Set<(update: DesktopSessionStateUpdate) => void>();
  private remoteSessionId = '';
  shellSnapshot: SessionSnapshot = null;

  constructor(private readonly owner: SessionHostPublicationOwner) {}

  subscribe(listener: (snapshot: SessionSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeSessions(listener: (sessions: DesktopSessionSummary[]) => void): () => void {
    this.sessionListeners.add(listener);
    return () => this.sessionListeners.delete(listener);
  }

  subscribeAgentPool(listener: (agents: DesktopAgentPoolRow[]) => void): () => void {
    this.agentPoolListeners.add(listener);
    return () => this.agentPoolListeners.delete(listener);
  }

  subscribeSessionStates(listener: (update: DesktopSessionStateUpdate) => void): () => void {
    this.sessionStateListeners.add(listener);
    return () => this.sessionStateListeners.delete(listener);
  }

  snapshotWithRemoteSession(snapshot: SessionSnapshot): SessionSnapshot {
    if (!snapshot || typeof snapshot !== 'object') return snapshot;
    return {
      ...snapshot,
      remoteEnabled: Boolean(this.remoteSessionId),
      remoteSessionId: this.remoteSessionId || null,
    };
  }

  applyRemoteSessionState(value: unknown): void {
    const state = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    const candidate = String(state.sessionId || '');
    const next = state.enabled === true && candidate.length <= 256 && isSessionId(candidate) ? candidate : '';
    if (next === this.remoteSessionId) return;
    this.remoteSessionId = next;
    if (this.shellSnapshot) this.publishShell(this.shellSnapshot);
    for (const sessionId of this.owner.visibleSessionIds()) {
      const projection = this.projections.get(sessionId);
      if (projection) this.publishSession(sessionId, projection.snapshot);
    }
  }

  publishShell(snapshot: SessionSnapshot): SessionSnapshot {
    const visibleSnapshot = this.snapshotWithRemoteSession(snapshot);
    this.shellSnapshot = visibleSnapshot;
    emitIsolated(this.listeners, visibleSnapshot);
    this.owner.onShellPublished();
    return visibleSnapshot;
  }

  publishSession(
    sessionId: string,
    snapshot: SessionSnapshot,
    frameSource: DesktopSessionFrameSource = 'live',
    readTraceId?: string
  ): void {
    const visibleSnapshot = this.snapshotWithRemoteSession(this.owner.snapshotWithShellJobs(sessionId, snapshot));
    for (const listener of [...this.sessionStateListeners]) {
      try {
        listener({
          sessionId,
          snapshot: visibleSnapshot,
          frameSource,
          ...(readTraceId ? { readTraceId } : {}),
        });
      } catch {
        // A visual client cannot affect service execution.
      }
    }
  }

  publishSessions(sessions: DesktopSessionSummary[]): void {
    emitIsolated(this.sessionListeners, sessions);
  }

  publishAgents(agents: DesktopAgentPoolRow[]): void {
    emitIsolated(this.agentPoolListeners, agents);
  }

  applySessionResult(
    sessionId: string,
    value: Record<string, unknown> | null | undefined,
    publish = true
  ): SessionSnapshot {
    const id = sessionIdOf(value?.sessionId || sessionId);
    const prior = this.projections.get(id);
    const revision = Number(value?.revision);
    // Configure replies and live frames can cross in flight. Revisions are
    // ordered across live runtimes and stored views. Never roll a selection
    // (or its transcript) back to an older reply.
    if (prior && Number.isFinite(revision) && revision < prior.revision) {
      return this.snapshotWithRemoteSession(prior.snapshot);
    }
    let snapshot = prior?.snapshot ?? null;
    if (value && Object.hasOwn(value, 'full')) {
      const full = value.full;
      const rebuilt =
        full && typeof full === 'object'
          ? ({ ...(full as Record<string, unknown>), sessionId: id } as SessionSnapshot)
          : null;
      // A stored read carries no baseline, so it always answers FULL — and a
      // visible cold view is re-read on a one second clock. Folding the fresh
      // parse onto the retained projection keeps the object identity that every
      // delta encoder downstream reads as "already sent".
      if (rebuilt) {
        snapshot = prior?.snapshot ? reconcileSessionProjection(prior.snapshot, rebuilt) : rebuilt;
      }
    } else if (value?.patch && typeof value.patch === 'object') {
      // The live lane usually delivers the same revision BEFORE the action
      // reply that carries it as a patch: the reply's baseline then reads as
      // crossed even though the projection already holds exactly this state.
      // Recovering there re-read every session in FULL on every submit
      // (daemon log: "missing baseline" after each accepted prompt).
      if (prior && Number.isFinite(revision) && revision === prior.revision) {
        return this.snapshotWithRemoteSession(prior.snapshot);
      }
      if (!prior || Number(value.baseRevision) !== prior.revision) {
        this.recoverMissingSessionBaseline(id);
        return this.snapshotWithRemoteSession(
          prior?.snapshot ?? ({ sessionId: id, items: [], queued: [] } as SessionSnapshot)
        );
      }
      snapshot = statePatch(prior.snapshot, value.patch as Record<string, unknown>);
    }
    if (!snapshot) {
      // The service control session owns no pane and is never published, so an
      // empty projection cannot blank anything: it keeps the cheap fallback
      // rather than paying for a recovery read on every global capability.
      if (id === this.owner.controlSessionId()) {
        snapshot = { sessionId: id, items: [], queued: [] } as SessionSnapshot;
      } else {
        this.recoverMissingSessionBaseline(id);
        return { sessionId: id, items: [], queued: [] } as SessionSnapshot;
      }
    }
    const nextRevision = Number.isFinite(revision) ? revision : (prior?.revision ?? 0);
    // Publishing a projection that did not move repaints nothing and costs a
    // whole transcript on the relay leg: the reader already holds this frame.
    const unmoved = prior !== undefined && prior.snapshot === snapshot && prior.revision === nextRevision;
    // Only a stored projection names a stamp; a live frame clears it so the
    // next cold refresh (after the owner lets go) reads a full body again.
    const projectionStamp =
      typeof value?.projectionStamp === 'string' && value.projectionStamp
        ? value.projectionStamp
        : value?.unchanged === true
          ? prior?.projectionStamp
          : undefined;
    this.projections.set(id, {
      revision: nextRevision,
      snapshot,
      // Revision 0 remains a compatibility fallback for older daemon replies.
      cold: value?.projection === true || nextRevision === 0,
      ...(projectionStamp ? { projectionStamp } : {}),
    });
    this.owner.trackShellJobsEngineState(snapshot);
    if (publish && !unmoved && id !== this.owner.controlSessionId()) {
      this.publishSession(id, snapshot);
    }
    return this.snapshotWithRemoteSession(snapshot);
  }

  /** A reply can outlive the baseline it was computed against: the projection
   *  is dropped when the daemon reclaims an unwatched session and when the
   *  daemon transport blips, so a reply that answers "unchanged since revision
   *  N" — or carries a patch against it — arrives with nothing to apply it to.
   *  Fabricating `{ items: [] }` for that case PUBLISHED AN EMPTY LIVE FRAME
   *  and blanked a pane that was on screen and working (user: 데스크탑 세션
   *  pane이 완전히 비어졌다 다시 나옴). Re-read instead: with no baseline to
   *  announce, the daemon must answer FULL, and nothing is published until that
   *  real content lands. The in-flight set keeps a read that itself finds no
   *  content from starting another one. */
  recoverMissingSessionBaseline(sessionId: string): void {
    if (this.owner.isDisposed() || this.recoveringSessionIds.has(sessionId)) return;
    this.recoveringSessionIds.add(sessionId);
    console.error(`[mixdog-lane] missing baseline session=${sessionId} — re-reading`);
    void this.owner
      .readSession(sessionId)
      .catch(() => undefined)
      .finally(() => {
        this.recoveringSessionIds.delete(sessionId);
      });
  }

  handleSessionFrame(frame: Record<string, unknown>): void {
    if (this.owner.isDisposed()) return;
    if (frame.type === 'remote-session-state') {
      this.applyRemoteSessionState(frame);
      return;
    }
    const sessionId = String(frame.sessionId || '');
    if (!sessionId) return;
    if (sessionId === this.owner.controlSessionId()) {
      if (frame.type === 'session-gone') {
        this.projections.delete(sessionId);
        this.owner.setControlSessionId('');
      }
      return;
    }
    if (frame.type === 'session-gone') {
      this.projections.delete(sessionId);
      // The daemon's idle sweep reclaims an unwatched session's MEMORY
      // (session-service: 'idle and unwatched') and reloads it on demand; the
      // transcript never left disk. Publishing that as an unqualified null
      // made the renderer drop its cached lane and repaint a live task as an
      // empty New Task (user: 진행중인 TASK창이 갑자기 NEWTASK처럼 아예
      // 비어버린다). Name the reason so only a real teardown clears a pane.
      const laneEnd: DesktopSessionLaneEnd = String(frame.reason || '') === 'idle and unwatched' ? 'unloaded' : 'gone';
      for (const listener of [...this.sessionStateListeners]) {
        try {
          listener({ sessionId, snapshot: null, frameSource: 'live', laneEnd });
        } catch {}
      }
      return;
    }
    if (frame.type !== 'session-state') return;
    const prior = this.projections.get(sessionId);
    if (prior && Number(frame.revision) < prior.revision) return;
    // An action reply can land first and apply this revision as its patch;
    // the lane frame that follows is the same state and must not read as a
    // crossed baseline.
    if (prior && frame.patch && Number(frame.revision) === prior.revision) return;
    if (frame.resyncRequired === true || (frame.patch && (!prior || Number(frame.baseRevision) !== prior.revision))) {
      void this.owner.readSession(sessionId).catch(() => undefined);
      return;
    }
    this.applySessionResult(sessionId, frame);
  }

  handleSessionTransportLoss(): void {
    this.owner.setControlSessionId('');
    this.projections.clear();
    for (const sessionId of this.owner.visibleSessionIds()) {
      for (const listener of [...this.sessionStateListeners]) {
        // Recovery re-attaches to the daemon and resyncs. Until it lands, a
        // pane keeps showing what it already has instead of blanking.
        try {
          listener({ sessionId, snapshot: null, frameSource: 'live', laneEnd: 'disconnected' });
        } catch {}
      }
    }
  }

  clearListeners(): void {
    this.listeners.clear();
    this.sessionListeners.clear();
    this.agentPoolListeners.clear();
    this.sessionStateListeners.clear();
  }

  clearProjections(): void {
    this.projections.clear();
  }
}

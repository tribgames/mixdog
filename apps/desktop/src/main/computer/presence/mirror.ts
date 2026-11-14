/**
 * What the overlay draws while an agent drives the desktop: the pill, the activities and each session's arrow. With the
 * Rust helper running Computer Use the core owns the state, so this mirror builds the overlay's snapshot from the core's
 * `computer` section (who is working, in which mode, on which windows, the user's hold) and from the helper's pointer
 * progress (`host/computer/pointerFeedback`, the arrow). While the section names the desktop's own host as the backend,
 * the in-process coordinator is the source and the mirror only passes it through.
 */
import { recordCursorDiagnostic } from '../overlay/cursor-diagnostics';
import type {
  ComputerUseActivity,
  ComputerUseActivityPhase,
  ComputerUseCoordinator,
  ComputerUseCursor,
  ComputerUseCursorEffect,
  ComputerUseSnapshot,
} from '../session/coordinator';

/** One session of the `computer` section; the fields after `observeOnly` come with the section's newer shape. */
export interface ComputerSectionSession {
  sessionThreadId: string;
  observeOnly: boolean;
  /** Windows with an active command of this session. */
  windowIds?: string[];
  /** How the active command reaches the screen; `null` while none runs. */
  mode?: 'foreground' | 'background' | null;
  /** The active command's phase word; `null` while none runs. */
  phase?: string | null;
}

export interface ComputerSectionValue {
  active: boolean;
  observeOnly: boolean;
  controller: string | null;
  sessionThreadId: string | null;
  /** Every session with an open execution, oldest first; the overlay draws one activity each. */
  sessions: ComputerSectionSession[];
  cleanupState?: 'pending' | 'failed' | 'ready';
  /** The user's hold on the desktop, which the pill offers to resume or stop; absent while the user holds none. */
  userControl?: { active: boolean; reason: string; resumeMode: 'idle' | 'manual' } | null;
  /** Which stack runs Computer Use; absent reads as the helper. */
  backend?: 'helper' | 'desktopHost';
  /** Seconds of user idleness after which a hold ends by itself; 0 = only Resume ends it. */
  idleResumeSeconds?: number;
}

/** One pointer-progress event of a helper, as `publishPointerProgress` takes it. */
export interface PointerProgressEvent {
  x: number;
  y: number;
  held: boolean;
  mode: 'foreground' | 'background';
  phase: string;
  windowId?: string;
}

/** What the overlay reads: the snapshot to draw, its changes, and the way to hand a session's pointer back. */
export interface ComputerPresenceSource {
  snapshot(): ComputerUseSnapshot;
  subscribe(listener: (snapshot: ComputerUseSnapshot) => void): () => void;
  releasePointer(sessionId: string): void;
}

export interface ComputerPresence extends ComputerPresenceSource {
  /** A `computer` section value (the whole value, not a delta). */
  applySection(section: ComputerSectionValue): void;
  pointerProgress(sessionId: string, event: PointerProgressEvent): void;
  windowIdsWithActiveCommand(): string[];
  backend(): 'helper' | 'desktopHost';
}

export interface ComputerPresenceDeps {
  /** The in-process coordinator, which is the source while the desktop's own host runs Computer Use. */
  coordinator?: Pick<
    ComputerUseCoordinator,
    'snapshot' | 'subscribe' | 'showCursor' | 'releasePointer' | 'windowIdsWithActiveCommand'
  >;
  /** Tells the core the user took the pointer back (`computer/pointerReleased`). */
  notifyPointerReleased(sessionThreadId: string): void;
  now?: () => number;
}

/** The cursor effect each pointer-progress phase paints; a bare move depends on whether a button is held. */
const PHASE_CURSOR_EFFECTS: Record<string, ComputerUseCursorEffect> = {
  release: 'click',
  prepare: 'prepare',
  press: 'press',
  scroll: 'scroll',
  type: 'type',
};

const cursorEffect = (event: PointerProgressEvent): ComputerUseCursorEffect =>
  PHASE_CURSOR_EFFECTS[event.phase] ?? (event.held ? 'drag' : 'move');

const ACTIVITY_PHASES: ReadonlySet<string> = new Set<ComputerUseActivityPhase>([
  'active_background',
  'active_foreground',
  'queued_foreground',
  'queued_target',
  'queued',
  'awaiting_recapture',
  'thinking',
  'paused_user_takeover',
]);

/** Why a pointer-progress event is not drawn: a user takeover, a pending cleanup, or a session without activity. */
function pointerDropReason(state: ComputerUseSnapshot, sessionId: string): string | null {
  if (state.userControlActive) return 'ignored_user_control';
  if (state.cleanupState !== 'ready') return 'ignored_cleanup';
  if (!state.activities.some((activity) => activity.sessionId === sessionId)) return 'ignored_no_activity';
  return null;
}

/** The in-process coordinator's way, for the desktop's own host: paints only while the session is actively driving the
 *  desktop, so a takeover, a pending cleanup or a session without activity drops the update. */
export function coordinatorPointerProgress(
  coordinator: Pick<ComputerUseCoordinator, 'snapshot' | 'showCursor'>,
  sessionId: string,
  event: PointerProgressEvent
): void {
  const dropped = pointerDropReason(coordinator.snapshot(), sessionId);
  if (dropped) {
    recordCursorDiagnostic(dropped);
    return;
  }
  recordCursorDiagnostic('published');
  coordinator.showCursor({
    sessionId,
    windowId: event.windowId,
    x: event.x,
    y: event.y,
    tracking: true,
    action: event.phase,
    effect: cursorEffect(event),
    mode: event.mode,
  });
}

export function createComputerPresence(deps: ComputerPresenceDeps): ComputerPresence {
  const { coordinator, notifyPointerReleased } = deps;
  const now = deps.now ?? Date.now;
  const listeners = new Set<(snapshot: ComputerUseSnapshot) => void>();
  let revision = 0;
  let section: ComputerSectionValue | null = null;
  let current: ComputerUseSnapshot | null = null;
  const cursors = new Map<string, ComputerUseCursor>();
  const released = new Set<string>();
  /** The last mode each open session ran in: the arrow follows it between commands. */
  const lastMode = new Map<string, 'foreground' | 'background'>();
  const startedAt = new Map<string, number>();
  let cursorSequence = 0;

  const backend = (): 'helper' | 'desktopHost' => (section?.backend === 'desktopHost' ? 'desktopHost' : 'helper');
  const delegating = (): boolean => coordinator !== undefined && backend() === 'desktopHost';

  const sessionsOf = (): ComputerSectionSession[] => (section?.active ? section.sessions : []);

  const build = (): ComputerUseSnapshot => {
    const value: ComputerSectionValue = section ?? {
      active: false,
      observeOnly: false,
      controller: null,
      sessionThreadId: null,
      sessions: [],
    };
    const at = now();
    const sessions = sessionsOf();
    const sessionIds = sessions.map((session) => session.sessionThreadId);
    const hold = value.userControl;
    const takeover = hold?.active === true;
    // A yield (`active: false`) holds the sessions that wait for the user to be idle; the pill offers Resume only for a
    // manual one (0 seconds; any other value reads as an automatic resume, `overlay/model.ts`).
    const manualYield = hold && !hold.active && (hold.resumeMode === 'manual' || value.idleResumeSeconds === 0);
    const activities: ComputerUseActivity[] = sessions.map((session) => {
      const id = session.sessionThreadId;
      const mode = cursors.get(id)?.mode ?? session.mode ?? lastMode.get(id) ?? 'background';
      // A pointer event after the section said no command runs is a command running (the coordinator's `showCursor`
      // makes the activity active), so the arrow is not read as one held while the session thinks.
      const phase: ComputerUseActivityPhase = takeover
        ? 'paused_user_takeover'
        : session.phase && ACTIVITY_PHASES.has(session.phase)
          ? (session.phase as ComputerUseActivityPhase)
          : session.mode === null && !cursors.has(id)
            ? 'thinking'
            : mode === 'foreground'
              ? 'active_foreground'
              : 'active_background';
      return {
        sessionId: id,
        action: session.observeOnly ? 'observe' : 'control',
        target: '',
        mode,
        phase,
        startedAt: startedAt.get(id) ?? at,
        updatedAt: at,
      };
    });
    const idleResumeSeconds =
      hold && !hold.active ? (manualYield ? 0 : value.idleResumeSeconds || 1) : value.idleResumeSeconds;
    return {
      revision,
      userControlActive: takeover,
      ...(hold?.active ? { takeoverReason: hold.reason, pausedSessionIds: sessionIds } : {}),
      ...(hold && !hold.active ? { yieldedSessionIds: sessionIds } : {}),
      ...(idleResumeSeconds === undefined ? {} : { idleResumeSeconds }),
      // A section without a latch is settled, as an idle coordinator is.
      cleanupState: value.cleanupState ?? 'ready',
      activities,
      cursors: [...cursors.values()].map((cursor) => ({ ...cursor })).sort((left, right) => left.eventId - right.eventId),
      releasedPointerSessionIds: [...released],
      presentSessionIds: sessionIds,
      targetLeases: sessions.flatMap((session) =>
        (session.windowIds ?? []).map((windowId) => ({ sessionId: session.sessionThreadId, windowId, expiresAt: null }))
      ),
    };
  };

  const snapshot = (): ComputerUseSnapshot => {
    if (coordinator && delegating()) return coordinator.snapshot();
    current ??= build();
    return current;
  };

  /** Every change to what the snapshot is built from. */
  const changed = (): void => {
    revision += 1;
    current = null;
    const value = snapshot();
    for (const listener of [...listeners]) listener(value);
  };

  let detachCoordinator: (() => void) | null = null;
  const attachCoordinator = (): void => {
    if (!coordinator || detachCoordinator) return;
    let initial = true;
    const off = coordinator.subscribe((value) => {
      if (initial || !delegating()) return;
      for (const listener of [...listeners]) listener(value);
    });
    initial = false;
    detachCoordinator = off;
  };

  return {
    snapshot,
    subscribe(listener): () => void {
      listeners.add(listener);
      attachCoordinator();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          detachCoordinator?.();
          detachCoordinator = null;
        }
      };
    },
    applySection(next): void {
      const wasDelegating = delegating();
      const previousModes = new Map(sessionsOf().map((session) => [session.sessionThreadId, session.mode]));
      section = next;
      const open = new Set(next.active ? next.sessions.map((session) => session.sessionThreadId) : []);
      const known = new Set([...startedAt.keys(), ...cursors.keys(), ...released, ...lastMode.keys()]);
      for (const sessionId of known) {
        if (open.has(sessionId)) continue;
        cursors.delete(sessionId);
        released.delete(sessionId);
        lastMode.delete(sessionId);
        startedAt.delete(sessionId);
      }
      // A takeover removes every arrow; none comes back with the resume.
      if (next.userControl?.active) cursors.clear();
      const at = now();
      for (const session of next.active ? next.sessions : []) {
        const id = session.sessionThreadId;
        if (!startedAt.has(id)) startedAt.set(id, at);
        // A finished command leaves only the overlay's short tail, not a live pointer through the session's thinking
        // time (on the command's end, not on every later value); a command in another mode starts with no arrow of the
        // previous one.
        if (session.mode === null) {
          if (previousModes.get(id) !== null) cursors.delete(id);
        }
        else if (session.mode) {
          const before = lastMode.get(id);
          if (before !== undefined && before !== session.mode) cursors.delete(id);
          lastMode.set(id, session.mode);
        }
      }
      if (wasDelegating && delegating()) {
        revision += 1;
        current = null;
        return;
      }
      changed();
    },
    pointerProgress(sessionId, event): void {
      if (coordinator && delegating()) {
        coordinatorPointerProgress(coordinator, sessionId, event);
        return;
      }
      const dropped = pointerDropReason(snapshot(), sessionId);
      if (dropped) {
        recordCursorDiagnostic(dropped);
        return;
      }
      recordCursorDiagnostic('published');
      released.delete(sessionId);
      lastMode.set(sessionId, event.mode);
      cursors.set(sessionId, {
        sessionId,
        ...(event.windowId ? { windowId: event.windowId } : {}),
        tracking: true,
        x: Math.round(event.x),
        y: Math.round(event.y),
        action: event.phase,
        effect: cursorEffect(event),
        mode: event.mode,
        eventId: ++cursorSequence,
        updatedAt: now(),
      });
      changed();
    },
    /** The session's pointer is the user's again: its arrow hides until the session's next pointer event, and the core
     *  ends its pointer hold. */
    releasePointer(sessionId): void {
      if (coordinator && delegating()) {
        coordinator.releasePointer(sessionId);
        return;
      }
      if (!sessionsOf().some((session) => session.sessionThreadId === sessionId) || released.has(sessionId)) return;
      released.add(sessionId);
      cursors.delete(sessionId);
      changed();
      try {
        notifyPointerReleased(sessionId);
      } catch {
        console.warn('[computer-presence] pointer_release_notify_failed');
      }
    },
    windowIdsWithActiveCommand(): string[] {
      if (coordinator && delegating()) return coordinator.windowIdsWithActiveCommand();
      return [...new Set(sessionsOf().flatMap((session) => session.windowIds ?? []))];
    },
    backend,
  };
}

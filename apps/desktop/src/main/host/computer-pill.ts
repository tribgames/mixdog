/**
 * The computer-use pill follows the core's `computer` section
 * (`{active, observeOnly, controller, sessionThreadId}`): this source turns
 * each section value into the snapshot the overlay already renders, with the
 * same `snapshot()`/`subscribe()` shape as the in-process coordinator.
 */
import type { ComputerUseSnapshot } from '../computer/session/coordinator';

export interface ComputerSectionValue {
  active: boolean;
  observeOnly: boolean;
  controller: string | null;
  sessionThreadId: string | null;
  /** Every session with an open execution, oldest first; the overlay draws one activity each. */
  sessions: { sessionThreadId: string; observeOnly: boolean }[];
  cleanupState?: 'pending' | 'failed' | 'ready';
  /** The user's hold on the desktop, which the pill offers to resume or stop; absent while the user holds none. */
  userControl?: { active: boolean; reason: string; resumeMode: 'idle' | 'manual' } | null;
}

export function snapshotFromComputerSection(
  revision: number,
  section: ComputerSectionValue,
  now: number
): ComputerUseSnapshot {
  const sessions = section.active ? section.sessions : [];
  const sessionIds = sessions.map((session) => session.sessionThreadId);
  const hold = section.userControl;
  return {
    revision,
    // A takeover holds every session open; a yield (`active: false`) holds the sessions that wait for the user to be idle,
    // and the pill offers Resume only for a manual one (`idleResumeSeconds` 0; any other value reads as an automatic resume, `model.ts`).
    userControlActive: hold?.active === true,
    ...(hold?.active ? { takeoverReason: hold.reason, pausedSessionIds: sessionIds } : {}),
    ...(hold && !hold.active ? { yieldedSessionIds: sessionIds, idleResumeSeconds: hold.resumeMode === 'manual' ? 0 : 1 } : {}),
    // Carried as the coordinator's snapshot carries it; a section without a
    // latch is settled, as an idle coordinator is ('ready').
    cleanupState: section.cleanupState ?? 'ready',
    activities: sessions.map((session) => ({
      sessionId: session.sessionThreadId,
      action: session.observeOnly ? 'observe' : 'control',
      target: '',
      mode: 'background',
      phase: 'active_background',
      startedAt: now,
      updatedAt: now,
    })),
    cursors: [],
    presentSessionIds: sessions.map((session) => session.sessionThreadId),
    targetLeases: [],
  };
}

export function createComputerPillSource(now: () => number = Date.now) {
  let revision = 0;
  let current = snapshotFromComputerSection(revision, { active: false, observeOnly: false, controller: null, sessionThreadId: null, sessions: [] }, now());
  const listeners = new Set<(snapshot: ComputerUseSnapshot) => void>();
  return {
    snapshot: (): ComputerUseSnapshot => current,
    subscribe(listener: (snapshot: ComputerUseSnapshot) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** A `computer/updated` section value (full snapshot, not a delta). */
    apply(section: ComputerSectionValue): void {
      revision += 1;
      current = snapshotFromComputerSection(revision, section, now());
      for (const listener of [...listeners]) listener(current);
    },
  };
}

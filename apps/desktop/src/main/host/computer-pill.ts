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
  cleanupState?: 'pending' | 'failed' | 'ready';
}

export function snapshotFromComputerSection(
  revision: number,
  section: ComputerSectionValue,
  now: number
): ComputerUseSnapshot {
  const sessionId = section.active ? section.sessionThreadId : null;
  return {
    revision,
    userControlActive: false,
    // Carried as the coordinator's snapshot carries it; a section without a
    // latch is settled, as an idle coordinator is ('ready').
    cleanupState: section.cleanupState ?? 'ready',
    activities: sessionId
      ? [
          {
            sessionId,
            action: section.observeOnly ? 'observe' : 'control',
            target: '',
            mode: 'background',
            phase: 'active_background',
            startedAt: now,
            updatedAt: now,
          },
        ]
      : [],
    cursors: [],
    presentSessionIds: sessionId ? [sessionId] : [],
    targetLeases: [],
  };
}

export function createComputerPillSource(now: () => number = Date.now) {
  let revision = 0;
  let current = snapshotFromComputerSection(revision, { active: false, observeOnly: false, controller: null, sessionThreadId: null }, now());
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

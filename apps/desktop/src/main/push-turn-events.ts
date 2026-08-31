// Decides WHEN a phone deserves a notification, from the session roster the
// relay already receives. Kept free of IO and timers so the rules below are
// testable on their own; push-notifier.ts owns delivery.
import type { DesktopSessionSummary } from '../shared/contract';

export interface TurnCompletion {
  sessionId: string;
  /** Notification title — the session's own name. */
  title: string;
  /** Notification body — the roster preview, which is the last message. */
  preview: string;
  at: number;
}

export interface TurnCompletionTracker {
  /** Feeds one roster push; returns the turns that just finished. */
  observe(sessions: readonly DesktopSessionSummary[], nowMs: number): TurnCompletion[];
  /** Still idle? Delivery waits out a quiet period and re-asks, so a turn that
   *  resumed immediately never produces a notification. */
  isIdle(sessionId: string): boolean;
  forget(sessionId: string): void;
}

/** One notification per session per minute at most. A roster can report the
 *  same completion again after an unrelated field changes, and an agent that
 *  stops and restarts repeatedly must not turn into a buzzing phone. */
const REPEAT_SUPPRESSION_MS = 60_000;
const MAX_TITLE_CHARS = 80;
const MAX_PREVIEW_CHARS = 160;

function clip(value: unknown, limit: number): string {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

function isWorking(session: DesktopSessionSummary): boolean {
  return Boolean(session.working || session.leadWorking || session.agentWorking);
}

export function createTurnCompletionTracker(): TurnCompletionTracker {
  const working = new Map<string, boolean>();
  const lastNotifiedAt = new Map<string, number>();
  // The first roster is a BASELINE, never a batch of notifications: a desktop
  // that just started up (or a relay that just reconnected) would otherwise
  // announce every session that happens to be idle right now.
  let seeded = false;
  return {
    observe(sessions, nowMs) {
      const completions: TurnCompletion[] = [];
      const present = new Set<string>();
      for (const session of sessions) {
        const id = String(session?.id || '');
        if (!id) continue;
        present.add(id);
        const busy = isWorking(session);
        const wasBusy = working.get(id) === true;
        working.set(id, busy);
        if (!seeded || !wasBusy || busy) continue;
        // Archived sessions are hidden from the app; a notification would point
        // at something the user cannot see without restoring it first.
        if (session.archived) continue;
        // "Never announced" is not "announced at time zero": a missing entry
        // must pass, or the very first completion of a session is swallowed.
        const previous = lastNotifiedAt.get(id);
        if (previous !== undefined && nowMs - previous < REPEAT_SUPPRESSION_MS) continue;
        lastNotifiedAt.set(id, nowMs);
        completions.push({
          sessionId: id,
          title: clip(session.title || session.preview || 'Mixdog', MAX_TITLE_CHARS) || 'Mixdog',
          preview: clip(session.preview, MAX_PREVIEW_CHARS),
          at: nowMs,
        });
      }
      for (const id of [...working.keys()]) {
        if (present.has(id)) continue;
        working.delete(id);
        lastNotifiedAt.delete(id);
      }
      seeded = true;
      return completions;
    },
    isIdle(sessionId) {
      return working.get(sessionId) === false;
    },
    forget(sessionId) {
      working.delete(sessionId);
      lastNotifiedAt.delete(sessionId);
    },
  };
}

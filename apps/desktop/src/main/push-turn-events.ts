// Decides WHEN a phone deserves a notification, from the session roster the
// relay already receives. Kept free of IO and timers so the rules below are
// testable on their own; push-notifier.ts owns delivery.
import type { DesktopAgentPoolRow, DesktopSessionSummary } from '../shared/contract';
import { isActiveDesktopAgentEntry, isCancelUnconfirmedDesktopAgentEntry } from '../shared/agent-activity';

export interface TurnCompletion {
  sessionId: string;
  sourceType?: DesktopSessionSummary['sourceType'];
  /** Notification title — the session's own name. */
  title: string;
  /** Filled from the completed turn's assistant answer by the watcher. */
  preview: string;
  startedAt: number;
  at: number;
  /** The Lead's OWN turn ended in this roster push. False when the session
   *  went idle because its background agents or shell jobs settled: the Lead
   *  may take their results into a new turn at once. */
  leadFinished: boolean;
}

interface TurnCompletionTracker {
  /** Feeds one roster push; returns the turns that just finished.
   *  `pendingWork` names sessions whose Lead stopped only to wait for its own
   *  background shell jobs or child agents — that is not the final answer. */
  observe(
    sessions: readonly DesktopSessionSummary[],
    nowMs: number,
    pendingWork?: ReadonlySet<string>
  ): TurnCompletion[];
  /** Still idle? Delivery waits out a quiet period and re-asks, so a turn that
   *  resumed immediately never produces a notification. */
  isIdle(sessionId: string): boolean;
}

const MAX_TITLE_CHARS = 80;

/** Delivery settings are checked by the watcher. Only schedules bypass the
 *  foreground suppression used for ordinary conversations. */
export function shouldShowTurnNotification(completion: TurnCompletion, foreground: boolean): boolean {
  return completion.sourceType === 'schedule' || !foreground;
}

function clip(value: unknown, limit: number): string {
  const text = String(value ?? '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

function isWorking(session: DesktopSessionSummary): boolean {
  return Boolean(session.working || session.leadWorking || session.agentWorking);
}

/** Lead sessions still waiting on agent work they started: a running or queued
 *  child agent, or a cancel not yet proven. Background shell jobs never hold a
 *  finished turn (a dev server may run for hours). The Lead's OWN row is
 *  skipped — its turn state comes from the roster, and a stale `running` on
 *  that row must not hold a finished turn. */
export function sessionsWithPendingWork(agents: readonly DesktopAgentPoolRow[]): Set<string> {
  const pending = new Set<string>();
  for (const agent of agents) {
    const sessionId = String(agent?.sessionId || '');
    const ownerSessionId = String(agent?.ownerSessionId || '') || sessionId;
    if (!ownerSessionId || sessionId === ownerSessionId) continue;
    if (isActiveDesktopAgentEntry(agent) || isCancelUnconfirmedDesktopAgentEntry(agent)) pending.add(ownerSessionId);
  }
  return pending;
}

export function createTurnCompletionTracker(): TurnCompletionTracker {
  const working = new Map<string, boolean>();
  const leadWorking = new Map<string, boolean>();
  const started = new Map<string, number>();
  // The first roster is a BASELINE, never a batch of notifications: a desktop
  // that just started up (or a relay that just reconnected) would otherwise
  // announce every session that happens to be idle right now.
  let seeded = false;
  return {
    observe(sessions, nowMs, pendingWork) {
      const completions: TurnCompletion[] = [];
      const present = new Set<string>();
      for (const session of sessions) {
        const id = String(session?.id || '');
        if (!id) continue;
        present.add(id);
        const busy = isWorking(session) || pendingWork?.has(id) === true;
        const wasBusy = working.get(id) === true;
        const leadBusy = session.leadWorking ?? session.working ?? false;
        const leadWasBusy = leadWorking.get(id) === true;
        if ((leadBusy && !leadWasBusy) || (busy && !started.has(id))) started.set(id, nowMs);
        leadWorking.set(id, leadBusy);
        working.set(id, busy);
        if (!seeded || !wasBusy || busy) continue;
        // Archived sessions are hidden from the app; a notification would point
        // at something the user cannot see without restoring it first.
        if (session.archived) continue;
        completions.push({
          sessionId: id,
          sourceType: session.sourceType,
          title: clip(session.title || session.preview || 'Mixdog', MAX_TITLE_CHARS) || 'Mixdog',
          preview: '',
          startedAt: started.get(id) ?? nowMs,
          at: nowMs,
          leadFinished: leadWasBusy,
        });
      }
      for (const id of working.keys()) {
        if (present.has(id)) continue;
        working.delete(id);
        leadWorking.delete(id);
        started.delete(id);
      }
      seeded = true;
      return completions;
    },
    isIdle(sessionId) {
      return working.get(sessionId) === false;
    },
  };
}

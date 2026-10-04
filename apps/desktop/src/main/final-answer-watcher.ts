// Decides when a Lead session has given its FINAL answer: its turn stopped, no
// child agent it started is still running, and it stayed that way
// through a short quiet period. The phone's Web Push and the desktop's own OS
// notification both deliver from here, so the two never disagree.
import { createTurnCompletionTracker, sessionsWithPendingWork, type TurnCompletion } from './push-turn-events';
import type { DesktopAgentPoolRow, DesktopSessionSummary } from '../shared/contract';
import type { SessionFinalAnswer } from './session-final-answer';
import { notificationPreview } from './notification-preview';

export interface FinalAnswerWatcher {
  onSessions(sessions: readonly DesktopSessionSummary[]): void;
  /** Child agents: a Lead waiting on them has not answered yet. */
  onAgentPool(agents: readonly DesktopAgentPoolRow[]): void;
  dispose(): void;
}

interface FinalAnswerWatcherOptions {
  /** Checked when the quiet period ends, so turning delivery off mid-wait wins. */
  isEnabled(): boolean;
  readFinalAnswer(sessionId: string, startedAt: number): Promise<SessionFinalAnswer | null>;
  onFinalAnswer(completion: TurnCompletion): void;
  onError?(detail: string): void;
  onDiagnostic?(event: string, details: Record<string, unknown>): void;
}

/** Background agents settling can be followed at once by a new
 *  Lead turn that takes their results; waiting this long and re-checking keeps
 *  that hand-off quiet. */
const STABILIZE_MS = 2_500;
/** A Lead that finished its own turn is confirmed by the turn's recorded
 *  answer (session-final-answer.ts), not by waiting: a mid-turn flicker has no
 *  answer newer than the turn's start and simply keeps polling. The short
 *  delay lets the transcript projection land; the full quiet period made every
 *  notification ~3 s late (user: 알림이 좀 늦어 보이는데). */
const LEAD_FINISHED_MS = 300;
const ANSWER_POLL_MS = 500;

export function createFinalAnswerWatcher(options: FinalAnswerWatcherOptions): FinalAnswerWatcher {
  const tracker = createTurnCompletionTracker();
  type Pending = { completion: TurnCompletion; timer?: NodeJS.Timeout; waitingReported?: boolean };
  const pending = new Map<string, Pending>();
  let disposed = false;
  let lastSessions: readonly DesktopSessionSummary[] = [];
  let pendingWork: ReadonlySet<string> = new Set();

  const cancel = (sessionId: string): void => {
    const entry = pending.get(sessionId);
    if (entry?.timer) clearTimeout(entry.timer);
    pending.delete(sessionId);
  };
  const current = (entry: Pending): boolean =>
    !disposed &&
    options.isEnabled() &&
    pending.get(entry.completion.sessionId) === entry &&
    tracker.isIdle(entry.completion.sessionId);

  const schedule = (entry: Pending, delayMs: number): void => {
    entry.timer = setTimeout(() => {
      void deliver(entry);
    }, delayMs);
    entry.timer.unref?.();
  };
  const retryDelay = (entry: Pending): number => (entry.completion.leadFinished ? ANSWER_POLL_MS : STABILIZE_MS);
  const deliver = async (entry: Pending): Promise<void> => {
    const { completion } = entry;
    if (!current(entry)) {
      if (pending.get(completion.sessionId) === entry) cancel(completion.sessionId);
      return;
    }
    let answer: SessionFinalAnswer | null;
    try {
      answer = await options.readFinalAnswer(completion.sessionId, completion.startedAt);
    } catch (error) {
      options.onError?.(error instanceof Error ? error.message : String(error));
      if (current(entry)) schedule(entry, STABILIZE_MS);
      return;
    }
    // The answer read may cross a new turn, an archive, settings change or
    // disposal. Idleness alone cannot identify the turn that was requested.
    if (!current(entry)) return;
    if (!answer || answer.at < completion.startedAt || (answer.status === 'done' && !answer.text.trim())) {
      if (!entry.waitingReported) {
        options.onDiagnostic?.('waiting-answer', { sessionId: completion.sessionId });
        entry.waitingReported = true;
      }
      schedule(entry, retryDelay(entry));
      return;
    }
    cancel(completion.sessionId);
    if (answer.status !== 'done') {
      options.onDiagnostic?.('suppressed', { sessionId: completion.sessionId, reason: answer.status });
      return;
    }
    options.onFinalAnswer({
      ...completion,
      preview: notificationPreview(answer.text),
    });
  };

  const observe = (): void => {
    // The roster is observed even while delivery is off, so enabling it
    // mid-session starts from a correct baseline instead of firing on the
    // first turn that merely LOOKS finished.
    const completions = tracker.observe(lastSessions, Date.now(), pendingWork);
    for (const id of pending.keys()) {
      if (
        !options.isEnabled() ||
        !tracker.isIdle(id) ||
        !lastSessions.some((session) => session.id === id && !session.archived)
      ) {
        options.onDiagnostic?.('cancelled', { sessionId: id, reason: 'state-changed' });
        cancel(id);
      }
    }
    if (disposed) return;
    for (const completion of completions) {
      if (!options.isEnabled()) {
        options.onDiagnostic?.('suppressed', { sessionId: completion.sessionId, reason: 'disabled' });
        continue;
      }
      cancel(completion.sessionId);
      options.onDiagnostic?.('detected', { sessionId: completion.sessionId });
      const entry = { completion };
      pending.set(completion.sessionId, entry);
      schedule(entry, completion.leadFinished ? LEAD_FINISHED_MS : STABILIZE_MS);
    }
  };

  return {
    onSessions(sessions) {
      if (disposed) return;
      lastSessions = sessions;
      observe();
    },
    onAgentPool(agents) {
      if (disposed) return;
      // Background work settling with no new Lead turn means the answer the
      // Lead already gave was the final one.
      pendingWork = sessionsWithPendingWork(agents);
      observe();
    },
    dispose() {
      disposed = true;
      for (const id of pending.keys()) cancel(id);
    },
  };
}

// Decides when a Lead session has given its FINAL answer: its turn stopped, no
// child agent it started is still running, and it stayed that way
// through a short quiet period. The phone's Web Push and the desktop's own OS
// notification both deliver from here, so the two never disagree.
import { createTurnCompletionTracker, sessionsWithPendingWork, type TurnCompletion } from './push-turn-events';
import type { DesktopAgentPoolRow, DesktopSessionSummary } from '../shared/contract';
import { isSessionMissingError, type SessionFinalAnswer } from './session-final-answer';
import { notificationPreview } from './notification-preview';
import { isRoutineQuietReply } from '../../../../src/runtime/shared/routine-trigger.mjs';

export interface FinalAnswerWatcher {
  onSessions(sessions: readonly DesktopSessionSummary[]): void;
  /** Child agents: a Lead waiting on them has not answered yet. */
  onAgentPool(agents: readonly DesktopAgentPoolRow[]): void;
  dispose(): void;
}

interface FinalAnswerWatcherOptions {
  /** Checked when the quiet period ends, so turning delivery off mid-wait wins. */
  isEnabled(): boolean;
  /** `signal` aborts when the read overruns its deadline; the read must stop. */
  readFinalAnswer(sessionId: string, startedAt: number, signal?: AbortSignal): Promise<SessionFinalAnswer | null>;
  /** 'undecided': delivery could not be decided (its preferences were
   *  unreadable). The completion is held and offered again on each roster or
   *  agent-pool event until it is decided or the session leaves that idle state. */
  onFinalAnswer(completion: TurnCompletion): 'undecided' | void;
  /** A bot's display name (rename included) for its home chat; '' when unknown. */
  agentName?(agentId: string): Promise<string>;
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
/** A failed answer read is retried after STABILIZE_MS, doubling up to this
 *  cap, and abandoned after READ_FAILURE_LIMIT consecutive failures: a read
 *  that keeps failing must not be re-issued for as long as the row lives. */
const READ_RETRY_MAX_MS = 60_000;
const READ_FAILURE_LIMIT = 6;

/** One answer read gets this long before it is aborted and counted as a
 *  transient failure, so a read that never settles cannot hold the single
 *  read slot (and with it every notification) forever. */
const READ_DEADLINE_MS = 30_000;

class FinalAnswerReadTimeoutError extends Error {
  constructor() {
    super(`final answer read timed out after ${READ_DEADLINE_MS} ms`);
    this.name = 'FinalAnswerReadTimeoutError';
  }
}

export function createFinalAnswerWatcher(options: FinalAnswerWatcherOptions): FinalAnswerWatcher {
  const tracker = createTurnCompletionTracker();
  type Pending = {
    completion: TurnCompletion;
    timer?: NodeJS.Timeout;
    waitingReported?: boolean;
    failures?: number;
  };
  const pending = new Map<string, Pending>();
  const held = new Map<string, TurnCompletion>();
  let disposed = false;
  let lastSessions: readonly DesktopSessionSummary[] = [];
  let pendingWork: ReadonlySet<string> = new Set();
  // At most one answer read in flight per watcher: a burst of completions
  // (or a slow host) queues behind it instead of piling reads onto the host.
  let readInFlight: Promise<void> | null = null;
  const readExclusive = (sessionId: string, startedAt: number): Promise<SessionFinalAnswer | null> => {
    const controller = new AbortController();
    let deadline: NodeJS.Timeout | undefined;
    const read = new Promise<SessionFinalAnswer | null>((resolve, reject) => {
      // Abort stops the underlying read; rejecting here as well frees the
      // slot even when that read ignores the signal.
      deadline = setTimeout(() => {
        const timeout = new FinalAnswerReadTimeoutError();
        controller.abort(timeout);
        reject(timeout);
      }, READ_DEADLINE_MS);
      deadline.unref?.();
      options.readFinalAnswer(sessionId, startedAt, controller.signal).then(
        (answer) => {
          clearTimeout(deadline);
          resolve(answer);
        },
        (error) => {
          clearTimeout(deadline);
          reject(error);
        }
      );
    });
    const freeSlot = (): void => {
      if (readInFlight === gate) readInFlight = null;
    };
    const gate: Promise<void> = read.then(freeSlot, freeSlot);
    readInFlight = gate;
    return read;
  };

  const cancel = (sessionId: string): void => {
    const entry = pending.get(sessionId);
    if (entry?.timer) clearTimeout(entry.timer);
    pending.delete(sessionId);
    held.delete(sessionId);
  };
  const offer = (completion: TurnCompletion): void => {
    if (options.onFinalAnswer(completion) === 'undecided') held.set(completion.sessionId, completion);
    else held.delete(completion.sessionId);
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
    // Wait for the read slot; the entry may go stale meanwhile.
    while (readInFlight && current(entry)) await readInFlight;
    if (!current(entry)) {
      if (pending.get(completion.sessionId) === entry) cancel(completion.sessionId);
      return;
    }
    let answer: SessionFinalAnswer | null;
    try {
      answer = await readExclusive(completion.sessionId, completion.startedAt);
    } catch (error) {
      if (isSessionMissingError(error)) {
        // Terminal: the record is gone, so no retry can ever succeed.
        if (pending.get(completion.sessionId) === entry) {
          options.onDiagnostic?.('cancelled', { sessionId: completion.sessionId, reason: 'session-missing' });
          cancel(completion.sessionId);
        }
        return;
      }
      options.onError?.(error instanceof Error ? error.message : String(error));
      if (!current(entry)) return;
      entry.failures = (entry.failures ?? 0) + 1;
      if (entry.failures >= READ_FAILURE_LIMIT) {
        options.onDiagnostic?.('cancelled', { sessionId: completion.sessionId, reason: 'read-failed' });
        cancel(completion.sessionId);
        return;
      }
      schedule(entry, Math.min(STABILIZE_MS * 2 ** (entry.failures - 1), READ_RETRY_MAX_MS));
      return;
    }
    entry.failures = 0;
    // The answer read may cross a new turn, an archive, settings change or
    // disposal. Idleness alone cannot identify the turn that was requested.
    if (!current(entry)) return;
    // A turn answered by a reaction alone raises no notification.
    if (answer?.reacted === true && answer.at >= completion.startedAt) {
      cancel(completion.sessionId);
      options.onDiagnostic?.('suppressed', { sessionId: completion.sessionId, reason: 'reaction' });
      return;
    }
    if (!answer || answer.at < completion.startedAt || (answer.status === 'done' && !answer.text.trim())) {
      if (!entry.waitingReported) {
        options.onDiagnostic?.('waiting-answer', { sessionId: completion.sessionId });
        entry.waitingReported = true;
      }
      schedule(entry, retryDelay(entry));
      return;
    }
    cancel(completion.sessionId);
    // A turn the user cancelled is no news; one that failed is an error
    // notification, its body worded by each channel.
    if (answer.status === 'cancelled') {
      options.onDiagnostic?.('suppressed', { sessionId: completion.sessionId, reason: answer.status });
      return;
    }
    if (answer.status === 'done' && isRoutineQuietReply(answer.text)) {
      options.onDiagnostic?.('suppressed', { sessionId: completion.sessionId, reason: 'routine-quiet' });
      return;
    }
    const botName = completion.agentHome ? await options.agentName?.(completion.agentHome).catch(() => '') : '';
    offer({
      ...completion,
      ...(botName ? { title: botName } : {}),
      event: answer.status === 'failed' ? 'error' : 'finished',
      preview: answer.status === 'failed' ? '' : notificationPreview(answer.text),
    });
  };

  const observe = (): void => {
    // The roster is observed even while delivery is off, so enabling it
    // mid-session starts from a correct baseline instead of firing on the
    // first turn that merely LOOKS finished.
    const completions = tracker.observe(lastSessions, Date.now(), pendingWork);
    for (const id of [...pending.keys(), ...held.keys()]) {
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
    // This event is the next chance to decide what could not be decided.
    for (const completion of [...held.values()]) offer(completion);
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
      for (const id of [...pending.keys(), ...held.keys()]) cancel(id);
    },
  };
}

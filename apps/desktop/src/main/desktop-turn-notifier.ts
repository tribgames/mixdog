import type { Notification } from 'electron';
import type { DesktopSessionStateUpdate, DesktopSessionSummary } from '../shared/contract';
import type { NotificationEvent } from '../shared/contract-notifications';
import { createFinalAnswerWatcher } from './final-answer-watcher';
import {
  decideNotification,
  type NotificationConversation,
  notificationConversationOf,
  type NotificationPreferencesView,
} from './notification-decision';
import { notificationTitleOf, type TurnCompletion } from './push-turn-events';
import type { SessionFinalAnswer } from './session-final-answer';
import { type SessionTitleLabels, sessionTitleLabel } from '../shared/session-title.mjs';

type NativeNotification = Pick<Notification, 'on' | 'show' | 'close'>;

/** The body of an error notification when the PC gives no words of its own. */
export const TURN_FAILED_TEXT = 'The turn stopped with an error.';

/** What a session waits on: a tool approval, or an ask_user question. */
export type SessionWait = 'approval' | 'question';

/** A wait notification's words when the PC gives none of its own. */
const WAITING_TEXT: Readonly<Record<SessionWait, string>> = {
  approval: 'Waiting for your approval.',
  question: 'Waiting for your answer.',
};

interface DesktopTurnNotifierOptions {
  /** This PC's notification preferences and the conversation overrides,
   *  read at each delivery (notification-preferences.ts). */
  preferences(): NotificationPreferencesView;
  isSupported(): boolean;
  /** The focused, visible window is showing this very session. */
  isSessionOnScreen(sessionId: string): boolean;
  readFinalAnswer(sessionId: string, startedAt: number, signal?: AbortSignal): Promise<SessionFinalAnswer | null>;
  createNotification(content: { title: string; body: string }): NativeNotification;
  playSound?(): Promise<string>;
  openSession(sessionId: string): void;
  diagnostic(event: string, details: Record<string, unknown>): void;
  /** The body of an error notification in this PC's language; English when absent. */
  turnFailedText?(): string;
  /** This PC's words for an attachment-only session title (`[Image]` …);
   *  English when absent. */
  titleLabels?(): SessionTitleLabels;
  /** A bot's display name for its home chat's notification title. */
  agentName?(agentId: string): Promise<string>;
  /** "{name} · …" of a wait notification in this PC's language; English when absent. */
  waitingText?(wait: SessionWait): string;
}

/** Completion detection and native delivery share one app-lifetime owner.
 * A native "show" event means OS acceptance, NOT proof that a banner was
 * visible. Keep that distinction in diagnostics and in the live probe. */
export function createDesktopTurnNotifier(options: DesktopTurnNotifierOptions) {
  const live = new Set<NativeNotification>();
  let disposed = false;
  const report = (event: string, sessionId: string, details: Record<string, unknown> = {}) =>
    options.diagnostic(event, { sessionId, ...details });

  /** This PC's preferences, mutes, quiet hours and what is on screen decide;
   *  a refusal is reported with its reason. */
  const allowed = (
    sessionId: string,
    event: NotificationEvent,
    conversation: NotificationConversation,
    details: Record<string, unknown> = {}
  ): boolean => {
    if (!options.isSupported()) {
      report('suppressed', sessionId, { ...details, reason: 'unsupported' });
      return false;
    }
    const decision = decideNotification({
      ...options.preferences(),
      event,
      conversation,
      now: Date.now(),
      foreground: options.isSessionOnScreen(sessionId),
    });
    if (decision.notify) return true;
    report('suppressed', sessionId, {
      ...details,
      reason: decision.reason === 'foreground' ? 'foreground-visible' : decision.reason,
    });
    return false;
  };

  /** One native notification; a click opens `sessionId`. */
  const present = (
    sessionId: string,
    content: { title: string; body: string },
    details: Record<string, unknown> = {}
  ): void => {
    let notification: NativeNotification | undefined;
    try {
      notification = options.createNotification(content);
      const current = notification;
      const release = () => {
        live.delete(current);
      };
      live.add(current);
      let soundStarted = false;
      current.on('show', () => {
        report('os-show', sessionId, details);
        if (soundStarted || !options.playSound) return;
        soundStarted = true;
        void options
          .playSound()
          .then((result) => report('sound', sessionId, { ...details, result }))
          .catch((error: unknown) =>
            report('sound-failed', sessionId, {
              ...details,
              error: error instanceof Error ? error.message : String(error),
            })
          );
      });
      current.on('close', () => {
        release();
        report('closed', sessionId, details);
      });
      current.on('failed', (_event, error) => {
        release();
        report('failed', sessionId, { ...details, error });
      });
      current.on('click', () => {
        release();
        report('clicked', sessionId, details);
        options.openSession(sessionId);
      });
      report('requested', sessionId, details);
      current.show();
    } catch (error) {
      if (notification) live.delete(notification);
      report('failed', sessionId, { ...details, error: error instanceof Error ? error.message : String(error) });
    }
  };

  const deliver = (completion: TurnCompletion): void => {
    const failed = completion.event === 'error';
    if (!allowed(completion.sessionId, failed ? 'error' : 'finished', completion.conversation)) return;
    present(completion.sessionId, {
      title: sessionTitleLabel(completion.title, options.titleLabels?.()),
      body: failed ? options.turnFailedText?.() || TURN_FAILED_TEXT : completion.preview,
    });
  };

  // Waits: a session that STARTS waiting on a tool approval or a question
  // needs the user. One notification per approval: the copies a hand-off or a
  // sub-agent docks in other chats carry its id and are not told again.
  // Browser Use approvals are no tool approvals (main/browser/approval-dialog.ts
  // tells those itself), so neither path repeats the other.
  const rows = new Map<string, DesktopSessionSummary>();
  const waits = new Map<string, string>();
  const told = new Set<string>();
  const waitName = async (sessionId: string): Promise<string> => {
    const row = rows.get(sessionId);
    const bot = row?.agentHome ? await options.agentName?.(row.agentHome).catch(() => '') : '';
    return bot || sessionTitleLabel(notificationTitleOf(row ?? { title: '' }), options.titleLabels?.());
  };
  const onSessionState = (update: DesktopSessionStateUpdate): void => {
    const sessionId = String(update?.sessionId || '');
    if (!sessionId || disposed) return;
    const approval = (
      update.snapshot as { toolApproval?: { id?: unknown; kind?: unknown; surfaceSessionId?: unknown } | null } | null
    )?.toolApproval;
    const key = approval ? String(approval.id ?? 'pending') : '';
    const previous = waits.get(sessionId) ?? '';
    if (key) waits.set(sessionId, key);
    else waits.delete(sessionId);
    // An approval no session shows any more is done with; its id is forgotten.
    if (previous && previous !== key && ![...waits.values()].includes(previous)) told.delete(previous);
    if (!key || key === previous || update.frameSource === 'replay' || told.has(key)) return;
    told.add(key);
    const wait: SessionWait = approval?.kind === 'question' ? 'question' : 'approval';
    // A sub-agent's request is answered in the top-level chat it shows in.
    const target = String(approval?.surfaceSessionId || '') || sessionId;
    const conversation = notificationConversationOf(rows.get(target) ?? { id: target });
    if (!allowed(target, wait, conversation, { wait })) return;
    void waitName(target).then((name) => {
      // Answered while the bot's name was read: nothing to tell.
      if (disposed || waits.get(sessionId) !== key) return;
      present(target, { title: `${name} · ${options.waitingText?.(wait) || WAITING_TEXT[wait]}`, body: '' }, { wait });
    });
  };

  const watcher = createFinalAnswerWatcher({
    // Whether to notify is decided at delivery, with the preferences of that moment.
    isEnabled: () => true,
    readFinalAnswer: options.readFinalAnswer,
    onFinalAnswer: deliver,
    ...(options.agentName ? { agentName: options.agentName } : {}),
    onDiagnostic: options.diagnostic,
    onError: (error) => options.diagnostic('read-failed', { error }),
  });
  return {
    onSessions(sessions: readonly DesktopSessionSummary[]) {
      rows.clear();
      for (const session of sessions) rows.set(session.id, session);
      watcher.onSessions(sessions);
    },
    onAgentPool: watcher.onAgentPool,
    /** Live per-session snapshots: a new tool approval or question is told. */
    onSessionState,
    dispose() {
      disposed = true;
      watcher.dispose();
      for (const notification of live) notification.close();
      live.clear();
    },
  };
}

// Turns finished turns into delivered notifications: the tracker decides what
// happened, the store says who wants to hear it, and web-push.ts does the
// sending. Everything here is best-effort — a phone that cannot be reached
// never affects the session that triggered it.
import { createFinalAnswerWatcher } from './final-answer-watcher';
import { shouldShowTurnNotification, type TurnCompletion } from './push-turn-events';
import type { PushSubscriptionStore } from './push-subscription-store';
import { sendWebPush } from './web-push';
import type { DesktopAgentPoolRow, DesktopSessionSummary } from '../shared/contract';
import type { SessionFinalAnswer } from './session-final-answer';

interface PushNotifier {
  onSessions(sessions: readonly DesktopSessionSummary[]): void;
  /** Child agents and shell jobs: a Lead waiting on them has not answered yet. */
  onAgentPool(agents: readonly DesktopAgentPoolRow[]): void;
  /** A browser lost its access: drop its endpoint with the credential. */
  forgetClient(clientId: string): void;
  dispose(): void;
}

interface PushNotifierOptions {
  store: PushSubscriptionStore;
  /** Off by default; the user opts in per browser from Settings. */
  isEnabled(): boolean;
  readFinalAnswer(sessionId: string, startedAt: number): Promise<SessionFinalAnswer | null>;
  /** Foreground browsers suppress ordinary replies, but not scheduled ones.
   *  Takes the browser id the subscription was registered with. */
  isClientForeground(browserId: string): boolean;
  fetchImpl?: typeof fetch;
  onError?(detail: string): void;
  /** Every decision on the way to a phone, so a missing notification can be
   *  traced to detection, suppression or the push service's answer. */
  onDiagnostic?(event: string, details: Record<string, unknown>): void;
}

/** RFC 8292 wants a contactable sender. A mailto the push service can reach
 *  is the convention; it identifies the software, not the user. */
const VAPID_SUBJECT = 'mailto:push@mixdog.app';

export function createPushNotifier(options: PushNotifierOptions): PushNotifier {
  const deliver = async (completion: TurnCompletion): Promise<void> => {
    const [keys, subscriptions] = await Promise.all([options.store.keys(), options.store.list()]);
    if (subscriptions.length === 0) {
      options.onDiagnostic?.('suppressed', { sessionId: completion.sessionId, reason: 'no-subscription' });
      return;
    }
    const payload = JSON.stringify({
      title: completion.title,
      // The session's own last words travel as they are; the sentence used
      // when there are none does NOT come from here. This process has no UI
      // language, and the phone showing the notification has one of its own,
      // so an empty body is the worker's cue to say it in that language.
      body: completion.preview || '',
      data: { sessionId: completion.sessionId, reason: 'turn-finished' },
    });
    await Promise.allSettled(
      subscriptions.map(async (subscription) => {
        const foreground = Boolean(subscription.clientId && options.isClientForeground(subscription.clientId));
        const target = { sessionId: completion.sessionId, browser: subscription.clientId.slice(0, 8) };
        if (!shouldShowTurnNotification(completion, foreground)) {
          options.onDiagnostic?.('suppressed', { ...target, reason: 'foreground' });
          return;
        }
        const result = await sendWebPush({
          subscription,
          payload,
          keys,
          subject: VAPID_SUBJECT,
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        });
        if (result.expired) {
          options.onDiagnostic?.('expired', { ...target, status: result.statusCode });
          await options.store.remove(subscription.endpoint).catch(() => false);
          return;
        }
        if (result.statusCode >= 400 || result.error) {
          options.onError?.(`push ${result.statusCode}${result.error ? `: ${result.error}` : ''}`);
          return;
        }
        options.onDiagnostic?.('sent', { ...target, status: result.statusCode });
      })
    );
  };

  const watcher = createFinalAnswerWatcher({
    isEnabled: options.isEnabled,
    readFinalAnswer: options.readFinalAnswer,
    onError: options.onError,
    onDiagnostic: options.onDiagnostic,
    onFinalAnswer: (completion) => {
      void deliver(completion).catch((error: unknown) => {
        options.onError?.(error instanceof Error ? error.message : String(error));
      });
    },
  });

  return {
    onSessions: watcher.onSessions,
    onAgentPool: watcher.onAgentPool,
    forgetClient(clientId) {
      void options.store.removeByClient(clientId).catch(() => false);
    },
    dispose: watcher.dispose,
  };
}

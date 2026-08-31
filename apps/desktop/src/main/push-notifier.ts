// Turns finished turns into delivered notifications: the tracker decides what
// happened, the store says who wants to hear it, and web-push.ts does the
// sending. Everything here is best-effort — a phone that cannot be reached
// never affects the session that triggered it.
import { createTurnCompletionTracker, type TurnCompletion } from './push-turn-events';
import type { PushSubscriptionStore } from './push-subscription-store';
import { sendWebPush } from './web-push';
import type { DesktopSessionSummary } from '../shared/contract';

export interface PushNotifier {
  onSessions(sessions: readonly DesktopSessionSummary[]): void;
  /** A browser lost its access: drop its endpoint with the credential. */
  forgetClient(clientId: string): void;
  dispose(): void;
}

export interface PushNotifierOptions {
  store: PushSubscriptionStore;
  /** Off by default; the user opts in per browser from Settings. */
  isEnabled(): boolean;
  /** A browser holding the app open is already showing the result. */
  isClientConnected(clientId: string): boolean;
  fetchImpl?: typeof fetch;
  onError?(detail: string): void;
}

/** A turn frequently reports done a moment before the next tool call restarts
 *  it. Waiting this long and re-checking keeps a working agent quiet, at the
 *  cost of a notification arriving a beat later than the desktop's own flash. */
const STABILIZE_MS = 2_500;
/** RFC 8292 wants a contactable sender. A mailto the push service can reach
 *  is the convention; it identifies the software, not the user. */
const VAPID_SUBJECT = 'mailto:push@mixdog.app';

export function createPushNotifier(options: PushNotifierOptions): PushNotifier {
  const tracker = createTurnCompletionTracker();
  const pending = new Set<NodeJS.Timeout>();
  let disposed = false;

  const deliver = async (completion: TurnCompletion): Promise<void> => {
    const [keys, subscriptions] = await Promise.all([
      options.store.keys(),
      options.store.list(),
    ]);
    if (subscriptions.length === 0) return;
    const payload = JSON.stringify({
      title: completion.title,
      // The session's own last words travel as they are; the sentence used
      // when there are none does NOT come from here. This process has no UI
      // language, and the phone showing the notification has one of its own,
      // so an empty body is the worker's cue to say it in that language.
      body: completion.preview || '',
      data: { sessionId: completion.sessionId, reason: 'turn-finished' },
    });
    await Promise.allSettled(subscriptions.map(async (subscription) => {
      if (subscription.clientId && options.isClientConnected(subscription.clientId)) return;
      const result = await sendWebPush({
        subscription,
        payload,
        keys,
        subject: VAPID_SUBJECT,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });
      if (result.expired) {
        await options.store.remove(subscription.endpoint).catch(() => false);
        return;
      }
      if (result.statusCode >= 400 || result.error) {
        options.onError?.(`push ${result.statusCode}${result.error ? `: ${result.error}` : ''}`);
      }
    }));
  };

  const schedule = (completion: TurnCompletion): void => {
    const timer = setTimeout(() => {
      pending.delete(timer);
      if (disposed || !options.isEnabled()) return;
      // Re-asked after the quiet period: the same turn may have resumed, and
      // the desktop would otherwise announce a session that is still running.
      if (!tracker.isIdle(completion.sessionId)) return;
      void deliver(completion).catch((error: unknown) => {
        options.onError?.(error instanceof Error ? error.message : String(error));
      });
    }, STABILIZE_MS);
    timer.unref?.();
    pending.add(timer);
  };

  return {
    onSessions(sessions) {
      if (disposed) return;
      // The roster is observed even while notifications are off, so enabling
      // them mid-session starts from a correct baseline instead of firing on
      // the first turn that merely LOOKS finished.
      const completions = tracker.observe(sessions, Date.now());
      if (!options.isEnabled()) return;
      for (const completion of completions) schedule(completion);
    },
    forgetClient(clientId) {
      void options.store.removeByClient(clientId).catch(() => false);
    },
    dispose() {
      disposed = true;
      for (const timer of pending) clearTimeout(timer);
      pending.clear();
    },
  };
}

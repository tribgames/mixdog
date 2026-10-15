// Turns finished turns into delivered notifications: the tracker decides what
// happened, the store says who wants to hear it, and web-push.ts does the
// sending. Everything here is best-effort — a phone that cannot be reached
// never affects the session that triggered it.
import { createHash } from 'node:crypto';

import { createFinalAnswerWatcher } from './final-answer-watcher';
import { encryptNativePush, type NativePushContent, type NativePushReason } from '../shared/native-push-crypto';
import type { NativePushSubscription } from './native-push-store';
import { shouldShowTurnNotification, type TurnCompletion } from './push-turn-events';
import type { PushSubscriptionStore } from './push-subscription-store';
import type { RelayWebPushTarget } from './remote-relay-web-push';
import { encryptWebPushPayload, sendWebPush } from './web-push';
import type { DesktopAgentPoolRow, DesktopSessionSummary } from '../shared/contract';
import type { DesktopSessionStateUpdate } from '../shared/contract-session';
import type { SessionFinalAnswer } from './session-final-answer';

type PushReason = NativePushReason;

/** What the desktop sends the relay per native subscription — never plaintext. */
export interface NativePushMessage {
  platform: 'apns' | 'fcm';
  token: string;
  sandbox: boolean;
  mx: string;
  reason: PushReason;
  collapseKey: string;
}

interface PendingInputSnapshot {
  busy?: boolean;
  commandBusy?: boolean;
  goal?: {
    id?: unknown;
    status?: unknown;
    blocker?: unknown;
    tasks?: ReadonlyArray<{ id?: unknown; status?: unknown }>;
  } | null;
}

/** The session runtime has no ask-user tool; the way a session waits for the
 *  user is its Goal: a blocked Goal, or tasks parked `awaiting_approval` (the
 *  user's own action) once the turn has gone idle. Returns an identity for the
 *  wait, or null when nothing is waiting. */
function pendingInputKey(snapshot: PendingInputSnapshot | null | undefined): string | null {
  const goal = snapshot?.goal;
  if (!goal) return null;
  const goalId = String(goal.id ?? 'goal');
  if (goal.status === 'blocked') return `${goalId}:blocked:${String(goal.blocker ?? '')}`;
  if (goal.status !== 'active' || snapshot?.busy || snapshot?.commandBusy) return null;
  const parked = (goal.tasks ?? []).filter((task) => task?.status === 'awaiting_approval');
  if (parked.length === 0) return null;
  return `${goalId}:parked:${parked.map((task) => String(task.id ?? '')).join(',')}`;
}

interface PushNotifier {
  onSessions(sessions: readonly DesktopSessionSummary[]): void;
  /** Live per-session snapshots: a new tool approval wakes a background phone. */
  onSessionState(update: DesktopSessionStateUpdate): void;
  /** Child agents and shell jobs: a Lead waiting on them has not answered yet. */
  onAgentPool(agents: readonly DesktopAgentPoolRow[]): void;
  /** A browser lost its access: drop its endpoint with the credential. */
  forgetClient(clientId: string): void;
  dispose(): void;
}

interface PushNotifierOptions {
  store: PushSubscriptionStore;
  /** Relay device id of this PC; native payloads carry it so the phone can
   *  bind notification actions to the host that sent them. */
  hostId?: string;
  /** Off by default; the user opts in per browser from Settings. */
  isEnabled(): boolean;
  readFinalAnswer(sessionId: string, startedAt: number): Promise<SessionFinalAnswer | null>;
  /** Foreground browsers suppress ordinary replies, but not scheduled ones.
   *  Takes the browser id the subscription was registered with. */
  isClientForeground(browserId: string): boolean;
  /** Native app push (APNs/FCM) through the relay; absent when unsupported. */
  native?: {
    list(): Promise<NativePushSubscription[]>;
    /** Whether the paired client (relay credential) is watching live. */
    isClientForeground(clientId: string): boolean;
    /** Hands the encrypted envelope to the relay; false when it cannot take it. */
    send(message: NativePushMessage): boolean;
    /** An unpaired client's registration goes with its credential. */
    removeByClient(clientId: string): Promise<boolean>;
  };
  /** Relay-owned Web Push. While the relay advertises it, every browser with
   *  a relay association is reached this way; the legacy direct send (`store`)
   *  still serves each browser that has none yet, and everything on a relay
   *  that lacks it. */
  relayWebPush?: {
    available(): boolean;
    list(): Promise<RelayWebPushTarget[]>;
    /** Whether the paired client (relay credential) is watching live. */
    isClientForeground(clientId: string): boolean;
    /** Hands the encrypted body to the relay; false when it cannot take it. */
    send(target: RelayWebPushTarget, body: Buffer): boolean;
  };
  fetchImpl?: typeof fetch;
  onError?(detail: string): void;
  /** Every decision on the way to a phone, so a missing notification can be
   *  traced to detection, suppression or the push service's answer. */
  onDiagnostic?(event: string, details: Record<string, unknown>): void;
}

/** A notification must fit APNs/FCM's 4 KB payload after encryption and two
 *  base64 layers, so the preview is clipped well below that. */
const NATIVE_TITLE_CHARS = 120;
const NATIVE_BODY_CHARS = 300;

/** APNs caps apns-collapse-id at 64 bytes, so the key is a fixed-size digest. */
export function nativeCollapseKey(sessionId: string, reason: PushReason): string {
  return createHash('sha256').update(`${sessionId}\n${reason}`).digest('base64url').slice(0, 32);
}

/** RFC 8292 wants a contactable sender. A mailto the push service can reach
 *  is the convention; it identifies the software, not the user. */
const VAPID_SUBJECT = 'mailto:support@tribgames.com';

export function createPushNotifier(options: PushNotifierOptions): PushNotifier {
  const deliver = async (
    completion: TurnCompletion,
    reason: PushReason = 'turn-finished',
    showWhenForeground = false,
    approvalId?: string
  ): Promise<void> => {
    const nativeDelivery = deliverNative(completion, reason, showWhenForeground, approvalId);
    const hostId = options.hostId ? options.hostId.slice(0, 64) : '';
    // `hostId` names the PC that sent it: one browser hears from every PC it
    // is paired with, and a tap has to open the session on THAT PC.
    const payload = JSON.stringify({
      ...(hostId ? { hostId } : {}),
      sessionId: completion.sessionId,
      title: completion.title,
      // The session's own last words travel as they are; the sentence used
      // when there are none does NOT come from here. This process has no UI
      // language, and the phone showing the notification has one of its own,
      // so an empty body is the worker's cue to say it in that language.
      body: completion.preview || '',
      reason,
      data: { sessionId: completion.sessionId, reason, ...(hostId ? { hostId } : {}) },
    });
    const relayWeb = options.relayWebPush?.available() ? options.relayWebPush : null;
    const [relayTargets, stored] = await Promise.all([relayWeb ? relayWeb.list() : [], options.store.list()]);
    // Per browser, not per relay: a browser moves to the relay's key on its
    // next launch, and until then its legacy subscription (this PC's own key)
    // is the only way to reach it. It is dropped from the direct path only
    // once that same paired browser holds a relay association.
    const relayBrowsers = new Set(relayTargets.map((target) => target.clientId));
    const relayEndpoints = new Set(relayTargets.map((target) => target.endpoint));
    const subscriptions = stored.filter(
      (subscription) =>
        !relayEndpoints.has(subscription.endpoint) && !(subscription.clientId && relayBrowsers.has(subscription.clientId))
    );
    if (relayTargets.length === 0 && subscriptions.length === 0) {
      await nativeDelivery;
      options.onDiagnostic?.('suppressed', { sessionId: completion.sessionId, reason: 'no-subscription' });
      return;
    }
    const relayDelivery = relayWeb
      ? deliverRelayWeb(relayWeb, relayTargets, completion, payload, showWhenForeground)
      : Promise.resolve();
    const keys = subscriptions.length > 0 ? await options.store.keys() : null;
    await Promise.allSettled(
      subscriptions.map(async (subscription) => {
        if (!keys) return;
        const foreground = Boolean(subscription.clientId && options.isClientForeground(subscription.clientId));
        const target = { sessionId: completion.sessionId, browser: subscription.clientId.slice(0, 8) };
        if (showWhenForeground ? foreground : !shouldShowTurnNotification(completion, foreground)) {
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
    await Promise.all([relayDelivery, nativeDelivery]);
  };

  // Relay-owned Web Push: the same gates, the payload encrypted HERE for each
  // subscription (RFC 8291), the relay signing and posting the ciphertext.
  const deliverRelayWeb = async (
    relayWeb: NonNullable<PushNotifierOptions['relayWebPush']>,
    targets: readonly RelayWebPushTarget[],
    completion: TurnCompletion,
    payload: string,
    showWhenForeground: boolean
  ): Promise<void> => {
    for (const subscription of targets) {
      const foreground = relayWeb.isClientForeground(subscription.clientId);
      const target = { sessionId: completion.sessionId, browser: subscription.clientId.slice(0, 8) };
      if (showWhenForeground ? foreground : !shouldShowTurnNotification(completion, foreground)) {
        options.onDiagnostic?.('suppressed', { ...target, reason: 'foreground' });
        continue;
      }
      let body: Buffer;
      try {
        body = encryptWebPushPayload(subscription, payload);
      } catch (error) {
        options.onError?.(`push: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      const sent = relayWeb.send(subscription, body);
      options.onDiagnostic?.(sent ? 'sent' : 'suppressed', {
        ...target,
        ...(sent ? { status: 'relay' } : { reason: 'relay-unavailable' }),
      });
    }
  };

  // Native app push: the same gates as web push, but the content is encrypted
  // for each phone and handed to the relay, which only holds the credentials.
  const deliverNative = async (
    completion: TurnCompletion,
    reason: PushReason,
    showWhenForeground: boolean,
    approvalId?: string
  ): Promise<void> => {
    const native = options.native;
    if (!native) return;
    const subscriptions = await native.list();
    await Promise.allSettled(
      subscriptions.map(async (subscription) => {
        const foreground = native.isClientForeground(subscription.clientId);
        const target = { sessionId: completion.sessionId, native: subscription.clientId.slice(0, 8) };
        if (showWhenForeground ? foreground : !shouldShowTurnNotification(completion, foreground)) {
          options.onDiagnostic?.('suppressed', { ...target, reason: 'foreground' });
          return;
        }
        const content: NativePushContent = {
          title: completion.title.slice(0, NATIVE_TITLE_CHARS),
          body: (completion.preview || '').slice(0, NATIVE_BODY_CHARS),
          sessionId: completion.sessionId,
          reason,
          ...(approvalId ? { approvalId: approvalId.slice(0, 120) } : {}),
          ...(options.hostId ? { hostId: options.hostId.slice(0, 64) } : {}),
        };
        const sent = native.send({
          platform: subscription.platform,
          token: subscription.token,
          sandbox: subscription.sandbox,
          mx: encryptNativePush(subscription.publicKey, content),
          reason,
          collapseKey: nativeCollapseKey(completion.sessionId, reason),
        });
        options.onDiagnostic?.(sent ? 'sent' : 'suppressed', {
          ...target,
          ...(sent ? { status: 'native' } : { reason: 'relay-unavailable' }),
        });
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

  // Approval-pending: a session that STARTS waiting on a tool approval needs a
  // human, so a background phone is told. Foreground clients already see the
  // card. Replays (re-emitted retained state) are not new waits.
  const titles = new Map<string, string>();
  const notifiedApproval = new Map<string, string>();
  const notifiedInput = new Map<string, string>();
  const notifiedQuestion = new Map<string, string>();
  const onSessionState = (update: DesktopSessionStateUpdate): void => {
    const sessionId = String(update?.sessionId || '');
    if (!sessionId || update.frameSource === 'replay') return;
    const snapshot = update.snapshot as (PendingInputSnapshot & { toolApproval?: { id?: unknown } | null }) | null;
    const approval = snapshot?.toolApproval as { id?: unknown; kind?: unknown } | null | undefined;
    // A question has no Allow/Deny: it only opens the app.
    const isQuestion = approval?.kind === 'question';
    notifyWait(
      sessionId,
      'approval-pending',
      notifiedApproval,
      approval && !isQuestion ? String(approval.id ?? 'pending') : null
    );
    notifyWait(
      sessionId,
      'input-needed',
      notifiedQuestion,
      approval && isQuestion ? String(approval.id ?? 'pending') : null,
      '에이전트가 질문했습니다'
    );
    notifyWait(sessionId, 'input-needed', notifiedInput, pendingInputKey(snapshot));
  };
  // One push per distinct wait: the key is remembered until the wait clears.
  const notifyWait = (
    sessionId: string,
    reason: PushReason,
    seen: Map<string, string>,
    key: string | null,
    preview = ''
  ): void => {
    if (!key) {
      seen.delete(sessionId);
      return;
    }
    if (seen.get(sessionId) === key) return;
    seen.set(sessionId, key);
    if (!options.isEnabled()) {
      options.onDiagnostic?.('suppressed', { sessionId, reason: 'disabled' });
      return;
    }
    const now = Date.now();
    void deliver(
      {
        sessionId,
        title: titles.get(sessionId) || 'Mixdog',
        preview,
        startedAt: now,
        at: now,
        leadFinished: false,
      },
      reason,
      true,
      reason === 'approval-pending' ? key : undefined
    ).catch((error: unknown) => {
      options.onError?.(error instanceof Error ? error.message : String(error));
    });
  };

  return {
    onSessions(sessions) {
      titles.clear();
      for (const session of sessions) titles.set(session.id, session.title || session.preview || '');
      watcher.onSessions(sessions);
    },
    onSessionState,
    onAgentPool: watcher.onAgentPool,
    forgetClient(clientId) {
      void options.store.removeByClient(clientId).catch(() => false);
      void options.native?.removeByClient(clientId).catch(() => false);
    },
    dispose: watcher.dispose,
  };
}

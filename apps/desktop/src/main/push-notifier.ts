// Turns finished turns into delivered notifications: the tracker decides what
// happened, each paired device's preferences decide who hears it
// (notification-decision.ts), and web-push.ts does the sending. Everything
// here is best-effort — a phone that cannot be reached never affects the
// session that triggered it.
import { createHash } from 'node:crypto';

import { approvalAllowIsPointerOnly, approvalAllowOnceDecision } from '../shared/approval-enter-rule';
import { TURN_FAILED_TEXT } from './desktop-turn-notifier';
import { createFinalAnswerWatcher } from './final-answer-watcher';
import { encryptNativePush, type NativePushContent, type NativePushReason } from '../shared/native-push-crypto';
import type { NativePushSubscription } from './native-push-store';
import {
  DESKTOP_HOLD_MS,
  decideNotification,
  type NotificationConversation,
  notificationConversationOf,
} from './notification-decision';
import type { NotificationTestResult } from './notification-center';
import type { TurnCompletion } from './push-turn-events';
import type { PushSubscriptionStore } from './push-subscription-store';
import type { RelayWebPushTarget } from './remote-relay-web-push';
import { encryptWebPushPayload, sendWebPush } from './web-push';
import type { DesktopAgentPoolRow, DesktopSessionSummary, ToolApprovalDecision } from '../shared/contract';
import {
  type ConversationNotificationOverride,
  DEFAULT_NOTIFICATION_PREFERENCES,
  type NotificationDevicePreferences,
  type NotificationEvent,
} from '../shared/contract-notifications';
import type { DesktopSessionStateUpdate } from '../shared/contract-session';
import type { SessionFinalAnswer } from './session-final-answer';
import { sessionTitleLabel } from '../shared/session-title.mjs';

type PushReason = NativePushReason;

/** The reasons the relay knows. A failed turn travels to it as a finished
 *  one (same priority, no actions); only the encrypted content says failed. */
export type RelayNativePushReason = Exclude<NativePushReason, 'turn-failed'>;

/** What the desktop sends the relay per native subscription — never plaintext. */
export interface NativePushMessage {
  platform: 'apns' | 'fcm';
  token: string;
  sandbox: boolean;
  mx: string;
  reason: RelayNativePushReason;
  collapseKey: string;
}

const EVENT_OF_REASON: Record<PushReason, NotificationEvent> = {
  'turn-finished': 'finished',
  'turn-failed': 'error',
  'approval-pending': 'approval',
  'input-needed': 'question',
};

/** The words of a test notification (Settings › Notifications). */
const TEST_PUSH_TEXT = 'Notifications from this PC reach this device.';
const RELAY_UNAVAILABLE = 'The relay is not connected right now.';

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

export interface HeldRequestPush {
  /** The owning agent's home thread: a tap opens it. */
  sessionId: string;
  /** The owning agent: its conversation override applies. */
  agentId?: string;
  agentName: string;
  requestId: string;
}

/** The whole text of a held-request push. */
export function heldRequestPushText(agentName: string): string {
  return `${String(agentName || 'Mixy').slice(0, 60)}가 승인을 기다립니다`;
}

/** The approval a push is about, and whether the phone may offer Allow on it. */
interface PushApproval {
  id: string;
  allowOnce: boolean;
  /** A payment, permanent delete or Office rollback: allowed only by a click. */
  pointerOnly?: boolean;
  /** What a notification's Allow answers with: the decision the card's
   *  한 번만 허용 sends (shared/approval-enter-rule.ts). Set when `allowOnce`. */
  allowDecision?: ToolApprovalDecision;
}

interface PushNotifier {
  onSessions(sessions: readonly DesktopSessionSummary[]): void;
  /** Live per-session snapshots: a new tool approval wakes a background phone. */
  onSessionState(update: DesktopSessionStateUpdate): void;
  /** Whether a notification's Allow may answer `approvalId`: the approval the
   *  session shows now, which this PC's card allows once with a bare Enter
   *  (shared/approval-enter-rule.ts). Anything else is decided in the app. */
  approvalAllowsOnce(sessionId: string, approvalId: string): boolean;
  /** The decision a notification's Allow answers `approvalId` with: what this
   *  PC's card sends for its 한 번만 허용 (a permission's once scope...). Null
   *  wherever `approvalAllowsOnce` is false: the app opens on it instead. */
  approvalAllowDecision(sessionId: string, approvalId: string): ToolApprovalDecision | null;
  /** Whether `approvalId`, the approval the session shows now, is allowed only
   *  by a click on its card (shared/approval-enter-rule.ts). */
  approvalPointerOnly(sessionId: string, approvalId: string): boolean;
  /** Child agents and shell jobs: a Lead waiting on them has not answered yet. */
  onAgentPool(agents: readonly DesktopAgentPoolRow[]): void;
  /** A held request of an unattended run (held-request-host.mjs): pushed as
   *  "<agent>가 승인을 기다립니다" and nothing else — no tool, args or text. */
  onHeldRequest(event: HeldRequestPush): void;
  /** A browser lost its access: drop its endpoint with the credential. */
  forgetClient(clientId: string): void;
  /** One notification to a paired device through its real channel, past
   *  every preference (Settings › Notifications › test). */
  sendTest(clientId: string): Promise<NotificationTestResult>;
  dispose(): void;
}

/** Each paired device's preferences and the conversation overrides
 *  (notification-preferences.ts). */
export interface PushPreferences {
  /** The paired client's preferences; a default comes from its pairing
   *  record, never from a push registration. */
  device(clientId: string): Promise<NotificationDevicePreferences>;
  overrides(): Promise<readonly ConversationNotificationOverride[]>;
  /** This PC had OS user input within the last 3 minutes. */
  desktopActive(): Promise<boolean>;
}

interface PushNotifierOptions {
  store: PushSubscriptionStore;
  /** Relay device id of this PC; native payloads carry it so the phone can
   *  bind notification actions to the host that sent them. */
  hostId?: string;
  /** Off by default; the user opts in per browser from Settings. */
  isEnabled(): boolean;
  readFinalAnswer(sessionId: string, startedAt: number, signal?: AbortSignal): Promise<SessionFinalAnswer | null>;
  /** Whether that browser shows `sessionId` in the foreground right now: such
   *  a browser is not pushed that conversation's notifications (results of
   *  schedules and webhooks excepted). Takes the browser id the subscription
   *  was registered with. */
  isClientForeground(browserId: string, sessionId: string): boolean;
  /** Native app push (APNs/FCM) through the relay; absent when unsupported. */
  native?: {
    list(): Promise<NativePushSubscription[]>;
    /** Whether the paired client (relay credential) shows `sessionId` live. */
    isClientForeground(clientId: string, sessionId: string): boolean;
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
    /** Whether the paired client (relay credential) shows `sessionId` live. */
    isClientForeground(clientId: string, sessionId: string): boolean;
    /** Hands the encrypted body to the relay; false when it cannot take it. */
    send(target: RelayWebPushTarget, body: Buffer): boolean;
  };
  /** Absent: every device at DEFAULT_NOTIFICATION_PREFERENCES, no overrides. */
  preferences?: PushPreferences;
  /** A bot's display name for its home chat's push title. */
  agentName?(agentId: string): Promise<string>;
  /** How long a push held for an in-use PC waits; DESKTOP_HOLD_MS. */
  holdMs?: number;
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

/** Whether one device hears this notification. `target` labels the diagnostics. */
type DeliveryGate = (deviceId: string, foreground: boolean, target: Record<string, unknown>) => Promise<boolean>;

/** What one send reached: devices handed a notification, and why the rest were not. */
interface SendOutcome {
  targets: number;
  sent: number;
  failures: string[];
}

export function createPushNotifier(options: PushNotifierOptions): PushNotifier {
  // One decision per device and notification (notification-decision.ts). The
  // overrides and this PC's activity are read once per notification, and the
  // activity only when a device holds pushes while this PC is in use. A device
  // held that way joins `held`; without `held` (the second look after the
  // hold) this PC's activity is not asked again.
  const deliveryGate = (
    completion: TurnCompletion,
    event: NotificationEvent,
    held: Set<string> | null
  ): DeliveryGate => {
    let overrides: Promise<readonly ConversationNotificationOverride[]> | undefined;
    let desktopActive: Promise<boolean> | undefined;
    return async (deviceId, foreground, target) => {
      const prefs = options.preferences;
      const preferences = prefs ? await prefs.device(deviceId) : DEFAULT_NOTIFICATION_PREFERENCES;
      const decision = decideNotification({
        preferences,
        overrides: prefs ? await (overrides ??= prefs.overrides()) : [],
        event,
        conversation: completion.conversation,
        now: Date.now(),
        foreground,
        desktopActive:
          held && prefs && preferences.holdWhileDesktopActive ? await (desktopActive ??= prefs.desktopActive()) : false,
      });
      if (decision.notify) return true;
      if (decision.reason === 'desktop-active') {
        held?.add(deviceId);
        options.onDiagnostic?.('held', target);
      } else {
        options.onDiagnostic?.('suppressed', { ...target, reason: decision.reason });
      }
      return false;
    };
  };
  const passGate: DeliveryGate = async () => true;

  const holdTimers = new Set<ReturnType<typeof setTimeout>>();
  const holdFor = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        holdTimers.delete(timer);
        resolve();
      }, ms);
      holdTimers.add(timer);
    });

  // `due` says, after the hold, whether the user still has to be told: the
  // turn is unread, or the wait is still open. Devices held because this PC
  // was in use hear it then, unless the user dealt with it on a surface.
  const deliver = async (
    turn: TurnCompletion,
    reason: PushReason,
    due: () => boolean,
    approval?: PushApproval
  ): Promise<void> => {
    const event = EVENT_OF_REASON[reason];
    const held = new Set<string>();
    const outcome = await send(turn, reason, deliveryGate(turn, event, held), approval);
    if (outcome.targets === 0) {
      options.onDiagnostic?.('suppressed', { sessionId: turn.sessionId, reason: 'no-subscription' });
    }
    if (held.size === 0) return;
    await holdFor(options.holdMs ?? DESKTOP_HOLD_MS);
    if (!options.isEnabled() || !due()) {
      options.onDiagnostic?.('suppressed', { sessionId: turn.sessionId, reason: 'seen-on-desktop' });
      return;
    }
    const gate = deliveryGate(turn, event, null);
    const heldOnly: DeliveryGate = async (deviceId, foreground, target) =>
      held.has(deviceId) && (await gate(deviceId, foreground, target));
    await send(turn, reason, heldOnly, approval);
  };

  const send = async (
    turn: TurnCompletion,
    reason: PushReason,
    allow: DeliveryGate,
    approval?: PushApproval,
    onlyClientId?: string
  ): Promise<SendOutcome> => {
    // An attachment-only title (`[Image]` …) goes out as its kind's label.
    // This process has no UI language (see the body below): English.
    const completion = { ...turn, title: sessionTitleLabel(turn.title) };
    const outcome: SendOutcome = { targets: 0, sent: 0, failures: [] };
    const only = <T extends { clientId: string }>(rows: readonly T[]): T[] =>
      onlyClientId === undefined ? [...rows] : rows.filter((row) => row.clientId === onlyClientId);
    const nativeDelivery = deliverNative(completion, reason, allow, outcome, only, approval);
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
    const [allRelayTargets, stored] = await Promise.all([relayWeb ? relayWeb.list() : [], options.store.list()]);
    const relayTargets = only(allRelayTargets);
    // Per browser, not per relay: a browser moves to the relay's key on its
    // next launch, and until then its legacy subscription (this PC's own key)
    // is the only way to reach it. It is dropped from the direct path only
    // once that same paired browser holds a relay association.
    const relayBrowsers = new Set(allRelayTargets.map((target) => target.clientId));
    const relayEndpoints = new Set(allRelayTargets.map((target) => target.endpoint));
    const subscriptions = only(stored).filter(
      (subscription) =>
        !relayEndpoints.has(subscription.endpoint) &&
        !(subscription.clientId && relayBrowsers.has(subscription.clientId))
    );
    outcome.targets += relayTargets.length + subscriptions.length;
    const relayDelivery = relayWeb
      ? deliverRelayWeb(relayWeb, relayTargets, completion, payload, allow, outcome)
      : Promise.resolve();
    const keys = subscriptions.length > 0 ? await options.store.keys() : null;
    await Promise.allSettled(
      subscriptions.map(async (subscription) => {
        if (!keys) return;
        const foreground = Boolean(
          subscription.clientId && options.isClientForeground(subscription.clientId, completion.sessionId)
        );
        const target = { sessionId: completion.sessionId, browser: subscription.clientId.slice(0, 8) };
        // The legacy subscription names the browser by the id it paired with.
        if (!(await allow(subscription.clientId, foreground, target))) return;
        const result = await sendWebPush({
          subscription,
          payload,
          keys,
          subject: VAPID_SUBJECT,
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        });
        if (result.expired) {
          options.onDiagnostic?.('expired', { ...target, status: result.statusCode });
          outcome.failures.push('The push service no longer accepts this browser’s subscription.');
          await options.store.remove(subscription.endpoint).catch(() => false);
          return;
        }
        if (result.statusCode >= 400 || result.error) {
          options.onError?.(`push ${result.statusCode}${result.error ? `: ${result.error}` : ''}`);
          outcome.failures.push(`The push service refused it (${result.error || result.statusCode}).`);
          return;
        }
        outcome.sent += 1;
        options.onDiagnostic?.('sent', { ...target, status: result.statusCode });
      })
    );
    await Promise.all([relayDelivery, nativeDelivery]);
    return outcome;
  };

  // Relay-owned Web Push: the same gates, the payload encrypted HERE for each
  // subscription (RFC 8291), the relay signing and posting the ciphertext.
  const deliverRelayWeb = async (
    relayWeb: NonNullable<PushNotifierOptions['relayWebPush']>,
    targets: readonly RelayWebPushTarget[],
    completion: TurnCompletion,
    payload: string,
    allow: DeliveryGate,
    outcome: SendOutcome
  ): Promise<void> => {
    for (const subscription of targets) {
      const foreground = relayWeb.isClientForeground(subscription.clientId, completion.sessionId);
      const target = { sessionId: completion.sessionId, browser: subscription.clientId.slice(0, 8) };
      if (!(await allow(subscription.clientId, foreground, target))) continue;
      let body: Buffer;
      try {
        body = encryptWebPushPayload(subscription, payload);
      } catch (error) {
        options.onError?.(`push: ${error instanceof Error ? error.message : String(error)}`);
        outcome.failures.push('The browser’s subscription keys are invalid.');
        continue;
      }
      const sent = relayWeb.send(subscription, body);
      if (sent) outcome.sent += 1;
      else outcome.failures.push(RELAY_UNAVAILABLE);
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
    allow: DeliveryGate,
    outcome: SendOutcome,
    only: <T extends { clientId: string }>(rows: readonly T[]) => T[],
    approval?: PushApproval
  ): Promise<void> => {
    const native = options.native;
    if (!native) return;
    const subscriptions = only(await native.list());
    outcome.targets += subscriptions.length;
    await Promise.allSettled(
      subscriptions.map(async (subscription) => {
        const foreground = native.isClientForeground(subscription.clientId, completion.sessionId);
        const target = { sessionId: completion.sessionId, native: subscription.clientId.slice(0, 8) };
        if (!(await allow(subscription.clientId, foreground, target))) return;
        // The phone shows the body as it is: a failed turn says so here.
        const body = reason === 'turn-failed' ? completion.preview || TURN_FAILED_TEXT : completion.preview || '';
        const content: NativePushContent = {
          title: completion.title.slice(0, NATIVE_TITLE_CHARS),
          body: body.slice(0, NATIVE_BODY_CHARS),
          sessionId: completion.sessionId,
          reason,
          ...(approval ? { approvalId: approval.id.slice(0, 120) } : {}),
          // Inside the encryption: the relay never learns whether Allow is offered.
          ...(approval?.allowOnce ? { allowOnce: true } : {}),
          ...(options.hostId ? { hostId: options.hostId.slice(0, 64) } : {}),
        };
        const sent = native.send({
          platform: subscription.platform,
          token: subscription.token,
          sandbox: subscription.sandbox,
          mx: encryptNativePush(subscription.publicKey, content),
          reason: reason === 'turn-failed' ? 'turn-finished' : reason,
          collapseKey: nativeCollapseKey(completion.sessionId, reason),
        });
        if (sent) outcome.sent += 1;
        else outcome.failures.push(RELAY_UNAVAILABLE);
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
    ...(options.agentName ? { agentName: options.agentName } : {}),
    onError: options.onError,
    onDiagnostic: options.onDiagnostic,
    onFinalAnswer: (completion) => {
      void deliver(completion, completion.event === 'error' ? 'turn-failed' : 'turn-finished', () =>
        unread(completion.sessionId)
      ).catch((error: unknown) => {
        options.onError?.(error instanceof Error ? error.message : String(error));
      });
    },
  });

  // The host's shared read cursor per session (any surface reading it moves
  // it): a turn is unread while its messages run past the cursor.
  const readState = new Map<string, { messageCount: number; readMessageCount: number }>();
  const unread = (sessionId: string): boolean => {
    const row = readState.get(sessionId);
    return !row || row.readMessageCount < row.messageCount;
  };

  // Approval-pending: a session that STARTS waiting on a tool approval needs a
  // human, so a background phone is told. Foreground clients already see the
  // card. Replays (re-emitted retained state) are not new waits.
  const titles = new Map<string, string>();
  const conversations = new Map<string, NotificationConversation>();
  const conversationOf = (sessionId: string): NotificationConversation =>
    conversations.get(sessionId) ?? notificationConversationOf({ id: sessionId });
  const notifiedApproval = new Map<string, string>();
  const notifiedInput = new Map<string, string>();
  const notifiedQuestion = new Map<string, string>();
  // The tool approval each session shows now: a notification's Allow is taken
  // for that very approval only, and only where a bare Enter allows it once.
  const shownApprovals = new Map<string, PushApproval>();
  const onSessionState = (update: DesktopSessionStateUpdate): void => {
    const sessionId = String(update?.sessionId || '');
    if (!sessionId) return;
    const snapshot = update.snapshot as (PendingInputSnapshot & { toolApproval?: { id?: unknown } | null }) | null;
    const approval = snapshot?.toolApproval as { id?: unknown; kind?: unknown } | null | undefined;
    // A question has no Allow/Deny: it only opens the app.
    const isQuestion = approval?.kind === 'question';
    const allowDecision = approvalAllowOnceDecision(approval);
    const shown =
      approval && !isQuestion
        ? {
            id: String(approval.id ?? 'pending'),
            allowOnce: allowDecision !== null,
            pointerOnly: approvalAllowIsPointerOnly(approval),
            ...(allowDecision ? { allowDecision } : {}),
          }
        : null;
    if (shown) shownApprovals.set(sessionId, shown);
    else shownApprovals.delete(sessionId);
    if (update.frameSource === 'replay') return;
    notifyWait(sessionId, 'approval-pending', notifiedApproval, shown?.id ?? null, '', shown?.allowOnce);
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
    preview = '',
    allowOnce = false
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
        conversation: conversationOf(sessionId),
        title: titles.get(sessionId) || 'Mixdog',
        preview,
        startedAt: now,
        at: now,
        leadFinished: false,
      },
      reason,
      // Still open: answered on this PC meanwhile clears the key.
      () => seen.get(sessionId) === key,
      reason === 'approval-pending' ? { id: key, allowOnce } : undefined
    ).catch((error: unknown) => {
      options.onError?.(error instanceof Error ? error.message : String(error));
    });
  };

  const sendTest = async (clientId: string): Promise<NotificationTestResult> => {
    const now = Date.now();
    const outcome = await send(
      {
        sessionId: '',
        conversation: notificationConversationOf({ id: '' }),
        title: 'Mixdog',
        preview: TEST_PUSH_TEXT,
        startedAt: now,
        at: now,
        leadFinished: false,
      },
      'turn-finished',
      passGate,
      undefined,
      clientId
    );
    if (outcome.sent > 0) return { ok: true };
    if (outcome.targets === 0) {
      return { ok: false, message: 'This device has not allowed notifications from this PC yet.' };
    }
    return { ok: false, message: outcome.failures[0] || RELAY_UNAVAILABLE };
  };

  return {
    onSessions(sessions) {
      titles.clear();
      conversations.clear();
      readState.clear();
      for (const session of sessions) {
        titles.set(session.id, session.title || session.preview || '');
        conversations.set(session.id, notificationConversationOf(session));
        readState.set(session.id, {
          messageCount: Number(session.messageCount) || 0,
          readMessageCount: Number(session.readMessageCount) || 0,
        });
      }
      watcher.onSessions(sessions);
    },
    onSessionState,
    approvalAllowsOnce(sessionId, approvalId) {
      const shown = shownApprovals.get(sessionId);
      return shown?.allowOnce === true && shown.id === approvalId;
    },
    approvalAllowDecision(sessionId, approvalId) {
      const shown = shownApprovals.get(sessionId);
      return shown?.allowOnce === true && shown.id === approvalId ? (shown.allowDecision ?? null) : null;
    },
    approvalPointerOnly(sessionId, approvalId) {
      const shown = shownApprovals.get(sessionId);
      return shown?.pointerOnly === true && shown.id === approvalId;
    },
    onHeldRequest(event) {
      const sessionId = String(event?.sessionId || '');
      const requestId = String(event?.requestId || '');
      if (!sessionId || !requestId) return;
      if (!options.isEnabled()) {
        options.onDiagnostic?.('suppressed', { sessionId, reason: 'disabled' });
        return;
      }
      const now = Date.now();
      const conversation = conversationOf(sessionId);
      void deliver(
        {
          sessionId,
          // An unattended run asks: its bot's override applies; its origin is
          // automatic, which only matters for results, not for this wait.
          conversation: {
            ...conversation,
            origin: 'schedule',
            agentId: conversation.agentId || String(event.agentId || ''),
          },
          title: 'Mixdog',
          preview: heldRequestPushText(event.agentName),
          startedAt: now,
          at: now,
          leadFinished: false,
        },
        'approval-pending',
        // An unattended run's request has no answer this notifier sees, nor
        // content: the phone offers no Allow for it.
        () => true,
        { id: requestId, allowOnce: false }
      ).catch((error: unknown) => {
        options.onError?.(error instanceof Error ? error.message : String(error));
      });
    },
    onAgentPool: watcher.onAgentPool,
    forgetClient(clientId) {
      void options.store.removeByClient(clientId).catch(() => false);
      void options.native?.removeByClient(clientId).catch(() => false);
    },
    sendTest,
    dispose() {
      for (const timer of holdTimers) clearTimeout(timer);
      holdTimers.clear();
      watcher.dispose();
    },
  };
}

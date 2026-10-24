// The relay web app's half of native push (iOS APNs / Android FCM) inside the
// Mixdog phone app (apps/mobile). The native shell owns the OS token and a
// per-install P-256 key pair (private key stays in the keystore/keychain); this
// module reads both through the shell's small host object (shared/native-app)
// and hands `{ platform, token, publicKey }` to the desktop over the existing
// E2EE channel with `registerNativePush` — but only when the connected host
// advertised `nativePush: 1` in its relay handshake.
//
// It also carries the other direction: a tapped notification, or its
// Allow / Deny action, reaches the shell first. The shell parks it and this
// module drains it, opens the session through the web app's notification
// navigation path (use-push-notification-navigation.ts) and, for an approval
// action, answers it with the host's `answerApprovalNotification`, which takes
// an Allow only where this PC's card allows it once with a bare Enter and
// otherwise answers 'open': the app is already open on that approval.
import {
  NATIVE_PUSH_EVENT,
  nativeAppInfo,
  type MixdogNativeInfo,
  type NativeNotificationAction,
  type NativePushState,
} from '../shared/native-app';
import { REMOTE_CONNECTION_READY_EVENT } from './remote-connection-state';
import type { RemoteShimContext } from './remote-shim-state';

interface NativePushRegistration {
  platform: 'apns' | 'fcm';
  token: string;
  publicKey: string;
  /** Only sent as `true` (development iOS builds). */
  sandbox?: boolean;
}

/** `window.mixdogRemoteNativePush`, published by the remote shim. */
interface NativePushHost {
  /** The CURRENT host advertised `nativePush: 1`; re-read per use because a
   *  reconnect may land on another host. */
  available(): boolean;
  /** Relay device id of the connected host; '' when unknown. Parked
   *  notification actions are matched against it. */
  hostId?(): string;
  register(input: NativePushRegistration): Promise<unknown>;
  /** A notification's Allow / Deny (remote-session-methods.ts
   *  answerApprovalNotification): 'answered', 'settled' or 'open'. */
  answerApproval?(sessionId: string, approvalId: string, action: 'allow' | 'deny'): Promise<unknown>;
}

export const REMOTE_NATIVE_PUSH_GLOBAL = 'mixdogRemoteNativePush';

export function createNativePushHost(
  ctx: Pick<RemoteShimContext, 'peerNativePush' | 'call'> & Partial<Pick<RemoteShimContext, 'deviceId'>>
): NativePushHost {
  return {
    available: () => ctx.peerNativePush === true,
    hostId: () => ctx.deviceId ?? '',
    answerApproval: (sessionId, approvalId, action) =>
      ctx.call('answerApprovalNotification', [sessionId, approvalId, action]),
    register: (input) =>
      ctx.call('registerNativePush', [
        {
          platform: input.platform,
          token: input.token,
          publicKey: input.publicKey,
          ...(input.sandbox === true ? { sandbox: true } : {}),
        },
      ]),
  };
}

type NativePushPermission = NativePushState['permission'];
let nativePermission: NativePushPermission | null = null;
const nativePermissionListeners = new Set<() => void>();

function publishNativePermission(permission: NativePushPermission): void {
  if (permission === nativePermission) return;
  nativePermission = permission;
  for (const listener of [...nativePermissionListeners]) listener();
}

/** What the OS last said about this app's notification permission; null until
 *  the shell has been asked (and always null outside the phone app). */
export function nativePushPermission(): NativePushPermission | null {
  return nativePermission;
}

export function subscribeNativePushPermission(listener: () => void): () => void {
  nativePermissionListeners.add(listener);
  return () => {
    nativePermissionListeners.delete(listener);
  };
}

/** Open this app's notification settings in the system. The permission is
 *  re-read when the app returns (the shell fires NATIVE_PUSH_EVENT, and the
 *  page becoming visible syncs, see installNativePushBridge). */
export async function openNativeNotificationSettings(
  deps: { native?: MixdogNativeInfo | null } = {}
): Promise<boolean> {
  const native = deps.native === undefined ? nativeAppInfo() : deps.native;
  if (!native?.call) return false;
  try {
    return (await native.call('openNotificationSettings')) === true;
  } catch {
    return false;
  }
}

/** The words the shell puts on an approval notification's actions, in this
 *  app's language: the card's 거절 and 한 번만 허용. True once the shell took
 *  them; false outside the phone app or for an older shell. */
export async function publishNativeNotificationLabels(
  labels: { deny: string; allowOnce: string },
  deps: { native?: MixdogNativeInfo | null } = {}
): Promise<boolean> {
  const native = deps.native === undefined ? nativeAppInfo() : deps.native;
  if (!native?.call) return false;
  try {
    return (await native.call('setNotificationLabels', labels)) === true;
  } catch {
    return false;
  }
}

type RegistrationResult = 'registered' | 'no-native' | 'no-host-support' | 'no-token' | 'denied' | 'failed';

/** Register this install's token with the connected host. Safe to call any
 *  number of times; the host treats it as an upsert. */
export async function syncNativePush(
  deps: { native?: MixdogNativeInfo | null; host?: NativePushHost } = {}
): Promise<RegistrationResult> {
  const native = deps.native === undefined ? nativeAppInfo() : deps.native;
  if (!native?.call) return 'no-native';
  const host =
    deps.host ?? (window as unknown as Record<string, NativePushHost | undefined>)[REMOTE_NATIVE_PUSH_GLOBAL];
  try {
    let state = await native.call('getPushState');
    // What the OS currently allows is shown whether or not a PC can use it.
    publishNativePermission(state.permission);
    if (!host?.available()) return 'no-host-support';
    // First run on this install: ask the OS once. The answer (and the token
    // that follows it) arrives later as NATIVE_PUSH_EVENT.
    if (state.permission === 'prompt') {
      state = await native.call('requestPush');
      publishNativePermission(state.permission);
    }
    if (state.permission === 'denied') return 'denied';
    if (state.permission !== 'granted' || !state.token || !state.publicKey) return 'no-token';
    await host.register({
      platform: state.platform,
      token: state.token,
      publicKey: state.publicKey,
      ...(state.sandbox === true ? { sandbox: true } : {}),
    });
    return 'registered';
  } catch {
    return 'failed';
  }
}

type ActionListener = (action: NativeNotificationAction) => void;
const actionListeners = new Set<ActionListener>();
let queuedActions: NativeNotificationAction[] = [];

/** Session opens requested by a native notification tap. Actions that arrive
 *  before React mounts the subscriber are held and delivered on subscribe. */
export function subscribeNativeNotificationActions(listener: ActionListener): () => void {
  actionListeners.add(listener);
  const held = queuedActions;
  queuedActions = [];
  for (const action of held) listener(action);
  return () => {
    actionListeners.delete(listener);
  };
}

function publishAction(action: NativeNotificationAction): void {
  if (actionListeners.size === 0) {
    queuedActions.push(action);
    return;
  }
  for (const listener of [...actionListeners]) listener(action);
}

const isApproval = (action: NativeNotificationAction): boolean =>
  (action.action === 'allow' || action.action === 'deny') && Boolean(action.approvalId);

// Parked actions stay in the shell until acknowledged, so a drain can see the
// same one again: these keep it from being opened twice or settled in parallel.
const publishedActionIds = new Set<string>();
const settlingActionIds = new Set<string>();

function currentHost(): NativePushHost | undefined {
  return (window as unknown as Record<string, NativePushHost | undefined>)[REMOTE_NATIVE_PUSH_GLOBAL];
}

/** Act on the actions the shell parked for the host this page is connected to.
 *  Other hosts' actions stay parked. An approval is acknowledged (removed from
 *  the shell) only after the host answered it; an open is acknowledged once
 *  delivered. Older shells without peek/ack hand over one action at a time. */
export async function drainNativeNotificationActions(
  deps: { native?: MixdogNativeInfo | null; host?: NativePushHost; retryDelayMs?: number; hostId?: string } = {}
): Promise<number> {
  const native = deps.native === undefined ? nativeAppInfo() : deps.native;
  if (!native?.call) return 0;
  const host = deps.host ?? currentHost();
  const retryDelayMs = deps.retryDelayMs ?? APPROVAL_RETRY_DELAY_MS;
  const call = native.call;
  let parked: NativeNotificationAction[] | null = null;
  try {
    const peeked = await call('peekPendingActions', { hostId: deps.hostId ?? host?.hostId?.() ?? '' });
    parked = Array.isArray(peeked) ? peeked : null;
  } catch {
    parked = null;
  }
  if (!parked) return drainLegacyActions(native, host, retryDelayMs);
  let handled = 0;
  // Bounded: the shell parks a handful at most.
  for (const action of parked.slice(0, 8)) {
    const id = action?.id;
    if (!id || !action.sessionId || settlingActionIds.has(id)) continue;
    handled += 1;
    settlingActionIds.add(id);
    if (!publishedActionIds.has(id)) {
      publishedActionIds.add(id);
      publishAction(action);
    }
    const settle = async (): Promise<void> => {
      try {
        if (isApproval(action) && !(await answerParkedApproval(host, action, retryDelayMs))) return;
        await call('ackPendingAction', { id });
        publishedActionIds.delete(id);
      } catch {
        /* stays parked; the next drain tries again */
      } finally {
        settlingActionIds.delete(id);
      }
    };
    if (isApproval(action)) void settle();
    else await settle();
  }
  return handled;
}

/** Shells without peek/ack remove each action as they hand it over, so this is
 *  the only delivery it will ever get. */
async function drainLegacyActions(
  native: MixdogNativeInfo,
  host: NativePushHost | undefined,
  retryDelayMs: number
): Promise<number> {
  let handled = 0;
  for (let index = 0; index < 8; index += 1) {
    let action: NativeNotificationAction | null;
    try {
      action = (await native.call?.('takePendingAction')) ?? null;
    } catch {
      break;
    }
    if (!action?.sessionId) break;
    handled += 1;
    publishAction(action);
    if (isApproval(action)) void answerParkedApproval(host, action, retryDelayMs);
  }
  return handled;
}

const APPROVAL_ATTEMPTS = 4;
const APPROVAL_RETRY_DELAY_MS = 500;

/** Resolves true once the host ANSWERED. A call cut off by the reconnect that
 *  carries it (a rejected call, i.e. nothing answered) is sent again. Safe to
 *  repeat: the host settles an approval by its id, and an id that is already
 *  settled or no longer pending answers 'settled' — an answer, which ends the
 *  retries, as does 'open' (an Allow this PC takes only in the app, which the
 *  action already opened on that session). False when every attempt failed:
 *  the action then stays parked. */
async function answerParkedApproval(
  host: NativePushHost | undefined,
  action: NativeNotificationAction,
  retryDelayMs: number
): Promise<boolean> {
  const answer = host?.answerApproval;
  if (!answer) return false;
  for (let attempt = 1; attempt <= APPROVAL_ATTEMPTS; attempt += 1) {
    try {
      await answer.call(
        host,
        action.sessionId,
        action.approvalId as string,
        action.action === 'allow' ? 'allow' : 'deny'
      );
      return true;
    } catch {
      if (attempt < APPROVAL_ATTEMPTS) await new Promise((r) => setTimeout(r, retryDelayMs * attempt));
    }
  }
  return false;
}

/** Wire the shell to the web app: register on every connection, drain on
 *  launch, on the shell's own event and whenever the app returns to the front. */
export function installNativePushBridge(): () => void {
  if (!nativeAppInfo()?.call) return () => {};
  const sync = (): void => void syncNativePush();
  const drain = (): void => void drainNativeNotificationActions();
  const syncAndDrain = (): void => {
    sync();
    drain();
  };
  const onVisible = (): void => {
    if (document.visibilityState !== 'visible') return;
    drain();
    // Back from system settings: the permission may now be granted.
    sync();
  };
  window.addEventListener(REMOTE_CONNECTION_READY_EVENT, syncAndDrain);
  window.addEventListener(NATIVE_PUSH_EVENT, syncAndDrain);
  document.addEventListener('visibilitychange', onVisible);
  drain();
  return () => {
    window.removeEventListener(REMOTE_CONNECTION_READY_EVENT, syncAndDrain);
    window.removeEventListener(NATIVE_PUSH_EVENT, syncAndDrain);
    document.removeEventListener('visibilitychange', onVisible);
  };
}

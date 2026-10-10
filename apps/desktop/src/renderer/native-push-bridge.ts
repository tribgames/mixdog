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
// action, resolves it with the same `resolveToolApprovalForSession` the
// approval card uses.
import type { DesktopApi } from '../shared/contract';
import {
  NATIVE_PUSH_EVENT,
  nativeAppInfo,
  type MixdogNativeInfo,
  type NativeNotificationAction,
} from '../shared/native-app';
import type { RemoteShimContext } from './remote-shim-state';

/** Same value as REMOTE_CONNECTION_READY_EVENT (remote-shim-state), which this
 *  module must not import at runtime: the navigation hook that subscribes here
 *  ships in every renderer bundle and would pull the whole shim along. */
const REMOTE_CONNECTION_READY_EVENT = 'mixdog:remote-connection-ready';

export interface NativePushRegistration {
  platform: 'apns' | 'fcm';
  token: string;
  publicKey: string;
  /** Only sent as `true` (development iOS builds). */
  sandbox?: boolean;
}

/** `window.mixdogRemoteNativePush`, published by the remote shim. */
export interface NativePushHost {
  /** The CURRENT host advertised `nativePush: 1`; re-read per use because a
   *  reconnect may land on another host. */
  available(): boolean;
  register(input: NativePushRegistration): Promise<unknown>;
}

export const REMOTE_NATIVE_PUSH_GLOBAL = 'mixdogRemoteNativePush';

export function createNativePushHost(ctx: Pick<RemoteShimContext, 'peerNativePush' | 'call'>): NativePushHost {
  return {
    available: () => ctx.peerNativePush === true,
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
  if (!host?.available()) return 'no-host-support';
  try {
    let state = await native.call('getPushState');
    // First run on this install: ask the OS once. The answer (and the token
    // that follows it) arrives later as NATIVE_PUSH_EVENT.
    if (state.permission === 'prompt') state = await native.call('requestPush');
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

/** Take every action the shell parked and act on it. */
export async function drainNativeNotificationActions(
  deps: {
    native?: MixdogNativeInfo | null;
    api?: Pick<Partial<DesktopApi>, 'resolveToolApprovalForSession'>;
  } = {}
): Promise<number> {
  const native = deps.native === undefined ? nativeAppInfo() : deps.native;
  if (!native?.call) return 0;
  const api = deps.api ?? (window as unknown as { mixdogDesktop?: Partial<DesktopApi> }).mixdogDesktop;
  let handled = 0;
  // Bounded: the shell parks a handful at most.
  for (let index = 0; index < 8; index += 1) {
    let action: NativeNotificationAction | null;
    try {
      action = await native.call('takePendingAction');
    } catch {
      break;
    }
    if (!action?.sessionId) break;
    handled += 1;
    publishAction(action);
    if ((action.action === 'allow' || action.action === 'deny') && action.approvalId) {
      // The approval card stays on the opened session if this fails.
      void api
        ?.resolveToolApprovalForSession?.(action.sessionId, action.approvalId, { approved: action.action === 'allow' })
        ?.catch(() => {});
    }
  }
  return handled;
}

/** Wire the shell to the web app: register on every connection, drain on
 *  launch, on the shell's own event and whenever the app returns to the front. */
export function installNativePushBridge(
  deps: { api?: Pick<Partial<DesktopApi>, 'resolveToolApprovalForSession'> } = {}
): () => void {
  if (!nativeAppInfo()?.call) return () => {};
  const sync = (): void => void syncNativePush();
  const drain = (): void => void drainNativeNotificationActions({ api: deps.api });
  const onNativeEvent = (): void => {
    sync();
    drain();
  };
  const onVisible = (): void => {
    if (document.visibilityState === 'visible') drain();
  };
  window.addEventListener(REMOTE_CONNECTION_READY_EVENT, sync);
  window.addEventListener(NATIVE_PUSH_EVENT, onNativeEvent);
  document.addEventListener('visibilitychange', onVisible);
  drain();
  return () => {
    window.removeEventListener(REMOTE_CONNECTION_READY_EVENT, sync);
    window.removeEventListener(NATIVE_PUSH_EVENT, onNativeEvent);
    document.removeEventListener('visibilitychange', onVisible);
  };
}

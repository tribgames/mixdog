// What the Mixdog phone app (the Capacitor shell in apps/mobile) tells the relay
// web app it runs in — the counterpart of shared/remote-window.ts. The shell
// injects the host object on every page it loads (a WKUserScript on iOS, a
// JavaScript interface on Android), and also tags the user agent so the
// surface is recognised before any script runs. It is a label plus a small
// push bridge; it grants the page nothing beyond this app's own push token
// and the save sink for files the page downloaded (shared/native-file-save.ts).

import {
  NATIVE_FILE_SAVE_INTERACTIVE_CALLS,
  NATIVE_FILE_SAVE_INTERACTIVE_TIMEOUT_MS,
  type NativeFileSaveCalls,
} from './native-file-save';

export const NATIVE_APP_USER_AGENT_TOKEN = 'MixdogApp/';
export const NATIVE_PUSH_EVENT = 'mixdognativepush';

export type NativeAppPlatform = 'ios' | 'android';

export interface NativePushState {
  platform: 'apns' | 'fcm';
  /** '' until the OS has issued a token. */
  token: string;
  /** iOS development/debug builds use the APNs sandbox; omitted elsewhere. */
  sandbox?: boolean;
  /** Uncompressed P-256 public key, base64url; '' until generated. */
  publicKey: string;
  permission: 'granted' | 'denied' | 'prompt';
}

export interface NativeNotificationAction {
  action: 'open' | 'allow' | 'deny';
  sessionId: string;
  approvalId?: string;
  /** Parked-action id (peek/ack); absent from older shells. */
  id?: string;
  /** Host (relay device id) the push came from; absent = any host may act. */
  hostId?: string;
}

/** Fired on `window` by the shell on every app-update state change. */
export const NATIVE_UPDATE_EVENT = 'mixdognativeupdate';

export interface NativeAppUpdateState {
  status:
    | 'idle'
    | 'checking'
    | 'up-to-date'
    | 'available'
    | 'downloading'
    | 'ready'
    | 'needs-permission'
    | 'installing'
    | 'failed';
  /** Installed app version. */
  installed: string;
  /** Newest version, when one is known. */
  version?: string;
  receivedBytes?: number;
  totalBytes?: number;
  /** The user postponed this version. */
  dismissed?: boolean;
  error?: 'network' | 'verify' | 'storage' | 'install';
  /** The shell downloads updates on its own (no user Update tap). */
  auto?: boolean;
  /** The last release lookup failed; absent from older shells. */
  lastCheckError?: 'network';
  /** When the last release lookup ran (ms since epoch); absent from older shells. */
  lastCheckAt?: number;
}

export interface MixdogNativeCalls extends NativeFileSaveCalls {
  /** Android only. Older shells answer `null` (or never answer): no update feature. */
  getAppUpdate: [{ check?: boolean }, NativeAppUpdateState | null];
  startAppUpdate: [undefined, NativeAppUpdateState | null];
  cancelAppUpdate: [undefined, NativeAppUpdateState | null];
  installAppUpdate: [undefined, NativeAppUpdateState | null];
  dismissAppUpdate: [{ version: string }, NativeAppUpdateState | null];
  openAppUpdateInBrowser: [undefined, boolean];
  getPushState: [undefined, NativePushState];
  requestPush: [undefined, NativePushState];
  /** Opens this app's notification settings in the system (Android: app
   *  notification settings, else app details; iOS 16+: notification settings,
   *  else the app's settings). False when the system could not open them;
   *  older shells answer `null`. The shell fires `mixdognativepush` when the
   *  app returns to the foreground. */
  openNotificationSettings: [undefined, boolean | null];
  /** The approval notification actions' words, in the web app's language
   *  (the card's 거절 / 한 번만 허용); older shells answer `null`. */
  setNotificationLabels: [{ deny: string; allowOnce: string }, boolean | null];
  takePendingAction: [undefined, NativeNotificationAction | null];
  /** Actions this host may act on; they stay parked until acknowledged. */
  peekPendingActions: [{ hostId: string }, NativeNotificationAction[]];
  ackPendingAction: [{ id: string }, boolean];
  openHostPicker: [undefined, boolean];
  /** Bundled pairing screen only: the relay origins the WebView may load. */
  setAllowedOrigins: [{ origins: string[] }, boolean];
}

export interface MixdogNativeInfo {
  platform: NativeAppPlatform;
  version: string;
  /** Absent when only the user-agent tag was seen (no bridge). The native side
   *  answers only the bundled screen and paired relay origins. */
  call?<M extends keyof MixdogNativeCalls>(
    method: M,
    ...args: MixdogNativeCalls[M][0] extends undefined ? [] : [MixdogNativeCalls[M][0]]
  ): Promise<MixdogNativeCalls[M][1]>;
}

/** Android's `addWebMessageListener` object: origin-restricted, message based. */
interface AndroidMessageHost {
  postMessage(message: string): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

const ANDROID_CALL_TIMEOUT_MS = 10_000;
const androidWrappers = new WeakMap<object, MixdogNativeInfo>();

function androidInfo(host: AndroidMessageHost, version: string): MixdogNativeInfo {
  const cached = androidWrappers.get(host);
  if (cached) return cached;
  let nextId = 1;
  const pending = new Map<number, (result: unknown) => void>();
  host.onmessage = (event) => {
    try {
      const reply = JSON.parse(String(event.data)) as { id?: number; result?: unknown };
      const settle = typeof reply.id === 'number' ? pending.get(reply.id) : undefined;
      if (settle) settle(reply.result);
    } catch {
      /* not ours */
    }
  };
  const info: MixdogNativeInfo = {
    platform: 'android',
    version,
    call: ((method: string, args?: unknown) =>
      new Promise<unknown>((resolve, reject) => {
        const id = nextId++;
        // A save location or share sheet waits on the user, not the bridge.
        const timeoutMs = NATIVE_FILE_SAVE_INTERACTIVE_CALLS.has(method as keyof NativeFileSaveCalls)
          ? NATIVE_FILE_SAVE_INTERACTIVE_TIMEOUT_MS
          : ANDROID_CALL_TIMEOUT_MS;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('Native bridge did not answer.'));
        }, timeoutMs);
        pending.set(id, (result) => {
          clearTimeout(timer);
          pending.delete(id);
          resolve(result);
        });
        host.postMessage(JSON.stringify({ id, method, args: args ?? {} }));
      })) as MixdogNativeInfo['call'],
  };
  androidWrappers.set(host, info);
  return info;
}

export function nativeAppInfo(): MixdogNativeInfo | null {
  if (typeof window === 'undefined') return null;
  const scope = window as unknown as {
    mixdogNative?: MixdogNativeInfo;
    MixdogNativeHost?: AndroidMessageHost;
  };
  const injected = scope.mixdogNative;
  if (injected && (injected.platform === 'ios' || injected.platform === 'android')) return injected;
  const userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const tagged = new RegExp(`${NATIVE_APP_USER_AGENT_TOKEN}(\\S+)`, 'u').exec(userAgent);
  const version = tagged?.[1] ?? '';
  const host = scope.MixdogNativeHost;
  if (host && typeof host.postMessage === 'function') return androidInfo(host, version);
  if (tagged) return { platform: /Android/iu.test(userAgent) ? 'android' : 'ios', version };
  return null;
}

// What the Mixdog phone app (the Capacitor shell in apps/mobile) tells the relay
// web app it runs in — the counterpart of shared/remote-window.ts. The shell
// injects the host object on every page it loads (a WKUserScript on iOS, a
// JavaScript interface on Android), and also tags the user agent so the
// surface is recognised before any script runs. It is a label plus a small
// push bridge; it grants the page nothing beyond this app's own push token.

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
}

export interface MixdogNativeCalls {
  getPushState: [undefined, NativePushState];
  requestPush: [undefined, NativePushState];
  takePendingAction: [undefined, NativeNotificationAction | null];
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
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('Native bridge did not answer.'));
        }, ANDROID_CALL_TIMEOUT_MS);
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

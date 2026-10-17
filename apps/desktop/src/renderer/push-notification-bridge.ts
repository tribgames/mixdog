// The app's half of the push notification path.
//
// A tapped notification reaches the WORKER (public/sw.js), never this document
// directly. The worker parks what was tapped and the app claims it here, the
// same way a shared payload travels: that parking is what lets a tap survive a
// phone which discarded the document while the app sat in the background.
//
// The same channel carries the UI language outward. A worker has no
// localStorage, and the device showing a notification — not the desktop that
// sent it — is the one whose language it should speak.
//
// Web Push itself is the RELAY's: it owns the one sender key (VAPID) this
// browser subscribes with, so every paired PC can deliver to the same
// subscription. The subscription is registered with the relay once per paired
// PC, each time with THAT PC's own credential, and its keys are sealed to that
// PC's E2EE identity so only the PC can encrypt for it. A relay without the
// capability leaves the legacy path: one PC's own key, registered over RPC.
import type { DesktopApi } from '../shared/contract';
import { sealRelayWebPushKeys, type RelayE2EEPairingMaterial } from '../shared/remote-e2ee';
import { isRemoteClientCredential, normalizeRemoteRelayOrigin, remotePairingKeys } from './remote-pairing-recovery';
import { currentDeviceId, readSavedPcs } from './remote-saved-pcs';

type PushRegistrationApi = Pick<Partial<DesktopApi>, 'registerPushSubscription' | 'pushPublicKey'>;

/** What the relay-mode helpers read; every field defaults to this page's own. */
export interface PushHostEnvironment {
  fetch?: typeof fetch;
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
  origin?: string;
  /** The saved PC list (remote-saved-pcs.ts) plus the PC this page drives. */
  hostIds?: readonly string[];
  currentHostId?: string;
  /** The clock restatement pacing reads (tests). */
  now?: () => number;
}

/** One paired PC this browser holds its own credential for. */
export interface PairedPushHost {
  deviceId: string;
  token: string;
  pairing: RelayE2EEPairingMaterial;
}

/** Why turning notifications on failed, for the note Settings shows:
 *  'push-service' — this browser has no working push service (an Electron
 *  window, a browser with push turned off); 'blocked' — the browser refused the
 *  subscription; 'outdated' — the PC predates push; 'unreachable' — the PC or
 *  the relay could not be asked; 'failed' — a retryable browser failure
 *  (network, state) that says nothing about push being unsupported. */
export type PushEnableFailure = 'push-service' | 'blocked' | 'outdated' | 'unreachable' | 'failed';

export class PushEnableError extends Error {
  constructor(
    readonly reason: PushEnableFailure,
    cause?: unknown
  ) {
    super(`push enable failed: ${reason}`, cause === undefined ? undefined : { cause });
    this.name = 'PushEnableError';
  }
}

/** The relay key this browser last subscribed with, for a browser that does
 *  not report `PushSubscription.options.applicationServerKey`. */
export const PUSH_SERVER_KEY_STORAGE = 'mixdog.push-server-key';
const RELAY_KEY = /^[A-Za-z0-9_-]{87}$/u;

function hostFetch(environment: PushHostEnvironment): typeof fetch {
  return environment.fetch ?? ((input, init) => fetch(input, init));
}

function hostStorage(environment: PushHostEnvironment): Pick<Storage, 'getItem' | 'setItem'> | null {
  if (environment.storage) return environment.storage;
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function hostOrigin(environment: PushHostEnvironment): string {
  return environment.origin ?? (typeof location === 'undefined' ? '' : location.origin);
}

function base64Url(value: ArrayBuffer | ArrayBufferView | string | null | undefined): string {
  if (typeof value === 'string') return value.replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
  if (!value) return '';
  const bytes =
    value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return base64Url(btoa(binary));
}

export function bufferFromBase64Url(value: string): ArrayBuffer {
  const normalized = String(value || '')
    .replace(/-/gu, '+')
    .replace(/_/gu, '/');
  const raw = atob(normalized + '='.repeat((4 - (normalized.length % 4)) % 4));
  const buffer = new ArrayBuffer(raw.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return buffer;
}

/** The relay's Web Push key; null when this relay predates it (legacy path).
 *  Throws when the relay could not be asked at all. */
export async function relayWebPushKey(environment: PushHostEnvironment = {}): Promise<string | null> {
  const response = await hostFetch(environment)('/webpush/key', { cache: 'no-store' });
  if (!response.ok) {
    // Only an answer that says "no such thing" means an older relay; a busy
    // one is asked again on the next connection.
    if (response.status >= 500 || response.status === 429) throw new Error(`relay ${response.status}`);
    return null;
  }
  try {
    const body = (await response.json()) as { publicKey?: unknown };
    return typeof body.publicKey === 'string' && RELAY_KEY.test(body.publicKey) ? body.publicKey : null;
  } catch {
    // An older relay answers an unknown path with its app shell.
    return null;
  }
}

/** The key a subscription was made with, or '' when the browser does not say. */
export function subscriptionServerKey(subscription: PushSubscription): string {
  return base64Url(subscription.options?.applicationServerKey ?? null);
}

/**
 * This browser's subscription, bound to the relay key. A subscription made
 * with another key (a PC's own, from before the relay owned it) can only ever
 * be delivered by that one PC, so it is replaced. Without a subscription one
 * is made only when `create` (the user turning notifications on).
 */
export async function ensureRelaySubscription(
  pushManager: PushManager,
  relayKey: string,
  create: boolean,
  environment: PushHostEnvironment = {}
): Promise<PushSubscription | null> {
  return ensureKeyedSubscription(pushManager, relayKey, create, environment, true);
}

/** The key the current subscription was made with: the browser's report, else
 *  the one recorded when this page made it; '' when neither says. */
function knownServerKey(subscription: PushSubscription, environment: PushHostEnvironment): string {
  return subscriptionServerKey(subscription) || hostStorage(environment)?.getItem(PUSH_SERVER_KEY_STORAGE) || '';
}

/** This browser's subscription, bound to `key`: one made with another key is
 *  replaced (always when `replaceUnknown`, else only when its key is known to
 *  differ). Kept as it is when already bound, so restating is idempotent. */
async function ensureKeyedSubscription(
  pushManager: PushManager,
  key: string,
  create: boolean,
  environment: PushHostEnvironment,
  replaceUnknown: boolean
): Promise<PushSubscription | null> {
  const storage = hostStorage(environment);
  const existing = await pushManager.getSubscription();
  if (existing) {
    const known = knownServerKey(existing, environment);
    if (known === key || (!known && !replaceUnknown)) return existing;
    await existing.unsubscribe().catch(() => false);
  } else if (!create) {
    return null;
  }
  const subscription = await pushManager
    .subscribe({
      userVisibleOnly: true,
      applicationServerKey: bufferFromBase64Url(key),
    })
    .catch((error: unknown) => {
      // AbortError ("push service not available") and NotSupportedError are a
      // browser that cannot subscribe at all: an Electron window has no push
      // service. NetworkError, InvalidStateError and anything unknown may pass.
      const name = (error as { name?: unknown } | null)?.name;
      let reason: PushEnableFailure = 'failed';
      if (name === 'NotAllowedError') reason = 'blocked';
      else if (name === 'AbortError' || name === 'NotSupportedError') reason = 'push-service';
      throw new PushEnableError(reason, error);
    });
  try {
    storage?.setItem(PUSH_SERVER_KEY_STORAGE, key);
  } catch {
    /* private storage: the browser's own report is used instead */
  }
  return subscription;
}

/** Every paired PC on this relay this browser holds a credential for: the
 *  saved PC list plus the PC this page drives. */
export function pairedPushHosts(environment: PushHostEnvironment = {}): PairedPushHost[] {
  const storage = hostStorage(environment);
  const origin = hostOrigin(environment);
  if (!storage || !origin) return [];
  const current = environment.currentHostId ?? currentDeviceId();
  const ids = [current, ...(environment.hostIds ?? readSavedPcs().map((pc) => pc.deviceId))].filter(Boolean);
  const hosts: PairedPushHost[] = [];
  for (const deviceId of new Set(ids)) {
    const keys = remotePairingKeys(origin, deviceId);
    const token = storage.getItem(keys.token) || '';
    const serverPublicKey = storage.getItem(keys.e2eePublicKey) || '';
    const pairingSecret = storage.getItem(keys.e2eeSecret) || '';
    const server = storage.getItem(keys.server) || '';
    // A PC paired through another relay is that relay's to notify.
    if (server && normalizeRemoteRelayOrigin(server) !== origin) continue;
    if (!isRemoteClientCredential(token) || !serverPublicKey || !pairingSecret) continue;
    hosts.push({ deviceId, token, pairing: { version: 1, serverPublicKey, pairingSecret } });
  }
  return hosts;
}

async function postHost(
  environment: PushHostEnvironment,
  path: string,
  host: PairedPushHost,
  body: Record<string, unknown>
): Promise<Response> {
  return hostFetch(environment)(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
    body: JSON.stringify(body),
  });
}

/** The box sealed for one PC, per PC, reused while nothing it covers changed:
 *  sealing is randomized, and the relay writes nothing for a box it already
 *  holds, so a launch that re-states an unchanged registration costs it no
 *  write and no republish. */
const SEALED_CACHE_PREFIX = 'mixdog.push-sealed:';

async function fingerprint(parts: readonly string[]): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(parts)));
  return base64Url(digest);
}

async function sealedFor(
  host: PairedPushHost,
  endpoint: string,
  material: { p256dh: string; auth: string },
  environment: PushHostEnvironment
): Promise<unknown> {
  const storage = hostStorage(environment);
  const key = `${SEALED_CACHE_PREFIX}${host.deviceId}`;
  const print = await fingerprint([
    endpoint,
    host.pairing.serverPublicKey,
    host.pairing.pairingSecret,
    material.p256dh,
    material.auth,
  ]);
  try {
    const cached = JSON.parse(storage?.getItem(key) || 'null') as { fingerprint?: unknown; sealed?: unknown } | null;
    if (cached?.fingerprint === print && cached.sealed) return cached.sealed;
  } catch {
    /* unreadable: sealed afresh */
  }
  const sealed = await sealRelayWebPushKeys(host.pairing, endpoint, material);
  try {
    storage?.setItem(key, JSON.stringify({ fingerprint: print, sealed }));
  } catch {
    /* private storage: the relay sees a new box, which it simply stores */
  }
  return sealed;
}

/** Register the subscription with the relay for the paired PCs in `only`
 *  (default: every paired PC), each with its own credential. Resolves the PCs
 *  now registered; `complete` is false when one could not be asked (retry on
 *  the next connection). A PC that refused the credential is skipped — its
 *  pairing is gone — as is one the relay says cannot deliver through it. */
export async function registerRelayPushSubscription(
  subscription: PushSubscription,
  environment: PushHostEnvironment = {},
  only: readonly string[] | null = null
): Promise<{ registered: string[]; complete: boolean }> {
  const keys = subscription.toJSON().keys ?? {};
  const material = { p256dh: base64Url(String(keys.p256dh || '')), auth: base64Url(String(keys.auth || '')) };
  let complete = true;
  const hosts = pairedPushHosts(environment).filter((host) => only === null || only.includes(host.deviceId));
  const accepted = await Promise.all(
    hosts.map(async (host) => {
      try {
        const sealed = await sealedFor(host, subscription.endpoint, material, environment);
        const response = await postHost(environment, '/webpush/register', host, {
          endpoint: subscription.endpoint,
          sealed,
        });
        if (!response.ok && (response.status >= 500 || response.status === 429)) complete = false;
        return response.ok;
      } catch {
        complete = false;
        return false;
      }
    })
  );
  return { registered: hosts.filter((_host, index) => accepted[index]).map((host) => host.deviceId), complete };
}

/** One paired PC as the relay sees it for this browser. `supported` is null
 *  when the relay could not be asked about it. */
export interface PushHostState {
  deviceId: string;
  supported: boolean | null;
  registered: boolean;
}

/** Which paired PCs deliver through the relay (and, with an endpoint, which
 *  already deliver to it). A PC whose credential the relay refused is left
 *  out: its pairing is gone. */
export async function relayPushHostStates(
  endpoint: string | null,
  environment: PushHostEnvironment = {}
): Promise<PushHostState[]> {
  const hosts = pairedPushHosts(environment);
  const states = await Promise.all(
    hosts.map(async (host): Promise<PushHostState | null> => {
      try {
        const response = await postHost(environment, '/webpush/status', host, endpoint ? { endpoint } : {});
        if (response.status === 401 || response.status === 403) return null;
        if (!response.ok) return { deviceId: host.deviceId, supported: null, registered: false };
        const body = (await response.json()) as { registered?: unknown; supported?: unknown };
        return { deviceId: host.deviceId, supported: body.supported === true, registered: body.registered === true };
      } catch {
        return { deviceId: host.deviceId, supported: null, registered: false };
      }
    })
  );
  return states.filter((state): state is PushHostState => state !== null);
}

/** Where this browser's subscription stands after stating it. */
export interface PushSubscriptionState {
  subscription: PushSubscription | null;
  /** 'relay': one subscription with the relay key, registered with every PC
   *  that delivers through the relay. 'legacy': no paired PC does yet (or the
   *  relay predates it), so the PC this page drives keeps its own key. */
  mode: 'relay' | 'legacy';
  /** Every paired PC the relay answered for; empty on a legacy relay. */
  hosts: PushHostState[];
  /** False when something could not be asked: state it again later. */
  complete: boolean;
  /** True once at least one PC is known to hold this subscription. An existing
   *  subscription nobody registered is not a working one. */
  confirmed: boolean;
}

/**
 * State this browser's subscription. The browser moves to the relay's key
 * only once at least one paired PC delivers through the relay, and registers
 * with exactly those PCs; a PC that does not yet (an older desktop) is left
 * out and reported, never registered where it would be silently ignored.
 * Until any PC does, the legacy per-PC registration stays as it was. `create`
 * makes a subscription where there is none (the user turning it on).
 */
export async function statePushSubscription(
  api: PushRegistrationApi | undefined,
  pushManager: PushManager,
  create: boolean,
  environment: PushHostEnvironment = {}
): Promise<PushSubscriptionState> {
  const relayKey = await relayWebPushKey(environment).catch((error: unknown) => {
    throw new PushEnableError('unreachable', error);
  });
  const states = relayKey ? await relayPushHostStates(null, environment) : [];
  const capable = states.filter((state) => state.supported === true).map((state) => state.deviceId);
  const undecided = states.some((state) => state.supported === null);
  if (relayKey && capable.length > 0) {
    const subscription = await ensureRelaySubscription(pushManager, relayKey, create, environment);
    if (!subscription) {
      return { subscription: null, mode: 'relay', hosts: states, complete: !undecided, confirmed: false };
    }
    const result = await registerRelayPushSubscription(subscription, environment, capable);
    return {
      subscription,
      mode: 'relay',
      hosts: states.map((state) => ({ ...state, registered: result.registered.includes(state.deviceId) })),
      // A capable PC that did not accept the registration leaves it partial.
      complete: result.complete && !undecided && capable.every((id) => result.registered.includes(id)),
      confirmed: result.registered.length > 0,
    };
  }
  const existing = await pushManager.getSubscription();
  // Whether any PC can take relay delivery is not known yet: change nothing.
  // Turning it on with nothing to change still subscribes — on the connected
  // PC's own key, which the next statement migrates once a PC is known to
  // deliver through the relay.
  if (relayKey && undecided && (existing || !create)) {
    return { subscription: existing, mode: 'legacy', hosts: states, complete: false, confirmed: false };
  }
  // Legacy: only the PC this page drives delivers, and only to a subscription
  // made with its own key. One bound to another key (the relay's, after the
  // last upgraded PC was removed) is replaced — the mirror of the migration.
  let keyError: unknown = null;
  const publicKey = await api?.pushPublicKey?.().catch((error: unknown) => {
    keyError = error;
    return null;
  });
  if (!publicKey) {
    if (create) throw new PushEnableError(pcPredatesPush(keyError) ? 'outdated' : 'unreachable', keyError);
    // The PC's key is unknown: a subscription known to be on the relay key
    // would be dead weight here, so leave it and state it again later.
    if (existing && relayKey && knownServerKey(existing, environment) === relayKey) {
      return { subscription: existing, mode: 'legacy', hosts: states, complete: false, confirmed: false };
    }
    if (existing && api) await registerBrowserPushSubscription(api, existing);
    return {
      subscription: existing,
      mode: 'legacy',
      hosts: states,
      complete: true,
      confirmed: Boolean(existing && api),
    };
  }
  const subscription = await ensureKeyedSubscription(pushManager, publicKey, create, environment, false);
  if (subscription && api) {
    await registerBrowserPushSubscription(api, subscription).catch((error: unknown) => {
      throw new PushEnableError('unreachable', error);
    });
  }
  return { subscription, mode: 'legacy', hosts: states, complete: !undecided, confirmed: Boolean(subscription && api) };
}

/** The PC answered without a key: no push support (no key, `unknown method`)
 *  or push switched off on its connection. Anything else is the connection. */
function pcPredatesPush(error: unknown): boolean {
  if (error === null) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /^unknown method\b/u.test(message) || message === 'Push notifications are unavailable on this connection.';
}

/** Remove this browser's subscription from every paired PC. Every PC is
 *  asked; rejects when any could not be (a PC whose credential the relay
 *  refused holds nothing under it, so that is done). */
export async function unregisterRelayPushSubscription(
  endpoint: string,
  environment: PushHostEnvironment = {}
): Promise<void> {
  const results = await Promise.allSettled(
    pairedPushHosts(environment).map(async (host) => {
      const response = await postHost(environment, '/webpush/unregister', host, { endpoint });
      if (!response.ok && response.status !== 401 && response.status !== 403) {
        throw new Error(`relay ${response.status}`);
      }
    })
  );
  const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failed) throw failed.reason;
}

/** The browser let go of its subscription but a PC or the relay could not be
 *  asked to forget the endpoint (it may push at it until the push service
 *  answers 404/410). `cause` is the server-side failure. */
export class PushServerCleanupError extends Error {
  constructor(cause: unknown) {
    super('push server cleanup failed', { cause });
    this.name = 'PushServerCleanupError';
  }
}

/** Turn this browser's notifications off: ask the PCs to forget the endpoint,
 *  then always unsubscribe the browser, which must really let go. Rejects with
 *  a browser failure if there is one, else with PushServerCleanupError when
 *  only the server side failed (the browser is unsubscribed either way). */
export async function removePushSubscription(
  api: Pick<Partial<DesktopApi>, 'removePushSubscription'> | undefined,
  pushManager: PushManager,
  environment: PushHostEnvironment = {}
): Promise<void> {
  const subscription = await pushManager.getSubscription();
  if (!subscription) return;
  let serverFailure: { reason: unknown } | null = null;
  try {
    // Null on a relay that predates relay-owned push: the legacy path.
    const relayKey = await relayWebPushKey(environment);
    if (relayKey) await unregisterRelayPushSubscription(subscription.endpoint, environment);
    else await api?.removePushSubscription?.(subscription.endpoint);
  } catch (error) {
    serverFailure = { reason: error };
  }
  if (!(await subscription.unsubscribe()) || (await pushManager.getSubscription())) {
    throw new Error('browser kept the subscription', serverFailure ? { cause: serverFailure.reason } : undefined);
  }
  if (serverFailure) throw new PushServerCleanupError(serverFailure.reason);
}

/** Mirrors public/sw.js. A worker is a standalone script that cannot import
 *  renderer modules, so both carry these names and a test asserts they agree. */
export const APP_STATE_CACHE_NAME = 'mixdog-app-state-v1';
export const UI_LANGUAGE_ENTRY = '/__mixdog-app__/ui-language';
export const NOTIFICATION_CLICK_ENTRY = '/__mixdog-app__/notification-click';
/** A tap the app never came back for stops meaning anything. */
export const NOTIFICATION_CLICK_TTL_MS = 10 * 60 * 1000;

interface AppStateEnvironment {
  caches?: CacheStorage;
  now?: number;
}

function appStateStorage(environment: AppStateEnvironment): CacheStorage | undefined {
  return environment.caches ?? (typeof caches !== 'undefined' ? caches : undefined);
}

/** Tell the worker which language to speak. Published on every launch, so a
 *  language changed in Settings (which reloads the window) reaches it too. */
export async function publishUiLanguage(language: string, environment: AppStateEnvironment = {}): Promise<void> {
  const store = appStateStorage(environment);
  if (!store || !language) return;
  try {
    const cache = await store.open(APP_STATE_CACHE_NAME);
    await cache.put(
      UI_LANGUAGE_ENTRY,
      new Response(language, {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      })
    );
  } catch {
    // Without storage the worker falls back to the phone's system language,
    // which is still this device rather than the desktop's.
  }
}

/** Hand one browser subscription to the desktop that will push to it. */
export async function registerBrowserPushSubscription(
  api: PushRegistrationApi,
  subscription: PushSubscription
): Promise<void> {
  const keys = subscription.toJSON().keys ?? {};
  await api.registerPushSubscription?.({
    endpoint: subscription.endpoint,
    p256dh: String(keys.p256dh || ''),
    auth: String(keys.auth || ''),
  });
}

/** Re-state this browser's CURRENT subscription once per launch. The browser
 *  may renew it on its own (sw.js pushsubscriptionchange) and its PCs would
 *  otherwise keep pushing to the retired endpoint. On a relay that owns the
 *  sender key, a subscription made with a PC's own key is migrated to the
 *  relay's, and the subscription is registered for EVERY paired PC — a PC
 *  paired since the last launch included. */
export async function syncPushSubscription(
  api: PushRegistrationApi | undefined,
  environment: PushHostEnvironment = {}
): Promise<boolean> {
  if (!api?.registerPushSubscription) return true;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return true;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return true;
  try {
    const registration = await navigator.serviceWorker.ready;
    const pushManager = registration.pushManager;
    if (!pushManager) return true;
    return (await statePushSubscription(api, pushManager, false, environment)).complete;
  } catch {
    // The desktop never heard it (the connection dropped under the call).
    return false;
  }
}

/** Sent by the worker (public/sw.js) when the browser renewed the subscription. */
export const PUSH_SUBSCRIPTION_CHANGED_MESSAGE = 'mixdog:push-subscription-changed';

/** A statement already accepted is not repeated by connections this close. */
export const PUSH_RESTATE_INTERVAL_MS = 60_000;

type WorkerMessages = Pick<ServiceWorkerContainer, 'addEventListener' | 'removeEventListener'>;

/** State the subscription on every connection until the desktop has accepted
 *  it. A single attempt on the first connection lost the statement whenever
 *  that connection dropped under the call, leaving the desktop pushing to a
 *  retired endpoint until the next launch. Once accepted, connections within
 *  PUSH_RESTATE_INTERVAL_MS are left alone unless the paired PCs changed; a
 *  renewal the worker reports starts the statement over regardless. */
export function installPushSubscriptionSync(
  api: PushRegistrationApi | undefined,
  readyEvent: string,
  target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window,
  environment: PushHostEnvironment = {},
  messages: WorkerMessages | undefined = typeof navigator === 'undefined' ? undefined : navigator.serviceWorker
): () => void {
  const now = (): number => environment.now?.() ?? Date.now();
  const pairing = (): string =>
    pairedPushHosts(environment)
      .map((host) => `${host.deviceId}:${host.token}`)
      .join(',');
  let statedAt: number | null = null;
  let statedPairing = '';
  let inFlight = false;
  let renewed = false;
  const run = (): void => {
    inFlight = true;
    renewed = false;
    const paired = pairing();
    void syncPushSubscription(api, environment).then((ok) => {
      inFlight = false;
      // The endpoint changed under the call: that statement may be the old one.
      if (renewed) {
        run();
        return;
      }
      if (ok) {
        statedAt = now();
        statedPairing = paired;
      }
    });
  };
  // A later connection restates when something it could not have known has
  // changed: a PC paired or re-paired (new credential), or a PC that came back
  // from a restart (possibly updated, so now able to deliver through the relay).
  const onReady = (): void => {
    if (inFlight) return;
    if (statedAt !== null && now() - statedAt < PUSH_RESTATE_INTERVAL_MS && pairing() === statedPairing) return;
    run();
  };
  const onMessage = (event: Event): void => {
    if ((event as MessageEvent).data?.type !== PUSH_SUBSCRIPTION_CHANGED_MESSAGE) return;
    statedAt = null;
    if (inFlight) renewed = true;
    else run();
  };
  target.addEventListener(readyEvent, onReady);
  messages?.addEventListener('message', onMessage);
  return () => {
    target.removeEventListener(readyEvent, onReady);
    messages?.removeEventListener('message', onMessage);
  };
}

/** A tapped notification: the session, and the PC (relay device id) that sent
 *  it. `hostId` is empty for a notification from a PC that predates it. */
export interface NotificationTap {
  sessionId: string;
  hostId: string;
}

/** Take the tap the worker parked, exactly once. */
export async function claimNotificationClick(environment: AppStateEnvironment = {}): Promise<NotificationTap | null> {
  const store = appStateStorage(environment);
  if (!store) return null;
  try {
    const cache = await store.open(APP_STATE_CACHE_NAME);
    const stored = await cache.match(NOTIFICATION_CLICK_ENTRY);
    if (!stored) return null;
    // Single use: a later reload must not reopen what was already handled.
    await cache.delete(NOTIFICATION_CLICK_ENTRY);
    const parked = (await stored.json()) as { sessionId?: unknown; hostId?: unknown; createdAt?: unknown };
    const sessionId = typeof parked.sessionId === 'string' ? parked.sessionId : '';
    const hostId = typeof parked.hostId === 'string' ? parked.hostId : '';
    const createdAt = Number(parked.createdAt) || 0;
    const now = environment.now ?? Date.now();
    // A tap from an hour ago is not a request to open anything now.
    if (!sessionId || now - createdAt > NOTIFICATION_CLICK_TTL_MS) return null;
    return { sessionId, hostId };
  } catch {
    return null;
  }
}

export type NotificationRoute =
  | { action: 'open'; sessionId: string }
  | { action: 'switch'; url: string }
  | { action: 'ignore' };

/**
 * Where a tap goes. One browser hears from every PC it is paired with, so a
 * session id alone is ambiguous: the tap opens on THIS page only when it came
 * from the PC this page drives, moves to the originating PC's route when that
 * PC is paired here, and does nothing for a PC this browser no longer knows —
 * opening it on the active PC would show the wrong machine's session.
 */
export function routeNotificationTap(tap: NotificationTap, environment: PushHostEnvironment = {}): NotificationRoute {
  if (!tap.sessionId) return { action: 'ignore' };
  // A PC that predates host ids sent it over the legacy path, which only ever
  // reached the browser through the PC this page was driving.
  if (!tap.hostId) return { action: 'open', sessionId: tap.sessionId };
  const hostId = tap.hostId.toLowerCase();
  const current = (environment.currentHostId ?? currentDeviceId()).toLowerCase();
  if (hostId === current) return { action: 'open', sessionId: tap.sessionId };
  if (!pairedPushHosts(environment).some((host) => host.deviceId.toLowerCase() === hostId)) {
    return { action: 'ignore' };
  }
  const query = new URLSearchParams({ session: tap.sessionId, host: hostId });
  return { action: 'switch', url: `/d/${encodeURIComponent(hostId)}/?${query.toString()}` };
}

/** The tap reached the running app directly; retire the parked copy so a later
 *  launch does not act on it a second time. */
export async function clearNotificationClick(environment: AppStateEnvironment = {}): Promise<void> {
  const store = appStateStorage(environment);
  if (!store) return;
  try {
    const cache = await store.open(APP_STATE_CACHE_NAME);
    await cache.delete(NOTIFICATION_CLICK_ENTRY);
  } catch {
    // It expires on its own (NOTIFICATION_CLICK_TTL_MS).
  }
}

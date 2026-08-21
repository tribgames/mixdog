// Browser-mode DesktopApi: when the Relay serves this page to a phone/tablet,
// install a WebSocket-backed implementation of window.mixdogDesktop before
// any module reads it.
// Inside Electron the preload bridge already exists and this is a no-op.
import type {
  DesktopApi,
  DesktopCapabilityRequest,
  DesktopCapabilityResult,
  DesktopAgentPoolRow,
  DesktopLspDiagnosticEvent,
  DesktopLspStatusEvent,
  DesktopSessionSummary,
  DesktopSessionStateUpdate,
  DesktopUpdaterState,
  SessionSnapshot,
} from '../shared/contract';
import {
  createRelayE2EEClientHandshake,
  exportRelayClaimKeyPair,
  generateRelayClaimKeyPair,
  importRelayClaimKeyPair,
  isRelayE2EEChallenge,
  openSealedRelayE2EEPairingMaterial,
  type RelayClaimKeyPair,
  type RelayE2EEChannel,
  type RelayE2EEPairingMaterial,
} from '../shared/remote-e2ee';
import { isRemotePaintProbe } from '../shared/remote-performance';
import { createKeyedListDeltaDecoder } from '../shared/list-delta';
import {
  REMOTE_PAIRING_STORAGE_KEYS,
  canReuseStoredRemoteClientRegistration,
  clearStoredRemotePairing,
  isInvalidRemotePairingClose,
  normalizeRemoteExternalUrl,
  normalizeRemoteRelayOrigin,
  readRemoteDeviceId,
} from './remote-pairing-recovery';
import { createSnapshotDeltaDecoder, markCompactWire } from '../main/state-delta';
import {
  isInstalledMobileWebAppSurface,
  isMobileRemoteSurface,
} from './mobile-surface';

const DISABLED_UPDATER: DesktopUpdaterState = { status: 'disabled' };
// OS-shell integrations (recoverable trash, open-with, reveal) are Electron
// APIs the daemon behind the relay cannot reach. Reporting them keeps a remote
// action honest instead of silently doing nothing.
const DESKTOP_ONLY_TRASH = 'Moving items to the trash is available in the desktop app only.';
const DESKTOP_ONLY_OPEN = 'Opening a file in its default app is available in the desktop app only.';
const DESKTOP_ONLY_REVEAL = 'Showing an item in the file manager is available in the desktop app only.';
const TOKEN_STORAGE_KEY = REMOTE_PAIRING_STORAGE_KEYS.token;
const SERVER_STORAGE_KEY = REMOTE_PAIRING_STORAGE_KEYS.server;
const BROWSER_ID_STORAGE_KEY = REMOTE_PAIRING_STORAGE_KEYS.browserId;
const DEVICE_STORAGE_KEY = REMOTE_PAIRING_STORAGE_KEYS.device;
const CLAIM_STORAGE_KEY = REMOTE_PAIRING_STORAGE_KEYS.claim;
const REMOTE_CREDENTIAL_READY_EVENT = 'mixdog:remote-credential-ready';
const REMOTE_CONNECTION_READY_EVENT = 'mixdog:remote-connection-ready';
const REMOTE_PAIRING_INVALID_EVENT = 'mixdog:remote-pairing-invalid';
// Sticky proof that this pairing has worked at least once. Without it a browser
// reopened while the desktop sleeps counts three quick retries and throws the
// pairing screen over a perfectly valid pairing.
const PAIRED_STORAGE_KEY = REMOTE_PAIRING_STORAGE_KEYS.paired;
const E2EE_PUBLIC_KEY_STORAGE_KEY = REMOTE_PAIRING_STORAGE_KEYS.e2eePublicKey;
const E2EE_SECRET_STORAGE_KEY = REMOTE_PAIRING_STORAGE_KEYS.e2eeSecret;

(() => {
  const w = window as Window & { mixdogDesktop?: DesktopApi };
  if (w.mixdogDesktop || typeof WebSocket === 'undefined') return;

  // The relay serves this container under /d/<deviceId>/, which is the ONE
  // thing an installed web app knows about the desktop it belongs to: an empty
  // storage container inherits nothing, but the URL its install captured says
  // whom to ask for approval. The cookie fallback covers a navigation that
  // landed outside the route.
  let serverBase = '';
  let deviceId = '';
  try {
    const storedServer = localStorage.getItem(SERVER_STORAGE_KEY) || '';
    serverBase = normalizeRemoteRelayOrigin(storedServer) || location.origin;
    if (storedServer && !normalizeRemoteRelayOrigin(storedServer)) {
      clearStoredRemotePairing(localStorage);
    }
    deviceId = readRemoteDeviceId(location.pathname, document.cookie)
      || localStorage.getItem(DEVICE_STORAGE_KEY) || '';
    if (deviceId) localStorage.setItem(DEVICE_STORAGE_KEY, deviceId);
  } catch { /* entry screen */ }

  // ?token= wins and is persisted for reconnects. Relay E2EE material rides
  // the fragment so it never reaches relay HTTP logs; strip both after use.
  let token = '';
  let e2eePublicKey = '';
  let e2eeSecret = '';
  // Credentials only ever come from an approval on the desktop, so this
  // container either already holds its own or has to ask for one. Nothing is
  // read out of the URL: the entry link carries a route, never a secret.
  try {
    token = localStorage.getItem(TOKEN_STORAGE_KEY) || '';
    e2eePublicKey = localStorage.getItem(E2EE_PUBLIC_KEY_STORAGE_KEY) || '';
    e2eeSecret = localStorage.getItem(E2EE_SECRET_STORAGE_KEY) || '';
  } catch { /* token stays empty; the entry screen asks for approval */ }
  let e2eePairing: RelayE2EEPairingMaterial | null =
    e2eePublicKey && e2eeSecret
      ? { version: 1, serverPublicKey: e2eePublicKey, pairingSecret: e2eeSecret }
      : null;
  const newBrowserId = (): string => {
    try { return crypto.randomUUID(); } catch {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
    }
  };
  let browserId = '';
  try {
    browserId = localStorage.getItem(BROWSER_ID_STORAGE_KEY) || newBrowserId();
    localStorage.setItem(BROWSER_ID_STORAGE_KEY, browserId);
  } catch {
    browserId = newBrowserId();
  }
  let clientRegistered = false;
  let registrationInFlight: Promise<void> | null = null;

  interface PendingCall { resolve: (value: unknown) => void; reject: (error: Error) => void }
  const pending = new Map<number, PendingCall>();
  const stateListeners = new Set<(snapshot: SessionSnapshot) => void>();
  const sessionListeners = new Set<(sessions: DesktopSessionSummary[]) => void>();
  const agentPoolListeners = new Set<(agents: DesktopAgentPoolRow[]) => void>();
  const sessionStateListeners = new Set<(update: DesktopSessionStateUpdate) => void>();
  const termListeners = new Set<(event: { id: string; data: string }) => void>();
  const folderChangeListeners = new Set<(dir: string) => void>();
  const lspDiagnosticsListeners = new Set<(event: DesktopLspDiagnosticEvent) => void>();
  const lspStatusListeners = new Set<(event: DesktopLspStatusEvent) => void>();
  let socket: WebSocket | null = null;
  let openPromise: Promise<WebSocket> | null = null;
  let openingSocket: WebSocket | null = null;
  let openingStartedAt = 0;
  // Last visible-session registration. The relay gates per-session transcript
  // frames on a PER CLIENT set, and a reconnect starts a fresh client record
  // with an empty one, so the shim replays this on every reopen.
  let lastVisibleSessionIds: string[] = [];
  // Push lanes this browser actually reads. Terminal output, diagnostics and
  // folder events are produced by DESKTOP activity — a build, a save — and
  // used to reach every paired phone regardless of what it had open, so a
  // phone left connected received entire build logs it never displayed.
  // Registering the lanes stops them at the source. A reconnect replays this
  // exactly like the visible-session set.
  const activeLanes = new Set<string>();
  const publishLanes = (): void => {
    void call<boolean>('setRemoteLanes', [[...activeLanes]]).catch(() => {
      // A missed registration is repaired by the reconnect replay.
    });
  };
  const laneSubscription = <T>(lane: string, listeners: Set<T>, listener: T): (() => void) => {
    listeners.add(listener);
    if (listeners.size === 1) {
      activeLanes.add(lane);
      publishLanes();
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        activeLanes.delete(lane);
        publishLanes();
      }
    };
  };
  let everConnected = false;
  let everPaired = false;
  try { everPaired = localStorage.getItem(PAIRED_STORAGE_KEY) === '1'; } catch { /* no storage */ }
  clientRegistered = canReuseStoredRemoteClientRegistration({
    everPaired,
    token,
    hasE2eePairing: Boolean(e2eePairing),
  });
  let retryMs = 500;
  let nextId = 1;
  let secureChannel: RelayE2EEChannel | null = null;
  let connectionReady = false;
  let approvalVerificationInFlight = false;
  let relayBinaryFrames = false;
  const sessionsDecoder = createKeyedListDeltaDecoder<DesktopSessionSummary>();
  const agentPoolDecoder = createKeyedListDeltaDecoder<DesktopAgentPoolRow>();

  // Another tab shares localStorage and may have re-registered this browser,
  // rotating the per-browser credential; always dial with the freshest one.
  const currentToken = (): string => {
    try {
      const stored = localStorage.getItem(TOKEN_STORAGE_KEY) || '';
      if (stored && /^[0-9a-f]{32,128}$/u.test(stored)) token = stored;
    } catch { /* keep the in-memory token */ }
    return token;
  };

  // React mounts behind the pairing layer and immediately asks for snapshots.
  // Those calls must wait for the approval handoff instead of registering with
  // an empty token and turning a healthy in-progress claim into a 401 reset.
  const waitForCredential = (): Promise<void> => {
    if (currentToken() && e2eePairing) return Promise.resolve();
    return new Promise((resolve) => {
      const ready = () => {
        if (!currentToken() || !e2eePairing) return;
        window.removeEventListener(REMOTE_CREDENTIAL_READY_EVENT, ready);
        resolve();
      };
      window.addEventListener(REMOTE_CREDENTIAL_READY_EVENT, ready);
    });
  };

  const wsUrl = (): string => {
    const auth = encodeURIComponent(currentToken());
    if (serverBase) {
      const base = new URL(serverBase);
      const scheme = base.protocol === 'https:' ? 'wss' : 'ws';
      return `${scheme}://${base.host}/ws?token=${auth}`;
    }
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${scheme}://${location.host}/ws?token=${auth}`;
  };

  const browserProfile = async (): Promise<{ name: string; platform: string; browser: string }> => {
    const userAgent = navigator.userAgent || '';
    let platform = (
      (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform
      || navigator.platform
      || 'Unknown device'
    ).slice(0, 80);
    const browser = /Edg\//u.test(userAgent) ? 'Edge'
      : /Firefox\//u.test(userAgent) ? 'Firefox'
        : /CriOS\//u.test(userAgent) ? 'Chrome'
          : /Chrome\//u.test(userAgent) ? 'Chrome'
            : /Safari\//u.test(userAgent) ? 'Safari'
              : 'Browser';
    // Device identity (user: 무슨 기기인지도 나와야): Android Chromium exposes
    // the hardware model via UA-Client Hints (e.g. "Pixel 8", "SM-S928N");
    // Apple never does, so iPhone/iPad fall back to the UA family.
    let model = '';
    try {
      const uaData = (navigator as Navigator & {
        userAgentData?: {
          getHighEntropyValues?(hints: string[]): Promise<Record<string, unknown>>;
        };
      }).userAgentData;
      if (uaData?.getHighEntropyValues) {
        const high = await uaData.getHighEntropyValues(['model', 'platform']);
        if (typeof high.model === 'string' && high.model.trim()) {
          model = high.model.trim().slice(0, 40);
        }
        if (typeof high.platform === 'string' && high.platform) {
          platform = String(high.platform).slice(0, 80);
        }
      }
    } catch { /* UA-CH unavailable; the platform label stands */ }
    if (!model) {
      if (/iPhone/u.test(userAgent)) model = 'iPhone';
      else if (/iPad|Macintosh.+Mobile/u.test(userAgent)) model = 'iPad';
    }
    // "Pixel 8 · Chrome" when the device is known; "Android · Chrome" otherwise.
    return { name: `${model || platform} · ${browser}`, platform, browser };
  };

  const ensureClientRegistration = (): Promise<void> => {
    if (clientRegistered) return Promise.resolve();
    // Single flight: the app fires several RPCs at startup and every one dials
    // connect(). Parallel registrations would each rotate this browser's
    // credential server-side, invalidating each other mid-pairing.
    registrationInFlight ??= (async () => {
      const endpoint = serverBase
        ? new URL('/client/register', serverBase).toString()
        : new URL('/client/register', location.origin).toString();
      const auth = currentToken();
      const response = await fetch(endpoint, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          // localStorage outlives cookies in installed PWAs; the bearer keeps
          // registration working when the pairing cookie is gone.
          ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
        },
        body: JSON.stringify({ clientId: browserId, ...await browserProfile() }),
      });
      if (!response.ok) {
        const failure: Error & { status?: number } = new Error(
          `Remote browser registration failed (${response.status}).`,
        );
        failure.status = response.status;
        throw failure;
      }
      const result = await response.json() as { clientId?: unknown; token?: unknown };
      if (typeof result.clientId === 'string' && result.clientId) {
        browserId = result.clientId;
        try { localStorage.setItem(BROWSER_ID_STORAGE_KEY, browserId); } catch { /* session only */ }
      }
      if (typeof result.token === 'string' && /^[0-9a-f]{32,128}$/u.test(result.token)) {
        token = result.token;
        try { localStorage.setItem(TOKEN_STORAGE_KEY, token); } catch { /* session only */ }
      }
      clientRegistered = true;
    })().finally(() => { registrationInFlight = null; });
    return registrationInFlight;
  };

  // Pairing recovery is scanner-first: the browser camera reads the secure URL
  // from Settings → Connection. Manual entry hides behind a toggle so the
  // default screen is just the viewfinder. Vanilla DOM keeps recovery working
  // before React mounts and even when the socket cannot open.
  // Chromium's install offer fires once and early — possibly before the entry
  // screen exists — so it is captured here and replayed when that screen mounts.
  let installPrompt: (Event & { prompt(): Promise<void> }) | null = null;
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event as Event & { prompt(): Promise<void> };
    document.querySelector('#mixdog-remote-pairing [data-role="install"]')
      ?.removeAttribute('hidden');
  });

  /** What an approval hands back: a credential minted for THIS container, plus
   *  E2EE material that travelled sealed to a key only this container holds. */
  const persistApproval = (
    credential: string,
    material: RelayE2EEPairingMaterial,
  ): boolean => {
    try {
      localStorage.setItem(SERVER_STORAGE_KEY, serverBase || location.origin);
      localStorage.setItem(TOKEN_STORAGE_KEY, credential);
      localStorage.setItem(E2EE_PUBLIC_KEY_STORAGE_KEY, material.serverPublicKey);
      localStorage.setItem(E2EE_SECRET_STORAGE_KEY, material.pairingSecret);
      localStorage.setItem(BROWSER_ID_STORAGE_KEY, browserId);
      if (deviceId) localStorage.setItem(DEVICE_STORAGE_KEY, deviceId);
      return true;
    } catch { return false; }
  };

  // The request already waiting on the desktop, kept across reloads: a phone OS
  // discards a backgrounded web app freely, and a forgotten request would mean
  // asking again — one more prompt on the desktop for the same connection.
  const savePendingClaim = async (
    claimId: string,
    keyPair: RelayClaimKeyPair,
  ): Promise<void> => {
    try {
      localStorage.setItem(CLAIM_STORAGE_KEY, JSON.stringify({
        claimId,
        keyPair: await exportRelayClaimKeyPair(keyPair),
      }));
    } catch { /* the approval still completes while this page lives */ }
  };

  const loadPendingClaim = async (): Promise<{
    claimId: string;
    keyPair: RelayClaimKeyPair;
  } | null> => {
    try {
      const raw = localStorage.getItem(CLAIM_STORAGE_KEY) || '';
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { claimId?: unknown; keyPair?: unknown };
      const keyPair = await importRelayClaimKeyPair(parsed.keyPair);
      if (!keyPair || typeof parsed.claimId !== 'string' || !parsed.claimId) return null;
      return { claimId: parsed.claimId, keyPair };
    } catch { return null; }
  };

  const clearPendingClaim = (): void => {
    try { localStorage.removeItem(CLAIM_STORAGE_KEY); } catch { /* private storage */ }
  };

  const waitForApprovedConnection = (): Promise<void> => {
    if (connectionReady) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        window.removeEventListener(REMOTE_CONNECTION_READY_EVENT, ready);
        window.removeEventListener(REMOTE_PAIRING_INVALID_EVENT, invalid);
      };
      const ready = () => {
        cleanup();
        resolve();
      };
      const invalid = (event: Event) => {
        cleanup();
        const message = event instanceof CustomEvent && typeof event.detail === 'string'
          ? event.detail
          : 'This device could not complete secure pairing.';
        reject(new Error(message));
      };
      window.addEventListener(REMOTE_CONNECTION_READY_EVENT, ready, { once: true });
      window.addEventListener(REMOTE_PAIRING_INVALID_EVENT, invalid, { once: true });
    });
  };

  // Approval instead of a scan. This container holds no credential and cannot
  // inherit one, so it asks the desktop its own entry route names, and the
  // answer comes back sealed to a key generated right here — the relay routes
  // the request and can open none of it.
  const requestApproval = async (
    layer: HTMLElement,
    onStatus: (text: string, failed?: boolean) => void,
  ): Promise<void> => {
    if (!deviceId) {
      onStatus('Open the link from your desktop QR code once to install this app.', true);
      return;
    }
    const base = serverBase || location.origin;
    // Resuming beats asking: the desktop may already be showing the prompt for
    // the request this app opened before it was discarded.
    const resumed = await loadPendingClaim();
    const keyPair = resumed?.keyPair ?? await generateRelayClaimKeyPair();
    let claimId = resumed?.claimId ?? '';
    const profile = await browserProfile();
    const wait = (ms: number): Promise<void> =>
      new Promise((done) => { window.setTimeout(done, ms); });
    const open = async (): Promise<string> => {
      const response = await fetch(new URL('/claim', base).toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId,
          clientId: browserId,
          publicKey: keyPair.publicKey,
          ...profile,
        }),
      });
      // 503 is the desktop being asleep or offline, which resolves itself.
      if (response.status === 503) return '';
      if (!response.ok) throw new Error(`claim refused (${response.status})`);
      const body = await response.json() as { claimId?: unknown };
      return typeof body.claimId === 'string' ? body.claimId : '';
    };
    for (;;) {
      if (!claimId) {
        try {
          claimId = await open();
        } catch {
          onStatus('This desktop no longer recognises this app. Scan its QR code again.', true);
          return;
        }
        if (!claimId) {
          onStatus('Waiting for your desktop to come online…');
          await wait(5_000);
          continue;
        }
        await savePendingClaim(claimId, keyPair);
      }
      onStatus('Waiting for approval on your desktop…');
      const deadline = Date.now() + 300_000;
      let outcome = 'expired';
      while (Date.now() < deadline) {
        await wait(2_000);
        let payload: { status?: unknown; token?: unknown; sealed?: unknown };
        try {
          const response = await fetch(
            new URL(`/claim/${encodeURIComponent(claimId)}`, base).toString(),
            { headers: { Accept: 'application/json' } },
          );
          if (!response.ok) continue;
          payload = await response.json() as typeof payload;
        } catch {
          continue;
        }
        const status = String(payload?.status || 'pending');
        if (status === 'pending') continue;
        if (status !== 'approved') {
          outcome = status;
          break;
        }
        const material = await openSealedRelayE2EEPairingMaterial(payload.sealed, keyPair);
        const credential = String(payload.token || '');
        // A box that does not open is a refused approval, never a half pairing.
        if (!material
          || !/^[0-9a-f]{32,128}$/u.test(credential)
          || !persistApproval(credential, material)) {
          clearPendingClaim();
          onStatus('That approval could not be verified.', true);
          return;
        }
        token = credential;
        e2eePairing = material;
        // Claim approval already minted this browser's credential server-side.
        clientRegistered = true;
        window.dispatchEvent(new Event(REMOTE_CREDENTIAL_READY_EVENT));
        approvalVerificationInFlight = true;
        onStatus('Approval received. Verifying the secure connection…');
        const verified = waitForApprovedConnection();
        void connect().catch(() => {
          // Transient failures stay on the reconnect loop. Permanent pairing
          // failures raise REMOTE_PAIRING_INVALID_EVENT and end this attempt.
        });
        try {
          await verified;
        } catch (error) {
          onStatus(error instanceof Error ? error.message : String(error), true);
          return;
        } finally {
          approvalVerificationInFlight = false;
        }
        clearPendingClaim();
        layer.classList.add('mrp-ok');
        const waitTitle = layer.querySelector<HTMLElement>('[data-role="wait-title"]');
        if (waitTitle) waitTitle.textContent = 'Success';
        onStatus('Securely connected. Opening Mixdog…');
        try { navigator.vibrate?.([30, 60, 30]); } catch { /* no haptics */ }
        window.setTimeout(() => layer.remove(), 900);
        return;
      }
      clearPendingClaim();
      onStatus(outcome === 'denied'
        ? 'The request was declined on your desktop.'
        : 'The request expired.', true);
      return;
    }
  };

  // Entry screen, vanilla DOM so it works before React mounts and with no
  // socket at all. Two states, decided by what this container IS: a browser
  // gets the install guide (the installed app is what pairs, never the
  // browser), and an installed app asks this desktop for approval.
  const showPairingScreen = (message: string, autoAsk = true): void => {
    if (document.getElementById('mixdog-remote-pairing')) return;
    const mobile = isMobileRemoteSurface();
    const standalone = isInstalledMobileWebAppSurface();
    const ios = /iPad|iPhone|iPod/iu.test(navigator.userAgent)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const mount = () => {
      const layer = document.createElement('div');
      layer.id = 'mixdog-remote-pairing';
      layer.innerHTML = '<style>'
        + '#mixdog-remote-pairing{position:fixed;inset:0;z-index:9999;display:grid;place-items:center;'
        + 'padding:24px;background:#0e0e0e;color:#e9e9e9;font:400 15px/22px system-ui,sans-serif;}'
        + '#mixdog-remote-pairing *{box-sizing:border-box;margin:0;}'
        + '#mixdog-remote-pairing [hidden]{display:none!important;}'
        + '@keyframes mrp-rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}'
        + '#mixdog-remote-pairing .mrp-card{display:grid;gap:14px;justify-items:center;width:100%;'
        + 'max-width:344px;padding:28px 22px calc(28px + env(safe-area-inset-bottom));'
        + 'border-radius:22px;background:#17171a;text-align:center;'
        + 'animation:mrp-rise 280ms ease-out both;}'
        + '#mixdog-remote-pairing img{width:54px;height:54px;}'
        + '#mixdog-remote-pairing b{font-size:18px;line-height:24px;}'
        + '#mixdog-remote-pairing p{color:#a8a8a8;font-size:13.5px;line-height:19px;}'
        + '#mixdog-remote-pairing ol{display:grid;gap:7px;width:100%;padding:0;list-style:none;'
        + 'text-align:left;}'
        + '#mixdog-remote-pairing li{display:flex;align-items:center;gap:10px;padding:10px 12px;'
        + 'border-radius:12px;background:rgba(255,255,255,.07);font-size:13px;line-height:18px;}'
        + '#mixdog-remote-pairing li i{flex:none;display:grid;place-items:center;width:20px;height:20px;'
        + 'border-radius:50%;background:rgba(255,255,255,.14);font-size:11.5px;font-style:normal;'
        + 'font-weight:700;}'
        + '@keyframes mrp-spin{to{transform:rotate(360deg)}}'
        + '#mixdog-remote-pairing .mrp-wait{display:grid;gap:12px;justify-items:center;width:100%;'
        + 'padding:20px 12px;border-radius:16px;background:rgba(255,255,255,.07);}'
        + '#mixdog-remote-pairing .mrp-wait i{width:26px;height:26px;border-radius:50%;'
        + 'border:2.5px solid rgba(255,255,255,.18);border-top-color:#e9e9e9;'
        + 'animation:mrp-spin 900ms linear infinite;}'
        + '#mixdog-remote-pairing.mrp-ok .mrp-wait i{border-color:#4ac885;animation:none;}'
        + '#mixdog-remote-pairing .mrp-wait b{font-size:15px;line-height:20px;}'
        + '#mixdog-remote-pairing .mrp-status{min-height:19px;color:#a8a8a8;font-size:13px;line-height:19px;}'
        + '#mixdog-remote-pairing .mrp-status.mrp-bad{color:#e5484d;}'
        + '#mixdog-remote-pairing button{width:100%;padding:13px;border:0;border-radius:12px;'
        + 'background:#e9e9e9;color:#111114;font:600 15px/20px system-ui,sans-serif;cursor:pointer;}'
        + '</style>'
        + '<main class="mrp-card">'
        + '<img src="/mixdog.svg" alt="" draggable="false"/>'
        + `<b>${standalone
          ? 'Approve this device'
          : (mobile ? 'Install Mixdog' : 'Install Mixdog on your phone')}</b>`
        + '<p data-role="note"></p>'
        + (standalone
          ? '<div class="mrp-wait"><i aria-hidden="true"></i>'
            + '<b data-role="wait-title">Waiting for approval</b></div>'
            + '<p class="mrp-status" data-role="status"></p>'
            + '<button type="button" data-role="ask" hidden>Ask again</button>'
          : (!mobile
            ? '<ol><li><i>1</i>Open this page on your phone or tablet</li>'
              + '<li><i>2</i>Install Mixdog from the mobile browser</li>'
              + '<li><i>3</i>Open the installed app and approve it on your desktop</li></ol>'
            : (ios
              ? '<ol><li><i>1</i>Tap the Share button</li>'
                + '<li><i>2</i>Choose Add to Home Screen</li>'
                + '<li><i>3</i>Open Mixdog and approve it on your desktop</li></ol>'
              : '<ol><li><i>1</i>Install Mixdog from your browser menu</li>'
                + '<li><i>2</i>Open it and approve it on your desktop</li></ol>')
              + '<button type="button" data-role="install" hidden>Install</button>'))
        + '</main>';
      const note = layer.querySelector<HTMLElement>('[data-role="note"]');
      if (note) {
        note.textContent = standalone
          ? (message || 'Mixdog needs a one-time approval from the desktop it belongs to.')
          : (mobile
            ? 'Mixdog runs as an installed mobile app. Install it, then approve it once on your desktop.'
            : 'The Mixdog web app works only when installed on a mobile device.');
      }
      const install = layer.querySelector<HTMLButtonElement>('[data-role="install"]');
      if (install && installPrompt) install.removeAttribute('hidden');
      install?.addEventListener('click', () => {
        void installPrompt?.prompt().catch(() => { /* the browser menu still works */ });
      });
      document.body.appendChild(layer);
      if (!standalone) return;
      const status = layer.querySelector<HTMLElement>('[data-role="status"]');
      const ask = layer.querySelector<HTMLButtonElement>('[data-role="ask"]');
      const setStatus = (text: string, failed?: boolean): void => {
        if (status) {
          status.textContent = text;
          status.classList.toggle('mrp-bad', failed === true);
        }
        // A failure waits for a deliberate retry. Asking again on its own is
        // exactly what turns one connection into prompt after prompt on the
        // desktop (user: 인증받고 그 화면인데도 계속 또 나오고).
        if (failed) ask?.removeAttribute('hidden');
      };
      const start = (): void => {
        ask?.setAttribute('hidden', '');
        setStatus('', false);
        void requestApproval(layer, setStatus).catch(() => {
          setStatus('Could not reach the relay. Check this device’s connection.', true);
        });
      };
      ask?.addEventListener('click', start);
      if (autoAsk) start();
      else setStatus(message || 'Open Settings → Connection, then ask again.', true);
    };
    if (document.body) mount();
    else window.addEventListener('DOMContentLoaded', mount, { once: true });
  };

  const dispatchState = (snapshot: SessionSnapshot): void => {
    for (const listener of [...stateListeners]) {
      try { listener(snapshot); } catch { /* renderer listener fault */ }
    }
  };

  // State pushes ride the same identity-prefix items delta the desktop IPC
  // uses (state-delta.ts): reassemble full snapshots here, and ask the
  // desktop for a resync when a patch does not match our base revision
  // (mid-stream join through the relay, missed frame).
  const stateDecoder = createSnapshotDeltaDecoder();
  const sessionStateDecoders = new Map<
    string,
    ReturnType<typeof createSnapshotDeltaDecoder>
  >();
  const resetDeltaState = (): void => {
    stateDecoder.reset();
    for (const decoder of sessionStateDecoders.values()) decoder.reset();
    sessionStateDecoders.clear();
    sessionsDecoder.reset();
    agentPoolDecoder.reset();
  };
  // stateResync only restores the bound-session state lane. The sessions/
  // agentPool/projection pushes and per-session sessionState lanes are
  // droppable on both relay hops and have no patch stream to expose a gap,
  // so a resync or reconnect refetches the catalog lanes here and tells the
  // renderer to re-read its per-session transcript lanes.
  const refreshBroadcastLanes = (): void => {
    void call<DesktopSessionSummary[]>('listSessions')
      .then((sessions) => {
        const list = Array.isArray(sessions) ? sessions : [];
        for (const listener of [...sessionListeners]) {
          try { listener(list); } catch { /* renderer listener fault */ }
        }
      })
      .catch(() => {});
    void call<DesktopAgentPoolRow[]>('listAgentPool')
      .then((agents) => {
        const list = Array.isArray(agents) ? agents : [];
        for (const listener of [...agentPoolListeners]) {
          try { listener(list); } catch { /* renderer listener fault */ }
        }
      })
      .catch(() => {});
    window.dispatchEvent(new Event('mixdog:remote-state-gap'));
  };
  // Unsolicited resync requests (relay drop hint, foreground wake) share one
  // short debounce: a tab that flips visibility repeatedly must not pull a
  // full transcript per flip, while a real gap still recovers immediately.
  let lastResyncAt = 0;
  let trailingResyncTimer: number | null = null;
  const requestResync = (): void => {
    const now = Date.now();
    // Even when the outbound request is debounced, never continue applying
    // patches to a known-invalid local base.
    resetDeltaState();
    const sinceLast = now - lastResyncAt;
    if (sinceLast < 3_000) {
      // TRAIL it, never drop it: a wake that lands inside the window of the
      // resync its own disconnect fired would otherwise be swallowed, and a
      // finished turn sends no further push to expose the gap.
      if (trailingResyncTimer === null) {
        trailingResyncTimer = window.setTimeout(() => {
          trailingResyncTimer = null;
          requestResync();
        }, 3_000 - sinceLast);
      }
      return;
    }
    if (trailingResyncTimer !== null) {
      window.clearTimeout(trailingResyncTimer);
      trailingResyncTimer = null;
    }
    lastResyncAt = now;
    fire('stateResync', []);
    refreshBroadcastLanes();
  };
  // Reassembly is the shared snapshot decoder's job — it already handles both
  // wire shapes (the original one and the compact frames a current desktop
  // sends), including the legacy full snapshot whose missing revision leaves
  // the next patch unverifiable. The shim only has to turn a rejected patch
  // into a resync request.
  const applyStatePayload = (payload: unknown): SessionSnapshot | null => {
    const decoded = stateDecoder.decode(payload);
    if (!decoded.ok) {
      requestResync();
      return null;
    }
    return decoded.snapshot as SessionSnapshot;
  };

  // Compact transcript envelope. The desktop addresses a session by handle
  // and sends its name once, so a live frame no longer repeats the nested
  // event/payload/sessionId trio around ~30 bytes of new text. Expanding it
  // here keeps ONE downstream code path for both shapes.
  const compactSessionNames = new Map<number, string>();
  const expandCompactFrame = (
    frame: Record<string, unknown>,
  ): Record<string, unknown> | null => {
    const handle = Number(frame.s);
    if (!Number.isSafeInteger(handle)) return null;
    const name = typeof frame.n === 'string' && frame.n
      ? frame.n
      : compactSessionNames.get(handle);
    if (!name) return null;
    compactSessionNames.set(handle, name);
    const wire = frame.w;
    // The compact payload shape is announced by this envelope rather than
    // repeated inside every frame; a full snapshot keeps its own marker and
    // must not be re-read as a patch.
    if (wire && typeof wire === 'object' && !Object.hasOwn(wire, '__itemsRevision')) {
      markCompactWire(wire as Record<string, unknown>);
    }
    return {
      event: 'sessionState',
      payload: {
        sessionId: name,
        wire,
        frameSource: frame.f ?? 'live',
        ...(frame.pp !== undefined ? { perfProbe: frame.pp } : {}),
        ...(typeof frame.cr === 'number' ? { contentRevision: frame.cr } : {}),
      },
    };
  };

  const handleMessage = (frame: Record<string, unknown>): void => {
    // Any inbound frame proves the socket is alive; pong frames carry
    // nothing else.
    awaitingPong = false;
    clearWakePongTimer();
    if ('pong' in frame) return;
    let message = frame;
    if (frame.e === 'S') {
      // Compact app-state push: same payload, envelope reduced to two keys.
      const wire = frame.w;
      if (wire && typeof wire === 'object' && !Object.hasOwn(wire, '__itemsRevision')) {
        markCompactWire(wire as Record<string, unknown>);
      }
      message = { event: 'state', payload: wire };
    } else if (frame.e === 'T') {
      const expanded = expandCompactFrame(frame);
      if (!expanded) {
        // This browser's handle map disagrees with the desktop's. Only a fresh
        // handshake rebuilds both sides, and the reconnect loop performs one.
        try { socket?.close(); } catch { /* reconnect loop takes over */ }
        return;
      }
      message = expanded;
    }
    // Relay hint: a state push was dropped for this leg (background tab, slow
    // link). The next patch would expose the gap, but a finished turn sends
    // no next patch — ask for a full snapshot now.
    if ('resync' in message) {
      requestResync();
      return;
    }
    if (typeof message.id === 'number') {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.ok === true) entry.resolve(message.value);
      else {
        const failure: Error & { code?: string } = new Error(
          typeof message.error === 'string' && message.error ? message.error : 'remote call failed.',
        );
        // Transport pass-through: the main side puts an errored call's `code`
        // on the frame (remote-methods.ts `RemoteFrameResponse.errorCode`)
        // because JSON drops custom Error properties. Putting it back here
        // keeps a remote caller on the same contract as an in-process one.
        if (typeof message.errorCode === 'string' && message.errorCode) {
          failure.code = message.errorCode;
        }
        entry.reject(failure);
      }
      return;
    }
    if (message.event === 'state') {
      const snapshot = applyStatePayload(message.payload ?? null);
      if (snapshot !== null) dispatchState(snapshot);
    } else if (message.event === 'sessions') {
      const decoded = Array.isArray(message.payload)
        ? { ok: true, items: message.payload as DesktopSessionSummary[] }
        : sessionsDecoder.decode(message.payload);
      if (!decoded.ok) {
        requestResync();
        return;
      }
      const sessions = decoded.items ?? [];
      for (const listener of [...sessionListeners]) {
        try { listener(sessions); } catch { /* renderer listener fault */ }
      }
    } else if (message.event === 'agentPool') {
      const decoded = Array.isArray(message.payload)
        ? { ok: true, items: message.payload as DesktopAgentPoolRow[] }
        : agentPoolDecoder.decode(message.payload);
      if (!decoded.ok) {
        requestResync();
        return;
      }
      const agents = decoded.items ?? [];
      for (const listener of [...agentPoolListeners]) {
        try { listener(agents); } catch { /* renderer listener fault */ }
      }
    } else if (message.event === 'sessionState') {
      const payload = message.payload as DesktopSessionStateUpdate & {
        wire?: unknown;
        perfProbe?: unknown;
      };
      if (!payload || typeof payload !== 'object' || !String(payload.sessionId || '')) return;
      const receivedAt = performance.now();
      let update: DesktopSessionStateUpdate = payload;
      if (Object.hasOwn(payload, 'wire')) {
        let decoder = sessionStateDecoders.get(payload.sessionId);
        if (!decoder) {
          decoder = createSnapshotDeltaDecoder();
          sessionStateDecoders.set(payload.sessionId, decoder);
        }
        const decoded = decoder.decode(payload.wire);
        if (!decoded.ok) {
          requestResync();
          return;
        }
        update = {
          sessionId: payload.sessionId,
          snapshot: decoded.snapshot as SessionSnapshot,
          frameSource: payload.frameSource,
          ...(typeof payload.contentRevision === 'number'
            ? { contentRevision: payload.contentRevision }
            : {}),
        };
        if (update.snapshot === null) sessionStateDecoders.delete(payload.sessionId);
      }
      for (const listener of [...sessionStateListeners]) {
        try { listener(update); } catch { /* renderer listener fault */ }
      }
      if (isRemotePaintProbe(payload.perfProbe)) {
        const probe = payload.perfProbe;
        window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
          const receiveToPaintMs = performance.now() - receivedAt;
          console.info(
            `[mixdog-remote-perf] session=${payload.sessionId}`
            + ` receive-to-paint=${receiveToPaintMs.toFixed(1)}ms`,
          );
          fire('remotePerfPaint', [probe.id, receiveToPaintMs]);
        }));
      }
    } else if (message.event === 'termData') {
      const payload = (message.payload ?? {}) as { id?: unknown; data?: unknown };
      const event = { id: String(payload.id || ''), data: String(payload.data ?? '') };
      for (const listener of [...termListeners]) {
        try { listener(event); } catch { /* renderer listener fault */ }
      }
    } else if (message.event === 'folderChanged') {
      const dir = String(message.payload || '');
      if (!dir) return;
      for (const listener of [...folderChangeListeners]) {
        try { listener(dir); } catch { /* renderer listener fault */ }
      }
    } else if (message.event === 'lspDiagnostics') {
      const payload = message.payload as DesktopLspDiagnosticEvent;
      if (!payload || typeof payload !== 'object') return;
      for (const listener of [...lspDiagnosticsListeners]) {
        try { listener(payload); } catch { /* renderer listener fault */ }
      }
    } else if (message.event === 'lspStatus') {
      const payload = message.payload as DesktopLspStatusEvent;
      if (!payload || typeof payload !== 'object') return;
      for (const listener of [...lspStatusListeners]) {
        try { listener(payload); } catch { /* renderer listener fault */ }
      }
    }
  };

  // NAT/carrier middleboxes silently drop idle WebSockets; the browser
  // cannot send protocol pings, so an app-level ping/pong detects the
  // half-dead socket and recycles it, and a foreground/online wake probe
  // reconnects immediately instead of on the next (hanging) tap.
  let heartbeatSentAt = 0;
  let awaitingPong = false;
  let wakePongTimer: number | null = null;
  const clearWakePongTimer = (): void => {
    if (wakePongTimer === null) return;
    window.clearTimeout(wakePongTimer);
    wakePongTimer = null;
  };
  window.setInterval(() => {
    const ws = socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      awaitingPong = false;
      return;
    }
    if (awaitingPong) {
      if (Date.now() - heartbeatSentAt >= 10_000) {
        awaitingPong = false;
        try { ws.close(); } catch { /* reconnect loop takes over */ }
      }
      return;
    }
    if (Date.now() - heartbeatSentAt >= 25_000) {
      heartbeatSentAt = Date.now();
      awaitingPong = true;
      try { ws.send('{"ping":1}'); } catch { /* surfaces as close */ }
    }
  }, 5_000);
  let resyncOnWake = document.visibilityState === 'hidden';
  const wakeProbe = (event?: Event): void => {
    if (document.visibilityState === 'hidden') {
      resyncOnWake = true;
      clearWakePongTimer();
      return;
    }
    const shouldResync = resyncOnWake || event?.type === 'online';
    const ws = socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      resyncOnWake = true;
      retryMs = 500;
      // A browser can leave a failed VPS handshake in CONNECTING for minutes.
      // Once the app is foregrounded, retire an old attempt so connect() does
      // not keep returning its permanently pending promise.
      if (openingSocket?.readyState === WebSocket.CONNECTING
        && Date.now() - openingStartedAt >= 1_500) {
        try { openingSocket.close(); } catch { /* close handler retries */ }
      }
      void connect().catch(() => { /* the retry loop keeps running */ });
      return;
    }
    heartbeatSentAt = Date.now();
    awaitingPong = true;
    try { ws.send('{"ping":1}'); } catch { /* surfaces as close */ }
    // Foreground recovery should not inherit the normal 10s background
    // heartbeat budget. If this exact probe gets no response, recycle the
    // half-open socket promptly and let the reconnect loop re-register lanes.
    clearWakePongTimer();
    const probeSentAt = heartbeatSentAt;
    wakePongTimer = window.setTimeout(() => {
      wakePongTimer = null;
      if (socket !== ws || !awaitingPong || heartbeatSentAt !== probeSentAt) return;
      awaitingPong = false;
      try { ws.close(); } catch { /* reconnect loop takes over */ }
    }, 2_500);
    // A live socket proves nothing about the transcript: pushes sent while
    // this tab was hidden may have been dropped for a congested leg, and a
    // finished turn never sends another patch to expose it.
    if (shouldResync) {
      resyncOnWake = false;
      requestResync();
    }
  };
  document.addEventListener('visibilitychange', wakeProbe);
  window.addEventListener('online', wakeProbe);
  window.addEventListener('focus', wakeProbe);
  window.addEventListener('pageshow', wakeProbe);

  // This credential is unrecoverable. Wipe it and hand the surface back to the
  // entry screen, which asks the desktop for a new approval; the device route
  // survives because it is a routing label, not a credential.
  const resetApprovalAndAsk = (message: string): void => {
    try {
      clearStoredRemotePairing(localStorage);
      if (deviceId) localStorage.setItem(DEVICE_STORAGE_KEY, deviceId);
    } catch { /* private storage */ }
    serverBase = location.origin;
    token = '';
    e2eePairing = null;
    everPaired = false;
    browserId = newBrowserId();
    clientRegistered = false;
    showPairingScreen(message, false);
    window.dispatchEvent(new CustomEvent(REMOTE_PAIRING_INVALID_EVENT, { detail: message }));
  };

  let reconnectTimer: number | null = null;
  const scheduleReconnect = (): void => {
    // Registration failures and socket closes can both ask for a retry in the
    // same tick; one timer serves them all.
    if (reconnectTimer !== null) return;
    const delay = retryMs;
    retryMs = Math.min(10_000, retryMs * 2);
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      void connect().catch(() => {});
    }, delay);
  };

  const connect = async (): Promise<WebSocket> => {
    await waitForCredential();
    if (socket && socket.readyState === WebSocket.OPEN && connectionReady) {
      return Promise.resolve(socket);
    }
    try {
      await ensureClientRegistration();
    } catch (error) {
      const status = (error as { status?: number } | null)?.status;
      // 401/403/409: this credential was revoked or its slot is gone — only a
      // new approval fixes it. Anything else (network, 429, 5xx) retries.
      if (status === 401 || status === 403 || status === 409) {
        // The status travels into the message on purpose: this is the one
        // failure a user can only report, never inspect.
        resetApprovalAndAsk(`This device is no longer approved (${status}).`);
      } else {
        scheduleReconnect();
      }
      throw error instanceof Error ? error : new Error(String(error));
    }
    openPromise ??= new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(wsUrl());
      openingSocket = ws;
      openingStartedAt = Date.now();
      ws.binaryType = 'arraybuffer';
      let opened = false;
      let handshakeTimer: number | null = null;
      const openingTimer = window.setTimeout(() => {
        if (opened || ws.readyState !== WebSocket.CONNECTING) return;
        try { ws.close(); } catch { /* close handler retries */ }
      }, 12_000);
      const finishOpen = () => {
        // The relay can preserve this browser socket while the desktop leg
        // redials. In that case a fresh E2EE challenge makes the already-open
        // socket temporarily unready, then this same completion path restores
        // its subscriptions without requiring a browser reconnect.
        if (opened && connectionReady) return;
        const firstReady = !opened;
        const reconnected = everConnected;
        if (firstReady) {
          opened = true;
          window.clearTimeout(openingTimer);
          if (openingSocket === ws) openingSocket = null;
        }
        connectionReady = true;
        if (handshakeTimer !== null) {
          window.clearTimeout(handshakeTimer);
          handshakeTimer = null;
        }
        retryMs = 500;
        if (!approvalVerificationInFlight) {
          document.getElementById('mixdog-remote-pairing')?.remove();
        }
        if (!everPaired) {
          everPaired = true;
          try { localStorage.setItem(PAIRED_STORAGE_KEY, '1'); } catch { /* no storage */ }
        }
        window.dispatchEvent(new Event(REMOTE_CONNECTION_READY_EVENT));
        if (everConnected) {
          // E2EE relay handshakes already trigger an authoritative full state
          // push from the desktop. Only legacy direct sockets need the RPC.
          if (!e2eePairing) {
            void call<SessionSnapshot>('getSnapshot').then(dispatchState).catch(() => {});
          }
          // The renderer only announces visible sessions when its pane set
          // CHANGES, so nothing re-registered this browser with the relay's
          // fresh client record: the phone silently stopped receiving
          // transcript frames until a session switch or a reload (user: 다른
          // 앱 갔다 들어오니 동기 안 됨). Replay it before the lane re-reads
          // below, whose replay frames pass through the same filter.
          // Encryption is asynchronous, so merely starting these RPCs in
          // order does not guarantee wire order. Finish the registration
          // before any transcript re-read can publish its recovery frame.
          void (async () => {
            if (lastVisibleSessionIds.length > 0) {
              try {
                await call<boolean>('setVisibleSessions', [lastVisibleSessionIds]);
              } catch {
                // The reconnect loop or the next pane registration retries it.
              }
            }
            // Always announced, even when empty: that is what tells the fresh
            // client record this browser speaks the lane protocol and wants
            // nothing but what it asks for.
            publishLanes();
            refreshBroadcastLanes();
          })();
        }
        resyncOnWake = false;
        everConnected = true;
        if (firstReady) resolve(ws);
        // Existing terminal panes can hold PTY ids from the relay leg that
        // just died. Notify them only after the replacement connection has
        // settled so their ensure calls cannot race the reconnecting request.
        if (reconnected) {
          queueMicrotask(() => window.dispatchEvent(new Event('mixdog:remote-reconnected')));
        }
      };
      ws.onopen = () => {
        socket = ws;
        connectionReady = false;
        secureChannel = null;
        relayBinaryFrames = false;
        if (!e2eePairing) {
          finishOpen();
          return;
        }
        handshakeTimer = window.setTimeout(() => {
          try { ws.close(); } catch { /* reconnect loop handles it */ }
        }, 10_000);
      };
      ws.onmessage = (event) => {
        void (async () => {
          if (event.data instanceof ArrayBuffer) {
            if (!secureChannel) throw new Error('Relay encryption handshake was not established.');
            const decrypted = await secureChannel.decryptJson(event.data);
            if (!decrypted || typeof decrypted !== 'object') return;
            const message = decrypted as Record<string, unknown>;
            if (message.type === 'e2ee-ready' && message.version === 1) {
              finishOpen();
              return;
            }
            if (!connectionReady) throw new Error('Relay sent data before encryption was ready.');
            handleMessage(message);
            return;
          }
          let parsed: unknown;
          try { parsed = JSON.parse(String(event.data)); } catch { return; }
          if (!parsed || typeof parsed !== 'object') return;
          const clear = parsed as Record<string, unknown>;
          awaitingPong = false;
          clearWakePongTimer();
          if ('pong' in clear) return;
          if ('resync' in clear) {
            requestResync();
            return;
          }
          if (!e2eePairing) {
            handleMessage(clear);
            return;
          }
          if (isRelayE2EEChallenge(clear)) {
            if (opened) {
              // The VPS retained this phone while its desktop leg redialed.
              // Calls sent to the old leg cannot complete; fail them now and
              // establish a new channel on the existing browser socket.
              connectionReady = false;
              resetDeltaState();
              const failure = new Error('Mixdog desktop connection restarted.');
              for (const entry of [...pending.values()]) entry.reject(failure);
              pending.clear();
            } else if (secureChannel) {
              throw new Error('Duplicate relay encryption challenge.');
            }
            secureChannel = null;
            relayBinaryFrames = clear.binaryFrames === 1;
            // Handles are per desktop leg; a new challenge starts a new map.
            compactSessionNames.clear();
            if (handshakeTimer !== null) window.clearTimeout(handshakeTimer);
            handshakeTimer = window.setTimeout(() => {
              try { ws.close(); } catch { /* reconnect loop handles it */ }
            }, 10_000);
            const handshake = await createRelayE2EEClientHandshake(e2eePairing, clear);
            secureChannel = handshake.channel;
            ws.send(JSON.stringify(handshake.hello));
            return;
          }
          if (!secureChannel) throw new Error('Relay encryption handshake was not established.');
          const decrypted = await secureChannel.decryptJson(clear);
          if (!decrypted || typeof decrypted !== 'object') return;
          const message = decrypted as Record<string, unknown>;
          if (message.type === 'e2ee-ready' && message.version === 1) {
            finishOpen();
            return;
          }
          if (!connectionReady) throw new Error('Relay sent data before encryption was ready.');
          handleMessage(message);
        })().catch(() => {
          try { ws.close(); } catch { /* reconnect loop handles it */ }
        });
      };
      ws.onclose = (event) => {
        window.clearTimeout(openingTimer);
        if (handshakeTimer !== null) window.clearTimeout(handshakeTimer);
        if (socket === ws) socket = null;
        if (openingSocket === ws) openingSocket = null;
        openPromise = null;
        connectionReady = false;
        secureChannel = null;
        relayBinaryFrames = false;
        clearWakePongTimer();
        resyncOnWake = true;
        // A new connection starts a fresh delta lane; a stale base revision
        // must never accidentally match the new encoder's numbering.
        resetDeltaState();
        const failure = new Error('Mixdog relay disconnected.');
        for (const entry of [...pending.values()]) entry.reject(failure);
        pending.clear();
        if (!opened) reject(failure);
        if (isInvalidRemotePairingClose(event)) {
          resetApprovalAndAsk(`This device is no longer approved (${event.code}).`);
          return;
        }
        scheduleReconnect();
      };
    });
    return openPromise;
  };

  const sendApplicationFrame = async (
    ws: WebSocket,
    payload: Record<string, unknown>,
  ): Promise<void> => {
    if (e2eePairing) {
      if (!secureChannel || !connectionReady) throw new Error('Relay encryption is not ready.');
      ws.send(relayBinaryFrames
        ? await secureChannel.encryptBinary(payload)
        : await secureChannel.encryptJson(payload));
      return;
    }
    ws.send(JSON.stringify(payload));
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const call = async <T = any>(method: string, params: unknown[] = []): Promise<T> => {
    const ws = await connect();
    return await new Promise<T>((resolve, reject) => {
      const id = nextId++;
      // A NAT-killed socket accepts sends and never answers: cap every RPC
      // so the UI fails fast and the socket recycles instead of hanging.
      const deadline = window.setTimeout(() => {
        if (!pending.delete(id)) return;
        reject(new Error('mixdog remote call timed out.'));
        try { ws.close(); } catch { /* reconnect loop takes over */ }
      }, 20_000);
      pending.set(id, {
        resolve: (value: unknown) => {
          window.clearTimeout(deadline);
          (resolve as (value: unknown) => void)(value);
        },
        reject: (reason: Error) => {
          window.clearTimeout(deadline);
          reject(reason);
        },
      });
      void sendApplicationFrame(ws, { id, method, params }).catch((error) => {
        pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
        try { ws.close(); } catch { /* reconnect loop handles it */ }
      });
    });
  };

  const fire = (method: string, params: unknown[]): void => {
    void connect()
      .then((ws) => sendApplicationFrame(ws, { method, params }))
      .catch(() => {});
  };

  const api: DesktopApi = {
    // Desktop-only OS integrations become inert or degrade to browser
// equivalents; everything else forwards over the relay socket.
    chooseProject: () => Promise.resolve(null),
    chooseFile: () => Promise.resolve(null),
    chooseFiles: () => Promise.resolve(null),
    startProject: (projectPath) => call('startProject', [projectPath]),
    startProjectTask: (projectPath) => call('startProjectTask', [projectPath]),
    startTask: () => call('startTask'),
    listProjects: () => call('listProjects'),
    addProject: (projectPath) => call('addProject', [projectPath]),
    openProjectInExplorer: () => Promise.resolve(),
    openExternal: (url) => {
      const target = normalizeRemoteExternalUrl(url);
      if (!target) return Promise.reject(new TypeError('url protocol is unsupported.'));
      try { window.open(target, '_blank', 'noopener'); } catch { /* popup blocked */ }
      return Promise.resolve();
    },
    renameProject: (projectPath, alias) => call('renameProject', [projectPath, alias]),
    removeProject: (projectPath) => call('removeProject', [projectPath]),
    listProjectDir: (projectPath, relDir) => call('listProjectDir', [projectPath, relDir]),
    readProjectFile: (projectPath, relPath, accessToken) =>
      call('readProjectFile', [projectPath, relPath, accessToken ?? null]),
    statProjectFile: (projectPath, relPath, accessToken) =>
      call('statProjectFile', [projectPath, relPath, accessToken ?? null]),
    writeProjectFile: (projectPath, relPath, content, expectedContent, accessToken, encoding) =>
      call('writeProjectFile', [
        projectPath, relPath, content, expectedContent, accessToken ?? null, encoding ?? null,
      ]),
    createProjectEntry: (projectPath, relDir, name, dir) =>
      call('createProjectEntry', [projectPath, relDir, name, dir === true]),
    renameProjectEntry: (projectPath, relPath, newName) =>
      call('renameProjectEntry', [projectPath, relPath, newName]),
    moveProjectEntry: (projectPath, relPath, targetDirRel) =>
      call('moveProjectEntry', [projectPath, relPath, targetDirRel]),
    copyProjectEntry: (projectPath, relPath, targetDirRel) =>
      call('copyProjectEntry', [projectPath, relPath, targetDirRel]),
    trashProjectEntry: () => Promise.reject(new Error(DESKTOP_ONLY_TRASH)),
    readEditorSettings: (projectPath, relPath, workspaceFile) =>
      call('readEditorSettings', [projectPath, relPath, workspaceFile ?? null]),
    readEditorBackup: (projectPath, relPath, accessToken) =>
      call('readEditorBackup', [projectPath, relPath, accessToken ?? null]),
    writeEditorBackup: (projectPath, relPath, content, expectedContent, accessToken) =>
      call('writeEditorBackup', [
        projectPath, relPath, content, expectedContent, accessToken ?? null,
      ]),
    deleteEditorBackup: (projectPath, relPath, accessToken) =>
      call('deleteEditorBackup', [projectPath, relPath, accessToken ?? null]),
    readInstructions: (projectPath) => call('readInstructions', [projectPath ?? null]),
    writeInstructions: (projectPath, content) =>
      call('writeInstructions', [projectPath ?? null, content]),
    codeGraphQuery: (projectPath, mode, query) =>
      call('codeGraphQuery', [projectPath, mode, query]),
    searchWorkspaceText: (projectPath, options) =>
      call('searchWorkspaceText', [projectPath, options]),
    replaceWorkspaceText: (projectPath, options, replacement, relPaths) =>
      call('replaceWorkspaceText', [projectPath, options, replacement, relPaths ?? null]),
    lspDocument: (input) => call('lspDocument', [input]),
    lspRequest: (input) => call('lspRequest', [input]),
    lspApplyWorkspaceEdit: (projectPath, writes) =>
      call('lspApplyWorkspaceEdit', [projectPath, writes]),
    subscribeLspDiagnostics: (listener) =>
      laneSubscription('editor', lspDiagnosticsListeners, listener),
    subscribeLspStatus: (listener) =>
      laneSubscription('editor', lspStatusListeners, listener),
    // ── Explorer pane (absolute-path local browsing) ───────────────────────
    // Native pickers belong to the desktop window; every caller already reads
    // null as "nothing was chosen".
    chooseFolder: () => Promise.resolve(null),
    chooseWorkspace: () => Promise.resolve(null),
    saveWorkspace: (workspaceFile, folders) =>
      call('saveWorkspace', [workspaceFile ?? null, folders]),
    listFolderDir: (dir) => call('listFolderDir', [dir]),
    folderPlaces: () => call('folderPlaces'),
    createFolderEntry: (dir, name, isDir) => call('createFolderEntry', [dir, name, isDir === true]),
    renameFolderEntry: (path, newName) => call('renameFolderEntry', [path, newName]),
    moveFolderEntry: (paths, targetDir, strategy) =>
      call('moveFolderEntry', [paths, targetDir, strategy ?? 'ask']),
    copyFolderEntry: (paths, targetDir) => call('copyFolderEntry', [paths, targetDir]),
    trashFolderEntry: () => Promise.reject(new Error(DESKTOP_ONLY_TRASH)),
    openFolderEntry: () => Promise.reject(new Error(DESKTOP_ONLY_OPEN)),
    revealFolderEntry: () => Promise.reject(new Error(DESKTOP_ONLY_REVEAL)),
    // Shell-rendered icons cannot cross the wire; the pane's own glyphs stand in.
    folderEntryIcon: () => Promise.resolve(''),
    // Only Electron's webUtils can name an OS-dropped file. A browser drop
    // carries the File itself, which the composer reads without a path.
    folderPathForFile: () => '',
    folderWatch: (dir, recursive) => call('folderWatch', [dir, recursive === true]),
    folderUnwatch: (dir, recursive) => call('folderUnwatch', [dir, recursive === true]),
    subscribeFolderChanges: (listener) =>
      laneSubscription('files', folderChangeListeners, listener),
    resolveLocalPaths: (paths) => call('resolveLocalPaths', [paths]),
    readLocalFile: (path) => call('readLocalFile', [path]),
    listSessions: () => call('listSessions'),
    subscribeSessions: (listener) => {
      sessionListeners.add(listener);
      return () => { sessionListeners.delete(listener); };
    },
    listAgentPool: () => call('listAgentPool'),
    subscribeAgentPool: (listener) => {
      agentPoolListeners.add(listener);
      return () => { agentPoolListeners.delete(listener); };
    },
    renameSession: (sessionId, title) => call('renameSession', [sessionId, title]),
    setSessionArchived: (sessionId: string, archived: boolean) =>
      call('setSessionArchived', [sessionId, archived]),
    deleteSession: (sessionId) => call('deleteSession', [sessionId]),
    // Cold session lanes fill through a host-side read; the replay frame
    // arrives on the broadcast sessionState event like any live push.
    prefetchSession: (sessionId) => call<boolean>('prefetchSession', [sessionId]),
    setVisibleSessions: (sessionIds) => {
      lastVisibleSessionIds = [...sessionIds];
      return call<boolean>('setVisibleSessions', [lastVisibleSessionIds]);
    },
    searchProjectFiles: (projectIdOrWorkspaceId, query, limit) =>
      call('searchProjectFiles', [projectIdOrWorkspaceId, query, limit]),
    getSnapshot: () => call('getSnapshot'),
    subscribeState: (listener) => {
      stateListeners.add(listener);
      return () => { stateListeners.delete(listener); };
    },
    // No perfLog: the Composer's keystroke paint sampler keys on its presence,
    // and a phone should not pay a double-rAF per keystroke to feed a no-op.
    rendererReady: () => {},
    termEnsure: (id, cwd, shell) => call('termEnsure', [id, cwd ?? null, shell ?? null]),
    termProfiles: () => call('termProfiles'),
    termWrite: (id, data) => fire('termWrite', [id, data]),
    termResize: (id, cols, rows) => fire('termResize', [id, cols, rows]),
    termDispose: (id) => call('termDispose', [id]),
    subscribeTermData: (listener) => laneSubscription('terminal', termListeners, listener),
    gitStatus: (cwd, options) => call('gitStatus', [cwd, options]),
    gitBranches: (cwd) => call('gitBranches', [cwd]),
    gitCheckoutBranch: (cwd, branch, remote) =>
      call('gitCheckoutBranch', [cwd, branch, remote === true]),
    gitCreateBranch: (cwd, branch) => call('gitCreateBranch', [cwd, branch]),
    gitRenameBranch: (cwd, branch, nextBranch) =>
      call('gitRenameBranch', [cwd, branch, nextBranch]),
    gitDeleteBranch: (cwd, branch) => call('gitDeleteBranch', [cwd, branch]),
    gitMergeBranch: (cwd, branch) => call('gitMergeBranch', [cwd, branch]),
    gitDiff: (cwd, path, staged, worktreeOnly, untracked) =>
      call('gitDiff', [cwd, path, staged === true, worktreeOnly === true, untracked === true]),
    gitApplyPatch: (cwd, path, patch, reverse) =>
      call('gitApplyPatch', [cwd, path, patch, reverse === true]),
    gitStage: (cwd, paths) => call('gitStage', [cwd, paths]),
    gitUnstage: (cwd, paths) => call('gitUnstage', [cwd, paths]),
    gitIgnore: (cwd, path, scope) => call('gitIgnore', [cwd, path, scope]),
    gitCommit: (cwd, message) => call('gitCommit', [cwd, message]),
    gitCommitPaths: (cwd, message, paths) => call('gitCommitPaths', [cwd, message, paths]),
    gitAmend: (cwd, message) => call('gitAmend', [cwd, message]),
    gitUndoLastCommit: (cwd) => call('gitUndoLastCommit', [cwd]),
    gitStash: (cwd, message) => call('gitStash', [cwd, message]),
    gitStashPop: (cwd) => call('gitStashPop', [cwd]),
    gitPush: (cwd) => call('gitPush', [cwd]),
    gitFetch: (cwd) => call('gitFetch', [cwd]),
    gitPull: (cwd) => call('gitPull', [cwd]),
    gitSync: (cwd) => call('gitSync', [cwd]),
    gitContinue: (cwd) => call('gitContinue', [cwd]),
    gitAbortOperation: (cwd) => call('gitAbortOperation', [cwd]),
    gitRevert: (cwd, path, untracked, mode) =>
      call('gitRevert', [cwd, path, untracked === true, mode]),
    gitLog: (cwd, query, skip, limit) => call('gitLog', [cwd, query, skip, limit]),
    gitShow: (cwd, hash) => call('gitShow', [cwd, hash]),
    gitShowDiff: (cwd, hash, path) => call('gitShowDiff', [cwd, hash, path]),
    // The confirmation flag is part of the call: dropping it made every
    // confirmed dirty `--mixed` reset ask again on the main side.
    gitResetToCommit: (cwd, hash, mode, confirmedDirty) =>
      call('gitResetToCommit', [cwd, hash, mode, confirmedDirty === true]),
    gitRevertCommit: (cwd, hash) => call('gitRevertCommit', [cwd, hash]),
    gitCherryPickCommit: (cwd, hash) => call('gitCherryPickCommit', [cwd, hash]),
    gitCreateTag: (cwd, tag, hash) => call('gitCreateTag', [cwd, tag, hash]),
    gitDeleteTag: (cwd, tag) => call('gitDeleteTag', [cwd, tag]),
    gitCheckoutCommit: (cwd, hash) => call('gitCheckoutCommit', [cwd, hash]),
    gitCreateBranchAtCommit: (cwd, branch, hash) =>
      call('gitCreateBranchAtCommit', [cwd, branch, hash]),
    gitReview: (cwd) => call('gitReview', [cwd]),
    gitReviewDiff: (cwd, path, untracked) => call('gitReviewDiff', [cwd, path, untracked === true]),
    gitStashList: (cwd) => call('gitStashList', [cwd]),
    gitStashApply: (cwd, ref) => call('gitStashApply', [cwd, ref]),
    gitStashDrop: (cwd, ref) => call('gitStashDrop', [cwd, ref]),
    gitShowFile: (cwd, rev, path) => call('gitShowFile', [cwd, rev, path]),
    gitGenerateCommitMessage: (cwd, files) => call('gitGenerateCommitMessage', [cwd, files]),
    gitGlobalConfig: () => call('gitGlobalConfig'),
    setGitGlobalConfig: (key, value) => call('setGitGlobalConfig', [key, value]),
    readGitPreferences: () => call('readGitPreferences'),
    updateGitPreferences: (preferences) => call('updateGitPreferences', [preferences]),
    // gh runs on the desktop machine and its login is a DEVICE flow, so the
    // phone shows the same code and finishes it in its own browser.
    githubStarStatus: () => call('githubStarStatus'),
    starGithub: () => call('starGithub'),
    githubCliStatus: () => call('githubCliStatus'),
    installGithubCli: () => call('installGithubCli'),
    githubCliLoginStart: () => call('githubCliLoginStart'),
    githubCliLoginStatus: (flowId) => call('githubCliLoginStatus', [flowId]),
    githubCliLoginCancel: (flowId) => call('githubCliLoginCancel', [flowId]),
    githubCliLogout: () => call('githubCliLogout'),
    githubCliAccount: () => call('githubCliAccount'),
    revealFile: () => Promise.resolve(),
    openFilePath: () => Promise.resolve(),
    getUpdaterState: () => Promise.resolve(DISABLED_UPDATER),
    subscribeUpdaterState: () => () => {},
    checkForDesktopUpdate: () => Promise.resolve(DISABLED_UPDATER),
    showDesktopUpdate: () => Promise.resolve(DISABLED_UPDATER),
    submitNewTask: (prompt, options, draft) => call('submitNewTask', [prompt, options, draft]),
    submitToSession: (sessionId, prompt, options) =>
      call('submitToSession', [sessionId, prompt, options]),
    abortSession: (sessionId, options = {}) => call('abortSession', [sessionId, options]),
    resolveToolApprovalForSession: (sessionId, id, decision) =>
      call('resolveToolApprovalForSession', [sessionId, id, decision]),
    subscribeSessionState: (listener) => {
      sessionStateListeners.add(listener);
      return () => { sessionStateListeners.delete(listener); };
    },
    inheritSession: (sourceSessionId, selection) =>
      call('inheritSession', [sourceSessionId, selection ?? null]),
    listProviderModels: (options) => call('listProviderModels', [options]),
    setModelRoute: (selection, sessionId) => call('setModelRoute', [selection, sessionId]),
    setFast: (enabled, sessionId) => call('setFast', [enabled, sessionId]),
    readSettings: () => call('readSettings'),
    updateSetting: (key, enabled) => call('updateSetting', [key, enabled]),
    getZoomFactor: () => Promise.resolve(1),
    setZoomFactor: () => {
      document.documentElement.style.removeProperty('zoom');
      try { window.localStorage.removeItem('mixdog.web-zoom'); } catch { /* private storage */ }
      return Promise.resolve(1);
    },
    onZoomFactorChanged: () => () => {},
    applyTitleBarTheme: () => Promise.resolve(),
    setTitleBarDim: () => Promise.resolve(),
    invokeCapability: <T = unknown>(request: DesktopCapabilityRequest) =>
      call<DesktopCapabilityResult<T>>('invokeCapability', [request]),
    readCapabilities: (requests) => call('readCapabilities', [requests]),
    // Gallery bytes ride HTTP, not this socket: the browser caches tiles and
    // asks for byte ranges when a clip seeks. A host that does not serve the
    // lane answers 404 and the caller falls back to the RPC payload.
    mediaUrl: (assetId, variant) => {
      const base = serverBase || location.origin;
      const auth = currentToken();
      const query = `variant=${encodeURIComponent(variant || 'original')}`
        + (auth ? `&token=${encodeURIComponent(auth)}` : '');
      return `${base}/media/${encodeURIComponent(assetId)}?${query}`;
    },
    quit: () => Promise.resolve(),
  };

  w.mixdogDesktop = Object.freeze(api);
  // Settings → Connection on a remote surface: expose where this session is
  // connected so the panel shows live status instead of desktop-only pairing.
  (w as unknown as { mixdogRemoteServer?: string }).mixdogRemoteServer =
    serverBase || location.origin;
  // A browser tab always gets the install guide. A desktop-installed PWA is
  // also guide-only: only an installed phone/tablet app may hold a credential
  // and dial the relay.
  if (!isInstalledMobileWebAppSurface() || !token) {
    showPairingScreen('');
    return;
  }
  if (!e2eePairing) {
    resetApprovalAndAsk('This device has incomplete approval data. Ask for approval again.');
    return;
  }
  void connect().catch(() => { /* the retry loop keeps running */ });
})();

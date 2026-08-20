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
  DesktopRemoteProjectionState,
  DesktopSessionSummary,
  DesktopStateFieldsPatch,
  DesktopStateStreamingTailPatch,
  DesktopSessionStateUpdate,
  DesktopTranscriptItem,
  DesktopUpdaterState,
  SessionSnapshot,
} from '../shared/contract';
import {
  createRelayE2EEClientHandshake,
  isRelayE2EEChallenge,
  type RelayE2EEChannel,
  type RelayE2EEPairingMaterial,
} from '../shared/remote-e2ee';
import { isRemotePaintProbe } from '../shared/remote-performance';
import { createKeyedListDeltaDecoder } from '../shared/list-delta';
import {
  REMOTE_PAIRING_STORAGE_KEYS,
  clearStoredRemotePairing,
  isInvalidRemotePairingClose,
  normalizeRemoteExternalUrl,
  normalizeRemoteRelayOrigin,
  parseRemotePairingLink,
  readRemotePairingLink,
  storeRemotePairingLink,
} from './remote-pairing-recovery';
import { isIosInstallPlatform } from './remote-install';
import { createSnapshotDeltaDecoder, markCompactWire } from '../main/state-delta';

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
// Sticky proof that this pairing has worked at least once. Without it a browser
// reopened while the desktop sleeps counts three quick retries and throws the
// pairing screen over a perfectly valid pairing.
const PAIRED_STORAGE_KEY = REMOTE_PAIRING_STORAGE_KEYS.paired;
const E2EE_PUBLIC_KEY_STORAGE_KEY = REMOTE_PAIRING_STORAGE_KEYS.e2eePublicKey;
const E2EE_SECRET_STORAGE_KEY = REMOTE_PAIRING_STORAGE_KEYS.e2eeSecret;

(() => {
  const w = window as Window & { mixdogDesktop?: DesktopApi };
  if (w.mixdogDesktop || typeof WebSocket === 'undefined') return;

  // A pairing recovery can redirect this browser to another relay origin, so
  // retain that origin alongside the token until a new QR link replaces it.
  let serverBase = '';
  let pairingRedirectUrl = '';
  try {
    const storedServer = localStorage.getItem(SERVER_STORAGE_KEY) || '';
    serverBase = normalizeRemoteRelayOrigin(storedServer);
    if (storedServer && !serverBase) clearStoredRemotePairing(localStorage);
  } catch { /* pairing screen */ }

  // ?token= wins and is persisted for reconnects. Relay E2EE material rides
  // the fragment so it never reaches relay HTTP logs; strip both after use.
  let token = '';
  let e2eePublicKey = '';
  let e2eeSecret = '';
  try {
    const params = new URLSearchParams(location.search);
    const fromUrl = params.get('token');
    if (fromUrl) {
      const parsed = parseRemotePairingLink(location.href);
      if (parsed) {
        token = parsed.token;
        e2eePublicKey = parsed.serverPublicKey;
        e2eeSecret = parsed.pairingSecret;
        serverBase = parsed.origin;
        localStorage.setItem(TOKEN_STORAGE_KEY, parsed.token);
        localStorage.setItem(E2EE_PUBLIC_KEY_STORAGE_KEY, parsed.serverPublicKey);
        localStorage.setItem(E2EE_SECRET_STORAGE_KEY, parsed.pairingSecret);
        localStorage.setItem(SERVER_STORAGE_KEY, parsed.origin);
        storeRemotePairingLink(localStorage, parsed);
      } else {
        clearStoredRemotePairing(localStorage);
        serverBase = '';
      }
      params.delete('token');
      params.delete('e2eeKey');
      params.delete('e2eeSecret');
      const query = params.toString();
      history.replaceState(null, '', location.pathname + (query ? `?${query}` : ''));
    } else {
      token = localStorage.getItem(TOKEN_STORAGE_KEY) || '';
      e2eePublicKey = localStorage.getItem(E2EE_PUBLIC_KEY_STORAGE_KEY) || '';
      e2eeSecret = localStorage.getItem(E2EE_SECRET_STORAGE_KEY) || '';
    }
  } catch { /* token stays empty; the relay refuses the socket */ }
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
  const projectionListeners = new Set<(state: DesktopRemoteProjectionState) => void>();
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
  let everConnected = false;
  let everPaired = false;
  try { everPaired = localStorage.getItem(PAIRED_STORAGE_KEY) === '1'; } catch { /* no storage */ }
  let retryMs = 500;
  let nextId = 1;
  let secureChannel: RelayE2EEChannel | null = null;
  let connectionReady = false;
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
  let stopPairingCamera: (() => void) | null = null;

  const installedStandalone = (): boolean => {
    try {
      return window.matchMedia('(display-mode: standalone)').matches
        || (navigator as Navigator & { standalone?: boolean }).standalone === true;
    } catch { return false; }
  };

  // An iOS Home Screen app runs in its OWN storage container: the pairing this
  // browser holds is invisible there, which is why an installed app landed on
  // the scanner. Pointing the manifest at the variant WITHOUT start_url makes
  // the install capture the launching document URL instead, and that URL is
  // what carries the scanned link across (RemoteInstallPrompt restores it right
  // before the Share sheet). Only a pairing that has actually connected may be
  // handed over. Chromium keeps the canonical manifest: start_url belongs to
  // its installability criteria.
  let inheritManifestLinked = false;
  const linkInheritManifest = (): void => {
    if (inheritManifestLinked || !everPaired || installedStandalone()) return;
    if (!isIosInstallPlatform(navigator.userAgent, navigator.platform, navigator.maxTouchPoints)) {
      return;
    }
    if (!readRemotePairingLink(localStorage)) return;
    const manifest = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
    if (!manifest) return;
    inheritManifestLinked = true;
    manifest.href = '/manifest.webmanifest?inherit=1';
  };

  const persistPairing = (raw: string): boolean => {
    try {
      const parsed = parseRemotePairingLink(raw);
      if (!parsed) return false;
      pairingRedirectUrl = parsed.url;
      serverBase = parsed.origin;
      localStorage.setItem(SERVER_STORAGE_KEY, parsed.origin);
      localStorage.setItem(TOKEN_STORAGE_KEY, parsed.token);
      localStorage.setItem(E2EE_PUBLIC_KEY_STORAGE_KEY, parsed.serverPublicKey);
      localStorage.setItem(E2EE_SECRET_STORAGE_KEY, parsed.pairingSecret);
      storeRemotePairingLink(localStorage, parsed);
      if (!browserId) {
        browserId = newBrowserId();
        localStorage.setItem(BROWSER_ID_STORAGE_KEY, browserId);
      }
      clientRegistered = false;
      // A new desktop has to prove itself again before it counts as reachable.
      localStorage.removeItem(PAIRED_STORAGE_KEY);
      everPaired = false;
      return true;
    } catch { return false; }
  };

  // Visible confirmation between "QR read" and the reload that dials the
  // desktop — green brackets, check badge and a haptic tick, the way system
  // scanners settle. Without it the screen just blinks and the scan feels
  // ignored.
  const completePairing = (layer: HTMLElement): void => {
    stopPairingCamera?.();
    layer.classList.add('mrp-ok');
    layer.querySelector('.mrp-success')?.removeAttribute('hidden');
    try { navigator.vibrate?.([30, 60, 30]); } catch { /* no haptics */ }
    // Long enough for the lock pulse + check draw + caption to play out.
    const target = pairingRedirectUrl;
    window.setTimeout(() => {
      if (target) location.assign(target);
      else location.reload();
    }, 1250);
  };

  const startPairingScanner = async (
    video: HTMLVideoElement,
    onPaired: () => void,
    onUnavailable: (reason: string) => void,
  ): Promise<void> => {
    stopPairingCamera?.(); // toggling modes must never stack two streams
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
    } catch {
      onUnavailable('Camera unavailable — paste the address below instead.');
      return;
    }
    let live = true;
    stopPairingCamera = () => {
      live = false;
      stopPairingCamera = null;
      for (const track of stream.getTracks()) track.stop();
    };
    video.srcObject = stream;
    await video.play().catch(() => {});
    // Only reveal the element once frames actually flow, avoiding the
    // browser's oversized play glyph over the empty video surface.
    video.classList.add('live');
    const { default: jsQR } = await import('jsqr');
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const tick = (): void => {
      if (!live) return;
      if (context && video.videoWidth > 0) {
        // Downscale before decoding: jsQR walks every pixel and ~500px is
        // plenty of resolution for a phone-sized QR.
        const scale = Math.min(1, 500 / video.videoWidth);
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const image = context.getImageData(0, 0, canvas.width, canvas.height);
        const hit = jsQR(image.data, image.width, image.height);
        if (hit?.data && persistPairing(hit.data)) {
          onPaired();
          return;
        }
      }
      window.setTimeout(tick, 250);
    };
    tick();
  };

  // Full-screen scanner in the mobile camera grammar: edge-to-edge preview,
  // a dimmed mask with a clear
  // center aperture marked by four corner brackets, instructions in a top
  // scrim, and manual entry demoted to a bottom-sheet behind a pill button.
  const showPairingScreen = (message: string): void => {
    if (document.getElementById('mixdog-remote-pairing')) return;
    const mount = () => {
      const layer = document.createElement('div');
      layer.id = 'mixdog-remote-pairing';
      layer.innerHTML = '<style>'
        + '#mixdog-remote-pairing{position:fixed;inset:0;z-index:9999;overflow:hidden;background:#0e0e0e;'
        + 'color:#e9e9e9;font:400 15px/22px system-ui,sans-serif;--mrp-ap:min(68vw,280px);}'
        + '#mixdog-remote-pairing *{box-sizing:border-box;margin:0;}'
        + '#mixdog-remote-pairing [hidden]{display:none!important;}'
        + '#mixdog-remote-pairing .mrp-cam{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;'
        + 'opacity:0;transition:opacity 200ms ease;}'
        + '#mixdog-remote-pairing .mrp-cam.live{opacity:1;}'
        + '#mixdog-remote-pairing .mrp-cam::-webkit-media-controls,'
        + '#mixdog-remote-pairing .mrp-cam::-webkit-media-controls-overlay-play-button,'
        + '#mixdog-remote-pairing .mrp-cam::-webkit-media-controls-start-playback-button'
        + '{display:none!important;-webkit-appearance:none;}'
        + '#mixdog-remote-pairing .mrp-hole{position:absolute;left:50%;top:44%;width:var(--mrp-ap);'
        + 'height:var(--mrp-ap);transform:translate(-50%,-50%);border-radius:24px;'
        + 'box-shadow:0 0 0 200vmax rgba(14,13,12,.55);}'
        + '#mixdog-remote-pairing .mrp-ap{position:absolute;left:50%;top:44%;width:var(--mrp-ap);'
        + 'height:var(--mrp-ap);transform:translate(-50%,-50%);pointer-events:none;}'
        + '@keyframes mrp-breathe{0%,100%{opacity:1}50%{opacity:.55}}'
        + '#mixdog-remote-pairing .mrp-ap span{position:absolute;width:34px;height:34px;'
        + 'border:0 solid rgba(255,255,255,.95);transition:border-color 200ms;'
        + 'animation:mrp-breathe 2.4s ease-in-out infinite;}'
        + '#mixdog-remote-pairing .mrp-ap .tl{top:-3px;left:-3px;border-top-width:4px;border-left-width:4px;border-top-left-radius:20px;}'
        + '#mixdog-remote-pairing .mrp-ap .tr{top:-3px;right:-3px;border-top-width:4px;border-right-width:4px;border-top-right-radius:20px;}'
        + '#mixdog-remote-pairing .mrp-ap .bl{bottom:-3px;left:-3px;border-bottom-width:4px;border-left-width:4px;border-bottom-left-radius:20px;}'
        + '#mixdog-remote-pairing .mrp-ap .br{bottom:-3px;right:-3px;border-bottom-width:4px;border-right-width:4px;border-bottom-right-radius:20px;}'
        + '#mixdog-remote-pairing.mrp-ok .mrp-ap span{border-color:#4ac885;animation:none;opacity:1;}'
        + '@keyframes mrp-lock{0%{transform:translate(-50%,-50%) scale(1)}'
        + '45%{transform:translate(-50%,-50%) scale(.92)}100%{transform:translate(-50%,-50%) scale(1)}}'
        + '#mixdog-remote-pairing.mrp-ok .mrp-ap{animation:mrp-lock 320ms cubic-bezier(.34,1.56,.64,1);}'
        + '#mixdog-remote-pairing .mrp-hole{transition:box-shadow 420ms ease;}'
        + '#mixdog-remote-pairing.mrp-ok .mrp-hole{box-shadow:0 0 0 200vmax rgba(14,13,12,.8);}'
        + '#mixdog-remote-pairing .mrp-top{position:absolute;left:0;right:0;top:0;display:grid;gap:6px;'
        + 'padding:calc(30px + env(safe-area-inset-top)) 28px 44px;text-align:center;'
        + 'background:linear-gradient(rgba(14,13,12,.78),rgba(14,13,12,0));}'
        + '#mixdog-remote-pairing .mrp-top b{font-size:18px;line-height:24px;text-shadow:0 1px 8px rgba(0,0,0,.55);}'
        + '#mixdog-remote-pairing .mrp-top span{color:rgba(244,242,238,.75);font-size:13px;line-height:18px;'
        + 'text-shadow:0 1px 6px rgba(0,0,0,.55);}'
        + '#mixdog-remote-pairing .mrp-bottom{position:absolute;left:0;right:0;bottom:0;display:grid;'
        + 'place-items:center;padding:36px 24px calc(30px + env(safe-area-inset-bottom));'
        + 'background:linear-gradient(rgba(14,13,12,0),rgba(14,13,12,.78));}'
        + '#mixdog-remote-pairing .mrp-manual{padding:12px 22px;border:1px solid rgba(255,255,255,.16);'
        + 'border-radius:999px;background:rgba(24,24,24,.72);color:#e9e9e9;'
        + 'font:500 14px/20px system-ui,sans-serif;cursor:pointer;'
        + '-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);}'
        + '#mixdog-remote-pairing .mrp-sheet{position:absolute;inset:0;z-index:2;}'
        + '#mixdog-remote-pairing .mrp-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.5);}'
        + '#mixdog-remote-pairing form{position:absolute;left:0;right:0;bottom:0;display:grid;gap:12px;'
        + 'padding:22px 20px calc(22px + env(safe-area-inset-bottom));border-radius:20px 20px 0 0;'
        + 'background:#111114;}'
        + '#mixdog-remote-pairing form b{font-size:16px;line-height:22px;}'
        + '#mixdog-remote-pairing form small{color:#a8a8a8;font-size:12.5px;line-height:17px;}'
        + '#mixdog-remote-pairing form small[data-role="err"]{color:#e5484d;}'
        + '#mixdog-remote-pairing input{width:100%;padding:12px;border-radius:10px;border:1px solid #3c3c3c;'
        + 'background:#222225;color:inherit;font-size:16px;}'
        + '#mixdog-remote-pairing .mrp-connect{padding:13px;border:0;border-radius:12px;background:#e9e9e9;'
        + 'color:#111114;font-weight:600;font-size:15px;cursor:pointer;}'
        + '#mixdog-remote-pairing .mrp-paste{padding:12px;border:1px solid #3c3c3c;border-radius:12px;'
        + 'background:#222225;color:inherit;font-weight:600;font-size:15px;cursor:pointer;}'
        + '#mixdog-remote-pairing .mrp-back{justify-self:center;padding:6px 10px;border:0;background:none;'
        + 'color:#a8a8a8;font:500 13.5px/18px system-ui,sans-serif;cursor:pointer;}'
        + '@keyframes mrp-fade{from{opacity:0}to{opacity:1}}'
        + '@keyframes mrp-pop{0%{transform:scale(.35);opacity:0}55%{transform:scale(1.12);opacity:1}'
        + '100%{transform:scale(1);opacity:1}}'
        + '@keyframes mrp-draw{to{stroke-dashoffset:0}}'
        + '@keyframes mrp-rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}'
        // Success settles INSIDE the aperture (user: the check belongs at the
        // camera window's center): the scan box itself seals with the badge.
        + '#mixdog-remote-pairing .mrp-success{position:absolute;left:50%;top:44%;'
        + 'width:var(--mrp-ap);height:var(--mrp-ap);transform:translate(-50%,-50%);'
        + 'z-index:3;display:grid;place-content:center;justify-items:center;gap:12px;'
        + 'border-radius:24px;background:rgba(14,13,12,.66);'
        + 'animation:mrp-fade 240ms ease both;}'
        + '#mixdog-remote-pairing .mrp-success svg{width:72px;height:72px;'
        + 'animation:mrp-pop 420ms 120ms cubic-bezier(.34,1.56,.64,1) both;}'
        + '#mixdog-remote-pairing .mrp-success circle{fill:#2f6b46;}'
        + '#mixdog-remote-pairing .mrp-success path{fill:none;stroke:#e9e9e9;stroke-width:5;'
        + 'stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:44;stroke-dashoffset:44;'
        + 'animation:mrp-draw 340ms 380ms ease-out forwards;}'
        + '#mixdog-remote-pairing .mrp-success span{font-size:15px;font-weight:600;'
        + 'animation:mrp-rise 300ms 480ms ease-out both;}'
        + '#mixdog-remote-pairing.mrp-nocam .mrp-cam,#mixdog-remote-pairing.mrp-nocam .mrp-hole,'
        + '#mixdog-remote-pairing.mrp-nocam .mrp-ap,#mixdog-remote-pairing.mrp-nocam .mrp-bottom,'
        + '#mixdog-remote-pairing.mrp-nocam .mrp-backdrop,#mixdog-remote-pairing.mrp-nocam .mrp-back'
        + '{display:none!important;}'
        + '</style>'
        + '<video class="mrp-cam" playsinline muted autoplay></video>'
        + '<div class="mrp-hole"></div>'
        + '<div class="mrp-ap"><span class="tl"></span><span class="tr"></span>'
        + '<span class="bl"></span><span class="br"></span></div>'
        + '<header class="mrp-top"><b>Connect to your Mixdog desktop</b>'
        + '<span data-role="note"></span></header>'
        + '<footer class="mrp-bottom">'
        + '<button type="button" class="mrp-manual">Enter address manually</button></footer>'
        + '<div class="mrp-sheet" hidden>'
        + '<div class="mrp-backdrop" data-role="close"></div>'
        + '<form><b>Connect with an address</b>'
        + '<small>Copy the browser link from Settings → Connection on your desktop and paste it here.</small>'
        + '<button type="button" class="mrp-paste" hidden>Paste the link</button>'
        + '<input name="address" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false"'
        + ' placeholder="https://… link with ?token=…" />'
        + '<small data-role="err" hidden>That does not look like a Mixdog link — paste the full address including ?token=…</small>'
        + '<button type="submit" class="mrp-connect">Connect</button>'
        + '<button type="button" class="mrp-back" data-role="close">Scan the QR instead</button></form></div>'
        + '<div class="mrp-success" hidden>'
        + '<svg viewBox="0 0 72 72" aria-hidden="true"><circle cx="36" cy="36" r="34"/>'
        + '<path d="M22 38l10 10 19-21"/></svg>'
        + '<span>Paired — connecting…</span></div>';
      const note = layer.querySelector<HTMLSpanElement>('[data-role="note"]');
      const video = layer.querySelector<HTMLVideoElement>('.mrp-cam');
      const sheet = layer.querySelector<HTMLDivElement>('.mrp-sheet');
      const form = layer.querySelector('form');
      const input = layer.querySelector('input');
      const error = layer.querySelector<HTMLElement>('[data-role="err"]');
      // A Home Screen app keeps its own storage container, so a pairing made in
      // Safari never reaches it. Say that, instead of implying a broken link.
      if (note) {
        note.textContent = installedStandalone()
          ? 'Home Screen apps keep their own storage. Paste the link copied in Safari, or scan the QR once.'
          : message;
      }
      if (input && serverBase) input.value = serverBase;
      layer.querySelector('.mrp-manual')?.addEventListener('click', () => {
        sheet?.removeAttribute('hidden');
        input?.focus();
      });
      // Reading the clipboard needs a user gesture and, on iOS, a permission
      // tap: the handoff is a button here, never an automatic probe.
      const paste = layer.querySelector<HTMLButtonElement>('.mrp-paste');
      if (paste && typeof navigator.clipboard?.readText === 'function') {
        paste.removeAttribute('hidden');
        paste.addEventListener('click', () => {
          void (async () => {
            let clipboard = '';
            try { clipboard = await navigator.clipboard.readText(); } catch { /* denied */ }
            if (persistPairing(clipboard)) {
              completePairing(layer);
              return;
            }
            if (input) input.style.borderColor = '#e5484d';
            error?.removeAttribute('hidden');
          })();
        });
      }
      for (const closer of layer.querySelectorAll('[data-role="close"]')) {
        closer.addEventListener('click', () => sheet?.setAttribute('hidden', ''));
      }
      form?.addEventListener('submit', (event) => {
        event.preventDefault();
        if (persistPairing(String(input?.value || ''))) {
          completePairing(layer);
        } else {
          if (input) input.style.borderColor = '#e5484d';
          error?.removeAttribute('hidden');
        }
      });
      document.body.appendChild(layer);
      if (video) {
        // The camera keeps running behind the manual sheet (system-scanner
        // behavior); it only stops on pairing or when it never opened.
        void startPairingScanner(video, () => completePairing(layer), (reason) => {
          layer.classList.add('mrp-nocam');
          if (note) note.textContent = reason;
          sheet?.removeAttribute('hidden');
        });
      }
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
  let deltaItems: unknown[] = [];
  let deltaStreamingTail: DesktopTranscriptItem | null = null;
  let deltaStateFields: Record<string, unknown> = {};
  let deltaRevision = -1;
  const sessionStateDecoders = new Map<
    string,
    ReturnType<typeof createSnapshotDeltaDecoder>
  >();
  const resetDeltaState = (): void => {
    deltaRevision = -1;
    deltaItems = [];
    deltaStreamingTail = null;
    deltaStateFields = {};
    for (const decoder of sessionStateDecoders.values()) decoder.reset();
    sessionStateDecoders.clear();
    sessionsDecoder.reset();
    agentPoolDecoder.reset();
  };
  const stateFieldsFrom = (record: Record<string, unknown>): Record<string, unknown> => {
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (
        key !== 'items'
        && key !== 'streamingTail'
        && key !== '__itemsRevision'
        && key !== '__itemsPatch'
        && key !== '__streamingTailPatch'
        && key !== '__streamingTailTextEpoch'
        && key !== '__statePatch'
      ) {
        fields[key] = value;
      }
    }
    return fields;
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
    void call<DesktopRemoteProjectionState>('getRemoteProjection')
      .then((projection) => {
        if (!projection || typeof projection !== 'object') return;
        for (const listener of [...projectionListeners]) {
          try { listener(projection); } catch { /* renderer listener fault */ }
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
  const applyStatePayload = (payload: unknown): SessionSnapshot | null => {
    if (!payload || typeof payload !== 'object') return payload as SessionSnapshot;
    const record = payload as Record<string, unknown>;
    const patch = record.__itemsPatch as
      { base?: unknown; revision?: unknown; prefix?: unknown; append?: unknown } | undefined;
    if (patch && typeof patch === 'object') {
      const statePatch = record.__statePatch as DesktopStateFieldsPatch | undefined;
      if (
        patch.base !== deltaRevision
        || !Number.isSafeInteger(patch.revision)
        || !Number.isSafeInteger(patch.prefix)
        || (patch.prefix as number) < 0
        || (patch.prefix as number) > deltaItems.length
        || !Array.isArray(patch.append)
        || (statePatch && (
          statePatch.base !== deltaRevision
          || statePatch.revision !== patch.revision
          || !statePatch.changed
          || typeof statePatch.changed !== 'object'
          || !Array.isArray(statePatch.removed)
        ))
      ) {
        requestResync();
        return null;
      }
      const prefix = patch.prefix as number;
      const append = patch.append as unknown[];
      const nextItems = prefix !== deltaItems.length || append.length > 0
        ? deltaItems.slice(0, prefix).concat(append)
        : deltaItems;
      let nextStateFields: Record<string, unknown>;
      if (statePatch) {
        nextStateFields = { ...deltaStateFields };
        for (const key of statePatch.removed) delete nextStateFields[key];
        Object.assign(nextStateFields, statePatch.changed);
      } else {
        nextStateFields = stateFieldsFrom(record);
      }
      const tailPatch = record.__streamingTailPatch as DesktopStateStreamingTailPatch | undefined;
      let nextStreamingTail = deltaStreamingTail;
      if (tailPatch) {
        const priorText = typeof deltaStreamingTail?.text === 'string'
          ? deltaStreamingTail.text
          : '';
        if (
          !deltaStreamingTail
          || deltaStreamingTail.id == null
          || deltaStreamingTail.id !== tailPatch.tail?.id
          || !Number.isSafeInteger(tailPatch.prefix)
          || tailPatch.prefix < 0
          || tailPatch.prefix > priorText.length
          || typeof tailPatch.append !== 'string'
        ) {
          requestResync();
          return null;
        }
        nextStreamingTail = {
          ...tailPatch.tail,
          text: priorText.slice(0, tailPatch.prefix) + tailPatch.append,
        };
      } else if (Object.hasOwn(record, 'streamingTail')) {
        nextStreamingTail = record.streamingTail && typeof record.streamingTail === 'object'
          ? record.streamingTail as DesktopTranscriptItem
          : null;
      }
      deltaItems = nextItems;
      deltaStateFields = nextStateFields;
      deltaStreamingTail = nextStreamingTail;
      deltaRevision = patch.revision as number;
      return {
        ...deltaStateFields,
        items: deltaItems,
        streamingTail: deltaStreamingTail,
      } as SessionSnapshot;
    }
    if (typeof record.__itemsRevision === 'number') {
      deltaRevision = record.__itemsRevision;
      deltaItems = Array.isArray(record.items) ? record.items as unknown[] : [];
      deltaStreamingTail = record.streamingTail && typeof record.streamingTail === 'object'
        ? record.streamingTail as DesktopTranscriptItem
        : null;
      deltaStateFields = stateFieldsFrom(record);
      const clean: Record<string, unknown> = { ...record };
      delete clean.__itemsRevision;
      delete clean.__streamingTailTextEpoch;
      return clean as unknown as SessionSnapshot;
    }
    // Legacy full snapshot without revision: future patches cannot verify
    // their base against it, so force the next patch through a resync.
    resetDeltaState();
    return payload as SessionSnapshot;
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
    if (frame.e === 'T') {
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
    } else if (message.event === 'remoteProjection') {
      const projection = message.payload as DesktopRemoteProjectionState;
      if (!projection || typeof projection !== 'object') return;
      for (const listener of [...projectionListeners]) {
        try { listener(projection); } catch { /* renderer listener fault */ }
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

  // The pairing is unrecoverable without a fresh QR: wipe every stored
  // credential and hand the surface to the scanner.
  const resetPairingAndShowScanner = (message: string): void => {
    try { clearStoredRemotePairing(localStorage); } catch { /* private storage */ }
    serverBase = '';
    token = '';
    e2eePairing = null;
    everPaired = false;
    browserId = newBrowserId();
    clientRegistered = false;
    showPairingScreen(message);
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
    if (socket && socket.readyState === WebSocket.OPEN && connectionReady) {
      return Promise.resolve(socket);
    }
    try {
      await ensureClientRegistration();
    } catch (error) {
      const status = (error as { status?: number } | null)?.status;
      // 401/403/409: the bootstrap token is stale or the browser slot is gone
      // — only a fresh QR fixes it. Anything else (network, 429, 5xx) retries.
      if (status === 401 || status === 403 || status === 409) {
        resetPairingAndShowScanner(
          'This pairing is no longer valid. Scan the current QR from Settings → Connection.',
        );
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
        stopPairingCamera?.();
        document.getElementById('mixdog-remote-pairing')?.remove();
        if (!everPaired) {
          everPaired = true;
          try { localStorage.setItem(PAIRED_STORAGE_KEY, '1'); } catch { /* no storage */ }
          // Proof that this pairing works: only now may it be handed to an
          // install, and only now does the install card offer to arm one.
          linkInheritManifest();
          window.dispatchEvent(new Event('mixdog:remote-paired'));
        }
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
          resetPairingAndShowScanner(
            'This pairing is no longer valid. Scan the current QR from Settings → Connection.',
          );
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
    subscribeLspDiagnostics: (listener) => {
      lspDiagnosticsListeners.add(listener);
      return () => { lspDiagnosticsListeners.delete(listener); };
    },
    subscribeLspStatus: (listener) => {
      lspStatusListeners.add(listener);
      return () => { lspStatusListeners.delete(listener); };
    },
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
    folderWatch: (dir) => call('folderWatch', [dir]),
    folderUnwatch: (dir) => call('folderUnwatch', [dir]),
    subscribeFolderChanges: (listener) => {
      folderChangeListeners.add(listener);
      return () => { folderChangeListeners.delete(listener); };
    },
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
    getRemoteProjection: () => call('getRemoteProjection'),
    setRemoteProjection: (projection) => call('setRemoteProjection', [projection]),
    subscribeRemoteProjection: (listener) => {
      projectionListeners.add(listener);
      return () => { projectionListeners.delete(listener); };
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
    subscribeTermData: (listener) => {
      termListeners.add(listener);
      return () => { termListeners.delete(listener); };
    },
    gitStatus: (cwd) => call('gitStatus', [cwd]),
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
    listProviderModels: (options) => call('listProviderModels', [options]),
    setModelRoute: (selection, sessionId) => call('setModelRoute', [selection, sessionId]),
    setFast: (enabled, sessionId) => call('setFast', [enabled, sessionId]),
    readSettings: () => call('readSettings'),
    updateSetting: (key, enabled) => call('updateSetting', [key, enabled]),
    getZoomFactor: () => {
      try {
        const stored = Number(window.localStorage.getItem('mixdog.web-zoom') || '1');
        return Promise.resolve(Number.isFinite(stored) && stored > 0 ? stored : 1);
      } catch {
        return Promise.resolve(1);
      }
    },
    setZoomFactor: (factor) => {
      const next = Math.min(10, Math.max(0.2, Math.round(Number(factor) * 100) / 100)) || 1;
      if (next === 1) document.documentElement.style.removeProperty('zoom');
      else document.documentElement.style.zoom = String(next);
      try { window.localStorage.setItem('mixdog.web-zoom', String(next)); } catch { /* session only */ }
      return Promise.resolve(next);
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
  // Install handoff: only a browser whose pairing has already connected may
  // pass it on, and only the SCANNED link travels — the registered per-browser
  // token is bound to this client id and cannot pair another container.
  (w as unknown as { mixdogRemotePairingHandoff?: () => string })
    .mixdogRemotePairingHandoff = () => (everPaired ? readRemotePairingLink(localStorage) : '');
  linkInheritManifest();
  void connect().catch(() => { /* the retry loop keeps running */ });
})();

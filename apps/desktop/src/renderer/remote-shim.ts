// Browser-mode DesktopApi: when the Relay serves this page to a phone/tablet,
// install a WebSocket-backed implementation of window.mixdogDesktop before
// any module reads it.
// Inside Electron the preload bridge already exists and this is a no-op.
import type {
  DesktopApi,
  DesktopCapabilityRequest,
  DesktopCapabilityResult,
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
import {
  REMOTE_PAIRING_STORAGE_KEYS,
  clearStoredRemotePairing,
  isInvalidRemotePairingClose,
  normalizeRemoteExternalUrl,
  normalizeRemoteRelayOrigin,
  parseRemotePairingLink,
} from './remote-pairing-recovery';

const DISABLED_UPDATER: DesktopUpdaterState = { status: 'disabled' };
const TOKEN_STORAGE_KEY = REMOTE_PAIRING_STORAGE_KEYS.token;
const SERVER_STORAGE_KEY = REMOTE_PAIRING_STORAGE_KEYS.server;
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

  interface PendingCall { resolve: (value: unknown) => void; reject: (error: Error) => void }
  const pending = new Map<number, PendingCall>();
  const stateListeners = new Set<(snapshot: SessionSnapshot) => void>();
  const sessionStateListeners = new Set<(update: DesktopSessionStateUpdate) => void>();
  const termListeners = new Set<(event: { id: string; data: string }) => void>();
  let socket: WebSocket | null = null;
  let openPromise: Promise<WebSocket> | null = null;
  let everConnected = false;
  let everPaired = false;
  try { everPaired = localStorage.getItem(PAIRED_STORAGE_KEY) === '1'; } catch { /* no storage */ }
  let retryMs = 500;
  let nextId = 1;
  let secureChannel: RelayE2EEChannel | null = null;
  let connectionReady = false;

  const wsUrl = (): string => {
    if (serverBase) {
      const base = new URL(serverBase);
      const scheme = base.protocol === 'https:' ? 'wss' : 'ws';
      return `${scheme}://${base.host}/ws?token=${encodeURIComponent(token)}`;
    }
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${scheme}://${location.host}/ws?token=${encodeURIComponent(token)}`;
  };

  // Pairing recovery is scanner-first: the browser camera reads the secure URL
  // from Settings → Connection. Manual entry hides behind a toggle so the
  // default screen is just the viewfinder. Vanilla DOM keeps recovery working
  // before React mounts and even when the socket cannot open.
  let stopPairingCamera: (() => void) | null = null;

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
        + 'background:#151518;}'
        + '#mixdog-remote-pairing form b{font-size:16px;line-height:22px;}'
        + '#mixdog-remote-pairing form small{color:#a8a8a8;font-size:12.5px;line-height:17px;}'
        + '#mixdog-remote-pairing form small[data-role="err"]{color:#e5484d;}'
        + '#mixdog-remote-pairing input{width:100%;padding:12px;border-radius:10px;border:1px solid #3c3c3c;'
        + 'background:#222225;color:inherit;font-size:16px;}'
        + '#mixdog-remote-pairing .mrp-connect{padding:13px;border:0;border-radius:12px;background:#e9e9e9;'
        + 'color:#151518;font-weight:600;font-size:15px;cursor:pointer;}'
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
      if (note) note.textContent = message;
      if (input && serverBase) input.value = serverBase;
      layer.querySelector('.mrp-manual')?.addEventListener('click', () => {
        sheet?.removeAttribute('hidden');
        input?.focus();
      });
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
  const resetDeltaState = (): void => {
    deltaRevision = -1;
    deltaItems = [];
    deltaStreamingTail = null;
    deltaStateFields = {};
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
  // Unsolicited resync requests (relay drop hint, foreground wake) share one
  // short debounce: a tab that flips visibility repeatedly must not pull a
  // full transcript per flip, while a real gap still recovers immediately.
  let lastResyncAt = 0;
  const requestResync = (): void => {
    const now = Date.now();
    // Even when the outbound request is debounced, never continue applying
    // patches to a known-invalid local base.
    resetDeltaState();
    if (now - lastResyncAt < 3_000) return;
    lastResyncAt = now;
    fire('stateResync', []);
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

  const handleMessage = (message: Record<string, unknown>): void => {
    // Any inbound frame proves the socket is alive; pong frames carry
    // nothing else.
    awaitingPong = false;
    if ('pong' in message) return;
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
    } else if (message.event === 'sessionState') {
      const update = message.payload as DesktopSessionStateUpdate;
      if (!update || typeof update !== 'object' || !String(update.sessionId || '')) return;
      for (const listener of [...sessionStateListeners]) {
        try { listener(update); } catch { /* renderer listener fault */ }
      }
    } else if (message.event === 'termData') {
      const payload = (message.payload ?? {}) as { id?: unknown; data?: unknown };
      const event = { id: String(payload.id || ''), data: String(payload.data ?? '') };
      for (const listener of [...termListeners]) {
        try { listener(event); } catch { /* renderer listener fault */ }
      }
    }
  };

  // NAT/carrier middleboxes silently drop idle WebSockets; the browser
  // cannot send protocol pings, so an app-level ping/pong detects the
  // half-dead socket and recycles it, and a foreground/online wake probe
  // reconnects immediately instead of on the next (hanging) tap.
  let heartbeatSentAt = 0;
  let awaitingPong = false;
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
  const wakeProbe = (): void => {
    if (document.visibilityState === 'hidden') return;
    const ws = socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      retryMs = 500;
      void connect().catch(() => { /* the retry loop keeps running */ });
      return;
    }
    heartbeatSentAt = Date.now();
    awaitingPong = true;
    try { ws.send('{"ping":1}'); } catch { /* surfaces as close */ }
    // A live socket proves nothing about the transcript: pushes sent while
    // this tab was hidden may have been dropped for a congested leg, and a
    // finished turn never sends another patch to expose it.
    requestResync();
  };
  document.addEventListener('visibilitychange', wakeProbe);
  window.addEventListener('online', wakeProbe);
  window.addEventListener('focus', wakeProbe);

  const scheduleReconnect = (): void => {
    const delay = retryMs;
    retryMs = Math.min(10_000, retryMs * 2);
    window.setTimeout(() => { void connect().catch(() => {}); }, delay);
  };

  const connect = (): Promise<WebSocket> => {
    if (socket && socket.readyState === WebSocket.OPEN && connectionReady) {
      return Promise.resolve(socket);
    }
    openPromise ??= new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(wsUrl());
      let opened = false;
      let handshakeTimer: number | null = null;
      const finishOpen = () => {
        if (opened) return;
        opened = true;
        connectionReady = true;
        if (handshakeTimer !== null) window.clearTimeout(handshakeTimer);
        retryMs = 500;
        stopPairingCamera?.();
        document.getElementById('mixdog-remote-pairing')?.remove();
        if (!everPaired) {
          everPaired = true;
          try { localStorage.setItem(PAIRED_STORAGE_KEY, '1'); } catch { /* no storage */ }
        }
        if (everConnected) {
          void call<SessionSnapshot>('getSnapshot').then(dispatchState).catch(() => {});
        }
        everConnected = true;
        resolve(ws);
      };
      ws.onopen = () => {
        socket = ws;
        connectionReady = false;
        secureChannel = null;
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
          let parsed: unknown;
          try { parsed = JSON.parse(String(event.data)); } catch { return; }
          if (!parsed || typeof parsed !== 'object') return;
          const clear = parsed as Record<string, unknown>;
          awaitingPong = false;
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
            if (secureChannel) throw new Error('Duplicate relay encryption challenge.');
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
        if (handshakeTimer !== null) window.clearTimeout(handshakeTimer);
        if (socket === ws) socket = null;
        openPromise = null;
        connectionReady = false;
        secureChannel = null;
        // A new connection starts a fresh delta lane; a stale base revision
        // must never accidentally match the new encoder's numbering.
        deltaRevision = -1;
        const failure = new Error('Mixdog relay disconnected.');
        for (const entry of [...pending.values()]) entry.reject(failure);
        pending.clear();
        if (!opened) reject(failure);
        if (isInvalidRemotePairingClose(event)) {
          try { clearStoredRemotePairing(localStorage); } catch { /* private storage */ }
          serverBase = '';
          token = '';
          e2eePairing = null;
          everPaired = false;
          showPairingScreen(
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
      ws.send(await secureChannel.encryptJson(payload));
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
    readProjectFile: (projectPath, relPath) => call('readProjectFile', [projectPath, relPath]),
    statProjectFile: (projectPath, relPath) => call('statProjectFile', [projectPath, relPath]),
    listSessions: () => call('listSessions'),
    renameSession: (sessionId, title) => call('renameSession', [sessionId, title]),
    setSessionArchived: (sessionId: string, archived: boolean) =>
      call('setSessionArchived', [sessionId, archived]),
    deleteSession: (sessionId) => call('deleteSession', [sessionId]),
    searchProjectFiles: (projectIdOrWorkspaceId, query, limit) =>
      call('searchProjectFiles', [projectIdOrWorkspaceId, query, limit]),
    getSnapshot: () => call('getSnapshot'),
    subscribeState: (listener) => {
      stateListeners.add(listener);
      return () => { stateListeners.delete(listener); };
    },
    perfLog: () => {},
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
      const query = `variant=${encodeURIComponent(variant || 'original')}`
        + (token ? `&token=${encodeURIComponent(token)}` : '');
      return `${base}/media/${encodeURIComponent(assetId)}?${query}`;
    },
    quit: () => Promise.resolve(),
  };

  w.mixdogDesktop = Object.freeze(api);
  // Settings → Connection on a remote surface: expose where this session is
  // connected so the panel shows live status instead of desktop-only pairing.
  (w as unknown as { mixdogRemoteServer?: string }).mixdogRemoteServer =
    serverBase || location.origin;
  void connect().catch(() => { /* the retry loop keeps running */ });
})();

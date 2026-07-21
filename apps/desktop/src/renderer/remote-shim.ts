// Browser-mode DesktopApi: when this page is served by the desktop remote
// bridge (phone/tablet browser — no Electron preload), install a WebSocket-
// backed implementation of window.mixdogDesktop before any module reads it.
// Inside Electron the preload bridge already exists and this is a no-op.
import type {
  DesktopApi,
  DesktopCapabilityRequest,
  DesktopCapabilityResult,
  DesktopUpdaterState,
  EngineSnapshot,
} from '../shared/contract';

const DISABLED_UPDATER: DesktopUpdaterState = { status: 'disabled' };
const TOKEN_STORAGE_KEY = 'mixdog.remote-token';
const SERVER_STORAGE_KEY = 'mixdog.remote-server';

(() => {
  const w = window as Window & { mixdogDesktop?: DesktopApi };
  if (w.mixdogDesktop || typeof WebSocket === 'undefined') return;

  // Native shells (Capacitor) serve the page from a local origin, so the
  // desktop address cannot come from location.host: it is pasted once on the
  // pairing screen and persisted alongside the token.
  const isNativeShell = Boolean((window as unknown as {
    Capacitor?: { isNativePlatform?: () => boolean };
  }).Capacitor?.isNativePlatform?.());
  let serverBase = '';
  try { serverBase = localStorage.getItem(SERVER_STORAGE_KEY) || ''; } catch { /* pairing screen */ }

  // ?token= wins and is persisted for reconnects; strip it from the visible
  // URL so casual screen shares do not leak the bridge secret.
  let token = '';
  try {
    const params = new URLSearchParams(location.search);
    const fromUrl = params.get('token');
    if (fromUrl) {
      token = fromUrl;
      localStorage.setItem(TOKEN_STORAGE_KEY, fromUrl);
      params.delete('token');
      const query = params.toString();
      history.replaceState(null, '', location.pathname + (query ? `?${query}` : '') + location.hash);
    } else {
      token = localStorage.getItem(TOKEN_STORAGE_KEY) || '';
    }
  } catch { /* token stays empty; the bridge refuses the socket */ }

  interface PendingCall { resolve: (value: unknown) => void; reject: (error: Error) => void }
  const pending = new Map<number, PendingCall>();
  const stateListeners = new Set<(snapshot: EngineSnapshot) => void>();
  const termListeners = new Set<(event: { id: string; data: string }) => void>();
  let socket: WebSocket | null = null;
  let openPromise: Promise<WebSocket> | null = null;
  let everConnected = false;
  let retryMs = 500;
  let failedAttempts = 0;
  let nextId = 1;

  const wsUrl = (): string => {
    if (serverBase) {
      const base = new URL(serverBase);
      const scheme = base.protocol === 'https:' ? 'wss' : 'ws';
      return `${scheme}://${base.host}/ws?token=${encodeURIComponent(token)}`;
    }
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${scheme}://${location.host}/ws?token=${encodeURIComponent(token)}`;
  };

  // Pairing screen (native shell): scanner-first — the in-app camera reads
  // either QR from the desktop's Remote Access window / Settings →
  // Connection (mixdog://pair?server=&token= or the browser URL with
  // ?token=). Manual address entry hides behind a toggle so the default
  // screen is just the viewfinder. Vanilla DOM so it works before React
  // mounts and even when the socket cannot open.
  let stopPairingCamera: (() => void) | null = null;

  const persistPairing = (raw: string): boolean => {
    try {
      const link = new URL(raw.trim());
      const pairToken = link.searchParams.get('token');
      let origin = '';
      if (link.protocol === 'mixdog:') {
        const server = link.searchParams.get('server');
        if (!server) return false;
        origin = new URL(server).origin;
      } else if (link.protocol === 'http:' || link.protocol === 'https:') {
        origin = link.origin;
      } else {
        return false;
      }
      localStorage.setItem(SERVER_STORAGE_KEY, origin);
      if (pairToken) localStorage.setItem(TOKEN_STORAGE_KEY, pairToken);
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
    window.setTimeout(() => location.reload(), 1250);
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
    // Only reveal the element once frames actually flow — before that the
    // WebView paints its own oversized (and stretched) play glyph over the
    // empty video surface.
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

  // Full-screen scanner in the system-camera grammar (WhatsApp/Discord/the
  // Android system scanner): edge-to-edge preview, a dimmed mask with a clear
  // center aperture marked by four corner brackets, instructions in a top
  // scrim, and manual entry demoted to a bottom-sheet behind a pill button.
  const showPairingScreen = (message: string): void => {
    if (document.getElementById('mixdog-remote-pairing')) return;
    const mount = () => {
      const layer = document.createElement('div');
      layer.id = 'mixdog-remote-pairing';
      layer.innerHTML = '<style>'
        + '#mixdog-remote-pairing{position:fixed;inset:0;z-index:9999;overflow:hidden;background:#0e0d0c;'
        + 'color:#f4f2ee;font:400 15px/22px system-ui,sans-serif;--mrp-ap:min(68vw,280px);}'
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
        + 'border-radius:999px;background:rgba(32,30,28,.72);color:#f4f2ee;'
        + 'font:500 14px/20px system-ui,sans-serif;cursor:pointer;'
        + '-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);}'
        + '#mixdog-remote-pairing .mrp-sheet{position:absolute;inset:0;z-index:2;}'
        + '#mixdog-remote-pairing .mrp-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.5);}'
        + '#mixdog-remote-pairing form{position:absolute;left:0;right:0;bottom:0;display:grid;gap:12px;'
        + 'padding:22px 20px calc(22px + env(safe-area-inset-bottom));border-radius:20px 20px 0 0;'
        + 'background:#201e1c;}'
        + '#mixdog-remote-pairing form b{font-size:16px;line-height:22px;}'
        + '#mixdog-remote-pairing form small{color:#b3ada3;font-size:12.5px;line-height:17px;}'
        + '#mixdog-remote-pairing form small[data-role="err"]{color:#e5484d;}'
        + '#mixdog-remote-pairing input{width:100%;padding:12px;border-radius:10px;border:1px solid #4a463f;'
        + 'background:#282623;color:inherit;font-size:16px;}'
        + '#mixdog-remote-pairing .mrp-connect{padding:13px;border:0;border-radius:12px;background:#f4f2ee;'
        + 'color:#201e1c;font-weight:600;font-size:15px;cursor:pointer;}'
        + '#mixdog-remote-pairing .mrp-back{justify-self:center;padding:6px 10px;border:0;background:none;'
        + 'color:#b3ada3;font:500 13.5px/18px system-ui,sans-serif;cursor:pointer;}'
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
        + '#mixdog-remote-pairing .mrp-success path{fill:none;stroke:#f4f2ee;stroke-width:5;'
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
        + `<span data-role="note">${message}</span></header>`
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

  const dispatchState = (snapshot: EngineSnapshot): void => {
    for (const listener of [...stateListeners]) {
      try { listener(snapshot); } catch { /* renderer listener fault */ }
    }
  };

  // State pushes ride the same identity-prefix items delta the desktop IPC
  // uses (state-delta.ts): reassemble full snapshots here, and ask the
  // desktop for a resync when a patch does not match our base revision
  // (mid-stream join through the relay, missed frame).
  let deltaItems: unknown[] = [];
  let deltaRevision = -1;
  const applyStatePayload = (payload: unknown): EngineSnapshot | null => {
    if (!payload || typeof payload !== 'object') return payload as EngineSnapshot;
    const record = payload as Record<string, unknown>;
    const patch = record.__itemsPatch as
      { base?: unknown; revision?: unknown; prefix?: unknown; append?: unknown } | undefined;
    if (patch && typeof patch === 'object') {
      if (patch.base !== deltaRevision) {
        fire('stateResync', []);
        return null;
      }
      const prefix = typeof patch.prefix === 'number' ? patch.prefix : 0;
      const append = Array.isArray(patch.append) ? patch.append : [];
      deltaItems = deltaItems.slice(0, prefix).concat(append);
      deltaRevision = typeof patch.revision === 'number' ? patch.revision : deltaRevision + 1;
      const clean: Record<string, unknown> = { ...record, items: deltaItems };
      delete clean.__itemsPatch;
      return clean as unknown as EngineSnapshot;
    }
    if (typeof record.__itemsRevision === 'number') {
      deltaRevision = record.__itemsRevision;
      deltaItems = Array.isArray(record.items) ? record.items as unknown[] : [];
      const clean: Record<string, unknown> = { ...record };
      delete clean.__itemsRevision;
      return clean as unknown as EngineSnapshot;
    }
    // Legacy full snapshot without revision: future patches cannot verify
    // their base against it, so force the next patch through a resync.
    deltaRevision = -1;
    return payload as EngineSnapshot;
  };

  const handleMessage = (raw: unknown): void => {
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(String(raw));
      if (!parsed || typeof parsed !== 'object') return;
      message = parsed as Record<string, unknown>;
    } catch { return; }
    // Any inbound frame proves the socket is alive; pong frames carry
    // nothing else.
    awaitingPong = false;
    if ('pong' in message) return;
    if (typeof message.id === 'number') {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.ok === true) entry.resolve(message.value);
      else {
        entry.reject(new Error(
          typeof message.error === 'string' && message.error ? message.error : 'remote call failed.',
        ));
      }
      return;
    }
    if (message.event === 'state') {
      const snapshot = applyStatePayload(message.payload ?? null);
      if (snapshot !== null) dispatchState(snapshot);
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
  };
  document.addEventListener('visibilitychange', wakeProbe);
  window.addEventListener('online', wakeProbe);
  window.addEventListener('focus', wakeProbe);

  const scheduleReconnect = (): void => {
    failedAttempts += 1;
    // A native shell that has never reached this desktop is mis-paired, not
    // offline: resurface the pairing screen instead of retrying forever.
    if (isNativeShell && !everConnected && failedAttempts >= 3) {
      showPairingScreen('Could not reach the desktop. Check the address from its startup log and try again.');
    }
    const delay = retryMs;
    retryMs = Math.min(10_000, retryMs * 2);
    window.setTimeout(() => { void connect().catch(() => {}); }, delay);
  };

  const connect = (): Promise<WebSocket> => {
    if (socket && socket.readyState === WebSocket.OPEN) return Promise.resolve(socket);
    openPromise ??= new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(wsUrl());
      let opened = false;
      ws.onopen = () => {
        opened = true;
        socket = ws;
        retryMs = 500;
        failedAttempts = 0;
        stopPairingCamera?.();
        document.getElementById('mixdog-remote-pairing')?.remove();
        if (everConnected) {
          // Re-sync after a drop: state pushes sent while offline are gone.
          void call<EngineSnapshot>('getSnapshot').then(dispatchState).catch(() => {});
        }
        everConnected = true;
        resolve(ws);
      };
      ws.onmessage = (event) => handleMessage(event.data);
      ws.onclose = () => {
        if (socket === ws) socket = null;
        openPromise = null;
        // A new connection starts a fresh delta lane; a stale base revision
        // must never accidentally match the new encoder's numbering.
        deltaRevision = -1;
        const failure = new Error('mixdog remote bridge disconnected.');
        for (const entry of [...pending.values()]) entry.reject(failure);
        pending.clear();
        if (!opened) reject(failure);
        scheduleReconnect();
      };
    });
    return openPromise;
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
      try {
        ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };

  const fire = (method: string, params: unknown[]): void => {
    void connect().then((ws) => { ws.send(JSON.stringify({ method, params })); }).catch(() => {});
  };

  const api: DesktopApi = {
    // Desktop-only OS integrations become inert or degrade to browser
    // equivalents; everything else forwards over the bridge socket.
    chooseProject: () => Promise.resolve(null),
    startProject: (projectPath) => call('startProject', [projectPath]),
    startProjectTask: (projectPath) => call('startProjectTask', [projectPath]),
    startTask: () => call('startTask'),
    listProjects: () => call('listProjects'),
    openProjectInExplorer: () => Promise.resolve(),
    openExternal: (url) => {
      try { window.open(url, '_blank', 'noopener'); } catch { /* popup blocked */ }
      return Promise.resolve();
    },
    renameProject: (projectPath, alias) => call('renameProject', [projectPath, alias]),
    setProjectPinned: (projectPath, pinned) => call('setProjectPinned', [projectPath, pinned]),
    removeProject: (projectPath) => call('removeProject', [projectPath]),
    listSessions: () => call('listSessions'),
    renameSession: (sessionId, title) => call('renameSession', [sessionId, title]),
    setSessionArchived: (sessionId: string, archived: boolean) =>
      call('setSessionArchived', [sessionId, archived]),
    deleteSession: (sessionId) => call('deleteSession', [sessionId]),
    resumeSession: (sessionId) => call('resumeSession', [sessionId]),
    searchProjectFiles: (projectIdOrWorkspaceId, query, limit) =>
      call('searchProjectFiles', [projectIdOrWorkspaceId, query, limit]),
    getSnapshot: () => call('getSnapshot'),
    subscribeState: (listener) => {
      stateListeners.add(listener);
      return () => { stateListeners.delete(listener); };
    },
    perfLog: () => {},
    rendererReady: () => {},
    termEnsure: (id, cwd) => call('termEnsure', [id, cwd ?? null]),
    termWrite: (id, data) => fire('termWrite', [id, data]),
    termResize: (id, cols, rows) => fire('termResize', [id, cols, rows]),
    subscribeTermData: (listener) => {
      termListeners.add(listener);
      return () => { termListeners.delete(listener); };
    },
    gitStatus: (cwd) => call('gitStatus', [cwd]),
    gitDiff: (cwd, path, staged) => call('gitDiff', [cwd, path, staged === true]),
    gitStage: (cwd, paths) => call('gitStage', [cwd, paths]),
    gitUnstage: (cwd, paths) => call('gitUnstage', [cwd, paths]),
    gitCommit: (cwd, message) => call('gitCommit', [cwd, message]),
    gitPush: (cwd) => call('gitPush', [cwd]),
    gitRevert: (cwd, path, untracked) => call('gitRevert', [cwd, path, untracked === true]),
    gitLog: (cwd) => call('gitLog', [cwd]),
    gitShow: (cwd, hash) => call('gitShow', [cwd, hash]),
    gitReview: (cwd) => call('gitReview', [cwd]),
    gitReviewDiff: (cwd, path, untracked) => call('gitReviewDiff', [cwd, path, untracked === true]),
    revealFile: () => Promise.resolve(),
    openFilePath: () => Promise.resolve(),
    getUpdaterState: () => Promise.resolve(DISABLED_UPDATER),
    subscribeUpdaterState: () => () => {},
    checkForDesktopUpdate: () => Promise.resolve(DISABLED_UPDATER),
    showDesktopUpdate: () => Promise.resolve(DISABLED_UPDATER),
    submit: (prompt, options) => call('submit', [prompt, options]),
    abort: () => call('abort'),
    resolveToolApproval: (id, decision) => call('resolveToolApproval', [id, decision]),
    listProviderModels: (options) => call('listProviderModels', [options]),
    setModelRoute: (selection) => call('setModelRoute', [selection]),
    setFast: (enabled) => call('setFast', [enabled]),
    readSettings: () => call('readSettings'),
    updateSetting: (key, enabled) => call('updateSetting', [key, enabled]),
    getZoomFactor: () => Promise.resolve(1),
    setZoomFactor: (factor) => Promise.resolve(factor),
    onZoomFactorChanged: () => () => {},
    applyTitleBarTheme: () => Promise.resolve(),
    invokeCapability: <T = unknown>(request: DesktopCapabilityRequest) =>
      call<DesktopCapabilityResult<T>>('invokeCapability', [request]),
    readCapabilities: (requests) => call('readCapabilities', [requests]),
    // Never let a phone kill the desktop engine in v1.
    dispose: () => Promise.resolve(),
    quit: () => Promise.resolve(),
  };

  w.mixdogDesktop = Object.freeze(api);
  // Settings → Connection on a remote surface: expose where this session is
  // connected so the panel shows live status instead of desktop-only pairing.
  (w as unknown as { mixdogRemoteServer?: string }).mixdogRemoteServer =
    serverBase || location.origin;
  // Android hardware back: close the topmost mobile layer (drawer/dock —
  // App.tsx consumes the event via preventDefault); with nothing open the
  // app minimizes instead of quitting mid-session.
  if (isNativeShell) {
    const appPlugin = (window as unknown as {
      Capacitor?: { Plugins?: { App?: {
        addListener?: (event: string, handler: (payload?: { url?: string }) => void) => unknown;
        minimizeApp?: () => void;
      } } };
    }).Capacitor?.Plugins?.App;
    appPlugin?.addListener?.('backButton', () => {
      const consumed = !window.dispatchEvent(
        new CustomEvent('mixdog:hardware-back', { cancelable: true }),
      );
      if (!consumed) appPlugin.minimizeApp?.();
    });
    // Pairing deep link (QR on the desktop's Remote Access window):
    // mixdog://pair?server=<origin>&token=<hex> — persist and reload so the
    // socket dials the new desktop without any typing.
    appPlugin?.addListener?.('appUrlOpen', (payload) => {
      try {
        const link = new URL(String(payload?.url || ''));
        if (link.protocol !== 'mixdog:') return;
        const server = link.searchParams.get('server');
        const pairToken = link.searchParams.get('token');
        if (!server) return;
        localStorage.setItem(SERVER_STORAGE_KEY, new URL(server).origin);
        if (pairToken) localStorage.setItem(TOKEN_STORAGE_KEY, pairToken);
        location.reload();
      } catch { /* malformed link — keep the current pairing */ }
    });
  }
  if (isNativeShell && !serverBase) {
    showPairingScreen('Point the camera at the pairing QR — Settings → Connection on your desktop.');
  } else {
    void connect().catch(() => { /* the retry loop keeps running */ });
  }
})();

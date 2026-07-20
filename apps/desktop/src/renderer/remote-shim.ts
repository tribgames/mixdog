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

  // Pairing screen (native shell): one field takes the full bridge URL the
  // desktop prints (http://<ip>:8791/?token=...); origin and token are split
  // out and persisted. Vanilla DOM so it works before React mounts and even
  // when the socket cannot open.
  const showPairingScreen = (message: string): void => {
    if (document.getElementById('mixdog-remote-pairing')) return;
    const mount = () => {
      const layer = document.createElement('div');
      layer.id = 'mixdog-remote-pairing';
      layer.style.cssText = 'position:fixed;inset:0;z-index:9999;display:grid;place-items:center;'
        + 'padding:24px;background:#201e1c;color:#f4f2ee;font:400 15px/22px system-ui,sans-serif;';
      layer.innerHTML = '<form style="width:min(420px,100%);display:grid;gap:12px;">'
        + '<b style="font-size:18px;">Connect to your Mixdog desktop</b>'
        + `<span style="color:#b3ada3;">${message}</span>`
        + '<input name="address" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false"'
        + ' placeholder="http://192.168.0.10:8791/?token=..."'
        + ' style="padding:12px;border-radius:10px;border:1px solid #4a463f;background:#282623;color:inherit;font-size:16px;" />'
        + '<button type="submit" style="padding:12px;border:0;border-radius:10px;background:#f4f2ee;'
        + 'color:#201e1c;font-weight:600;font-size:15px;">Connect</button></form>';
      const form = layer.querySelector('form');
      const input = layer.querySelector('input');
      if (input && serverBase) input.value = serverBase;
      form?.addEventListener('submit', (event) => {
        event.preventDefault();
        try {
          const parsed = new URL(String(input?.value || '').trim());
          const pastedToken = parsed.searchParams.get('token');
          localStorage.setItem(SERVER_STORAGE_KEY, parsed.origin);
          if (pastedToken) localStorage.setItem(TOKEN_STORAGE_KEY, pastedToken);
          location.reload();
        } catch { if (input) input.style.borderColor = '#e5484d'; }
      });
      document.body.appendChild(layer);
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
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
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
  // Android hardware back: close the topmost mobile layer (drawer/dock —
  // App.tsx consumes the event via preventDefault); with nothing open the
  // app minimizes instead of quitting mid-session.
  if (isNativeShell) {
    const appPlugin = (window as unknown as {
      Capacitor?: { Plugins?: { App?: {
        addListener?: (event: string, handler: () => void) => unknown;
        minimizeApp?: () => void;
      } } };
    }).Capacitor?.Plugins?.App;
    appPlugin?.addListener?.('backButton', () => {
      const consumed = !window.dispatchEvent(
        new CustomEvent('mixdog:hardware-back', { cancelable: true }),
      );
      if (!consumed) appPlugin.minimizeApp?.();
    });
  }
  if (isNativeShell && !serverBase) {
    showPairingScreen('Paste the remote bridge URL shown by your desktop (Settings → Remote, or the startup log).');
  } else {
    void connect().catch(() => { /* the retry loop keeps running */ });
  }
})();

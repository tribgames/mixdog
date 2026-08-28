import { existsSync, statSync } from 'node:fs';
import * as nodeModule from 'node:module';
import { constants as osConstants, freemem, setPriority, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { app, BrowserWindow, crashReporter, dialog, ipcMain, nativeImage, powerMonitor, powerSaveBlocker, screen, session, shell } from 'electron';

import type { DesktopService } from './desktop-service-contract';
import { DesktopServiceClient } from './desktop-service-client';
import { SessionTransport } from './session-transport';
import { readDesktopModelBootstrapSnapshot } from './model-bootstrap';
import { AgentAwakeService } from './agent-awake';
import { createTurnAttention, type TurnAttention } from './turn-attention';
import { createIdleReclaim, purgeRendererMemory, type IdleReclaim } from './idle-reclaim';
import { createDesktopDiagnostics, type DesktopDiagnostics } from './desktop-diagnostics';
import { installViewportGuard } from './viewport-guard';
import {
  gpuFallbackDecision,
  readActiveGpuFallbackMarker,
  writeGpuFallbackMarker,
  type GpuFallbackEnvironment,
} from './gpu-recovery';
import { registerDesktopIpc } from './ipc';
import { createBrowserHost, type BrowserHost } from './browser-host';
import { createComputerHost, type ComputerHost } from './computer-host';
import { MEDIA_SCHEME, registerMediaProtocol, registerMediaScheme } from './media-protocol';
import { desktopPermissionAllowed } from './permission-policy';
import { installNativeMenu } from './menu';
import { DesktopSettingsStore } from './settings-store';
import { desktopUpdater, startAutoUpdater } from './updater';
import type { RemoteAccessDescriptor } from './remote-access-window';
import {
  DESKTOP_WINDOW_OPTIONS,
  configureTitleBarThemePersistence,
  initialTitleBarWindowOverrides,
  setDesktopTitleBarZoom,
} from './window-options';
import {
  DESKTOP_IPC,
  type DesktopRemoteAccessInfo,
  type DesktopSettings,
} from '../shared/contract';
import { persistWindowState, readWindowState } from './window-state';
import {
  normalizeRendererComposerActionDiagnostic,
  normalizeRendererDiagnostic,
  normalizeRendererLongTaskDiagnostic,
  rendererRecoveryDecision,
} from './renderer-recovery';

const desktopProcessStartedAt = Date.now();
// The launcher's stdio pipe can close while the app keeps running (started
// from a terminal or script that exits). Every later console write then
// raises EPIPE, and an unhandled stream error becomes Electron's fatal
// "A JavaScript error occurred in the main process" dialog. Logging is never
// worth a crash, so dead-pipe writes fail silently.
for (const stream of [process.stdout, process.stderr]) {
  stream?.on?.('error', () => { /* dead stdio pipe: logging is best-effort */ });
}
// V8 compile cache for the main process's dynamic imports (remote access,
// dialogs) and the daemon service adapter. Best-effort no-op when the
// running Node build lacks the API.
try {
  (nodeModule as { enableCompileCache?: () => unknown }).enableCompileCache?.();
} catch { /* launch-speed optimization only */ }
const desktopBootId = `${desktopProcessStartedAt.toString(36)}-${process.pid.toString(36)}`;
const desktopBootScenario = String(process.env.MIXDOG_BOOT_SCENARIO || '')
  .replace(/[^A-Za-z0-9_.:-]/g, '')
  .slice(0, 80);
const DESKTOP_WINDOW_SHOW_DEADLINE_MS = 3_000;

// Profile identity. Unpackaged shells (electron-vite dev/preview, source-mode
// E2E) derive userData from this package's name (@mixdog/desktop), so every
// dev run landed in a SEPARATE Chromium profile from the installed app
// (extraMetadata.name = mixdog-desktop). Recent models, the last
// session/project, and window state therefore started empty each time — the
// New task composer read "Select model" even though the installed app had a
// route. Pin the dev profile to the packaged one; MIXDOG_DESKTOP_USER_DATA
// still isolates a run explicitly (throwaway profiles, migration tests).
const PACKAGED_USER_DATA_DIRECTORY = 'mixdog-desktop';
if (process.env.MIXDOG_DESKTOP_USER_DATA) {
  app.setPath('userData', resolve(process.env.MIXDOG_DESKTOP_USER_DATA));
} else if (!app.isPackaged) {
  app.setName(PACKAGED_USER_DATA_DIRECTORY);
  app.setPath('userData', join(app.getPath('appData'), PACKAGED_USER_DATA_DIRECTORY));
}

let crashReporterStatus = process.platform === 'win32' ? 'start-failed' : 'not-required';
let crashReporterErrorName = '';
if (process.platform === 'win32') {
  try {
    // Keep reports local: the handler must exist before any renderer starts,
    // but Mixdog never uploads a user's dump without an explicit future policy.
    crashReporter.start({
      uploadToServer: false,
      productName: 'Mixdog',
      globalExtra: { bootId: desktopBootId },
    });
    crashReporterStatus = 'local';
  } catch (error) {
    crashReporterErrorName = error instanceof Error ? error.name : typeof error;
    console.warn('Mixdog desktop crash handler failed to start:', error);
  }
}

if (app.isPackaged) {
  const nativeToolsDir = join(process.resourcesPath, 'native-tools');
  const executableSuffix = process.platform === 'win32' ? '.exe' : '';
  const graphPath = join(nativeToolsDir, `mixdog-graph${executableSuffix}`);
  const nativeOverrides = {
    MIXDOG_GRAPH_BIN: graphPath,
    MIXDOG_SEARCH_SERVER_BIN: graphPath,
    MIXDOG_PATCH_NATIVE_BIN: join(nativeToolsDir, `mixdog-patch${executableSuffix}`),
    MIXDOG_SPAWN_SERVER_BIN: join(nativeToolsDir, `mixdog-spawn${executableSuffix}`),
    MIXDOG_TOKEN_NATIVE_BIN: join(nativeToolsDir, 'mixdog-token.node'),
  };
  for (const [name, path] of Object.entries(nativeOverrides)) {
    if (!process.env[name] && existsSync(path)) process.env[name] = path;
  }
}

const gpuFallbackEnvironment: GpuFallbackEnvironment = {
  appVersion: app.getVersion(),
  electronVersion: process.versions.electron || '',
  platform: process.platform,
};
const gpuFallbackMarker = readActiveGpuFallbackMarker(
  app.getPath('userData'),
  gpuFallbackEnvironment,
);
const softwareRenderingThisLaunch = Boolean(gpuFallbackMarker);
if (softwareRenderingThisLaunch) {
  // Electron requires this before app.whenReady(). The marker is scoped to the
  // exact app/Electron build, so an upgrade gets a fresh hardware-GPU attempt.
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
}

// Windows-only Chromium occlusion tracking can leave a RESTORED window marked
// occluded: document.hidden stays true, requestAnimationFrame never fires, and
// every rAF-based surface reveal (PaneSurfaceGate — terminal/editor/studio
// panes) stalls indefinitely while timers throttle to once a minute (user:
// 터미널이 안 뜬다 — reproduced with a visible window still reporting
// visibilityState "hidden"). Disabling the native occlusion calculation is the
// standard Electron workaround; genuine minimize still suspends painting.
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
}

// V8 sizes the renderer's old space against what the host can spare, so on a
// 32 GB machine a working day of sessions left the renderer resident above
// 1 GB with nothing leaking: the collector simply had no reason to run while
// 20 GB sat free (the same diagnostics log shows unforced 500 MB drops the
// moment the host came under pressure). Capping the old space makes V8 run its
// own major GCs at a size that fits the UI's real working set — transcript
// virtualization keeps the live set far below this, and the cap is well above
// the ~550 MB the renderer settles at after a collection. This is the
// supported lever: forcing a purge through the debugger crashes the renderer
// (see main/idle-reclaim.ts). MIXDOG_RENDERER_HEAP_MB overrides; 0 restores
// V8's own default sizing.
const configuredRendererHeapMb = Number(process.env.MIXDOG_RENDERER_HEAP_MB);
const rendererHeapMb = Number.isFinite(configuredRendererHeapMb) && configuredRendererHeapMb >= 0
  ? Math.floor(configuredRendererHeapMb)
  : 768;
if (rendererHeapMb > 0) {
  app.commandLine.appendSwitch('js-flags', `--max-old-space-size=${rendererHeapMb}`);
}

// Shell/agent launchers may themselves run below normal priority. The desktop
// chrome must not inherit that class: keep main at normal while the service
// explicitly lowers only the compute tree that should yield to the UI.
try {
  setPriority(0, osConstants.priority.PRIORITY_NORMAL);
} catch (error) {
  console.warn('Mixdog desktop main could not restore normal process priority:', error);
}

const acceptanceDebugPort = process.argv
  .find((argument) => argument.startsWith('--remote-debugging-port='))
  ?.slice('--remote-debugging-port='.length);
if (acceptanceDebugPort && /^\d+$/.test(acceptanceDebugPort)) {
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
  app.commandLine.appendSwitch('remote-debugging-port', acceptanceDebugPort);
}

// Perf triage (MIXDOG_DESKTOP_PERF=1): any synchronous child process spawned on
// the MAIN thread freezes the event loop (timers, IPC, transitions) for its
// full runtime while showing near-zero CPU. Attribute every long sync spawn.
if (process.env.MIXDOG_DESKTOP_PERF === '1') {
  void (async () => {
    // ESM namespace exports are read-only; patch the mutable CJS exports object.
    const { createRequire } = await import('node:module');
    const cp = createRequire(import.meta.url)('node:child_process') as
      typeof import('node:child_process');
    const { appendFile } = await import('node:fs/promises');
    let writeQueue: Promise<void> = Promise.resolve();
    const wrap = <K extends 'spawnSync' | 'execSync' | 'execFileSync'>(name: K) => {
      const original = (cp as Record<K, (...values: unknown[]) => unknown>)[name];
      const wrapped = (...values: unknown[]) => {
        const started = Date.now();
        try {
          return original(...values);
        } finally {
          const ms = Date.now() - started;
          if (ms >= 150) {
            const caller = (new Error().stack || '').split('\n').slice(2, 5)
              .map((line) => line.trim()).join(' <- ');
            const entry =
              `${new Date().toISOString()} main-sync-spawn ${name} ms=${ms} cmd=${String(values[0] ?? '')} by=${caller}\n`;
            writeQueue = writeQueue
              .then(() => appendFile(
                join(app.getPath('userData'), 'desktop-perf.log'),
                entry,
              ))
              .catch(() => { /* diagnostics only */ });
          }
        }
      };
      try {
        (cp as Record<K, (...values: unknown[]) => unknown>)[name] = wrapped;
        return true;
      } catch {
        // Electron/Vite can expose a read-only ESM namespace here even through
        // createRequire. Diagnostics must never reject desktop startup.
        return false;
      }
    };
    const installed = [wrap('spawnSync'), wrap('execSync'), wrap('execFileSync')].some(Boolean);
    if (!installed) console.warn('Mixdog desktop sync-spawn diagnostics disabled: exports are read-only.');
  })().catch((error) => {
    console.warn(
      'Mixdog desktop sync-spawn diagnostics disabled:',
      error instanceof Error ? error.name : 'Error',
    );
  });
}

function desktopServiceModuleUrl(): string {
  const modulePath = app.isPackaged
    ? join(
      process.resourcesPath,
      'app.asar.unpacked',
      'out',
      'main',
      'daemon.cjs',
    )
    : join(__dirname, 'daemon.cjs');
  const moduleUrl = pathToFileURL(modulePath);
  let artifact = app.getVersion();
  try {
    const stat = statSync(modulePath);
    artifact = `${artifact}:${stat.size}:${Math.trunc(stat.mtimeMs)}`;
  } catch {
    // The daemon reports the eventual import failure with the concrete path.
  }
  moduleUrl.searchParams.set('build', artifact);
  return moduleUrl.href;
}

let diagnostics: DesktopDiagnostics | null = null;
const serviceClient = new DesktopServiceClient({
  connect: () => new SessionTransport(
    desktopServiceModuleUrl(),
    process.cwd(),
  ),
  sessionOptions: () => ({
    userDataPath: app.getPath('userData'),
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    rendererDir: app.isPackaged
      ? join(process.resourcesPath, 'app.asar.unpacked', 'out', 'renderer')
      : join(__dirname, '../renderer'),
  }),
  initialSnapshot: readDesktopModelBootstrapSnapshot(),
  onDiagnostic: (event, data) => {
    diagnostics?.write(
      event,
      event === 'desktop-transport-error'
        ? { type: String(data.type || '') }
        : data,
    );
    console.error(`[mixdog] ${event}`, data);
  },
  onServiceReady: ({ generation }) => {
    // The FIRST attachment belongs to the deferred scheduler, so no early
    // interaction pays for relay startup. Every later one follows a daemon
    // replacement that dropped the relay leg with the old process, and
    // nothing else would ever dial it again: the deferred schedule runs once
    // per window, and this window is already open.
    if (generation <= 1) return;
    diagnostics?.write('relay-redial-after-daemon-restart', { generation });
    void startDeferredDesktopServices();
  },
});
const host: DesktopService = serviceClient;
let daemonServiceBootReported = false;
function startDaemonService(): void {
  if (!daemonServiceBootReported) {
    daemonServiceBootReported = true;
    diagnostics?.write('daemon-service-start', {
      totalMs: Date.now() - desktopProcessStartedAt,
    });
  }
  void serviceClient.start()
    .then(() => {
      diagnostics?.write('daemon-service-ready', {
        totalMs: Date.now() - desktopProcessStartedAt,
      });
    })
    .catch((error: unknown) => {
      diagnostics?.write('daemon-service-start-failed', {
        totalMs: Date.now() - desktopProcessStartedAt,
        errorName: error instanceof Error ? error.name : typeof error,
      });
      console.error('Failed to start the Mixdog daemon:', error);
    });
}
// Scheme privileges must be declared before the app is ready, otherwise the
// media lane cannot stream or answer Range requests.
registerMediaScheme();
const settingsStore = new DesktopSettingsStore({
  packaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  appPath: app.getAppPath(),
});
let mainWindow: BrowserWindow | null = null;
let browserHost: BrowserHost | null = null;
// Last-known Browser Use opt-in: the host is created with the window, which
// may happen before or after the initial settings read, so both sides apply.
let browserControlEnabled = false;
let computerHost: ComputerHost | null = null;
let computerControlEnabled = false;
let removeIpc: (() => void) | null = null;
let pendingPrimaryActivation = false;
function activatePrimaryWindow(): void {
  const window = mainWindow;
  if (!window || window.isDestroyed()) {
    pendingPrimaryActivation = true;
    return;
  }
  pendingPrimaryActivation = false;
  if (window.isMinimized()) window.restore();
  if (!window.isVisible()) window.show();
  window.focus();
}
// PTYs are daemon-owned; Electron forwards control and receives output events.
const serviceTerminalManager = {
  async ensure(
    id: string | null,
    cwd: string | null,
    profile?: import('./terminal-contract').TerminalSpawnProfile | string | null,
  ): Promise<{ id: string; replay: string }> {
    const value = await serviceClient.invokeDesktopOperation('termEnsure', [id, cwd, profile ?? null]);
    if (!value || typeof value !== 'object') {
      throw new Error('The service terminal did not return a session.');
    }
    const result = value as Record<string, unknown>;
    return { id: String(result.id || ''), replay: String(result.replay || '') };
  },
  write(id: string, data: string): void {
    // Keystrokes take the fire-and-forget lane: a response frame per keypress
    // only queued the input behind whatever session request was in flight.
    serviceClient.notifyDesktopOperation('termWrite', [id, data]);
  },
  resize(id: string, cols: number, rows: number): void {
    serviceClient.notifyDesktopOperation('termResize', [id, cols, rows]);
  },
  pauseOutput(id: string): void {
    void serviceClient.invokeDesktopOperation('termPause', [id]).catch(() => {});
  },
  resumeOutput(id: string): void {
    void serviceClient.invokeDesktopOperation('termResume', [id]).catch(() => {});
  },
  dispose(id: string): void {
    void serviceClient.invokeDesktopOperation('termDispose', [id]).catch(() => {});
  },
  disposeAll(): void {},
  subscribe(listener: (event: { id: string; data: string }) => void): () => void {
    return serviceClient.subscribeDesktopEvents(({ name, value }) => {
      if (name !== 'terminal-data' || !value || typeof value !== 'object') return;
      const event = value as Record<string, unknown>;
      listener({ id: String(event.id || ''), data: String(event.data || '') });
    });
  },
};
// Keep-awake spans the app lifetime, not one window: agents keep working
// while the window is closed on macOS and through renderer reloads.
const awakeService = new AgentAwakeService(powerSaveBlocker);
let turnAttention: TurnAttention | null = null;
let unsubscribeAwake: (() => void) | null = null;
let unsubscribeServiceSettings: (() => void) | null = null;
const applyDesktopSettings = (settings: DesktopSettings): void => {
  awakeService.setEnabled(settings.keepAwake !== false);
  applyComputerControlSetting(settings.computerControl === true);
  browserControlEnabled = settings.browserControl === true;
  browserHost?.setBridgeEnabled(browserControlEnabled);
};
// Computer use is opt-in and high risk, so the bridge (and thus the agent
// `computer` tool) exists only while the setting is on. Toggling it starts or
// tears down the host live; Windows-only for now.
function applyComputerControlSetting(enabled: boolean): void {
  computerControlEnabled = enabled && process.platform === 'win32';
  computerHost?.setBridgeEnabled(computerControlEnabled);
}
unsubscribeServiceSettings = serviceClient.subscribeDesktopEvents(({ name, value }) => {
  if (name === 'desktop-settings-changed' && value && typeof value === 'object') {
    applyDesktopSettings(value as DesktopSettings);
  }
});
let quitAfterDispose = false;
let disposalPromise: Promise<void> | null = null;
const DESKTOP_DISPOSE_TIMEOUT_MS = 4_000;
let windowState: ReturnType<typeof persistWindowState> | null = null;
let windowStateFlush: Promise<void> = Promise.resolve();
let diagnosticsMemoryTimer: NodeJS.Timeout | null = null;
let idleReclaim: IdleReclaim | null = null;
let diagnosticsEventLoopTimer: NodeJS.Timeout | null = null;
let deferredServicesPromise: Promise<void> | null = null;
let deferredServicesScheduled = false;
let gpuCrashTimes: number[] = [];
let gpuFallbackScheduled = softwareRenderingThisLaunch;
let gpuFallbackPromptOpen = false;

function currentProcessMemory() {
  try {
    return app.getAppMetrics().slice(0, 32).map((metric) => ({
      pid: metric.pid,
      type: metric.type,
      name: metric.name,
      serviceName: metric.serviceName,
      workingSetKb: metric.memory.workingSetSize,
      peakWorkingSetKb: metric.memory.peakWorkingSetSize,
      privateKb: metric.memory.privateBytes,
    }));
  } catch {
    return [];
  }
}

/** Working set of the renderer processes only, for the idle-reclaim record. */
function rendererWorkingSetKb(): number {
  try {
    return app.getAppMetrics()
      .filter((metric) => metric.type === 'Tab')
      .reduce((total, metric) => total + (metric.memory?.workingSetSize || 0), 0);
  } catch {
    return 0;
  }
}

function currentSystemMemory() {
  const freeBytes = freemem();
  const totalBytes = totalmem();
  return {
    freeKb: Math.round(freeBytes / 1024),
    totalKb: Math.round(totalBytes / 1024),
    pressurePercent: totalBytes > 0
      ? Math.round((1 - freeBytes / totalBytes) * 1_000) / 10
      : 0,
  };
}

const DIAGNOSTICS_EVENT_LOOP_INTERVAL_MS = 1_000;
const DIAGNOSTICS_EVENT_LOOP_LAG_MS = 250;

function startDiagnosticsEventLoopMonitor(): void {
  if (diagnosticsEventLoopTimer) return;
  let expectedAt = Date.now() + DIAGNOSTICS_EVENT_LOOP_INTERVAL_MS;
  diagnosticsEventLoopTimer = setInterval(() => {
    const now = Date.now();
    const durationMs = now - expectedAt;
    expectedAt = now + DIAGNOSTICS_EVENT_LOOP_INTERVAL_MS;
    if (durationMs < DIAGNOSTICS_EVENT_LOOP_LAG_MS) return;
    diagnostics?.write('main-event-loop-lag', {
      durationMs: Math.min(60_000, Math.round(durationMs)),
    });
  }, DIAGNOSTICS_EVENT_LOOP_INTERVAL_MS);
  diagnosticsEventLoopTimer.unref();
}

function installDesktopMenu(): void {
  installNativeMenu(Boolean(process.env.ELECTRON_RENDERER_URL), {
    reset: () => { void setPersistentZoom(1); },
    zoomIn: () => { void setPersistentZoom((mainWindow?.webContents.getZoomFactor() || 1) + 0.2); },
    zoomOut: () => { void setPersistentZoom((mainWindow?.webContents.getZoomFactor() || 1) - 0.2); },
  }, {
    // The OS window stays in Electron; the daemon owns both remote transports.
    showRemoteAccess: () => {
      void (async () => {
        const info = await remoteAccessInfo();
        if (!info) return;
        const { showRemoteAccessWindow } = await import('./remote-access-window');
        await showRemoteAccessWindow(info, mainWindow);
      })().catch((error: unknown) => {
        console.error('Failed to open the remote access window:', error);
      });
    },
  });
}

function startDeferredDesktopServices(): Promise<void> {
  deferredServicesPromise ??= host.invokeDesktopOperation('remoteAccessStart', [])
    .then(() => undefined)
    .finally(() => { deferredServicesPromise = null; });
  return deferredServicesPromise;
}

async function remoteAccessInfo(): Promise<DesktopRemoteAccessInfo | null> {
  const descriptor = await host.invokeDesktopOperation('remoteAccessInfo', []);
  if (!descriptor || typeof descriptor !== 'object') return null;
  const { buildRemoteAccessInfo } = await import('./remote-access-window');
  return buildRemoteAccessInfo(descriptor as RemoteAccessDescriptor);
}

async function rotateRemoteAccess(): Promise<DesktopRemoteAccessInfo | null> {
  const descriptor = await host.invokeDesktopOperation('remoteAccessRotate', []);
  if (!descriptor || typeof descriptor !== 'object') return null;
  const { buildRemoteAccessInfo } = await import('./remote-access-window');
  return buildRemoteAccessInfo(descriptor as RemoteAccessDescriptor);
}

async function revokeRemoteAccessClient(clientId: string): Promise<DesktopRemoteAccessInfo | null> {
  const descriptor = await host.invokeDesktopOperation('remoteAccessRevokeClient', [clientId]);
  if (!descriptor || typeof descriptor !== 'object') return null;
  const { buildRemoteAccessInfo } = await import('./remote-access-window');
  return buildRemoteAccessInfo(descriptor as RemoteAccessDescriptor);
}

function scheduleDeferredDesktopServices(window: BrowserWindow): void {
  if (deferredServicesScheduled || deferredServicesPromise) return;
  deferredServicesScheduled = true;
  // BrowserWindow.webContents is an Electron getter that throws once the
  // BrowserWindow has been destroyed. Keep the live WebContents reference
  // while the window still exists; the `closed` cleanup below is intentionally
  // allowed to run after destruction.
  const webContents = window.webContents;
  let timer: NodeJS.Timeout | null = null;
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    if (timer) clearTimeout(timer);
    timer = null;
    if (window.isDestroyed() || webContents.isDestroyed()) return;
    webContents.removeListener('before-input-event', postpone);
    void startDeferredDesktopServices();
    startAutoUpdater(async () => {
      await disposeDesktopResources();
      quitAfterDispose = true;
    }, (message, data) => {
      diagnostics?.write('updater', { message, ...data });
    });
  };
  const schedule = (delay: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(start, delay);
    timer.unref();
  };
  // Never make the FIRST click/wheel pay bridge/relay import and startup.
  // Interaction postpones this main-process work until two quiet seconds.
  const postpone = () => { if (!started) schedule(2_000); };
  webContents.on('before-input-event', postpone);
  schedule(4_000);
  window.once('closed', () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!webContents.isDestroyed()) {
      webContents.removeListener('before-input-event', postpone);
    }
    if (!started) deferredServicesScheduled = false;
  });
}

function disposeDesktopResources(): Promise<void> {
  if (diagnosticsMemoryTimer) {
    clearInterval(diagnosticsMemoryTimer);
    diagnosticsMemoryTimer = null;
  }
  if (diagnosticsEventLoopTimer) {
    clearInterval(diagnosticsEventLoopTimer);
    diagnosticsEventLoopTimer = null;
  }
  idleReclaim?.dispose();
  idleReclaim = null;
  unsubscribeAwake?.();
  unsubscribeAwake = null;
  unsubscribeServiceSettings?.();
  unsubscribeServiceSettings = null;
  awakeService.dispose();
  if (!disposalPromise) diagnostics?.write('desktop-stop');
  serviceTerminalManager.disposeAll();
  if (!disposalPromise) {
    const browserAndComputerCleanup = (async () => {
      await browserHost?.dispose();
      await computerHost?.dispose();
    })();
    const cleanup = Promise.all([
      browserAndComputerCleanup,
      host.dispose(),
      windowStateFlush,
      windowState?.flush(),
      diagnostics?.flush(),
    ])
      .then(() => undefined)
      .catch((error: unknown) => {
        console.error('Failed to dispose Mixdog session during quit:', error);
      });
    let timeout: NodeJS.Timeout | null = null;
    const deadline = new Promise<void>((resolve) => {
      timeout = setTimeout(() => {
        diagnostics?.write('desktop-stop-timeout', { timeoutMs: DESKTOP_DISPOSE_TIMEOUT_MS });
        resolve();
      }, DESKTOP_DISPOSE_TIMEOUT_MS);
    });
    disposalPromise = Promise.race([cleanup, deadline]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });
  }
  return disposalPromise;
}

function handleGpuChildCrash(reason: string, exitCode: number): void {
  if (gpuFallbackScheduled || quitAfterDispose) return;
  const decision = gpuFallbackDecision(gpuCrashTimes, {
    platform: process.platform,
    type: 'GPU',
    reason,
  });
  gpuCrashTimes = decision.crashes;
  if (decision.action !== 'engage' || process.platform !== 'win32') return;
  try {
    writeGpuFallbackMarker(app.getPath('userData'), {
      engagedAt: Date.now(),
      crashesInWindow: decision.crashes.length,
    }, {
      ...gpuFallbackEnvironment,
      platform: 'win32',
    });
  } catch (error) {
    diagnostics?.write('gpu-fallback-persist-failed', {
      errorName: error instanceof Error ? error.name : typeof error,
    });
    return;
  }
  gpuFallbackScheduled = true;
  diagnostics?.write('gpu-fallback-engaged', {
    reason,
    exitCode,
    crashesInWindow: decision.crashes.length,
  });
  if (gpuFallbackPromptOpen) return;
  gpuFallbackPromptOpen = true;
  const options = {
    type: 'warning' as const,
    title: 'Restart Mixdog?',
    message: "Mixdog's graphics process has crashed repeatedly.",
    detail: 'Restart with software rendering to keep Mixdog from disrupting video playback in other apps.',
    buttons: ['Restart with software rendering', 'Keep running'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  };
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  const prompt = parent
    ? dialog.showMessageBox(parent, options)
    : dialog.showMessageBox(options);
  void prompt.then(({ response }) => {
    if (response !== 0 || quitAfterDispose) {
      diagnostics?.write('gpu-fallback-restart-deferred');
      return;
    }
    diagnostics?.write('gpu-fallback-restart');
    app.relaunch();
    app.quit();
  }).catch((error: unknown) => {
    diagnostics?.write('gpu-fallback-prompt-failed', {
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }).finally(() => {
    gpuFallbackPromptOpen = false;
  });
}

async function setPersistentZoom(factor: number): Promise<void> {
  const window = mainWindow;
  if (!window || window.isDestroyed()) return;
  const next = Math.min(10, Math.max(0.2, Math.round(factor * 100) / 100));
  window.webContents.setZoomFactor(next);
  setDesktopTitleBarZoom(window, next);
  const saved = await settingsStore.updateZoom(next);
  if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
    window.webContents.send(DESKTOP_IPC.zoomFactorChanged, saved);
  }
}

function configuredDevelopmentUrl(candidate: string): URL {
  try {
    const url = new URL(candidate);
    const localHost = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
    if (!localHost || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
      throw new Error('Development renderer URL must use a local HTTP(S) origin.');
    }
    return url;
  } catch {
    throw new Error('Invalid local development renderer URL.');
  }
}

async function createWindow(): Promise<void> {
  const startupStartedAt = desktopProcessStartedAt;
  const developmentUrl = process.env.ELECTRON_RENDERER_URL;
  const packagedRendererPath = join(__dirname, '../renderer/index.html');
  // Use an explicit runtime icon even in packaged builds. Relying only on the
  // executable's embedded resource leaves the live taskbar button at the mercy
  // of Explorer's stale icon cache after an in-place installer upgrade.
  const brandIconPath = [
    ...(app.isPackaged ? [join(process.resourcesPath, 'mixdog.ico')] : []),
    ...['mixdog.ico', 'mixdog.png'].map((name) => join(app.getAppPath(), 'build', name)),
  ].find((candidate) => existsSync(candidate)) ?? null;
  const rendererUrl = developmentUrl
    ? configuredDevelopmentUrl(developmentUrl)
    : new URL(pathToFileURL(packagedRendererPath).href);
  const isAllowedNavigation = (candidate: string): boolean => {
    try {
      const target = new URL(candidate);
      return developmentUrl
        ? target.origin === rendererUrl.origin
        : target.href === rendererUrl.href;
    } catch {
      return false;
    }
  };

  const statePath = join(app.getPath('userData'), 'window-state.json');
  const [savedState, initialZoom] = await Promise.all([
    readWindowState(statePath, screen.getAllDisplays()),
    settingsStore ? settingsStore.readZoom() : Promise.resolve(1),
  ]);
  diagnostics?.write('window-state-ready', {
    totalMs: Date.now() - startupStartedAt,
  });
  configureTitleBarThemePersistence(join(app.getPath('userData'), 'desktop-titlebar-theme'));
  const window = new BrowserWindow({
    ...DESKTOP_WINDOW_OPTIONS,
    ...initialTitleBarWindowOverrides(),
    ...(savedState?.bounds ?? {}),
    ...(brandIconPath ? { icon: brandIconPath } : {}),
    webPreferences: {
      ...DESKTOP_WINDOW_OPTIONS.webPreferences,
      preload: join(__dirname, '../preload/index.js'),
      additionalArguments: [
        `--mixdog-boot-id=${desktopBootId}`,
        `--mixdog-process-started-at=${desktopProcessStartedAt}`,
        ...(desktopBootScenario ? [`--mixdog-boot-scenario=${desktopBootScenario}`] : []),
      ],
    },
  });
  if (savedState?.maximized) window.maximize();
  windowState = persistWindowState(window, statePath);
  mainWindow = window;
  if (process.platform === 'win32' && !computerHost) {
    computerHost = createComputerHost({ bridgeEnabled: false });
  }
  computerHost?.setBridgeEnabled(computerControlEnabled);
  // Browser pane host: registers this window's browser-pane webviews. The
  // agent bridge (the runtime's `browser` tool) is opt-in and only serves
  // while the Browser Use setting is on, mirroring Computer Use.
  browserHost = createBrowserHost(window);
  browserHost.setBridgeEnabled(browserControlEnabled);
  // A dead capture/automation CDP client can leave the renderer frozen at a
  // synthetic viewport (observed 800x600) while the native window resizes —
  // the guard detects the persistent mismatch and self-heals.
  installViewportGuard(window);
  // Taskbar attention: flash/bounce when the active turn finishes while this
  // window is unfocused; focusing it clears the signal.
  turnAttention = createTurnAttention({
    isFocused: () => !window.isDestroyed() && window.isFocused(),
    flashFrame: (flag) => {
      if (!window.isDestroyed()) window.flashFrame(flag);
    },
    ...(process.platform === 'darwin'
      ? { bounceDock: () => { app.dock?.bounce('informational'); } }
      : {}),
  });
  // Background memory reclaim: a heavy session leaves the renderer resident
  // above 1 GB and nothing hands that back while the desktop sits untouched.
  idleReclaim = createIdleReclaim({
    isFocused: () => !window.isDestroyed() && window.isFocused(),
    reclaim: async () => {
      if (window.isDestroyed()) return;
      const startedAt = Date.now();
      const beforeKb = rendererWorkingSetKb();
      await purgeRendererMemory(window.webContents);
      diagnostics?.write('renderer-idle-reclaim', {
        beforeKb,
        afterKb: rendererWorkingSetKb(),
        totalMs: Date.now() - startedAt,
      });
    },
  });
  window.on('focus', () => {
    turnAttention?.onFocus();
    idleReclaim?.onFocus();
  });
  window.on('blur', () => idleReclaim?.onBlur());
  // Apply the persisted zoom BEFORE the first paint. It used to be applied by
  // the renderer's lazy getZoomFactor call a beat after the window appeared,
  // which rescaled the page and the titlebar overlay height in quick
  // succession — the visible double "pop" of the title tab on startup.
  if (initialZoom !== 1) {
    setDesktopTitleBarZoom(window, initialZoom);
    window.webContents.on('dom-ready', () => {
      window.webContents.setZoomFactor(initialZoom);
    });
  }
  removeIpc = registerDesktopIpc(window, host, {
    app,
    ipcMain,
    dialog,
    shell,
    powerMonitor,
    nativeImage,
    onDesktopSettingsChanged: applyDesktopSettings,
    browserHost,
    updater: desktopUpdater,
    terminals: serviceTerminalManager,
    remoteAccessInfo,
    rotateRemoteAccess,
    revokeRemoteAccessClient,
  });
  diagnostics?.write('window-created', {
    totalMs: Date.now() - startupStartedAt,
  });

  let rendererFailureTimes: number[] = [];
  let rendererRecoveryPromptOpen = false;
  const reloadRenderer = () => {
    if (quitAfterDispose || window.isDestroyed() || window.webContents.isDestroyed()) return;
    window.webContents.reload();
  };
  const onRendererDiagnostic = (event: Electron.IpcMainEvent, payload: unknown) => {
    if (window.isDestroyed()
      || event.sender !== window.webContents
      || event.senderFrame !== window.webContents.mainFrame) return;
    const composerAction = normalizeRendererComposerActionDiagnostic(payload);
    const longTask = composerAction ? null : normalizeRendererLongTaskDiagnostic(payload);
    diagnostics?.write(
      composerAction ? 'renderer-composer-action' : (longTask ? 'renderer-long-task' : 'renderer-error'),
      composerAction ?? longTask ?? normalizeRendererDiagnostic(payload),
    );
  };
  ipcMain.on(DESKTOP_IPC.rendererDiagnostic, onRendererDiagnostic);
  diagnostics?.write('ipc-ready', {
    totalMs: Date.now() - startupStartedAt,
  });

  let rendererLoaded = false;
  let tryShowWindow = () => {};
  window.webContents.on('did-start-loading', () => {
    diagnostics?.write('renderer-load-start', {
      totalMs: Date.now() - startupStartedAt,
    });
  });
  window.webContents.on('dom-ready', () => {
    diagnostics?.write('renderer-dom-ready', {
      totalMs: Date.now() - startupStartedAt,
    });
  });
  window.webContents.on('did-finish-load', () => {
    rendererLoaded = true;
    diagnostics?.write('renderer-load-finished', {
      totalMs: Date.now() - startupStartedAt,
    });
    tryShowWindow();
  });

  window.on('unresponsive', () => {
    diagnostics?.write('renderer-unresponsive', { processes: currentProcessMemory() });
  });
  window.on('responsive', () => {
    diagnostics?.write('renderer-responsive');
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    const recovery = rendererRecoveryDecision(rendererFailureTimes, details.reason);
    rendererFailureTimes = recovery.failures;
    diagnostics?.write('render-process-gone', {
      reason: details.reason,
      exitCode: details.exitCode,
      recovery: recovery.action,
      processes: currentProcessMemory(),
      systemMemory: currentSystemMemory(),
      crashReporterStatus,
    });
    if (recovery.action === 'reload') {
      setTimeout(reloadRenderer, 250);
      return;
    }
    if (recovery.action !== 'prompt' || rendererRecoveryPromptOpen
      || quitAfterDispose || window.isDestroyed()) return;
    rendererRecoveryPromptOpen = true;
    void dialog.showMessageBox(window, {
      type: 'error',
      title: 'Mixdog needs to recover',
      message: 'The interface stopped repeatedly.',
      detail: 'Your active task remains in the desktop host. Reload the interface to continue.',
      buttons: ['Reload interface', 'Close window'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    }).then(({ response }) => {
      if (response === 0) reloadRenderer();
      else if (!window.isDestroyed()) window.close();
    }).catch(() => reloadRenderer()).finally(() => {
      rendererRecoveryPromptOpen = false;
    });
  });

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url)) event.preventDefault();
  });
  window.webContents.on('will-redirect', (event, url) => {
    if (!isAllowedNavigation(url)) event.preventDefault();
  });
  // A hidden Chromium surface can throttle requestAnimationFrame and delay
  // ready-to-show for seconds. The renderer's React layout-commit handshake
  // plus did-finish-load is therefore sufficient; ready-to-show remains the
  // preferred compositor signal when it arrives first.
  let readyToShow = false;
  let rendererCommitted = false;
  let shown = false;
  let showDeadline: NodeJS.Timeout | null = null;
  let visibleFrameAnnounced = false;
  const announceVisibleFrame = () => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return;
    visibleFrameAnnounced = true;
    void window.webContents.executeJavaScript(`new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        window.__mixdogWindowShown = true;
        window.dispatchEvent(new Event("mixdog:window-shown"));
        resolve(true);
      }));
    })`).then(() => {
      diagnostics?.write('window-visible-frame', {
        totalMs: Date.now() - startupStartedAt,
      });
    }).catch(() => {});
  };
  // A renderer navigation/reload wipes window.__mixdogWindowShown, and the
  // one-shot 'mixdog:window-shown' event never repeats, so every surface gate
  // waited out its 1.2s browser fallback instead (measured: 382ms cold first
  // open vs 1576ms for the same open after a reload). Re-announce once the
  // reloaded document has finished loading, gated on a window that is ALREADY
  // visible and has published its true first frame — cold start still
  // announces exactly once, from showWhenComposed.
  window.webContents.on('did-finish-load', () => {
    if (!visibleFrameAnnounced || window.isDestroyed()
      || window.webContents.isDestroyed() || !window.isVisible()) return;
    announceVisibleFrame();
  });
  const showWhenComposed = (force = false, reason = 'composed') => {
    if (shown || window.isDestroyed()) return;
    if (!force && !(rendererCommitted && (readyToShow || rendererLoaded))) return;
    shown = true;
    if (showDeadline) clearTimeout(showDeadline);
    showDeadline = null;
    window.show();
    diagnostics?.write('window-shown', {
      durationMs: Date.now() - startupStartedAt,
      forced: force,
      reason,
    });
    // Renderer prewarms wait until the window has produced two VISIBLE
    // composed frames. Hidden-window chunk evaluation caused the first shown
    // frame itself to hitch even though the DOM was already committed.
    if (window.webContents.isLoadingMainFrame()) {
      window.webContents.once('did-finish-load', announceVisibleFrame);
    } else announceVisibleFrame();
  };
  tryShowWindow = () => showWhenComposed();
  // A stale listener can outlive its window (dev reloads recreate windows):
  // touching window.webContents after destroy throws "Object has been
  // destroyed", so guard first and detach on close.
  const onRendererReady = (event: Electron.IpcMainEvent) => {
    if (window.isDestroyed() || event.sender !== window.webContents) return;
    if (!rendererCommitted) {
      diagnostics?.write('renderer-ready', {
        durationMs: Date.now() - startupStartedAt,
      });
    }
    rendererCommitted = true;
    // Idempotent fallback for recreated windows; the primary boot starts this
    // concurrently before renderer navigation.
    startDaemonService();
    showWhenComposed();
    scheduleDeferredDesktopServices(window);
  };
  ipcMain.on(DESKTOP_IPC.rendererReady, onRendererReady);
  window.once('ready-to-show', () => {
    readyToShow = true;
    diagnostics?.write('ready-to-show', {
      totalMs: Date.now() - startupStartedAt,
    });
    showWhenComposed();
  });
  showDeadline = setTimeout(
    () => showWhenComposed(true, 'absolute-deadline'),
    Math.max(0, DESKTOP_WINDOW_SHOW_DEADLINE_MS - (Date.now() - startupStartedAt)),
  );
  showDeadline.unref();
  window.on('closed', () => {
    if (showDeadline) clearTimeout(showDeadline);
    showDeadline = null;
    diagnostics?.write('window-closed');
    ipcMain.removeListener(DESKTOP_IPC.rendererReady, onRendererReady);
    ipcMain.removeListener(DESKTOP_IPC.rendererDiagnostic, onRendererDiagnostic);
    const state = windowState;
    windowState = null;
    windowStateFlush = state?.flush().finally(() => state.dispose()) ?? Promise.resolve();
    removeIpc?.();
    removeIpc = null;
    mainWindow = null;
    turnAttention = null;
  });

  try {
    diagnostics?.write('renderer-navigation-start', {
      totalMs: Date.now() - startupStartedAt,
      development: Boolean(developmentUrl),
    });
    if (developmentUrl) {
      await window.loadURL(rendererUrl.href);
    } else {
      await window.loadFile(packagedRendererPath);
    }
  } catch (error) {
    if (!window.isDestroyed()) window.destroy();
    throw error;
  }
}

if (!app.requestSingleInstanceLock()) {
  // The dev shell now shares the installed app's profile, so a running
  // Mixdog holds the lock. Say so instead of exiting silently.
  if (!app.isPackaged) {
    console.error(
      'Mixdog desktop: another instance already owns the shared user profile. '
      + 'Close the running app, or set MIXDOG_DESKTOP_USER_DATA to run an isolated profile.',
    );
  }
  app.quit();
} else {
  app.on('second-instance', () => {
    activatePrimaryWindow();
  });

  void app.whenReady().then(async () => {
    const appReadyAt = Date.now();
    // Windows toast/taskbar identity. Packaged installs get a shortcut whose
    // AppUserModelID matches, so the taskbar resolves the branded icon. In the
    // dev/preview shell no such shortcut exists and an explicit AUMID makes
    // Explorer fall back to electron.exe's stock icon for the taskbar button
    // (user-reported missing Mixdog icon), so leave the default identity there
    // and let the BrowserWindow icon brand the button instead.
    if (process.platform === 'win32' && app.isPackaged) {
      app.setAppUserModelId('io.mixdog.desktop');
    }
    diagnostics = createDesktopDiagnostics(
      join(app.getPath('userData'), 'logs', 'desktop-diagnostics.jsonl'),
      {
        appVersion: app.getVersion(),
        packaged: app.isPackaged,
        bootId: desktopBootId,
        ...(desktopBootScenario ? { scenario: desktopBootScenario } : {}),
      },
    );
    diagnostics.write('process-entry', {
      occurredAt: new Date(desktopProcessStartedAt).toISOString(),
      totalMs: 0,
    });
    diagnostics.write('app-ready', {
      totalMs: appReadyAt - desktopProcessStartedAt,
    });
    diagnostics.write('desktop-start', {
      totalMs: Date.now() - desktopProcessStartedAt,
      electronVersion: process.versions.electron,
      chromeVersion: process.versions.chrome,
      nodeVersion: process.versions.node,
      sessionProcess: 'daemon',
      gpuRendering: softwareRenderingThisLaunch ? 'software-fallback' : 'hardware',
      crashReporterStatus,
      ...(crashReporterErrorName ? { crashReporterErrorName } : {}),
      ...(gpuFallbackMarker
        ? { gpuFallbackCrashes: gpuFallbackMarker.crashesInWindow }
        : {}),
    });
    // The daemon front door is intentionally lighter than the renderer and
    // prewarms runtime work asynchronously. Start it in parallel with window
    // creation so immediate post-update submits queue for readiness instead of
    // beginning the service handshake only after the first React frame.
    startDaemonService();
    startDiagnosticsEventLoopMonitor();
    // Keep-awake + taskbar attention feed on the same session state lane.
    unsubscribeAwake = host.subscribe((snapshot) => {
      awakeService.onSnapshot(snapshot);
      turnAttention?.onSnapshot(snapshot);
      idleReclaim?.onSnapshot(snapshot);
    });
    void settingsStore.read().then(applyDesktopSettings).catch(() => {
      /* default stays enabled */
    });
    powerMonitor.on('resume', () => {
      // The blocker may have been dropped across sleep; re-assert it, and
      // redial the relay leg instead of waiting for the ping cycle.
      awakeService.reevaluate();
      void host.invokeDesktopOperation('remoteAccessResume', []).catch(() => {});
    });
    diagnosticsMemoryTimer = setInterval(() => {
      diagnostics?.write('process-memory', {
        processes: currentProcessMemory(),
        systemMemory: currentSystemMemory(),
      });
    }, 5 * 60 * 1000);
    diagnosticsMemoryTimer.unref();
    app.on('child-process-gone', (_event, details) => {
      diagnostics?.write('child-process-gone', {
        type: details.type,
        reason: details.reason,
        exitCode: details.exitCode,
        serviceName: details.serviceName,
        name: details.name,
      });
      if (String(details.type).toLowerCase() === 'gpu') {
        handleGpuChildCrash(details.reason, details.exitCode);
      }
    });
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      const development = Boolean(process.env.ELECTRON_RENDERER_URL);
      // GitHub avatar hosts are allowed in img-src for the onboarding /
      // settings account cards (github.com redirects to avatars host).
      // media-src mirrors img-src: Studio tiles load from the mixdog-media
      // byte lane, and older paths still inline data:/blob: URLs, which
      // default-src 'self' would otherwise block.
      const policy = development
        ? `default-src 'self'; script-src 'self' 'unsafe-eval' 'unsafe-inline'; connect-src 'self' ${MEDIA_SCHEME}: ws://127.0.0.1:* ws://localhost:*; img-src 'self' data: blob: ${MEDIA_SCHEME}: https://github.com https://avatars.githubusercontent.com; media-src 'self' data: blob: ${MEDIA_SCHEME}:; frame-src 'self' blob: ${MEDIA_SCHEME}:; style-src 'self' 'unsafe-inline'; font-src 'self' data:`
        : `default-src 'self'; script-src 'self'; connect-src 'self' ${MEDIA_SCHEME}:; img-src 'self' data: blob: ${MEDIA_SCHEME}: https://github.com https://avatars.githubusercontent.com; media-src 'self' data: blob: ${MEDIA_SCHEME}:; frame-src 'self' blob: ${MEDIA_SCHEME}:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`;
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [policy],
        },
      });
    });
    // Gallery bytes leave the RPC lane here: tiles and clips become ordinary
    // cacheable, range-able resources fetched straight by the DOM.
    registerMediaProtocol(host);
    // Push-to-talk and pairing use getUserMedia. Only the trusted desktop
    // renderer receives that permission; every other permission fails closed.
    const trustedPermissionSender = () => {
      const window = mainWindow;
      return window && !window.isDestroyed() ? window.webContents : null;
    };
    session.defaultSession.setPermissionCheckHandler((webContents, permission) =>
      desktopPermissionAllowed(permission, webContents, trustedPermissionSender()));
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      const allowed = desktopPermissionAllowed(
        permission,
        webContents,
        trustedPermissionSender(),
      );
      if (!allowed) {
        diagnostics?.write('permission-request', { permission });
      }
      callback(allowed);
    });
    await createWindow();
    if (pendingPrimaryActivation) activatePrimaryWindow();
    installDesktopMenu();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createWindow().catch((error: unknown) => {
          console.error('Failed to recreate the Mixdog desktop window:', error);
        });
      }
    });
  }).catch((error: unknown) => {
    diagnostics?.write('desktop-initialize-failed', {
      errorName: error instanceof Error ? error.name : typeof error,
      errorCode: typeof error === 'object' && error !== null && 'code' in error
        ? String((error as NodeJS.ErrnoException).code || '')
        : '',
    });
    console.error('Failed to initialize the Mixdog desktop window:', error);
    app.quit();
  });
}

app.on('before-quit', (event) => {
  if (quitAfterDispose) return;
  event.preventDefault();
  removeIpc?.();
  removeIpc = null;
  void disposeDesktopResources().finally(() => {
      quitAfterDispose = true;
      app.quit();
    });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

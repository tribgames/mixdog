import { existsSync, statSync } from 'node:fs';
import * as nodeModule from 'node:module';
import { constants as osConstants, freemem, homedir, setPriority, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { inlineBootScriptHash, withInlineBootScript } from './renderer-csp';
import { pathToFileURL } from 'node:url';

import {
  app,
  BrowserWindow,
  crashReporter,
  dialog,
  ipcMain,
  Notification,
  powerMonitor,
  powerSaveBlocker,
  screen,
  session,
  shell,
} from 'electron';

import type { DesktopService } from './desktop-service-contract';
import { DesktopServiceClient } from './desktop-service-client';
import { isSessionId } from './desktop-state';
import { SessionTransport } from './session-transport';
import { readDesktopModelBootstrapSnapshot } from './model-bootstrap';
import { AgentAwakeService } from './agent-awake';
import { createBackgroundWindow } from './background-window';
import { createDesktopTray, type DesktopTray } from './desktop-tray';
import { loginShellOverrides, readLoginShellEnvironment } from './login-shell-environment';
import { createTurnAttention, type TurnAttention } from './turn-attention';
import { createDesktopTurnNotifier } from './desktop-turn-notifier';
import { desktopIdentity } from './desktop-identity';
import { notificationSoundPath, playWindowsNotificationSound } from './notification-sound';
import { activateDesktopWindow, openDesktopNotificationSession } from './notification-window';
import { createIdleReclaim, purgeRendererMemory, type IdleReclaim } from './idle-reclaim';
import { watchCrashHandler } from './crash-handler-watch';
import { createDesktopDiagnostics, type DesktopDiagnostics } from './desktop-diagnostics';
import { scheduleDeferredDesktopServices as scheduleAfterServiceQuiet } from './deferred-desktop-services';
import { installViewportGuard } from './viewport-guard';
import {
  gpuFallbackDecision,
  readActiveGpuFallbackMarker,
  writeGpuFallbackMarker,
  type GpuFallbackEnvironment,
} from './gpu-recovery';
import { registerDesktopIpc } from './ipc';
import { createBrowserHost, type BrowserHost } from './browser/host';
import { createComputerHost, type ComputerHost } from './computer';
import { bridgeDiscoveryDirectory } from './bridge/discovery-file';
import { TerminalBridgeServer } from './terminal/bridge-server';
import { createTerminalCommandExecutor, type TerminalBridgeCommand } from './terminal/commands';
import type { SessionTerminalTab } from './terminal-manager';
import { requestComputerPermissions } from './computer/host/permission-reads';
import { createComputerUseOverlay, type ComputerUseOverlay } from './computer/overlay';
import { confirmComputerTurnsStopped } from './computer/overlay/stop-turns';
import { MEDIA_SCHEME, registerMediaProtocol, registerMediaScheme } from './media-protocol';
import { desktopPermissionAllowed } from './permission-policy';
import { installNativeMenu } from './menu';
import { nativeT, refreshNativeUiLanguage } from './native-i18n';
import { DesktopSettingsStore } from './settings-store';
import { mixdogDataDirectory } from './computer/shared/common';
import { desktopUpdater, startAutoUpdater } from './updater';
import { gcSupersededNativeToolCaches } from './native-runtime-cache-gc.mjs';
import {
  DESKTOP_WINDOW_OPTIONS,
  configureTitleBarThemePersistence,
  initialTitleBarWindowOverrides,
  installDesktopWindowMaterial,
} from './window-options';
import {
  DESKTOP_IPC,
  type DesktopRemoteAccessInfo,
  type DesktopRemoteBrowserControl,
  type DesktopRemoteBrowserStreamOptions,
  type DesktopSettings,
} from '../shared/contract';
import { persistWindowState, readWindowState } from './window-state';
import {
  normalizeTranscriptReadDiagnostic,
  setTranscriptReadDiagnosticSink,
} from '../shared/transcript-read-diagnostics';
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
  stream?.on?.('error', () => {
    /* dead stdio pipe: logging is best-effort */
  });
}
// V8 compile cache for the main process's dynamic imports (remote access,
// dialogs) and the daemon service adapter. Best-effort no-op when the
// running Node build lacks the API.
try {
  (nodeModule as { enableCompileCache?: () => unknown }).enableCompileCache?.();
} catch {
  /* launch-speed optimization only */
}
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
  // An isolated profile holds its own single-instance lock, so it can run
  // beside the installed app. Without its own data dir it would publish its
  // Browser/Computer Use bridges into the shared `~/.mixdog/data` and steal
  // the running app's tool surface (observed: a probe run shadowed the live
  // browser bridge until it exited). Namespace the discovery files with the
  // profile instead; the daemon inherits the variable and looks there too.
  if (!process.env.MIXDOG_DATA_DIR && !process.env.MIXDOG_BRIDGE_DISCOVERY_DIR) {
    process.env.MIXDOG_BRIDGE_DISCOVERY_DIR = join(app.getPath('userData'), 'bridges');
  }
} else if (!app.isPackaged) {
  app.setPath('userData', join(app.getPath('appData'), PACKAGED_USER_DATA_DIRECTORY));
}

// Branding must not relocate an existing profile. Development and notification
// probes must never register electron.exe under the installed sender identity.
const desktopBrand = desktopIdentity(app.isPackaged ? 'installed' : 'development');
const desktopUserData = app.getPath('userData');
app.setName(desktopBrand.name);
app.setPath('userData', desktopUserData);

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
// The Crashpad handler is a separate process and a second crashReporter.start()
// is a silent no-op, so a handler that dies cannot be restarted in-process.
// Children (the ELECTRON_RUN_AS_NODE daemon included) register with it through
// the inherited CHROME_CRASHPAD_PIPE_NAME; after a loss a respawned daemon would
// fail that registration and be killed 0xFFFF7003 without a dump on its first
// fatal error. The watcher records the loss and drops the dead pipe so later
// children fall back to Windows' own handler.
let stopCrashHandlerWatch: (() => void) | null = null;
function startCrashHandlerWatch(): void {
  if (crashReporterStatus !== 'local' || stopCrashHandlerWatch) return;
  stopCrashHandlerWatch = watchCrashHandler({
    mainPid: process.pid,
    onEvent: (event) => {
      if (event.state === 'lost') {
        crashReporterStatus = 'lost';
        console.error('Mixdog desktop crash handler is gone:', event);
      }
      diagnostics?.write(`crash-handler-${event.state}`, {
        ...event,
        ...(event.state === 'lost' ? { systemMemory: currentSystemMemory() } : {}),
      });
    },
  });
}

if (app.isPackaged) {
  const nativeToolsDir = join(process.resourcesPath, 'native-tools');
  const executableSuffix = process.platform === 'win32' ? '.exe' : '';
  const graphPath = join(nativeToolsDir, `mixdog-graph${executableSuffix}`);
  const nativeOverrides = [
    { kind: 'graph', names: ['MIXDOG_GRAPH_BIN', 'MIXDOG_SEARCH_SERVER_BIN'], path: graphPath },
    {
      kind: 'patch',
      names: ['MIXDOG_PATCH_NATIVE_BIN'],
      path: join(nativeToolsDir, `mixdog-patch${executableSuffix}`),
    },
    {
      kind: 'spawn',
      names: ['MIXDOG_SPAWN_SERVER_BIN'],
      path: join(nativeToolsDir, `mixdog-spawn${executableSuffix}`),
    },
  ];
  const bundledKinds = [];
  for (const { kind, names, path } of nativeOverrides) {
    if (!existsSync(path)) continue;
    for (const name of names) {
      if (!process.env[name]) process.env[name] = path;
    }
    if (names.every((name) => process.env[name] === path)) bundledKinds.push(kind);
  }
  const mixdogHome = process.env.MIXDOG_HOME || join(homedir(), '.mixdog');
  const dataDir = process.env.MIXDOG_DATA_DIR || join(mixdogHome, 'data');
  void gcSupersededNativeToolCaches(dataDir, bundledKinds).then(({ failed }) => {
    for (const { kind, error } of failed) {
      console.warn(`Could not remove superseded ${kind} runtime cache:`, error);
    }
  });
}

// The native Computer Use backend for macOS and Linux: bundled with packaged
// builds, built from native/mixdog-computer during development.
if (process.platform !== 'win32' && !process.env.MIXDOG_COMPUTER_BIN) {
  const computerBackend = app.isPackaged
    ? join(process.resourcesPath, 'native-tools', 'mixdog-computer')
    : join(app.getAppPath(), '..', '..', 'native', 'mixdog-computer', 'target', 'release', 'mixdog-computer');
  if (existsSync(computerBackend)) process.env.MIXDOG_COMPUTER_BIN = computerBackend;
}

const gpuFallbackEnvironment: GpuFallbackEnvironment = {
  appVersion: app.getVersion(),
  electronVersion: process.versions.electron || '',
  platform: process.platform,
};
const gpuFallbackMarker = readActiveGpuFallbackMarker(app.getPath('userData'), gpuFallbackEnvironment);
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
const rendererHeapMb =
  Number.isFinite(configuredRendererHeapMb) && configuredRendererHeapMb >= 0
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
    const cp = createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process');
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
            const caller = (new Error().stack || '')
              .split('\n')
              .slice(2, 5)
              .map((line) => line.trim())
              .join(' <- ');
            const entry = `${new Date().toISOString()} main-sync-spawn ${name} ms=${ms} cmd=${String(values[0] ?? '')} by=${caller}\n`;
            writeQueue = writeQueue
              .then(() => appendFile(join(app.getPath('userData'), 'desktop-perf.log'), entry))
              .catch(() => {
                /* diagnostics only */
              });
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
    console.warn('Mixdog desktop sync-spawn diagnostics disabled:', error instanceof Error ? error.name : 'Error');
  });
}

function desktopServiceModuleUrl(): string {
  const modulePath = app.isPackaged
    ? join(process.resourcesPath, 'app.asar.unpacked', 'out', 'main', 'daemon.cjs')
    : join(import.meta.dirname, 'daemon.cjs');
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
const earlyDiagnostics: Array<{ event: string; entry: Record<string, unknown>; at: string }> = [];
function writeBootDiagnostic(event: string, entry: Record<string, unknown>): void {
  if (diagnostics) diagnostics.write(event, entry);
  else earlyDiagnostics.push({ event, entry, at: new Date().toISOString() });
}
// Resolved at once for the instance that quits on the single-instance lock.
let loginShellEnvironmentReady: Promise<void> = Promise.resolve();
/** Adopt the user's login-shell environment (macOS/Linux GUI launches lack
 *  it) before the daemon, which inherits process.env at spawn, exists. */
function adoptLoginShellEnvironment(): Promise<void> {
  const startedAt = Date.now();
  return readLoginShellEnvironment().then(({ environment, failures }) => {
    const overrides = environment ? loginShellOverrides(process.env, environment) : {};
    Object.assign(process.env, overrides);
    if (process.platform === 'win32') return;
    writeBootDiagnostic('login-shell-environment', {
      durationMs: Date.now() - startedAt,
      adopted: Boolean(environment),
      changedCount: Object.keys(overrides).length,
      failures,
    });
  });
}
const serviceClient = new DesktopServiceClient({
  connect: () => new SessionTransport(desktopServiceModuleUrl(), process.cwd(), null, loginShellEnvironmentReady),
  sessionOptions: () => ({
    userDataPath: app.getPath('userData'),
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    rendererDir: app.isPackaged
      ? join(process.resourcesPath, 'app.asar.unpacked', 'out', 'renderer')
      : join(import.meta.dirname, '../renderer'),
  }),
  initialSnapshot: readDesktopModelBootstrapSnapshot(),
  onDiagnostic: (event, data) => {
    const entry =
      event === 'desktop-transport-error'
        ? {
            type: String(data.type || ''),
            detail: String(data.detail || '')
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 500),
            generation: Number(data.generation) || 0,
          }
        : data;
    // The daemon handshake starts before app.whenReady opens the sink: its
    // first phases (client import, discovery probe, spawn) are exactly the
    // ones a boot investigation needs, so they wait here and flush in order.
    writeBootDiagnostic(event, entry);
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
// The daemon handshake starts before app.whenReady, when the diagnostics sink
// does not exist yet; the first start is stamped here and written as soon as
// the sink opens, so the boot timeline keeps its daemon-service-start entry.
let daemonServiceStartedAt = 0;
let daemonServiceBootReported = false;
function reportDaemonServiceStart(): void {
  if (daemonServiceBootReported || !daemonServiceStartedAt || !diagnostics) return;
  daemonServiceBootReported = true;
  diagnostics.write('daemon-service-start', {
    totalMs: daemonServiceStartedAt - desktopProcessStartedAt,
  });
}
function startDaemonService(): void {
  if (!daemonServiceStartedAt) daemonServiceStartedAt = Date.now();
  reportDaemonServiceStart();
  void serviceClient
    .start()
    .then(() => {
      terminalBridge.start();
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
let browserHostDisposal: Promise<void> = Promise.resolve();
// Last-known Browser Use opt-in: the host is created with the window, which
// may happen before or after the initial settings read, so both sides apply.
let browserControlEnabled = false;
let computerHost: ComputerHost | null = null;
let computerUseOverlay: ComputerUseOverlay | null = null;
let computerControlEnabled = false;
// The first application is the stored state at launch, not a user's toggle.
let computerControlApplied = false;
// Observation-only opt-in travels with the host the same way, so a toggle made
// before the window exists still reaches the bridge when it starts.
let computerObserveOnly = false;
let removeIpc: (() => void) | null = null;
let pendingPrimaryActivation = false;
function activatePrimaryWindow(): void {
  pendingPrimaryActivation = !activateDesktopWindow(mainWindow);
}
// PTYs are daemon-owned; Electron forwards control and receives output events.
const serviceTerminalManager = {
  async ensure(
    id: string | null,
    cwd: string | null,
    profile?: import('./terminal-contract').TerminalSpawnProfile | string | null
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
  subscribe(listener: (event: { id: string; data: string }) => void): () => void {
    return serviceClient.subscribeDesktopEvents(({ name, value }) => {
      if (name !== 'terminal-data' || !value || typeof value !== 'object') return;
      const event = value as Record<string, unknown>;
      listener({ id: String(event.id || ''), data: String(event.data || '') });
    });
  },
};
// Agent `terminal` tool: a read-only loopback bridge over the daemon-owned
// PTYs. A hidden always-on built-in (like Media Studio): it runs for the app's
// lifetime, so headless runs without the desktop app never see the tool.
const terminalBridge = new TerminalBridgeServer<TerminalBridgeCommand>({
  dataDirectory: bridgeDiscoveryDirectory,
  execute: createTerminalCommandExecutor({
    sessionTabs: async (sessionId) =>
      (await serviceClient.invokeDesktopOperation('termSessionTabs', [sessionId])) as SessionTerminalTab[],
    snapshot: async (id, since) =>
      (await serviceClient.invokeDesktopOperation('termSnapshot', since === undefined ? [id] : [id, since])) as {
        text: string;
        cursor: number;
        reset: boolean;
      } | null,
  }),
});
// Keep-awake spans the app lifetime, not one window: agents keep working
// while the window is closed on macOS and through renderer reloads.
const awakeService = new AgentAwakeService(powerSaveBlocker);
let turnAttention: TurnAttention | null = null;
let unsubscribeAwake: (() => void) | null = null;
let unsubscribeServiceSettings: (() => void) | null = null;
// OS notification on final answers: schedules notify even in the foreground,
// ordinary conversations only while unfocused. Both respect the setting.
// App-lifetime like keep-awake: a window hidden to the tray still wants it.
let turnNotificationsEnabled = true;
const turnNotifier = createDesktopTurnNotifier({
  isEnabled: () => turnNotificationsEnabled,
  isSupported: () => Notification.isSupported(),
  isForeground: () =>
    Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && mainWindow.isFocused()),
  createNotification: (content) =>
    new Notification({
      ...content,
      // Windows already brands the header through the registered shortcut.
      // An explicit icon adds a second, large image beside the body.
      ...(process.platform === 'win32' ? {} : { icon: trayIconPath() ?? undefined }),
      silent: process.platform === 'win32',
    }),
  ...(process.platform === 'win32'
    ? {
        playSound: () =>
          playWindowsNotificationSound(
            notificationSoundPath({
              packaged: app.isPackaged,
              resourcesPath: process.resourcesPath,
              appPath: app.getAppPath(),
            }),
            false,
            desktopBrand.appId
          ),
      }
    : {}),
  readFinalAnswer: (sessionId, startedAt) => serviceClient.readSessionFinalAnswer(sessionId, startedAt),
  diagnostic: (event, details) => {
    diagnostics?.write(`turn-notification-${event}`, details);
    if (event === 'failed' || event === 'read-failed') console.error(`[mixdog-turn-notification] ${event}`, details);
  },
  openSession: (sessionId) => {
    pendingPrimaryActivation = !openDesktopNotificationSession(mainWindow, sessionId);
  },
});
let unsubscribeTurnNotifier: (() => void) | null = null;
const applyDesktopSettings = (settings: DesktopSettings): void => {
  awakeService.setEnabled(settings.keepAwake !== false);
  turnNotificationsEnabled = settings.turnNotifications !== false;
  runInBackground = settings.runInBackground !== false;
  syncDesktopTray();
  applyComputerControlSetting(settings.computerControl === true);
  applyComputerObserveOnlySetting(settings.computerObserveOnly === true);
  browserControlEnabled = settings.browserControl === true;
  browserHost?.setBridgeEnabled(browserControlEnabled);
};
// Computer use is opt-in and high risk, so the bridge (and thus the agent
// `computer` tool) exists only while the setting is on. Toggling it starts or
// tears down the host live.
function applyComputerControlSetting(enabled: boolean): void {
  // macOS withholds input and the accessibility tree until the user grants
  // Accessibility, and every foreign window's pixels until it grants Screen
  // Recording. Ask only when the user turns Computer Use on: launching the
  // app or changing an unrelated setting re-applies every setting, and a
  // grant missing later is named by diagnose and the capture error instead.
  if (enabled && !computerControlEnabled && computerControlApplied) requestComputerPermissions();
  computerControlApplied = true;
  computerControlEnabled = enabled;
  computerHost?.setBridgeEnabled(computerControlEnabled);
}
// Observation only: the bridge keeps serving reads while every input action is
// refused by the host, so a running agent turn is narrowed the moment it flips.
function applyComputerObserveOnlySetting(enabled: boolean): void {
  computerObserveOnly = enabled === true;
  computerHost?.setObserveOnly(computerObserveOnly);
}
unsubscribeServiceSettings = serviceClient.subscribeDesktopEvents(({ name, value }) => {
  if (name === 'session-runtime-released') {
    const event = value as { sessionId?: unknown; restore?: unknown } | null;
    if (isSessionId(event?.sessionId)) {
      browserHost?.releaseSession(event.sessionId, { restore: event.restore === true });
    }
    return;
  }
  if (name === 'browser-remote-request') {
    const request =
      value && typeof value === 'object' ? (value as { id?: unknown; method?: unknown; args?: unknown }) : {};
    const id = typeof request.id === 'string' ? request.id : '';
    const method =
      request.method === 'stream' || request.method === 'control' || request.method === 'release'
        ? request.method
        : '';
    const args = Array.isArray(request.args) ? request.args : [];
    if (!id || !method) return;
    void (async () => {
      try {
        if (!browserHost) throw new Error('Desktop Browser Use is unavailable.');
        const sessionId = typeof args[0] === 'string' ? args[0] : '';
        let result: unknown;
        if (method === 'stream') {
          result = await browserHost.remoteBrowserStream(
            sessionId,
            args[1] as DesktopRemoteBrowserStreamOptions | null
          );
        } else if (method === 'control') {
          result = await browserHost.remoteBrowserControl(sessionId, args[1] as DesktopRemoteBrowserControl);
        } else {
          result = browserHost.releaseSession(sessionId);
        }
        await serviceClient.invokeDesktopOperation('browserRemoteResolve', [id, true, result ?? null, null]);
      } catch (error) {
        await serviceClient
          .invokeDesktopOperation('browserRemoteResolve', [
            id,
            false,
            null,
            error instanceof Error ? error.message : String(error),
          ])
          .catch(() => {});
      }
    })();
    return;
  }
  if (name === 'desktop-settings-changed' && value && typeof value === 'object') {
    applyDesktopSettings(value as DesktopSettings);
  }
});
let quitAfterDispose = false;
// Last-known runInBackground setting; the window's close listener reads it live.
let runInBackground = true;
// A quit is under way (any quit entry, relaunch, failed start, OS session
// end): windows close for real instead of hiding to the tray.
let quitApproved = false;
let desktopTray: DesktopTray | null = null;
const backgroundWindow = createBackgroundWindow({
  enabled: () => runInBackground,
  quitting: () => quitApproved || quitAfterDispose,
});

function trayIconPath(): string | null {
  const name = process.platform === 'win32' ? 'mixdog.ico' : 'mixdog.png';
  return (
    [...(app.isPackaged ? [join(process.resourcesPath, name)] : []), join(app.getAppPath(), 'build', name)].find(
      (candidate) => existsSync(candidate)
    ) ?? null
  );
}

/** Windows and Linux carry a tray icon from launch, whatever the close
 *  setting; macOS has its Dock icon. */
function syncDesktopTray(): void {
  if (quitApproved || process.platform === 'darwin' || !app.isReady()) {
    desktopTray?.dispose();
    desktopTray = null;
    return;
  }
  if (desktopTray) return;
  const iconPath = trayIconPath();
  if (!iconPath) return;
  desktopTray = createDesktopTray({ iconPath, open: activatePrimaryWindow, quit: () => app.quit() });
}

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
    return app
      .getAppMetrics()
      .slice(0, 32)
      .map((metric) => ({
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
    return app
      .getAppMetrics()
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
    pressurePercent: totalBytes > 0 ? Math.round((1 - freeBytes / totalBytes) * 1_000) / 10 : 0,
  };
}

// Dropped caches shrink the renderer only once V8 collects them: read at once,
// afterKb always equalled beforeKb (8 of 8 records), so the record waits.
const RENDERER_RECLAIM_SETTLE_MS = 60_000;

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
  installNativeMenu(
    Boolean(process.env.ELECTRON_RENDERER_URL),
    {
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
    }
  );
}

function startDeferredDesktopServices(): Promise<void> {
  if (deferredServicesPromise) return deferredServicesPromise;
  const startedAt = Date.now();
  diagnostics?.write('deferred-services-start', {});
  deferredServicesPromise = host
    .invokeDesktopOperation('remoteAccessStart', [])
    .then(() => {
      diagnostics?.write('deferred-services-ready', { durationMs: Date.now() - startedAt });
    })
    .catch((error: unknown) => {
      diagnostics?.write('deferred-services-failed', {
        durationMs: Date.now() - startedAt,
        errorName: error instanceof Error ? error.name : typeof error,
      });
      throw error;
    })
    .finally(() => {
      deferredServicesPromise = null;
    });
  return deferredServicesPromise;
}

async function remoteAccessInfo(): Promise<DesktopRemoteAccessInfo | null> {
  const descriptor = await host.invokeDesktopOperation('remoteAccessInfo', []);
  const { remoteAccessInfoFromDescriptor } = await import('./remote-access-window');
  return remoteAccessInfoFromDescriptor(descriptor);
}

async function rotateRemoteAccess(): Promise<DesktopRemoteAccessInfo | null> {
  const descriptor = await host.invokeDesktopOperation('remoteAccessRotate', []);
  const { remoteAccessInfoFromDescriptor } = await import('./remote-access-window');
  return remoteAccessInfoFromDescriptor(descriptor);
}

async function revokeRemoteAccessClient(clientId: string): Promise<DesktopRemoteAccessInfo | null> {
  const descriptor = await host.invokeDesktopOperation('remoteAccessRevokeClient', [clientId]);
  const { remoteAccessInfoFromDescriptor } = await import('./remote-access-window');
  return remoteAccessInfoFromDescriptor(descriptor);
}

function scheduleDeferredDesktopServices(window: BrowserWindow): void {
  if (deferredServicesScheduled || deferredServicesPromise) return;
  deferredServicesScheduled = true;
  scheduleAfterServiceQuiet(window, {
    awaitServiceReady: () => serviceClient.start(),
    start: () => {
      void startDeferredDesktopServices().catch((error: unknown) => {
        console.error('Failed to start deferred Desktop services:', error);
      });
      diagnostics?.write('updater-start', {});
      startAutoUpdater(
        async () => {
          await disposeDesktopResources();
          quitAfterDispose = true;
        },
        (message, data) => {
          diagnostics?.write('updater', { message, ...data });
        }
      );
    },
    onReady: () => diagnostics?.write('deferred-services-quiet-phase', {}),
    onCancelled: () => {
      deferredServicesScheduled = false;
    },
    onError: (error) => {
      diagnostics?.write('deferred-services-schedule-failed', {
        errorName: error instanceof Error ? error.name : typeof error,
      });
    },
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
  unsubscribeTurnNotifier?.();
  unsubscribeTurnNotifier = null;
  turnNotifier.dispose();
  unsubscribeServiceSettings?.();
  unsubscribeServiceSettings = null;
  awakeService.dispose();
  computerUseOverlay?.dispose();
  computerUseOverlay = null;
  if (!disposalPromise) {
    diagnostics?.write('desktop-stop');
    const browserAndComputerCleanup = (async () => {
      await browserHost?.dispose();
      await browserHostDisposal;
      await computerHost?.dispose();
      await terminalBridge.stop();
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
    writeGpuFallbackMarker(
      app.getPath('userData'),
      {
        engagedAt: Date.now(),
        crashesInWindow: decision.crashes.length,
      },
      {
        ...gpuFallbackEnvironment,
        platform: 'win32',
      }
    );
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
    title: nativeT('Restart Mixdog?'),
    message: nativeT("Mixdog's graphics process has crashed repeatedly."),
    detail: nativeT('Restart with software rendering to keep Mixdog from disrupting video playback in other apps.'),
    buttons: [nativeT('Restart with software rendering'), nativeT('Keep running')],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  };
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  const prompt = parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
  void prompt
    .then(({ response }) => {
      if (response !== 0 || quitAfterDispose) {
        diagnostics?.write('gpu-fallback-restart-deferred');
        return;
      }
      diagnostics?.write('gpu-fallback-restart');
      quitApproved = true;
      app.relaunch();
      app.quit();
    })
    .catch((error: unknown) => {
      diagnostics?.write('gpu-fallback-prompt-failed', {
        errorName: error instanceof Error ? error.name : typeof error,
      });
    })
    .finally(() => {
      gpuFallbackPromptOpen = false;
    });
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

/** Where the renderer is loaded from, what it may navigate to, and the icon the
 *  taskbar button carries. */
function resolveRendererTarget(): {
  developmentUrl: string | undefined;
  packagedRendererPath: string;
  rendererUrl: URL;
  brandIconPath: string | null;
  isAllowedNavigation: (candidate: string) => boolean;
} {
  const developmentUrl = process.env.ELECTRON_RENDERER_URL;
  const packagedRendererPath = join(import.meta.dirname, '../renderer/index.html');
  // Use an explicit runtime icon even in packaged builds. Relying only on the
  // executable's embedded resource leaves the live taskbar button at the mercy
  // of Explorer's stale icon cache after an in-place installer upgrade.
  const brandIconPath =
    [
      ...(app.isPackaged ? [join(process.resourcesPath, 'mixdog.ico')] : []),
      ...['mixdog.ico', 'mixdog.png'].map((name) => join(app.getAppPath(), 'build', name)),
    ].find((candidate) => existsSync(candidate)) ?? null;
  const rendererUrl = developmentUrl
    ? configuredDevelopmentUrl(developmentUrl)
    : new URL(pathToFileURL(packagedRendererPath).href);
  return {
    developmentUrl,
    packagedRendererPath,
    rendererUrl,
    brandIconPath,
    isAllowedNavigation: (candidate: string): boolean => {
      try {
        const target = new URL(candidate);
        return developmentUrl ? target.origin === rendererUrl.origin : target.href === rendererUrl.href;
      } catch {
        return false;
      }
    },
  };
}

/** The product window itself: the shell's own options, the persisted bounds,
 *  the brand icon, the preload bridge, and the boot identity the renderer
 *  measures its startup against. */
function createMainBrowserWindow(
  savedState: Awaited<ReturnType<typeof readWindowState>>,
  brandIconPath: string | null
): BrowserWindow {
  return new BrowserWindow({
    ...DESKTOP_WINDOW_OPTIONS,
    ...initialTitleBarWindowOverrides(),
    ...(savedState?.bounds ?? {}),
    ...(brandIconPath ? { icon: brandIconPath } : {}),
    webPreferences: {
      ...DESKTOP_WINDOW_OPTIONS.webPreferences,
      preload: join(import.meta.dirname, '../preload/index.js'),
      additionalArguments: [
        `--mixdog-boot-id=${desktopBootId}`,
        `--mixdog-process-started-at=${desktopProcessStartedAt}`,
        ...(desktopBootScenario ? [`--mixdog-boot-scenario=${desktopBootScenario}`] : []),
      ],
    },
  });
}

/** Renderer-reported diagnostics, accepted only from this window's main frame:
 *  transcript reads, composer actions and long tasks each have their own
 *  record, and anything else is an error report. */
function rendererDiagnosticListener(window: BrowserWindow): (event: Electron.IpcMainEvent, payload: unknown) => void {
  return (event, payload) => {
    if (
      window.isDestroyed() ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    )
      return;
    const transcriptRead = normalizeTranscriptReadDiagnostic(payload);
    if (transcriptRead) {
      diagnostics?.write('renderer-transcript-read', { ...transcriptRead });
      return;
    }
    const composerAction = normalizeRendererComposerActionDiagnostic(payload);
    const longTask = composerAction ? null : normalizeRendererLongTaskDiagnostic(payload);
    if (composerAction) {
      diagnostics?.write('renderer-composer-action', composerAction);
    } else if (longTask) {
      diagnostics?.write('renderer-long-task', longTask);
    } else {
      diagnostics?.write('renderer-error', normalizeRendererDiagnostic(payload));
    }
  };
}

// Renderer console errors had no sink outside the screenshot window, so a
// caught-and-logged failure left no evidence at all. Keep a bounded,
// de-duplicated tail: enough to explain a boot, never a growth path.
function installRendererConsoleErrorTail(window: BrowserWindow, startupStartedAt: number): void {
  const consoleErrorSeenAt = new Map<string, number>();
  let consoleErrorsWritten = 0;
  window.webContents.on('console-message', (event) => {
    const details = event as unknown as {
      level?: string;
      message?: string;
      lineNumber?: number;
      sourceId?: string;
    };
    if (details.level !== 'error' || consoleErrorsWritten >= 100) return;
    const message = String(details.message || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 500);
    if (!message) return;
    const now = Date.now();
    if (now - (consoleErrorSeenAt.get(message) ?? 0) < 10_000) return;
    if (consoleErrorSeenAt.size > 200) consoleErrorSeenAt.clear();
    consoleErrorSeenAt.set(message, now);
    consoleErrorsWritten += 1;
    diagnostics?.write('renderer-console-error', {
      message,
      source:
        String(details.sourceId || '')
          .split(/[\\/]/)
          .at(-1)
          ?.slice(0, 120) || '',
      line: Number(details.lineNumber) || 0,
      totalMs: now - startupStartedAt,
    });
  });
}

/** What a dead renderer costs: a silent reload while the failures are rare, a
 *  single prompt once they are not, and nothing at all while quitting. */
function installRendererCrashRecovery(window: BrowserWindow, reloadRenderer: () => void): void {
  let rendererFailureTimes: number[] = [];
  let rendererRecoveryPromptOpen = false;
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
    if (recovery.action !== 'prompt' || rendererRecoveryPromptOpen || quitAfterDispose || window.isDestroyed()) return;
    rendererRecoveryPromptOpen = true;
    void dialog
      .showMessageBox(window, {
        type: 'error',
        title: nativeT('Mixdog needs to recover'),
        message: nativeT('The interface stopped repeatedly.'),
        detail: nativeT('Your active task remains in the desktop host. Reload the interface to continue.'),
        buttons: [nativeT('Reload interface'), nativeT('Close window')],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      })
      .then(({ response }) => {
        if (response === 0) reloadRenderer();
        else if (!window.isDestroyed()) window.close();
      })
      .catch(() => reloadRenderer())
      .finally(() => {
        rendererRecoveryPromptOpen = false;
      });
  });
}

/** The renderer stays on the document it was opened with, and opens no others. */
function installNavigationGuards(window: BrowserWindow, isAllowedNavigation: (candidate: string) => boolean): void {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url)) event.preventDefault();
  });
  window.webContents.on('will-redirect', (event, url) => {
    if (!isAllowedNavigation(url)) event.preventDefault();
  });
}

/** When the window appears, and how the page learns that it did.
 *
 * A hidden Chromium surface can throttle requestAnimationFrame and delay
 * ready-to-show for seconds. The renderer's React layout-commit handshake
 * plus did-finish-load is therefore sufficient; ready-to-show remains the
 * preferred compositor signal when it arrives first, and an absolute deadline
 * shows the window either way. */
function createWindowPresentation(window: BrowserWindow, startupStartedAt: number) {
  let readyToShow = false;
  let rendererCommitted = false;
  let rendererLoaded = false;
  let shown = false;
  let showDeadline: NodeJS.Timeout | null = null;
  let visibleFrameAnnounced = false;
  const announceVisibleFrame = () => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return;
    visibleFrameAnnounced = true;
    void window.webContents
      .executeJavaScript(`new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        window.__mixdogWindowShown = true;
        window.dispatchEvent(new Event("mixdog:window-shown"));
        resolve(true);
      }));
    })`)
      .then(() => {
        diagnostics?.write('window-visible-frame', {
          totalMs: Date.now() - startupStartedAt,
        });
      })
      .catch(() => {});
  };
  // A renderer navigation/reload wipes window.__mixdogWindowShown, and the
  // one-shot 'mixdog:window-shown' event never repeats, so every surface gate
  // waited out its 1.2s browser fallback instead (measured: 382ms cold first
  // open vs 1576ms for the same open after a reload). Re-announce once the
  // reloaded document has finished loading, gated on a window that is ALREADY
  // visible and has published its true first frame — cold start still
  // announces exactly once, from showWhenComposed.
  window.webContents.on('did-finish-load', () => {
    if (!visibleFrameAnnounced || window.isDestroyed() || window.webContents.isDestroyed() || !window.isVisible())
      return;
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
    Math.max(0, DESKTOP_WINDOW_SHOW_DEADLINE_MS - (Date.now() - startupStartedAt))
  );
  showDeadline.unref();
  return {
    /** The document finished loading: one of the two signals that compose. */
    markRendererLoaded(): void {
      rendererLoaded = true;
    },
    showWhenComposed,
    cancelShowDeadline(): void {
      if (showDeadline) clearTimeout(showDeadline);
      showDeadline = null;
    },
    detach(): void {
      ipcMain.removeListener(DESKTOP_IPC.rendererReady, onRendererReady);
    },
  };
}

async function createWindow(): Promise<void> {
  const startupStartedAt = desktopProcessStartedAt;
  const { developmentUrl, packagedRendererPath, rendererUrl, brandIconPath, isAllowedNavigation } =
    resolveRendererTarget();

  const statePath = join(app.getPath('userData'), 'window-state.json');
  const savedState = await readWindowState(statePath, screen.getAllDisplays());
  diagnostics?.write('window-state-ready', {
    totalMs: Date.now() - startupStartedAt,
  });
  configureTitleBarThemePersistence(join(app.getPath('userData'), 'desktop-titlebar-theme'));
  const window = createMainBrowserWindow(savedState, brandIconPath);
  installDesktopWindowMaterial(window);
  if (savedState?.maximized) window.maximize();
  windowState = persistWindowState(window, statePath);
  mainWindow = window;
  if (!computerHost) {
    computerHost = createComputerHost({
      bridgeEnabled: false,
      observeOnly: computerObserveOnly,
      onDiagnostic: (event, data) => diagnostics?.write(event, data),
    });
  }
  if (computerHost && !computerUseOverlay) {
    const overlayComputerHost = computerHost;
    computerUseOverlay = createComputerUseOverlay(
      {
        // Control-renderer recovery pauses input without cancelling the task.
        pause: async () => overlayComputerHost.takeOver('user_pause'),
        // The user's Resume, for the pause they saw; an ordinary input pause
        // also resumes by itself after the configured quiet interval.
        resume: (generation) => overlayComputerHost.resumeByUser(generation),
        configureIdleResume: (seconds) => overlayComputerHost.configureIdleResume(seconds),
        // Stop native input immediately, independently of the daemon's turn
        // cancellation reply. Only both confirmations may clear the pause.
        async stop(sessionIds) {
          overlayComputerHost.takeOver('user_stop');
          await overlayComputerHost.stopAllSessions(
            confirmComputerTurnsStopped(sessionIds, async (sessionId) => host.abortSession(sessionId))
          );
        },
      },
      app.getLocale()
    );
  }
  computerHost?.setObserveOnly(computerObserveOnly);
  computerHost?.setBridgeEnabled(computerControlEnabled);
  // Browser pane host: registers this window's browser-pane webviews. The
  // agent bridge (the runtime's `browser` tool) is opt-in and only serves
  // while the Browser Use setting is on, mirroring Computer Use.
  const windowBrowserHost = (browserHost = createBrowserHost(window, {
    onDiagnostic: (event, data) => diagnostics?.write(event, data),
    // Live frames and explicit reveal/hide requests reach paired clients
    // through the service, which owns the relay and per-client pacing.
    publishRemoteFrame: async (frame) => {
      await serviceClient.invokeDesktopOperation('browserRemoteFrame', [frame]);
    },
    onSurfaceRequest: (request) => {
      void serviceClient.invokeDesktopOperation('browserRemoteOpen', [request]).catch(() => {});
    },
  }));
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
      ? {
          bounceDock: () => {
            app.dock?.bounce('informational');
          },
        }
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
      const totalMs = Date.now() - startedAt;
      setTimeout(() => {
        diagnostics?.write('renderer-idle-reclaim', {
          beforeKb,
          afterKb: rendererWorkingSetKb(),
          totalMs,
          settleMs: RENDERER_RECLAIM_SETTLE_MS,
        });
      }, RENDERER_RECLAIM_SETTLE_MS).unref();
    },
  });
  window.on('focus', () => {
    turnAttention?.onFocus();
    idleReclaim?.onFocus();
  });
  window.on('blur', () => idleReclaim?.onBlur());
  window.on('close', (event) => backgroundWindow.onClose(event, () => window.hide()));
  // Windows logoff/shutdown: the OS ends the session, nobody is asked.
  window.on('session-end', () => {
    quitApproved = true;
  });
  // Pin only the application shell; Browser Use guests keep their own zoom.
  window.webContents.setZoomFactor(1);
  void window.webContents.setVisualZoomLevelLimits(1, 1);
  window.webContents.on('dom-ready', () => {
    window.webContents.setZoomFactor(1);
  });
  removeIpc = registerDesktopIpc(window, host, {
    app,
    translateUi: nativeT,
    ipcMain,
    dialog,
    shell,
    powerMonitor,
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

  const reloadRenderer = () => {
    if (quitAfterDispose || window.isDestroyed() || window.webContents.isDestroyed()) return;
    window.webContents.reload();
  };
  const onRendererDiagnostic = rendererDiagnosticListener(window);
  ipcMain.on(DESKTOP_IPC.rendererDiagnostic, onRendererDiagnostic);
  diagnostics?.write('ipc-ready', {
    totalMs: Date.now() - startupStartedAt,
  });

  installRendererConsoleErrorTail(window, startupStartedAt);

  window.webContents.on('did-start-loading', () => {
    diagnostics?.write('renderer-load-start', {
      totalMs: Date.now() - startupStartedAt,
    });
  });
  window.webContents.on('dom-ready', () => {
    void refreshNativeUiLanguage(window).then(() => {
      if (!window.isDestroyed()) installDesktopMenu();
      desktopTray?.relabel();
    });
    diagnostics?.write('renderer-dom-ready', {
      totalMs: Date.now() - startupStartedAt,
    });
  });
  window.webContents.on('did-finish-load', () => {
    presentation.markRendererLoaded();
    diagnostics?.write('renderer-load-finished', {
      totalMs: Date.now() - startupStartedAt,
    });
    presentation.showWhenComposed();
  });

  window.on('unresponsive', () => {
    diagnostics?.write('renderer-unresponsive', { processes: currentProcessMemory() });
  });
  window.on('responsive', () => {
    diagnostics?.write('renderer-responsive');
  });
  installRendererCrashRecovery(window, reloadRenderer);

  installNavigationGuards(window, isAllowedNavigation);
  const presentation = createWindowPresentation(window, startupStartedAt);
  window.on('closed', () => {
    presentation.cancelShowDeadline();
    diagnostics?.write('window-closed');
    presentation.detach();
    ipcMain.removeListener(DESKTOP_IPC.rendererDiagnostic, onRendererDiagnostic);
    const state = windowState;
    windowState = null;
    windowStateFlush = state?.flush().finally(() => state.dispose()) ?? Promise.resolve();
    removeIpc?.();
    removeIpc = null;
    computerUseOverlay?.dispose();
    computerUseOverlay = null;
    // This window's host dies with it (macOS 'activate' builds a new one);
    // dispose is idempotent, so a later quit-time dispose is a no-op.
    if (browserHost === windowBrowserHost) browserHost = null;
    browserHostDisposal = Promise.all([browserHostDisposal, windowBrowserHost.dispose()]).then(() => undefined);
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
      'Mixdog desktop: another instance already owns the shared user profile. ' +
        'Close the running app, or set MIXDOG_DESKTOP_USER_DATA to run an isolated profile.'
    );
  }
  quitApproved = true;
  app.quit();
} else {
  app.on('second-instance', () => {
    activatePrimaryWindow();
  });

  // Fork the daemon NOW, while Chromium is still bringing the app up and the
  // main thread is otherwise idle. Started from whenReady, the client import
  // and the fork queued behind window creation and the renderer load (215ms
  // for a 25ms import), and the data lane finished a full second after the
  // window had shown (user: 부팅 속도). Nothing here needs Electron ready:
  // the transport is plain Node and the daemon is a separate process. The
  // transport holds the daemon spawn until the login-shell read settles.
  loginShellEnvironmentReady = adoptLoginShellEnvironment();
  startDaemonService();

  void app
    .whenReady()
    .then(async () => {
      const appReadyAt = Date.now();
      // Separate shell registrations keep dev/test Electron shortcuts from
      // replacing the installed Mixdog name and icon.
      if (process.platform === 'win32') {
        app.setAppUserModelId(desktopBrand.appId);
      }
      diagnostics = createDesktopDiagnostics(join(app.getPath('userData'), 'logs', 'desktop-diagnostics.jsonl'), {
        appVersion: app.getVersion(),
        packaged: app.isPackaged,
        bootId: desktopBootId,
        ...(desktopBootScenario ? { scenario: desktopBootScenario } : {}),
      });
      setTranscriptReadDiagnosticSink((entry) => {
        diagnostics?.write('transcript-read', { ...entry });
      });
      diagnostics.write('process-entry', {
        occurredAt: new Date(desktopProcessStartedAt).toISOString(),
        totalMs: 0,
      });
      diagnostics.write('app-ready', {
        totalMs: appReadyAt - desktopProcessStartedAt,
      });
      // The daemon handshake is already running (started before whenReady);
      // stamp its start into the timeline now that the sink exists.
      reportDaemonServiceStart();
      void settingsStore.separateDefaults(mixdogDataDirectory()).catch((error: unknown) => {
        diagnostics?.write('defaults-separation-failed', { message: error instanceof Error ? error.message : String(error) });
      });
      for (const { event, entry, at } of earlyDiagnostics.splice(0)) {
        diagnostics.write(event, { ...entry, occurredAt: at });
      }
      diagnostics.write('desktop-start', {
        totalMs: Date.now() - desktopProcessStartedAt,
        electronVersion: process.versions.electron,
        chromeVersion: process.versions.chrome,
        nodeVersion: process.versions.node,
        sessionProcess: 'daemon',
        gpuRendering: softwareRenderingThisLaunch ? 'software-fallback' : 'hardware',
        crashReporterStatus,
        ...(crashReporterErrorName ? { crashReporterErrorName } : {}),
        ...(gpuFallbackMarker ? { gpuFallbackCrashes: gpuFallbackMarker.crashesInWindow } : {}),
      });
      startCrashHandlerWatch();
      startDiagnosticsEventLoopMonitor();
      // Keep-awake + taskbar attention feed on the same session state lane.
      unsubscribeAwake = host.subscribe((snapshot) => {
        awakeService.onSnapshot(snapshot);
        turnAttention?.onSnapshot(snapshot);
        idleReclaim?.onSnapshot(snapshot);
      });
      // Every session's roster and the agent pool, not just the active pane:
      // the final-answer rule needs background work as well as turn state.
      const unsubscribeTurnSessions = host.subscribeSessions(turnNotifier.onSessions);
      const unsubscribeTurnAgents = host.subscribeAgentPool(turnNotifier.onAgentPool);
      unsubscribeTurnNotifier = () => {
        unsubscribeTurnSessions();
        unsubscribeTurnAgents();
      };
      void settingsStore
        .read()
        .then(applyDesktopSettings)
        .catch(() => {
          /* default stays enabled */
        });
      // macOS/Linux shutdown or logoff: the OS ends the session, nobody is asked.
      powerMonitor.on('shutdown', () => {
        quitApproved = true;
      });
      powerMonitor.on('resume', () => {
        // The blocker may have been dropped across sleep; re-assert it, and
        // redial the relay leg instead of waiting for the ping cycle.
        awakeService.reevaluate();
        void host.invokeDesktopOperation('remoteAccessResume', []).catch(() => {});
      });
      diagnosticsMemoryTimer = setInterval(
        () => {
          diagnostics?.write('process-memory', {
            processes: currentProcessMemory(),
            systemMemory: currentSystemMemory(),
          });
        },
        5 * 60 * 1000
      );
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
      const bootScriptHash = process.env.ELECTRON_RENDERER_URL
        ? null
        : inlineBootScriptHash(join(import.meta.dirname, '../renderer'));
      session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        // The policy governs the app's own documents: the built renderer
        // (file:) or the dev server. Other responses keep their headers —
        // stamped onto a previewed PDF and onto Chromium's built-in viewer
        // page, `frame-ancestors 'none'` left the editor's PDF preview blank.
        const rendererOrigin = process.env.ELECTRON_RENDERER_URL;
        if (!details.url.startsWith('file:') && !(rendererOrigin && details.url.startsWith(rendererOrigin))) {
          callback({});
          return;
        }
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
            'Content-Security-Policy': [development ? policy : withInlineBootScript(policy, bootScriptHash)],
          },
        });
      });
      // Gallery bytes leave the RPC lane here: tiles and clips become ordinary
      // cacheable, range-able resources fetched straight by the DOM.
      registerMediaProtocol(host);
      // Push-to-talk/pairing use getUserMedia; transcript copy uses clipboard
      // writes. Only the trusted desktop renderer receives these permissions.
      // Clipboard reads and every other permission still fail closed.
      const trustedPermissionSender = () => {
        const window = mainWindow;
        return window && !window.isDestroyed() ? window.webContents : null;
      };
      session.defaultSession.setPermissionCheckHandler((webContents, permission) =>
        desktopPermissionAllowed(permission, webContents, trustedPermissionSender())
      );
      session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
        const allowed = desktopPermissionAllowed(permission, webContents, trustedPermissionSender());
        if (!allowed) {
          diagnostics?.write('permission-request', { permission });
        }
        callback(allowed);
      });
      await createWindow();
      if (pendingPrimaryActivation) activatePrimaryWindow();
      installDesktopMenu();
      // The settings read may have landed before the app was ready to host a tray.
      syncDesktopTray();
      app.on('activate', () => {
        // A Dock click brings back a window hidden by close-to-background.
        if (mainWindow && !mainWindow.isDestroyed()) {
          activatePrimaryWindow();
          return;
        }
        if (BrowserWindow.getAllWindows().length === 0) {
          void createWindow().catch((error: unknown) => {
            console.error('Failed to recreate the Mixdog desktop window:', error);
          });
        }
      });
    })
    .catch((error: unknown) => {
      diagnostics?.write('desktop-initialize-failed', {
        errorName: error instanceof Error ? error.name : typeof error,
        errorCode:
          typeof error === 'object' && error !== null && 'code' in error
            ? String((error as NodeJS.ErrnoException).code || '')
            : '',
      });
      console.error('Failed to initialize the Mixdog desktop window:', error);
      quitApproved = true;
      app.quit();
    });
}

app.on('before-quit', (event) => {
  // Every quit entry (menu, tray, Cmd+Q, last window) quits without asking;
  // the flag lets a window hidden to the tray close for real.
  quitApproved = true;
  // The handler outlives a quitting main process; its normal exit is not a loss.
  stopCrashHandlerWatch?.();
  stopCrashHandlerWatch = null;
  desktopTray?.dispose();
  desktopTray = null;
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

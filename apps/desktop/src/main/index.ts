import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import * as nodeModule from 'node:module';
import { constants as osConstants, freemem, homedir, hostname, setPriority, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { createNetworkWatcher, networkSignature } from './network-watch';
import { inlineBootScriptHash, withInlineBootScript } from './renderer-csp';
import { pathToFileURL } from 'node:url';

import {
  app,
  BrowserWindow,
  clipboard,
  crashReporter,
  dialog,
  ipcMain,
  net,
  Notification,
  powerMonitor,
  powerSaveBlocker,
  screen,
  session,
  shell,
} from 'electron';

import { isSessionId } from './desktop-state';
import { TAKEOVER_EXPIRED_REASON, takeoverGate } from './takeover-gate';
import {
  allowsTaskbarFlash,
  decideNotification,
  type NotificationConversation,
  notificationConversationOf,
} from './notification-decision';
import { notificationPreferencesPath, readPcNotificationView } from './notification-preferences';
import { captureTakeoverOrDecline } from './takeover-capture';
import type { NotificationTestResult } from './notification-center';
import { secretInputs } from './secret-input';
import { remoteSessionConfigFromEnv } from './ssh/remote-session';
import { allowedProvidersForHost, loadSshHostStore } from './ssh/ssh-host-store';
import { currentSshContext, runWithSshContext } from './ssh/ssh-context';
import { parseSshTarget } from './ssh/ssh-command';
import { SshTunnel } from './ssh/tunnel';
import { openCallbackForward } from './ssh/callback-forward';
import {
  ConnectionPool,
  LOCAL_CONNECTION_ID,
  WindowRouteRegistry,
  createConnectionIpcRouter,
  createConnectionManager,
  createConnectionWindowOpener,
  createDesktopConnection,
  createPortForwardStore,
  createServerNotifier,
  createServerPortForwards,
  createServerWindowRestore,
  hostGraceMs,
  forwardConnectionLink,
  registerConnectionLinkIpc,
  registerServerPortsIpc,
  resolveWindowConnection,
  type ServerNotifier,
  type ConnectionIdentity,
  type DesktopConnection,
  type DesktopConnectionDependencies,
} from './connections';
import { readDesktopModelBootstrapSnapshot } from './model-bootstrap';
import { AgentAwakeService } from './agent-awake';
import { createBackgroundWindow } from './background-window';
import { createDesktopTray, type DesktopTray } from './desktop-tray';
import { createDesktopQuitSequence, DESKTOP_DAEMON_STOP_TIMEOUT_MS } from './quit-sequence';
import { loginShellOverrides, readLoginShellEnvironment, withHomebrewPath } from './login-shell-environment';
import { createTurnAttention, type TurnAttention } from './turn-attention';
import { createDesktopTurnNotifier } from './desktop-turn-notifier';
import { isSessionOnScreen } from './screen-sessions';
import { desktopIdentity } from './desktop-identity';
import { notificationSoundPath, playWindowsNotificationSound, scaledNotificationSound } from './notification-sound';
import {
  activateDesktopWindow,
  createPrimaryWindowActivation,
  openDesktopNotificationSession,
  retainNotification,
} from './notification-window';
import { createDesktopPet, type DesktopPet, type PetWindow } from './desktop-pet-window';
import { setBrowserApprovalHooks } from './browser/approval-dialog';
import { approvalSurfaceSessionId, createApprovalRequesterResolver } from './browser/approval-requester';
import { createBrowserApprovalGrants } from './browser/approval-grants';
import { boundedNotification } from './connections/server-notifier';
import type { RemoteHostWindows } from './remote-host-windows';
import { createIdleReclaim, purgeRendererMemory, type IdleReclaim } from './idle-reclaim';
import { watchCrashHandler } from './crash-handler-watch';
import { setPageFaultDiagnosticSink } from './browser/page-fault-diagnostics';
import { createDesktopDiagnostics, type DesktopDiagnostics } from './desktop-diagnostics';
import { scheduleDeferredDesktopServices as scheduleAfterServiceQuiet } from './deferred-desktop-services';
import { installViewportGuard } from './viewport-guard';
import { computerUseOperates, createUserInputReporter, type UserInputReporter } from './user-input-report';
import { agentInputInFlight } from './browser/agent-input';
import { computerUseCoordinator } from './computer/session/coordinator';
import { electronWindowForNativeId } from './computer/observation/window-handles';
import {
  gpuFallbackDecision,
  readActiveGpuFallbackMarker,
  writeGpuFallbackMarker,
  type GpuFallbackEnvironment,
} from './gpu-recovery';
import { registerDesktopIpc } from './ipc';
import { registerSshHostIpc } from './ipc-ssh-hosts';
import { createBrowserHost, type BrowserHost } from './browser/host';
import { BROWSER_PARTITION } from './browser/command';
import { browserUrlPolicyFromEnvironment } from './browser/host-policy';
import { createBrowserLoginPopup } from './browser/login-popup';
import { loginTakeoverOf } from './browser/login-takeover';
import { createComputerHost, type ComputerHost } from './computer';
import { bridgeDiscoveryDirectory } from './bridge/discovery-file';
import { TERMINAL_SHOWN_WAIT_MS } from '../shared/terminal-command';
import { createTerminalRunDispatch } from './terminal/run-dispatch';
import { TerminalBridgeServer } from './terminal/bridge-server';
import { requiredVisualizeTabCommand } from './ipc-validation';
import { VisualizeBridgeServer } from './visualize/bridge-server';
import { createDesktopVisualize } from './visualize/host';
import { localPageOrigin, localPageUrl } from './local-page-server';
import { createTerminalCommandExecutor, type TerminalBridgeCommand } from './terminal/commands';
import { createTerminalRunRequests } from './terminal/run-requests';
import { createTerminalBridgeBackend } from './terminal/bridge-backend';
import { readComputerPermissions, requestComputerPermissions } from './computer/host/permission-reads';
import { applyGnomeExtensionSetting } from './computer/host/gnome-extension';
import { createComputerUseOverlay, type ComputerUseOverlay } from './computer/overlay';
import { confirmComputerTurnsStopped } from './computer/overlay/stop-turns';
import { MEDIA_SCHEME, registerMediaProtocol, registerMediaScheme } from './media-protocol';
import { desktopPermissionAllowed } from './permission-policy';
import { installNativeMenu } from './menu';
import { installDefaultContextMenu } from './context-menu';
import { nativeT, refreshNativeUiLanguage } from './native-i18n';
import { readHostWindowDisplayPreferences } from './host-display-preferences';
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
  NOTIFICATION_VOLUME_DEFAULT,
  type DesktopAgentPoolRow,
  type DesktopRemoteAccessInfo,
  type DesktopSessionSummary,
  type DesktopSettings,
} from '../shared/contract';
import { BROWSER_REMOTE_METHODS, runBrowserRemoteRequest, type BrowserRemoteMethod } from './remote-browser-methods';
import { modelProxyRuntimeLoader } from './model-proxy-host';
import { fileSnapshots } from './file-snapshot';
import { clampBoundsToWorkArea, persistWindowState, readWindowState } from './window-state';
import {
  normalizeTranscriptReadDiagnostic,
  setTranscriptReadDiagnosticSink,
} from '../shared/transcript-read-diagnostics';
import {
  normalizeRendererComposerActionDiagnostic,
  normalizeRendererDiagnostic,
  normalizeRendererLongTaskDiagnostic,
  normalizeRendererWhatsNewDiagnostic,
  rendererRecoveryDecision,
} from './renderer-recovery';
import { acknowledgeAnnouncement, LAUNCH_VERSION_FILE, recordLaunchVersion } from './launch-version';
import { installWhatsNewAcknowledge } from './whats-new-acknowledge';
import { createPaneLayoutFile, flushPaneLayoutFiles, PANE_LAYOUT_FILE } from './pane-layout-file';

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
let launchFollowsUpdate: Promise<boolean> | null = null;
const launchVersionPath = () => join(app.getPath('userData'), LAUNCH_VERSION_FILE);
const launchRecordWriteFailure = (error: unknown) =>
  diagnostics?.write('launch-version-write-failed', {
    errorName: error instanceof Error ? error.name : 'Error',
    message: String((error as Error)?.message ?? error).slice(0, 300),
  });
const paneLayoutFileFailure = (stage: 'read' | 'write', error: unknown) =>
  diagnostics?.write('pane-layout-file-failed', {
    stage,
    errorName: error instanceof Error ? error.name : 'Error',
    message: String((error as Error)?.message ?? error).slice(0, 300),
  });

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

function desktopServiceModulePath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'app.asar.unpacked', 'out', 'main', 'daemon.cjs')
    : join(import.meta.dirname, 'daemon.cjs');
}

function desktopServiceModuleUrl(): string {
  const modulePath = desktopServiceModulePath();
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
    let homebrewPathAdded: string[] = [];
    if (process.platform === 'darwin') {
      const homebrew = withHomebrewPath(process.env.PATH);
      if (homebrew.added.length) process.env.PATH = homebrew.path;
      homebrewPathAdded = homebrew.added;
    }
    writeBootDiagnostic('login-shell-environment', {
      durationMs: Date.now() - startedAt,
      adopted: Boolean(environment),
      changedCount: Object.keys(overrides).length,
      homebrewPathAdded,
      failures,
    });
  });
}
// Several daemon connections live side by side: this PC's (`local`, the main
// window's, always open) and one per ssh server window. Each connection owns
// its service client, transport, RemoteSession and model proxy; desktop.init
// paths are remapped to the server once its home is known (RemoteSession →
// remoteSessionOptions), while sessionOptions() stays local because this
// process still imports the local session client.
// Port forwards of each saved server, started again when it reconnects.
const portForwardStore = createPortForwardStore(desktopUserData);
/** Ssh work started outside a connect attempt (a port forward) runs under the
 *  server's saved settings (identity file), in batch mode: it never prompts. */
async function runWithHostSettings<T>(hostId: string, run: () => Promise<T>): Promise<T> {
  const host = (await loadSshHostStore(desktopUserData)).list().find((entry) => entry.id === hostId);
  return runWithSshContext(host?.settings ? { settings: host.settings } : {}, run);
}
const connectionDependencies: DesktopConnectionDependencies = {
  moduleUrl: desktopServiceModuleUrl,
  environmentReady: () => loginShellEnvironmentReady,
  sessionOptions: () => ({
    userDataPath: app.getPath('userData'),
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    appVersion: app.getVersion(),
    rendererDir: app.isPackaged
      ? join(process.resourcesPath, 'app.asar.unpacked', 'out', 'renderer')
      : join(import.meta.dirname, '../renderer'),
  }),
  // Model calls of every connected daemon run here, with this PC's credentials.
  loadModelProxyRuntime: modelProxyRuntimeLoader({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  }),
  appVersion: app.getVersion(),
  bundlePath: desktopServiceModulePath(),
  remoteGraceMs: process.env.MIXDOG_REMOTE_CLIENT_GRACE_MS?.trim() || '',
  // A server's turns use only the providers its host entry allows (no list:
  // every provider).
  createPortForwards: (connection, target, scan) => {
    const sshTarget = parseSshTarget(target);
    return createServerPortForwards({
      hostId: connection.id,
      store: portForwardStore,
      scan,
      runSsh: (run) => runWithHostSettings(connection.id, run),
      createTunnel: ({ freePort, onChange }) =>
        new SshTunnel(sshTarget, {
          freePort,
          log: (line) => {
            diagnostics?.write('port-forward', { connection: 'ssh', detail: line.slice(0, 300) });
            onChange();
          },
        }),
    });
  },
  isProviderAllowed: (connection, provider) => {
    const allowed = allowedProvidersForHost(connection.id);
    return allowed === null || allowed.includes(provider);
  },
  onDiagnostic: (connection, event, data) => {
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
    if (connection.kind === 'local') {
      // The daemon handshake starts before app.whenReady opens the sink: its
      // first phases (client import, discovery probe, spawn) are exactly the
      // ones a boot investigation needs, so they wait here and flush in order.
      writeBootDiagnostic(event, entry);
      console.error(`[mixdog] ${event}`, data);
      return;
    }
    diagnostics?.write(event, { ...entry, connection: 'ssh' });
    console.error(`[mixdog:${connection.name}] ${event}`, data);
  },
  onServiceReady: (connection, { generation }) => {
    // The FIRST attachment belongs to the deferred scheduler, so no early
    // interaction pays for relay startup. Every later one follows a daemon
    // replacement that dropped the relay leg with the old process, and
    // nothing else would ever dial it again: the deferred schedule runs once
    // per window, and this window is already open. The relay is this PC's.
    if (connection.kind !== 'local' || generation <= 1) return;
    diagnostics?.write('relay-redial-after-daemon-restart', { generation });
    void startDeferredDesktopServices();
  },
};
const connectionPool = new ConnectionPool<DesktopConnection>();
// webContents.id → connection id; every IPC call resolves its connection here.
const windowRoutes = new WindowRouteRegistry();
const ipcRouter = createConnectionIpcRouter({
  ipcMain,
  resolveSender: (sender) => resolveWindowConnection(windowRoutes, connectionPool, sender.id),
});
const localConnection = createDesktopConnection(
  { id: LOCAL_CONNECTION_ID, kind: 'local', name: hostname() },
  { ...connectionDependencies, initialSnapshot: readDesktopModelBootstrapSnapshot }
);
connectionPool.add(localConnection);
/** This PC's daemon, for the features that exist once per machine (updater
 *  relay, tray, OS notifications, phone access, Computer Use, Browser Use,
 *  keep-awake). Window IPC never uses it directly: it resolves the sender's
 *  connection through the route registry. */
const localService = localConnection.client;
// MIXDOG_SSH_TARGET (development and tests): the main window stays on this PC
// and a server window for that target opens beside it at startup.
const ENV_SSH_CONNECTION_ID = 'ssh-env-target';
const envSshConfig = remoteSessionConfigFromEnv(process.env, {
  appVersion: app.getVersion(),
  bundlePath: desktopServiceModulePath(),
});
const connectionWindows = new Map<string, BrowserWindow>();
const withGrace = (graceMs: number | null): { graceMs?: number } => (graceMs === null ? {} : { graceMs });
const sshConnections = createConnectionManager<DesktopConnection>({
  pool: connectionPool,
  createConnection: (spec, onProgress, options) => {
    // The connect attempt's per-host settings (default folder, reconnect).
    const context = currentSshContext();
    const settings = context?.settings;
    return createDesktopConnection(
      {
        id: spec.id,
        kind: 'ssh',
        name: spec.name,
        target: spec.target,
        remoteCwd:
          spec.id === ENV_SSH_CONNECTION_ID ? (envSshConfig?.remoteCwd ?? null) : settings?.remoteCwd?.trim() || null,
        ...(settings?.autoReconnect === false ? { autoReconnect: false } : {}),
        // The host's opt-in: its daemon runs models with the server's own logins.
        ...(spec.id !== ENV_SSH_CONNECTION_ID && settings?.modelLogin === 'server'
          ? { modelLogin: 'server' as const }
          : {}),
        // The host's grace (minutes) caps the reconnect backoff and tells the
        // server how long to keep its daemon for this PC.
        ...withGrace(hostGraceMs((settings as { graceMinutes?: unknown } | undefined)?.graceMinutes)),
      },
      connectionDependencies,
      {
        ...(onProgress ? { onProgress } : {}),
        ...(options?.forceRestart || context?.forceRestart ? { forceRestart: true } : {}),
      }
    );
  },
  showWindow: (connection) => showConnectionWindow(connection),
  closeWindows: (connectionId) => {
    const window = connectionWindows.get(connectionId);
    if (window && !window.isDestroyed()) window.close();
  },
});
// The server windows open at quit come back at the next launch (a setting in
// this PC's window), connecting in the background with their progress shown
// there.
const serverWindowRestore = createServerWindowRestore({
  userDataPath: desktopUserData,
  savedServers: async () => (await loadSshHostStore(desktopUserData)).list(),
  // Automatic, so ssh runs in batch mode: a server that now needs a password
  // fails here and is reconnected from Settings → Connection.
  open: (spec, onProgress, server) =>
    runWithSshContext({ ...(server.settings ? { settings: server.settings } : {}) }, () =>
      sshConnections.open(spec, onProgress)
    ),
  onProgress: (progress) => {
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send(DESKTOP_IPC.serverRestoreProgress, progress);
  },
});
/** Each server window's OS notifications (final answers, approvals, link). */
const serverNotifiers = new Map<BrowserWindow, ServerNotifier>();
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
  visualizeBridge.start();
  void localConnection
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
/** The always-on-top desktop pet (Settings → General → Desktop pet). */
let desktopPet: DesktopPet | null = null;
let browserHostDisposal: Promise<void> = Promise.resolve();
// Last-known Browser Use opt-in: the host is created with the window, which
// may happen before or after the initial settings read, so both sides apply.
let browserControlEnabled = false;
// Saved-login sign-in (default on), read by the host per command.
let browserAutoSignIn = true;
let computerHost: ComputerHost | null = null;
let computerUseOverlay: ComputerUseOverlay | null = null;
let computerControlEnabled = false;
// The first application is the stored state at launch, not a user's toggle.
let computerControlApplied = false;
// Observation-only opt-in travels with the host the same way, so a toggle made
// before the window exists still reaches the bridge when it starts.
let computerObserveOnly = false;
// Each window's IPC registration, removed when it closes or the app quits.
const windowIpcDisposers = new Map<BrowserWindow, () => void>();
// Each window's in-app input reporter (Mixy's heartbeat idle rule), stopped
// when the window closes or the app quits.
const userInputReporters = new Set<UserInputReporter>();
let primaryWindowStarted = false;
const primaryActivation = createPrimaryWindowActivation(
  () => mainWindow,
  // A click on a notification after the window was closed for real (not hidden
  // to the tray) builds it again and then opens what the click named.
  () => {
    // Until the first window is up, the startup path builds it and flushes the click.
    if (!primaryWindowStarted || quitApproved || quitAfterDispose) return;
    void showConnectionWindow(localConnection)
      .then(() => primaryActivation.flush())
      .catch((error: unknown) => console.error('Failed to recreate the Mixdog desktop window:', error));
  }
);
function activatePrimaryWindow(): void {
  primaryActivation.activate();
}
// Native notifications stay referenced until clicked, closed or failed: the
// OS toast holds none, and a collected one never delivers its click.
const liveNotifications = new Set<unknown>();
// Agent `terminal` tool: a loopback bridge over the daemon-owned PTYs that
// lists, reads and runs commands in a session's side terminal. A hidden
// always-on built-in (like Media Studio): it runs for the app's lifetime, so
// headless runs without the desktop app never see the tool. It serves this
// PC's agents, so it uses this PC's daemon.
// A run's reveal goes to the desktop window (true when it took the request) and,
// stripped of the ack id and paths, to paired clients through the relay.
const requestTerminalRun = createTerminalRunDispatch({
  sendToWindow: (request) => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return false;
    mainWindow.webContents.send(DESKTOP_IPC.terminalRunRequested, request);
    return true;
  },
  relay: (request) => {
    // Best effort: a paired client missing the reveal costs nothing the run
    // needs, but the failure is reported rather than lost.
    void localService.invokeDesktopOperation('terminalRemoteOpen', [request]).catch((error: unknown) => {
      diagnostics?.write('terminal-remote-open-failed', {
        sessionId: request.sessionId,
        message: error instanceof Error ? error.message : String(error),
      });
    });
  },
});
const terminalRuns = createTerminalRunRequests(requestTerminalRun);
// A run waits for a pane to claim its reveal (the renderer watches
// TERMINAL_SHOWN_WAIT_MS) plus the claim's trip back, then reports background.
const TERMINAL_CLAIM_GRACE_MS = 500;
const terminalBridge = new TerminalBridgeServer<TerminalBridgeCommand>({
  dataDirectory: bridgeDiscoveryDirectory,
  execute: createTerminalCommandExecutor(
    createTerminalBridgeBackend({
      invoke: (name, args) => localService.invokeDesktopOperation(name, args),
      sessionCwd: async (sessionId) =>
        (await localService.listSessions()).find((session) => session.id === sessionId)?.cwd || null,
      reveal: (request) => terminalRuns.reveal(request, TERMINAL_SHOWN_WAIT_MS + TERMINAL_CLAIM_GRACE_MS),
    })
  ),
});
// Agent `visualize` tool: shows produced artifacts in the session's side
// panel. Default-on built-in; the runtime gates the tool by its toggle, and
// the bridge runs for the app's lifetime like the terminal bridge.
let browserFeatureInstalled = false;
const visualize = createDesktopVisualize({
  window: () => mainWindow,
  invokeDesktopOperation: (method, args) => localService.invokeDesktopOperation(method, args),
  browserAvailable: () => browserFeatureInstalled,
  watchBrowserTab: (sessionId, requestId) => browserHost?.watchNewTab(sessionId, requestId),
  // Paired remote clients: the daemon mirrors the tabs and serves pane bytes.
  publishRemote: (event) => {
    void localService.invokeDesktopOperation('visualizeRemotePublish', [event]).catch(() => {});
  },
  remoteViewing: async (sessionId) =>
    (await localService.invokeDesktopOperation('visualizeRemoteViewing', [sessionId])) === true,
  // Kept versions of visualize tabs: app data, never the project.
  versionsDirectory: join(app.getPath('userData'), 'visualize-versions'),
  // A chat card reopening a closed tab: the session's own working directory.
  sessionCwd: async (sessionId) =>
    (await localService.listSessions()).find((session) => session.id === sessionId)?.cwd || null,
  // A sub-agent's or room member's opens show in the conversation it works
  // for, by the same rules as its approvals.
  ownerSessionId: (sessionId) => approvalSurfaceSessionId(sessionId, approvalSources),
});
const visualizeBridge = new VisualizeBridgeServer<object>({
  dataDirectory: bridgeDiscoveryDirectory,
  execute: (command) => visualize.execute(command),
});
// The renderer frames visualize HTML from the local page server; its CSP
// names that one origin, so the server starts with the app.
let localPageFrameOrigin = '';
void localPageOrigin()
  .then((origin) => {
    localPageFrameOrigin = origin;
  })
  .catch((error: unknown) => console.error('local page server failed to start:', error));
// Keep-awake spans the app lifetime, not one window: agents keep working
// while the window is closed on macOS and through renderer reloads.
const awakeService = new AgentAwakeService(powerSaveBlocker);
let turnAttention: TurnAttention | null = null;
let unsubscribeAwake: (() => void) | null = null;
let unsubscribeServiceSettings: (() => void) | null = null;
let unsubscribeTakeovers: (() => void) | null = null;
let unsubscribeUpdaterRelay: (() => void) | null = null;
// OS notification on final answers and failed turns: whether one shows is this
// PC's notification preferences (notification-decision.ts), read fresh from
// the file the desktop service writes. App-lifetime like keep-awake: a window
// hidden to the tray still wants it.
const pcNotificationView = () => readPcNotificationView(notificationPreferencesPath(app.getPath('userData')));
let notificationVolume = NOTIFICATION_VOLUME_DEFAULT;
const playNotificationSound = async (): Promise<string> => {
  if (notificationVolume === 0) return 'suppressed:volume-muted';
  return playWindowsNotificationSound(
    scaledNotificationSound(
      notificationSoundPath({
        packaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        appPath: app.getAppPath(),
      }),
      notificationVolume,
      join(app.getPath('userData'), 'notification-sounds')
    ),
    false,
    desktopBrand.appId
  );
};
/** An attachment-only session title (`[Image]` …) in this PC's UI language. */
const nativeSessionTitleLabels = () => ({ image: nativeT('Image'), video: nativeT('Video'), file: nativeT('File') });
const turnNotifier = createDesktopTurnNotifier({
  preferences: pcNotificationView,
  isSupported: () => Notification.isSupported(),
  // The representative bot overlay showing that session's reply counts too.
  isSessionOnScreen: (sessionId) =>
    isSessionOnScreen(mainWindow, sessionId) || desktopPet?.showsSession(sessionId) === true,
  createNotification: (content) =>
    new Notification({
      ...content,
      // Windows already brands the header through the registered shortcut.
      // An explicit icon adds a second, large image beside the body.
      ...(process.platform === 'win32' ? {} : { icon: trayIconPath() ?? undefined }),
      silent: process.platform === 'win32',
    }),
  ...(process.platform === 'win32' ? { playSound: playNotificationSound } : {}),
  readFinalAnswer: (sessionId, startedAt, signal) => localService.readSessionFinalAnswer(sessionId, startedAt, signal),
  diagnostic: (event, details) => {
    diagnostics?.write(`turn-notification-${event}`, details);
    if (event === 'failed' || event === 'read-failed') console.error(`[mixdog-turn-notification] ${event}`, details);
  },
  openSession: (sessionId) => {
    primaryActivation.activate(sessionId);
  },
  turnFailedText: () => nativeT('The turn stopped with an error.'),
  // "{name} · 승인을 기다리고 있습니다." / "{name} · 답변을 기다리고 있습니다."
  waitingText: (wait) =>
    wait === 'question' ? nativeT('Waiting for your answer.') : nativeT('Waiting for your approval.'),
  titleLabels: nativeSessionTitleLabels,
  agentName: (agentId) => browserApprovalGrants.agentName(agentId),
});
// A Browser Use approval raised while Mixdog is in the background: the card is
// in the app; this notification (same toggle and look as turn notifications)
// only points to it and opens the asking bot's chat when clicked.
let latestSessions: readonly DesktopSessionSummary[] = [];
// A sub-agent asks as its root bot and its notification opens the top-level chat.
let latestAgentPool: readonly DesktopAgentPoolRow[] = [];
const approvalSources = { sessions: () => latestSessions, agentPool: () => latestAgentPool };
/** A session's conversation for the notification decision, from the roster. */
const notificationConversation = (sessionId: string): NotificationConversation =>
  notificationConversationOf(latestSessions.find((session) => session.id === sessionId) ?? { id: sessionId });
/** One notification on this PC now, past every preference (Settings › Notifications). */
const showTestNotification = (): NotificationTestResult => {
  if (!Notification.isSupported()) {
    return { ok: false, message: nativeT('This computer does not support notifications.') };
  }
  const notification = new Notification({
    ...boundedNotification({ title: 'Mixdog', body: nativeT('Notifications from Mixdog appear like this.') }),
    ...(process.platform === 'win32' ? {} : { icon: trayIconPath() ?? undefined }),
    silent: process.platform === 'win32',
  });
  retainNotification(liveNotifications, notification);
  notification.on('click', () => primaryActivation.activate());
  notification.show();
  if (process.platform === 'win32') void playNotificationSound().catch(() => undefined);
  return { ok: true };
};
const browserApprovalGrants = createBrowserApprovalGrants(localService);
setBrowserApprovalHooks({
  resolveRequester: createApprovalRequesterResolver({
    ...approvalSources,
    listAgents: browserApprovalGrants.listAgents,
    titleLabels: nativeSessionTitleLabels,
    leadName: () => nativeT('Lead'),
  }),
  isAllowed: browserApprovalGrants.isAllowed,
  isBlocked: browserApprovalGrants.isBlocked,
  allowAllActions: browserApprovalGrants.allowsAllActions,
  remember: async (agentId, actions) => {
    await browserApprovalGrants.remember(agentId, actions);
    void localService.invokeDesktopOperation('notifySettingsChanged', ['permissions']).catch(() => {});
  },
  audit: browserApprovalGrants.audit,
  downloadsDir: () => app.getPath('downloads'),
  surfaceSessionId: (sessionId) => approvalSurfaceSessionId(sessionId, approvalSources),
  // Paired devices mark these sessions too (ids only; the card stays here).
  onPendingSessions: (sessionIds) => {
    void localService.invokeDesktopOperation('publishBrowserApprovalSessions', [sessionIds]).catch(() => {});
  },
  notify: (window, { sessionId, name }) => {
    if (!Notification.isSupported()) return;
    const target = sessionId ? approvalSurfaceSessionId(sessionId, approvalSources) : '';
    // Raised only while Mixdog is in the background: nothing is on screen.
    const decision = decideNotification({
      ...pcNotificationView(),
      event: 'approval',
      conversation: notificationConversation(target),
      now: Date.now(),
      foreground: false,
    });
    if (!decision.notify) {
      diagnostics?.write('browser-approval-notification-suppressed', { sessionId: target, reason: decision.reason });
      return;
    }
    const notification = new Notification({
      ...boundedNotification({
        title: name ? `${name} · ${nativeT('Browser Use approval')}` : nativeT('Browser Use approval'),
        body: nativeT('A tool is waiting for your approval.'),
      }),
      ...(process.platform === 'win32' ? {} : { icon: trayIconPath() ?? undefined }),
      silent: process.platform === 'win32',
    });
    retainNotification(liveNotifications, notification);
    notification.on('click', () => {
      if (!target || !openDesktopNotificationSession(window, target)) activateDesktopWindow(window);
    });
    notification.show();
    if (process.platform === 'win32') void playNotificationSound().catch(() => undefined);
  },
});
let unsubscribeTurnNotifier: (() => void) | null = null;
/** A server window's notifications fire on this PC, labeled with the server
 *  and following this PC's notification preferences; a click brings that
 *  window (and the session) to the front. */
function createServerWindowNotifier(window: BrowserWindow, connection: DesktopConnection): ServerNotifier {
  const client = connection.client;
  const link = connection.link;
  return createServerNotifier({
    serverName: connection.name,
    sources: {
      subscribeSessions: (listener) => client.subscribeSessions(listener),
      subscribeAgentPool: (listener) => client.subscribeAgentPool(listener),
      subscribeSessionStates: (listener) => client.subscribeSessionStates(listener),
      subscribeLink: (listener) => link?.subscribe(listener) ?? (() => {}),
      readFinalAnswer: (sessionId, startedAt, signal) => client.readSessionFinalAnswer(sessionId, startedAt, signal),
    },
    preferences: pcNotificationView,
    isSupported: () => Notification.isSupported(),
    isForeground: () => !window.isDestroyed() && window.isVisible() && window.isFocused(),
    isSessionOnScreen: (sessionId) => isSessionOnScreen(window, sessionId),
    createNotification: (content) =>
      new Notification({
        ...content,
        ...(process.platform === 'win32' ? {} : { icon: trayIconPath() ?? undefined }),
        silent: process.platform === 'win32',
      }),
    ...(process.platform === 'win32' ? { playSound: playNotificationSound } : {}),
    focus: (sessionId) => {
      if (sessionId) openDesktopNotificationSession(window, sessionId);
      else activateDesktopWindow(window);
    },
    text: {
      approvalWaiting: () => nativeT('A tool is waiting for your approval.'),
      lostTitle: () => nativeT('Connection to {{name}} lost'),
      lostReconnecting: () => nativeT('Mixdog is reconnecting automatically.'),
      lostStopped: () => nativeT('Open the server window to reconnect.'),
      restoredTitle: () => nativeT('Reconnected to {{name}}'),
      restoredBody: () => nativeT('The server window is working again.'),
    },
    titleLabels: nativeSessionTitleLabels,
    diagnostic: (event, details) => diagnostics?.write(event, { ...details, connection: 'ssh' }),
  });
}
const applyDesktopSettings = (settings: DesktopSettings): void => {
  awakeService.setEnabled(settings.keepAwake !== false);
  notificationVolume = settings.notificationVolume;
  runInBackground = settings.runInBackground !== false;
  syncDesktopTray();
  applyComputerControlSetting(settings.computerControl === true);
  applyComputerObserveOnlySetting(settings.computerObserveOnly === true);
  browserControlEnabled = settings.browserControl === true;
  browserFeatureInstalled = settings.browserInstalled !== false;
  browserHost?.setBridgeEnabled(browserControlEnabled);
  browserAutoSignIn = settings.browserAutoSignIn !== false;
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
  // GNOME window control comes from Mixdog's own shell extension: keep it in
  // place and enabled exactly while Computer Use is on (a no-op elsewhere).
  void applyGnomeExtensionSetting(
    enabled,
    app.isPackaged
      ? join(process.resourcesPath, 'gnome-extension', 'mixdog-windows@mixdog.io')
      : join(app.getAppPath(), '..', '..', 'native', 'gnome-extension', 'mixdog-windows@mixdog.io')
  );
  computerHost?.setBridgeEnabled(computerControlEnabled);
}
// Observation only: the bridge keeps serving reads while every input action is
// refused by the host, so a running agent turn is narrowed the moment it flips.
function applyComputerObserveOnlySetting(enabled: boolean): void {
  computerObserveOnly = enabled;
  computerHost?.setObserveOnly(computerObserveOnly);
}
// This PC's daemon drives the PC-wide features: the Browser Use host, the
// updater and trash requests of paired phones, and the desktop settings.
// A pending takeover hands the requesting session's page or step to the user:
// only that session's Browser Use waits (a screen takeover also holds
// Computer Use, there being one screen). Nobody finishing it, it expires.
// A browser takeover is the one moment the Browser Use panel opens by itself,
// on the handed-over page, once human control is ready (the session's
// commands stopped and drained).
// A login takeover never reveals the panel: its card opens the sign-in window.
const browserLogin = createBrowserLoginPopup({
  parent: () => mainWindow,
  session: () => session.fromPartition(BROWSER_PARTITION),
  urlPolicy: browserUrlPolicyFromEnvironment({ remote: false }),
  ready: (sessionId, id) => takeoverGate.ready(sessionId, id),
  settle: (sessionId, id) =>
    localService.resolveToolApprovalForSession(sessionId, id, { approved: true, response: 'done' }),
  afterSignIn: (sessionId, id) => browserHost?.reloadAfterSignIn(sessionId, id),
});
takeoverGate.onExpire((sessionId, id) => {
  browserHost?.endTakeoverPage(sessionId, '');
  return localService.resolveToolApprovalForSession(sessionId, id, {
    approved: false,
    reason: TAKEOVER_EXPIRED_REASON,
  });
});
const takeoverCapture = {
  capture: (sessionId: string, id: string, tab: string) => browserHost?.captureTakeoverPage(sessionId, id, tab),
  decline: (sessionId: string, id: string, reason: string) =>
    localService.resolveToolApprovalForSession(sessionId, id, { approved: false, reason }),
  report: (event: string, details: Record<string, unknown>) => {
    diagnostics?.write(event, details);
    console.error(`[mixdog-takeover] ${event}`, details);
  },
};
unsubscribeTakeovers = localService.subscribeSessionStates((update) => {
  const surface = takeoverGate.onSessionState(update);
  const login = update?.snapshot ? loginTakeoverOf(update.snapshot) : null;
  const approval = (
    update?.snapshot as
      | { toolApproval?: { id?: unknown; kind?: unknown; takeover?: { tab?: unknown } | null } | null }
      | undefined
  )?.toolApproval;
  const id = String(approval?.id ?? 'takeover');
  if (update?.sessionId && update.snapshot) {
    browserLogin.sync(String(update.sessionId), login);
    // A settled (or replaced) takeover forgets the page it handed over.
    browserHost?.endTakeoverPage(String(update.sessionId), approval?.kind === 'takeover' ? id : '');
  }
  if (surface !== 'browser') return;
  const sessionId = String(update.sessionId);
  // The handed-over page is fixed as the takeover starts (login or not), so
  // later tab moves never retarget the handoff or the post-login reload.
  // A tab that cannot be handed over declines the takeover with the reason.
  const tab = typeof approval?.takeover?.tab === 'string' ? approval.takeover.tab : '';
  if (!captureTakeoverOrDecline(takeoverCapture, sessionId, id, tab)) return;
  if (login) return;
  void takeoverGate.ready(sessionId, id).then((ready) => {
    if (ready) browserHost?.openForTakeover(sessionId, id);
  });
});
unsubscribeServiceSettings = localService.subscribeDesktopEvents(({ name, value }) => {
  if (name === 'session-runtime-released') {
    const event = value as { sessionId?: unknown; restore?: unknown } | null;
    if (isSessionId(event?.sessionId)) {
      browserHost?.releaseSession(event.sessionId, { restore: event.restore === true });
      // A session's secrets are redacted for its lifetime, then forgotten.
      if (event.restore !== true) secretInputs.forget(event.sessionId);
    }
    return;
  }
  if (name === 'browser-remote-request') {
    const request =
      value && typeof value === 'object' ? (value as { id?: unknown; method?: unknown; args?: unknown }) : {};
    const id = typeof request.id === 'string' ? request.id : '';
    const args = Array.isArray(request.args) ? request.args : [];
    if (
      id &&
      (request.method === 'trashItem' ||
        request.method === 'updaterState' ||
        request.method === 'updaterCheck' ||
        request.method === 'updaterInstall' ||
        request.method === 'displayPreferences' ||
        request.method === 'visualizeState' ||
        request.method === 'visualizeCommand' ||
        request.method === 'visualizeExport' ||
        request.method === 'captureFileSnapshot' ||
        request.method === 'localPageUrl' ||
        request.method === 'notificationStatus' ||
        request.method === 'notificationTest')
    ) {
      const hostMethod = request.method;
      void (async () => {
        let installAfterAnswer = false;
        try {
          let result: unknown = null;
          if (hostMethod === 'trashItem') {
            await shell.trashItem(String(args[0] || ''));
          } else if (hostMethod === 'updaterState') {
            result = desktopUpdater.getState();
          } else if (hostMethod === 'updaterCheck') {
            result = await desktopUpdater.check();
          } else if (hostMethod === 'displayPreferences') {
            result = await readHostWindowDisplayPreferences(mainWindow, app.getLocale());
          } else if (hostMethod === 'notificationStatus') {
            // Paired devices that hold pushes while this PC is in use read
            // the OS's own idle time: input anywhere on the PC counts.
            result = { supported: Notification.isSupported(), idleSeconds: powerMonitor.getSystemIdleTime() };
          } else if (hostMethod === 'notificationTest') {
            result = showTestNotification();
          } else if (hostMethod === 'visualizeState') {
            result = visualize.hostSnapshot();
          } else if (hostMethod === 'visualizeCommand') {
            result = (await visualize.command(requiredVisualizeTabCommand(args[0]))) ?? null;
          } else if (hostMethod === 'visualizeExport') {
            // A paired device's PNG/PDF: rendered to a temp file the daemon
            // turns into that device's download.
            result = await visualize.exportForDevice(requiredVisualizeTabCommand(args[0]));
          } else if (hostMethod === 'captureFileSnapshot') {
            // The daemon already confined the path; this only renders it.
            result = await fileSnapshots.capture(String(args[0] || ''), String(args[1] || ''), args[2] === true);
          } else if (hostMethod === 'localPageUrl') {
            // The daemon already confined the path; this only mints the lease
            // the desktop handler mints, owned by the window so it dies with it.
            result = await localPageUrl(String(args[0] || ''), String(args[1] || ''), {
              scope: args[2] === 'file' ? 'file' : 'project',
              owner: mainWindow?.webContents,
              authorize: async () => {},
            });
          } else {
            result = desktopUpdater.getState();
            installAfterAnswer = desktopUpdater.getState().status === 'ready';
          }
          await localService.invokeDesktopOperation('browserRemoteResolve', [id, true, result, null]);
        } catch (error) {
          installAfterAnswer = false;
          await localService
            .invokeDesktopOperation('browserRemoteResolve', [
              id,
              false,
              null,
              error instanceof Error ? error.message : String(error),
            ])
            .catch(() => {});
        }
        // Installing restarts this app, so the caller is answered first.
        if (installAfterAnswer) await desktopUpdater.install();
      })();
      return;
    }
    const method =
      typeof request.method === 'string' && BROWSER_REMOTE_METHODS.has(request.method)
        ? (request.method as BrowserRemoteMethod)
        : null;
    if (!id || !method) return;
    void (async () => {
      try {
        if (!browserHost) throw new Error('Desktop Browser Use is unavailable.');
        const result = await runBrowserRemoteRequest(browserHost, method, args);
        await localService.invokeDesktopOperation('browserRemoteResolve', [id, true, result ?? null, null]);
      } catch (error) {
        await localService
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
// Paired browsers show this machine's updater, so its state travels to the daemon.
unsubscribeUpdaterRelay = desktopUpdater.subscribe((state) => {
  void localService.invokeDesktopOperation('publishUpdaterState', [state]).catch(() => {});
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
// Bounds persist per connection: each open window's writer, and the final
// flushes of the ones already closed.
const windowStates = new Map<BrowserWindow, ReturnType<typeof persistWindowState>>();
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
  installNativeMenu(Boolean(process.env.ELECTRON_RENDERER_URL), {
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
  if (deferredServicesPromise) return deferredServicesPromise;
  const startedAt = Date.now();
  diagnostics?.write('deferred-services-start', {});
  deferredServicesPromise = localService
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

async function remoteAccessInfo(options?: { activate?: boolean }): Promise<DesktopRemoteAccessInfo | null> {
  const descriptor = await localService.invokeDesktopOperation('remoteAccessInfo', [options?.activate !== false]);
  const { remoteAccessInfoFromDescriptor } = await import('./remote-access-window');
  return remoteAccessInfoFromDescriptor(descriptor);
}

async function rotateRemoteAccess(): Promise<DesktopRemoteAccessInfo | null> {
  const descriptor = await localService.invokeDesktopOperation('remoteAccessRotate', []);
  const { remoteAccessInfoFromDescriptor } = await import('./remote-access-window');
  return remoteAccessInfoFromDescriptor(descriptor);
}

async function revokeRemoteAccessClient(clientId: string): Promise<DesktopRemoteAccessInfo | null> {
  const descriptor = await localService.invokeDesktopOperation('remoteAccessRevokeClient', [clientId]);
  const { remoteAccessInfoFromDescriptor } = await import('./remote-access-window');
  return remoteAccessInfoFromDescriptor(descriptor);
}

// Hosts saved for "Connect to another PC" live for the whole app, not one
// window: closing and reopening the main window keeps their windows.
/** Brings this PC's window to the front on Settings → Connection. */
function showLocalConnectionSettings(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send(DESKTOP_IPC.showConnectionSettings);
}
let remoteHostWindows: Promise<RemoteHostWindows> | null = null;
function remoteHostsHandle(): RemoteHostWindows {
  remoteHostWindows ??= (async () => {
    const [{ loadRemoteHostStore, relayHttpOrigin }, { createRemoteHostWindows }] = await Promise.all([
      import('./remote-hosts'),
      import('./remote-host-windows'),
    ]);
    const { resolveRelayUrl } = await import('./remote-relay-device');
    return createRemoteHostWindows(
      await loadRemoteHostStore(desktopUserData),
      join(import.meta.dirname, '../preload/remote-window.js'),
      {
        relayOrigin: () => {
          const relayUrl = resolveRelayUrl(process.env);
          return relayUrl ? relayHttpOrigin(relayUrl) : null;
        },
        showConnectionSettings: showLocalConnectionSettings,
      }
    );
  })();
  const ready = remoteHostWindows;
  return {
    list: async () => (await ready).list(),
    connectByCode: async (code) => (await ready).connectByCode(code),
    open: async (id) => (await ready).open(id),
    forget: async (id) => (await ready).forget(id),
    rename: async (id, name) => (await ready).rename(id, name),
  };
}

function scheduleDeferredDesktopServices(window: BrowserWindow): void {
  if (deferredServicesScheduled || deferredServicesPromise) return;
  deferredServicesScheduled = true;
  scheduleAfterServiceQuiet(window, {
    awaitServiceReady: () => localConnection.start(),
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
  unsubscribeTakeovers?.();
  unsubscribeTakeovers = null;
  browserLogin.dispose();
  takeoverGate.dispose();
  unsubscribeUpdaterRelay?.();
  unsubscribeUpdaterRelay = null;
  awakeService.dispose();
  computerUseOverlay?.dispose();
  computerUseOverlay = null;
  desktopPet?.dispose();
  desktopPet = null;
  if (!disposalPromise) {
    diagnostics?.write('desktop-stop');
    const browserAndComputerCleanup = (async () => {
      await browserHost?.dispose();
      await browserHostDisposal;
      await computerHost?.dispose();
      await terminalBridge.stop();
      await visualizeBridge.stop();
      visualize.dispose();
    })();
    const cleanup = Promise.all([
      browserAndComputerCleanup,
      // Quit detaches from every server: the tunnels close, the servers'
      // daemons keep running.
      sshConnections.closeAll(),
      localConnection.dispose(),
      windowStateFlush,
      ...[...windowStates.values()].map((state) => state.flush()),
      flushPaneLayoutFiles(),
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
    disposalPromise = Promise.race([cleanup, deadline])
      .finally(() => {
        if (timeout) clearTimeout(timeout);
      })
      // The view is detached; an in-tree daemon still has to stop before the
      // exit kills it mid-teardown (it would leave PostgreSQL running).
      .then(() => localConnection.transport()?.stopInTreeDaemon(DESKTOP_DAEMON_STOP_TIMEOUT_MS))
      .then(
        () => undefined,
        (error: unknown) => {
          console.error('Failed to stop the Mixdog daemon during quit:', error);
        }
      );
  }
  return disposalPromise;
}

// Windows vanish the moment a quit begins; detach, daemon stop and the
// PostgreSQL behind it finish in this still-running main process afterwards.
const quitSequence = createDesktopQuitSequence({
  windows: () => BrowserWindow.getAllWindows(),
  teardown: async () => {
    for (const removeWindowIpc of windowIpcDisposers.values()) removeWindowIpc();
    windowIpcDisposers.clear();
    await disposeDesktopResources();
  },
  exit: () => {
    quitAfterDispose = true;
    app.quit();
  },
  relaunch: () => app.relaunch(),
  onError: (error) => console.error('Mixdog desktop quit step failed:', error),
});

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
  brandIconPath: string | null,
  afterUpdate: boolean,
  connection: ConnectionIdentity,
  partition: string | undefined
): BrowserWindow {
  return new BrowserWindow({
    ...DESKTOP_WINDOW_OPTIONS,
    ...initialTitleBarWindowOverrides(),
    ...clampBoundsToWorkArea(
      savedState?.bounds ?? { width: DESKTOP_WINDOW_OPTIONS.width, height: DESKTOP_WINDOW_OPTIONS.height },
      (savedState ? screen.getDisplayMatching(savedState.bounds) : screen.getPrimaryDisplay()).workArea
    ),
    ...(brandIconPath ? { icon: brandIconPath } : {}),
    webPreferences: {
      ...DESKTOP_WINDOW_OPTIONS.webPreferences,
      ...(partition ? { partition } : {}),
      // The browser pane (the only <webview> user) exists in this PC's
      // window only; a server window cannot attach one at all. Voice input
      // keeps `media`: dictation records here and the server transcribes.
      ...(connection.kind === 'ssh' ? { webviewTag: false } : {}),
      preload: join(import.meta.dirname, '../preload/index.js'),
      additionalArguments: [
        `--mixdog-boot-id=${desktopBootId}`,
        `--mixdog-process-started-at=${desktopProcessStartedAt}`,
        ...(desktopBootScenario ? [`--mixdog-boot-scenario=${desktopBootScenario}`] : []),
        ...(afterUpdate ? ['--mixdog-after-update=1'] : []),
        // The window's identity: the title bar names the server it drives.
        `--mixdog-connection-id=${encodeURIComponent(connection.id)}`,
        `--mixdog-connection-kind=${connection.kind}`,
        `--mixdog-connection-name=${encodeURIComponent(connection.name)}`,
      ],
    },
  });
}

/** Per-connection storage name: ids are user data, file and partition names
 *  are not. */
function connectionStorageKey(connection: ConnectionIdentity): string {
  return createHash('sha256').update(connection.id).digest('hex').slice(0, 16);
}

function connectionWindowStatePath(connection: ConnectionIdentity): string {
  return join(
    app.getPath('userData'),
    connection.kind === 'local' ? 'window-state.json' : `window-state-ssh-${connectionStorageKey(connection)}.json`
  );
}

/** The profile-file copy of the window's pane layout, beside its window state
 *  and named the same way: a server window's layout is its own. */
function connectionPaneLayoutFile(connection: ConnectionIdentity) {
  return createPaneLayoutFile(
    join(
      app.getPath('userData'),
      connection.kind === 'local' ? PANE_LAYOUT_FILE : `pane-layout-ssh-${connectionStorageKey(connection)}.json`
    ),
    paneLayoutFileFailure
  );
}

/** A server window keeps its renderer storage (open session, drafts, panes)
 *  in its own persistent partition: those ids belong to the server's daemon
 *  and must never be read back by this PC's window, or the other way round. */
function connectionPartition(connection: ConnectionIdentity): string | undefined {
  return connection.kind === 'local' ? undefined : `persist:mixdog-ssh-${connectionStorageKey(connection)}`;
}

// Set once the app is ready; every renderer session uses the same policy.
let rendererBootScriptHash: string | null = null;
const policedRendererSessions = new WeakSet<Electron.Session>();

/** The app renderer's CSP and permissions, for this PC's session and for each
 *  server window's partition. */
function installRendererSessionPolicy(target: Electron.Session): void {
  if (policedRendererSessions.has(target)) return;
  policedRendererSessions.add(target);
  target.webRequest.onHeadersReceived((details, callback) => {
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
    // Visualize panes frame project pages from the local page server only
    // (tokenized, loopback); no other http origin may be framed.
    const frameSrc = `frame-src 'self' blob: ${MEDIA_SCHEME}:${localPageFrameOrigin ? ` ${localPageFrameOrigin}` : ''}`;
    // GitHub avatar hosts are allowed in img-src for the onboarding /
    // settings account cards (github.com redirects to avatars host).
    // media-src mirrors img-src: Studio tiles load from the mixdog-media
    // byte lane, and older paths still inline data:/blob: URLs, which
    // default-src 'self' would otherwise block.
    const policy = development
      ? `default-src 'self'; script-src 'self' 'unsafe-eval' 'unsafe-inline'; connect-src 'self' ${MEDIA_SCHEME}: ws://127.0.0.1:* ws://localhost:*; img-src 'self' data: blob: ${MEDIA_SCHEME}: https://github.com https://avatars.githubusercontent.com; media-src 'self' data: blob: ${MEDIA_SCHEME}:; ${frameSrc}; style-src 'self' 'unsafe-inline'; font-src 'self' data:`
      : `default-src 'self'; script-src 'self'; connect-src 'self' ${MEDIA_SCHEME}:; img-src 'self' data: blob: ${MEDIA_SCHEME}: https://github.com https://avatars.githubusercontent.com; media-src 'self' data: blob: ${MEDIA_SCHEME}:; ${frameSrc}; style-src 'self' 'unsafe-inline'; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`;
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [development ? policy : withInlineBootScript(policy, rendererBootScriptHash)],
      },
    });
  });
  // Push-to-talk/pairing use getUserMedia; transcript copy uses clipboard
  // writes. Only the trusted desktop renderers (routed app windows) receive
  // these permissions. Clipboard reads and every other permission still fail
  // closed.
  const trustedPermissionSender = (webContents: Electron.WebContents | null) =>
    webContents && !webContents.isDestroyed() && windowRoutes.has(webContents.id) ? webContents : null;
  target.setPermissionCheckHandler((webContents, permission) =>
    desktopPermissionAllowed(permission, webContents, trustedPermissionSender(webContents))
  );
  target.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowed = desktopPermissionAllowed(permission, webContents, trustedPermissionSender(webContents));
    if (!allowed) {
      diagnostics?.write('permission-request', { permission });
    }
    callback(allowed);
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
    const whatsNew = normalizeRendererWhatsNewDiagnostic(payload);
    if (whatsNew) {
      diagnostics?.write('renderer-whats-new', whatsNew);
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
function createWindowPresentation(window: BrowserWindow, startupStartedAt: number, afterRendererReady: () => void) {
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
    showWhenComposed();
    afterRendererReady();
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

/** The desktop pet window: frameless, transparent, always on top, off the
 *  taskbar, shown without taking focus; it loads
 *  desktop-pet.html with its own narrow preload. */
function createDesktopPetController(): DesktopPet {
  const { developmentUrl, rendererUrl } = resolveRendererTarget();
  return createDesktopPet({
    prefsPath: join(app.getPath('userData'), 'desktop-pet.json'),
    screen,
    createWindow: (bounds, layer) => {
      const window = new BrowserWindow({
        ...bounds,
        // Its layer is fixed here (desktop-pet-window.ts createWindow).
        ...(layer.parent ? { parent: layer.parent as unknown as BrowserWindow } : {}),
        alwaysOnTop: layer.alwaysOnTop,
        show: false,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        hasShadow: false,
        // No native resize border to flash around the transparent window.
        thickFrame: false,
        // Windows 11 rounds a frameless window and draws its 1px system
        // border: a light rounded box around the transparent pet window.
        roundedCorners: false,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        // Activatable from the start (shown inactive, focused only on a
        // click): a window made unfocusable and switched with setFocusable
        // left the IME composing outside its quick message.
        title: 'Mixdog bot overlay',
        webPreferences: {
          preload: join(import.meta.dirname, '../preload/desktop-pet.js'),
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
          backgroundThrottling: false,
        },
      });
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', (event) => event.preventDefault());
      return window as unknown as PetWindow;
    },
    load: async (window) => {
      const target = window as unknown as BrowserWindow;
      if (developmentUrl) await target.loadURL(new URL('desktop-pet.html', rendererUrl).href);
      else await target.loadFile(join(import.meta.dirname, '../renderer/desktop-pet.html'));
    },
    // The composer's own route: the followed session's submitToSession.
    submit: async (sessionId, text) =>
      (await localService.submitToSession(sessionId, text, { submittedAt: Date.now() })) === true,
    openApp: (sessionId) => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        void showConnectionWindow(localConnection).catch(() => {});
        return;
      }
      if (!sessionId || !openDesktopNotificationSession(mainWindow, sessionId)) activateDesktopWindow(mainWindow);
    },
    // The shared read cursor the app advances when the chat is viewed: the
    // catalog push that follows clears the session's unread mark there.
    markRead: (sessionId) => {
      void (async () => {
        const row = (await localService.listSessions()).find((session) => session.id === sessionId);
        if (row) await localService.markSessionRead(sessionId, Math.max(0, Number(row.messageCount) || 0), true);
      })().catch(() => {});
    },
    copyText: (text) => clipboard.writeText(text),
    avatarImage: async (agentId) =>
      (await localService.invokeCapability('getAgentAvatarImage', [agentId]))?.value ?? null,
  });
}

/** This PC's window carries the machine's single instances: Computer Use and
 *  its overlay, the Browser Use pane host, taskbar attention, idle reclaim and
 *  the close-to-background behavior. Returns its Browser Use host. */
function installLocalWindowFeatures(
  window: BrowserWindow,
  onGuest: (guest: Electron.WebContents) => void
): BrowserHost {
  mainWindow = window;
  desktopPet?.attachAppWindow(window);
  if (!computerHost) {
    computerHost = createComputerHost({
      bridgeEnabled: false,
      observeOnly: computerObserveOnly,
      onDiagnostic: (event, data) => diagnostics?.write(event, data),
      // Saved logins in the user's browser follow Browser Use's Auto login.
      savedLoginEnabled: () => browserAutoSignIn,
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
            confirmComputerTurnsStopped(sessionIds, async (sessionId) => localService.abortSession(sessionId))
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
  const windowBrowserHost = createBrowserHost(window, {
    // Only this PC's own window has a browser host (server windows refuse the
    // browser pane and agent bridge), so its sessions always work locally.
    remoteSession: false,
    onGuest,
    onDiagnostic: (event, data) => diagnostics?.write(event, data),
    autoSignIn: () => browserAutoSignIn,
    // Live frames and explicit reveal/hide requests reach paired clients
    // through the service, which owns the relay and per-client pacing.
    publishRemoteFrame: async (frame) => {
      await localService.invokeDesktopOperation('browserRemoteFrame', [frame]);
    },
    publishRemoteTabs: async (tabs) => {
      await localService.invokeDesktopOperation('browserRemoteTabs', [tabs]);
    },
    publishRemoteImportProgress: async (progress) => {
      await localService.invokeDesktopOperation('browserRemoteImportProgress', [progress]);
    },
    onSurfaceRequest: (request) => {
      void localService.invokeDesktopOperation('browserRemoteOpen', [request]).catch(() => {});
    },
  });
  browserHost = windowBrowserHost;
  windowBrowserHost.setBridgeEnabled(browserControlEnabled);
  // Taskbar attention: flash/bounce when the active turn finishes while this
  // window is unfocused; focusing it clears the signal.
  turnAttention = createTurnAttention({
    isFocused: () => !window.isDestroyed() && window.isFocused(),
    allows: (sessionId) => allowsTaskbarFlash(pcNotificationView(), notificationConversation(sessionId), Date.now()),
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
  window.on('closed', () => {
    computerUseOverlay?.dispose();
    computerUseOverlay = null;
    // This window's host dies with it (macOS 'activate' builds a new one);
    // dispose is idempotent, so a later quit-time dispose is a no-op.
    if (browserHost === windowBrowserHost) browserHost = null;
    browserHostDisposal = Promise.all([browserHostDisposal, windowBrowserHost.dispose()]).then(() => undefined);
    mainWindow = null;
    turnAttention = null;
  });
  return windowBrowserHost;
}

/** Opens the connection's window, or brings back the one already open (or
 *  still being created): one connection never gets two windows. */
const showConnectionWindow = createConnectionWindowOpener<DesktopConnection, BrowserWindow>({
  find: (connectionId) => {
    const window = connectionWindows.get(connectionId);
    return window && !window.isDestroyed() ? window : null;
  },
  focus: (window) => {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  },
  create: (connection) => createWindow(connection),
});

async function createWindow(connection: DesktopConnection): Promise<void> {
  const local = connection.kind === 'local';
  // The main window measures against process start; a server window opens later.
  const startupStartedAt = local ? desktopProcessStartedAt : Date.now();
  const { developmentUrl, packagedRendererPath, rendererUrl, brandIconPath, isAllowedNavigation } =
    resolveRendererTarget();

  const statePath = connectionWindowStatePath(connection);
  const savedState = await readWindowState(statePath, screen.getAllDisplays());
  diagnostics?.write('window-state-ready', {
    totalMs: Date.now() - startupStartedAt,
  });
  configureTitleBarThemePersistence(join(app.getPath('userData'), 'desktop-titlebar-theme'));
  // Once per process: a later window must still know this launch was an update.
  launchFollowsUpdate ??= recordLaunchVersion(
    launchVersionPath(),
    app.getVersion(),
    process.argv,
    launchRecordWriteFailure
  );
  const partition = connectionPartition(connection);
  if (partition) installRendererSessionPolicy(session.fromPartition(partition));
  const window = createMainBrowserWindow(savedState, brandIconPath, await launchFollowsUpdate, connection, partition);
  // Routed before anything can load: every IPC call from this window is
  // answered by this connection, and nothing else.
  windowRoutes.register(window.webContents, connection.id);
  connectionWindows.set(connection.id, window);
  installDesktopWindowMaterial(window);
  // The user's operations in this window reach its connection's runtime.
  const inputReporter = createUserInputReporter({
    report: (at) => connection.client.invokeCapability('noteUserInput', [at]),
  });
  // Not while Computer Use is executing a command against this window (its
  // Browser Use pages, which live inside it, follow the same rule).
  const computerUseOnWindow = () => computerUseOperates(computerUseCoordinator, electronWindowForNativeId, window);
  inputReporter.watch(window.webContents, computerUseOnWindow);
  userInputReporters.add(inputReporter);
  window.once('closed', () => {
    inputReporter.stop();
    userInputReporters.delete(inputReporter);
  });
  if (savedState?.maximized) window.maximize();
  const windowState = persistWindowState(window, statePath);
  windowStates.set(window, windowState);
  // A person's input on a Browser Use page counts; the agent's (and a paired
  // phone's) CDP input raises the same events and is excluded while in flight,
  // as the pane's own takeover rule does (browser/native-view.ts watch).
  const windowBrowserHost = local
    ? installLocalWindowFeatures(window, (guest) => {
        const unwatch = inputReporter.watch(guest, () => agentInputInFlight(guest) || computerUseOnWindow());
        guest.once('destroyed', unwatch);
      })
    : null;
  if (!local) window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  // A dead capture/automation CDP client can leave the renderer frozen at a
  // synthetic viewport (observed 800x600) while the native window resizes —
  // the guard detects the persistent mismatch and self-heals.
  installViewportGuard(window);
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
  const disposeWindowIpc = installWindowIpc(window, connection, windowBrowserHost);
  // A server window hears its own link and notices, raises its own OS
  // notifications, and is reopened at the next launch while it stays open.
  const stopLinkForward = local ? () => {} : forwardConnectionLink(connection, window.webContents);
  if (!local) {
    serverNotifiers.set(window, createServerWindowNotifier(window, connection));
    if (connection.id !== ENV_SSH_CONNECTION_ID) void serverWindowRestore.remember(connection.id).catch(() => {});
  }
  windowIpcDisposers.set(window, () => {
    disposeWindowIpc();
    stopLinkForward();
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
  // The renderer's notice was on screen: retire the pending update announcement.
  if (local) {
    installWhatsNewAcknowledge(ipcMain, window, {
      version: app.getVersion(),
      launchRecorded: () => Promise.resolve(launchFollowsUpdate),
      acknowledge: (version) => acknowledgeAnnouncement(launchVersionPath(), version, launchRecordWriteFailure),
    });
  }
  diagnostics?.write('ipc-ready', {
    totalMs: Date.now() - startupStartedAt,
  });

  installRendererConsoleErrorTail(window, startupStartedAt);
  installDefaultContextMenu(window.webContents);

  installRendererLoadDiagnostics(window, local, startupStartedAt, () => presentation);
  installRendererCrashRecovery(window, reloadRenderer);

  installNavigationGuards(window, isAllowedNavigation);
  const presentation = createWindowPresentation(
    window,
    startupStartedAt,
    local
      ? () => {
          // Idempotent fallback for recreated windows; the primary boot starts
          // this concurrently before renderer navigation.
          startDaemonService();
          scheduleDeferredDesktopServices(window);
        }
      : () => {}
  );
  installWindowCloseCleanup(window, connection, windowState, presentation, onRendererDiagnostic);

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

/** This window's handler table: one ipcMain registration per channel serves
 *  every window, and the router hands each call to its sender's table.
 *  Returns the disposer for both. */
function installWindowIpc(
  window: BrowserWindow,
  connection: DesktopConnection,
  windowBrowserHost: BrowserHost | null
): () => void {
  const local = connection.kind === 'local';
  const ipcScope = ipcRouter.scope(window.webContents.id, connection.id);
  const removeWindowIpc = registerDesktopIpc(window, connection.client, {
    app,
    translateUi: nativeT,
    ipcMain: ipcScope,
    dialog,
    shell,
    powerMonitor,
    connectionKind: connection.kind,
    // A server window's model calls run on this PC's sign-ins (model proxy,
    // filtered by the host's provider list): their quota is this PC's.
    pcHost: {
      invokeCapability: (capability, args, sessionId) => localService.invokeCapability(capability, args, sessionId),
      readCapabilities: (requests) => localService.readCapabilities(requests),
      // A server on its own logins reads its own quota.
      inUse: () => connection.modelLogin !== 'server',
      isProviderAllowed: (provider) => {
        const allowed = allowedProvidersForHost(connection.id);
        return allowed === null || allowed.includes(provider);
      },
    },
    serviceUserDataPath: () => connection.serviceUserDataPath(),
    // The updater and the notification sound are this PC's: a server window
    // gets neither (its channels are refused by the feature gates).
    ...(local && process.platform === 'win32' ? { previewNotificationSound: playNotificationSound } : {}),
    ...(local ? { updater: desktopUpdater } : {}),
    ...(local
      ? { notifications: { isSupported: () => Notification.isSupported(), sendTest: showTestNotification } }
      : {}),
    // This PC's settings, Browser Use, Computer Use and phone access exist only
    // in this PC's window; a server window refuses them (feature gates).
    ...(windowBrowserHost
      ? {
          onDesktopSettingsChanged: applyDesktopSettings,
          browserHost: windowBrowserHost,
          browserLogin,
          computer: { readPermissions: readComputerPermissions, requestPermissions: requestComputerPermissions },
          remoteAccessInfo,
          rotateRemoteAccess,
          revokeRemoteAccessClient,
          visualize,
        }
      : {}),
    terminals: connection.terminals,
    terminalRuns,
    remoteHosts: remoteHostsHandle(),
    paneLayoutFile: connectionPaneLayoutFile(connection),
  });
  return () => {
    removeWindowIpc();
    ipcScope.dispose();
  };
}

function installRendererLoadDiagnostics(
  window: BrowserWindow,
  local: boolean,
  startupStartedAt: number,
  presentation: () => ReturnType<typeof createWindowPresentation>
): void {
  window.webContents.on('did-start-loading', () => {
    diagnostics?.write('renderer-load-start', {
      totalMs: Date.now() - startupStartedAt,
    });
  });
  window.webContents.on('dom-ready', () => {
    void refreshNativeUiLanguage(window).then(() => {
      if (!window.isDestroyed()) installDesktopMenu();
      desktopTray?.relabel();
      // A language change reloads this window: paired browsers re-read the host's display choice.
      if (local) void localService.invokeDesktopOperation('notifySettingsChanged', ['desktop']).catch(() => {});
    });
    diagnostics?.write('renderer-dom-ready', {
      totalMs: Date.now() - startupStartedAt,
    });
  });
  window.webContents.on('did-finish-load', () => {
    presentation().markRendererLoaded();
    diagnostics?.write('renderer-load-finished', {
      totalMs: Date.now() - startupStartedAt,
    });
    presentation().showWhenComposed();
  });

  window.on('unresponsive', () => {
    diagnostics?.write('renderer-unresponsive', { processes: currentProcessMemory() });
  });
  window.on('responsive', () => {
    diagnostics?.write('renderer-responsive');
  });
}

function installWindowCloseCleanup(
  window: BrowserWindow,
  connection: DesktopConnection,
  windowState: ReturnType<typeof persistWindowState>,
  presentation: ReturnType<typeof createWindowPresentation>,
  onRendererDiagnostic: ReturnType<typeof rendererDiagnosticListener>
): void {
  window.on('closed', () => {
    presentation.cancelShowDeadline();
    diagnostics?.write('window-closed');
    presentation.detach();
    ipcMain.removeListener(DESKTOP_IPC.rendererDiagnostic, onRendererDiagnostic);
    windowStates.delete(window);
    windowStateFlush = Promise.all([windowStateFlush, windowState.flush().finally(() => windowState.dispose())]).then(
      () => undefined
    );
    windowIpcDisposers.get(window)?.();
    windowIpcDisposers.delete(window);
    if (connectionWindows.get(connection.id) === window) connectionWindows.delete(connection.id);
    serverNotifiers.get(window)?.dispose();
    serverNotifiers.delete(window);
    // Closing a server window detaches: its tunnel closes, the server's
    // daemon keeps running. Only the user's close forgets it for the next
    // launch; quitting keeps it.
    if (connection.kind !== 'local') {
      if (!quitApproved) void serverWindowRestore.forget(connection.id).catch(() => {});
      void sshConnections.close(connection.id).catch((error: unknown) => {
        console.error(`Failed to detach from ${connection.name}:`, error);
      });
    }
  });
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
    // During a quit's teardown this instance still holds the lock: the new
    // launch exits, and this one relaunches the app on its way out.
    if (quitSequence.secondInstance()) {
      diagnostics?.write('second-instance-during-quit-relaunch', {});
      return;
    }
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
      setPageFaultDiagnosticSink((entry) => diagnostics?.write('browser-page-fault', { ...entry }));
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
        diagnostics?.write('defaults-separation-failed', {
          message: error instanceof Error ? error.message : String(error),
        });
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
      // The desktop pet window, when its setting is on (desktop-pet-window.ts).
      desktopPet = createDesktopPetController();
      if (mainWindow) desktopPet.attachAppWindow(mainWindow);
      desktopPet.start();
      // Keep-awake + taskbar attention feed on the same session state lane.
      unsubscribeAwake = localService.subscribe((snapshot) => {
        awakeService.onSnapshot(snapshot);
        turnAttention?.onSnapshot(snapshot);
        idleReclaim?.onSnapshot(snapshot);
      });
      // Every session's roster and the agent pool, not just the active pane:
      // the final-answer rule needs background work as well as turn state.
      const unsubscribeTurnSessions = localService.subscribeSessions((sessions) => {
        latestSessions = sessions;
        turnNotifier.onSessions(sessions);
        // Visualize holds the panel while a session's agent turn runs.
        void visualize.observeTurns(sessions);
      });
      const unsubscribeTurnAgents = localService.subscribeAgentPool((agents) => {
        latestAgentPool = agents;
        turnNotifier.onAgentPool(agents);
      });
      // A session starting to wait on a tool approval or a question, while it
      // is not on screen, is told like a finished turn.
      const unsubscribeTurnWaits = localService.subscribeSessionStates((update) => turnNotifier.onSessionState(update));
      unsubscribeTurnNotifier = () => {
        unsubscribeTurnSessions();
        unsubscribeTurnAgents();
        unsubscribeTurnWaits();
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
        void localService.invokeDesktopOperation('remoteAccessResume', []).catch(() => {});
        // Server links probe before touching their tunnel: a live one stays.
        for (const connection of connectionPool.list()) void connection.link?.resume();
      });
      // Sleep pauses the server links: no attempts, no failure shown.
      powerMonitor.on('suspend', () => {
        for (const connection of connectionPool.list()) connection.link?.suspend();
      });
      // A dead network is otherwise noticed only by the ping cycle: redial the
      // relay leg the moment the machine is back online or its network changes.
      createNetworkWatcher({
        isOnline: () => net.isOnline(),
        signature: () => networkSignature(),
        onChange: () => {
          void localService.invokeDesktopOperation('remoteAccessResume', []).catch(() => {});
        },
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
      rendererBootScriptHash = process.env.ELECTRON_RENDERER_URL
        ? null
        : inlineBootScriptHash(join(import.meta.dirname, '../renderer'));
      installRendererSessionPolicy(session.defaultSession);
      // Gallery bytes leave the RPC lane here: tiles and clips become ordinary
      // cacheable, range-able resources fetched straight by the DOM. The lane
      // reads this PC's files, so only this PC's window session has it.
      registerMediaProtocol(localService);
      registerSshHostIpc({
        ipcMain,
        routes: windowRoutes,
        userDataPath: desktopUserData,
        connections: sshConnections,
        serverLogins: {
          connection: (id) => {
            const connection = id === LOCAL_CONNECTION_ID ? undefined : connectionPool.get(id);
            if (connection?.kind !== 'ssh') return null;
            const modelLogin = connection.modelLogin;
            return {
              modelLogin,
              invoke: async (capability, args) => (await connection.client.invokeCapability(capability, args)).value,
              busySessions: async () => (await connection.remote?.busySessions(3_000)) ?? null,
              onEnd: (listener) => connection.onModelLoginEnd(modelLogin, listener),
            };
          },
          onAttach: (listener) =>
            connectionPool.onAdd((connection) => {
              if (connection.kind === 'ssh') listener(connection.id);
            }),
          openExternal: (url) => shell.openExternal(url),
          // The provider's callback port, the same on both ends, while one
          // server login is pending: this PC's own bind of it is the check,
          // so a port taken here is never forwarded. Its ssh runs under the
          // server's saved settings (its key file).
          forwardCallback: (host, port) =>
            runWithHostSettings(host.id, () =>
              openCallbackForward({
                target: parseSshTarget(host.target),
                port,
                log: (line) =>
                  diagnostics?.write('ssh-login-forward', { connection: 'ssh', detail: line.slice(0, 300) }),
              })
            ),
        },
      });
      registerServerPortsIpc({
        ipcMain,
        routes: windowRoutes,
        pool: connectionPool,
        openExternal: (url) => shell.openExternal(url),
      });
      registerConnectionLinkIpc({
        ipcMain,
        routes: windowRoutes,
        pool: connectionPool,
        restore: serverWindowRestore,
        closeWindow: (sender) => BrowserWindow.fromWebContents(sender)?.close(),
        showConnectionSettings: showLocalConnectionSettings,
        requestSignIn: (connection) => {
          if (!mainWindow || mainWindow.isDestroyed() || !connection.target) return;
          activateDesktopWindow(mainWindow);
          mainWindow.webContents.send(DESKTOP_IPC.connectionSignIn, {
            id: connection.id,
            name: connection.name,
            target: connection.target,
          });
        },
      });
      await showConnectionWindow(localConnection);
      void serverWindowRestore.restore().catch((error: unknown) => {
        console.error('Failed to reopen the server windows:', error);
      });
      // MIXDOG_SSH_TARGET: the server window opens beside this PC's.
      if (envSshConfig) {
        void sshConnections
          .open({ id: ENV_SSH_CONNECTION_ID, name: envSshConfig.target, target: envSshConfig.target })
          .catch((error: unknown) => {
            diagnostics?.write('ssh-target-window-failed', {
              errorName: error instanceof Error ? error.name : typeof error,
            });
            console.error('Failed to open the MIXDOG_SSH_TARGET server window:', error);
          });
      }
      primaryWindowStarted = true;
      primaryActivation.flush();
      installDesktopMenu();
      // The settings read may have landed before the app was ready to host a tray.
      syncDesktopTray();
      app.on('activate', () => {
        // A Dock click brings back a window hidden by close-to-background.
        if (mainWindow && !mainWindow.isDestroyed()) {
          activatePrimaryWindow();
          return;
        }
        // This PC's window is gone: bring it back even while server windows
        // stay open. A second click while it is being built only waits.
        void showConnectionWindow(localConnection).catch((error: unknown) => {
          console.error('Failed to recreate the Mixdog desktop window:', error);
        });
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
  for (const reporter of userInputReporters) reporter.stop();
  userInputReporters.clear();
  desktopTray?.dispose();
  desktopTray = null;
  if (quitAfterDispose) return;
  event.preventDefault();
  void quitSequence.begin();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

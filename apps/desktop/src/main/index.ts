import { createHash } from 'node:crypto';
import { existsSync, watch as watchDirectory } from 'node:fs';
import * as nodeModule from 'node:module';
import { constants as osConstants, freemem, hostname, setPriority, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { installRendererConsoleErrorTail } from './renderer-console-error-tail';
import { inlineBootScriptHash, withInlineBootScript } from './renderer-csp';
import { pathToFileURL } from 'node:url';

import {
  app,
  BrowserWindow,
  clipboard,
  crashReporter,
  dialog,
  ipcMain,
  Notification,
  powerMonitor,
  powerSaveBlocker,
  screen,
  session,
  shell,
  webContents,
} from 'electron';

import { isSessionId } from './desktop-state';
import { TAKEOVER_EXPIRED_REASON, takeoverGate } from './takeover-gate';
import {
  allowsTaskbarFlash,
  decideNotification,
  type NotificationConversation,
  notificationConversationOf,
} from './notification-decision';
import { createPcNotificationView } from './pc-notification-view';
import { captureTakeoverOrDecline } from './takeover-capture';
import { createTakeoverFeed } from './takeover-feed';
import { observeCoreForMain } from './core-observers';
import { createTakeoverStateHandler } from './takeover-state';
import { secretInputs } from './secret-input';
import {
  ConnectionPool,
  LOCAL_CONNECTION_ID,
  WindowRouteRegistry,
  createConnectionIpcRouter,
  ConnectionError,
  createConnectionWindowOpener,
  createDesktopConnection,
  forwardConnectionLink,
  registerConnectionLinkIpc,
  resolveWindowConnection,
  type ConnectionIdentity,
  type DesktopConnection,
  type DesktopConnectionDependencies,
} from './connections';
import { createServerConnections } from './connections/server-connections';
import { createServerHostSettings } from './connections/server-host-settings';
import { localizeServerNotice } from './connections/server-notice-text';
import { createServerWindows, openEnvSshTarget } from './connections/server-window-record';
import { readDesktopModelBootstrapSnapshot } from './model-bootstrap';
import { AgentAwakeService } from './agent-awake';
import { createBackgroundWindow } from './background-window';
import { createDesktopTray, type DesktopTray } from './desktop-tray';
import { createDesktopQuitSequence, stopCoreForQuit } from './quit-sequence';
import { loginShellOverrides, readLoginShellEnvironment, withHomebrewPath } from './login-shell-environment';
import { createTurnAttention, type TurnAttention } from './turn-attention';
import type { InitializeResponse, WindowFocusEntry } from '../../../../packages/protocol/src/index.ts';
import { screenSessionIds } from './screen-sessions';
import { setForegroundLeaseLibrary } from './computer/backend/foreground-lock-host';
import { micaLibraryPath } from './window-mica';
import { onProtocolAttached, publishScreenSessions } from './protocol/screen-sessions-publish';
import { adoptProfileIfBehind } from './protocol/profile-adopt';
import { desktopIdentity } from './desktop-identity';
import { notificationSoundPath, playWindowsNotificationSound, scaledNotificationSound } from './notification-sound';
import {
  activateDesktopWindow,
  createPrimaryWindowActivation,
  openDesktopNotificationSession,
  retainNotification,
} from './notification-window';
import { createDesktopPet, type DesktopPet, type PetWindow } from './desktop-pet-window';
import { hostDeviceName } from './session-device';
import { endBrowserApprovalSession, setBrowserApprovalHooks } from './browser/approval-dialog';
import { approvalSurfaceSessionId, createApprovalRequesterResolver } from './browser/approval-requester';
import { createTranscriptTap } from './host/browser-engine/transcript';
import { createBrowserApprovalGrants } from './browser/approval-grants';
import { boundedNotification } from './connections/server-notifier';
import type { RemoteHostWindows } from './remote-host-windows';
import { attachWindowIdleReclaim, purgeRendererMemory, type IdleReclaim } from './idle-reclaim';
import { watchCrashHandler } from './crash-handler-watch';
import { setPageFaultDiagnosticSink } from './browser/page-fault-diagnostics';
import { browserPageWindow } from './browser/page-window';
import { createDesktopDiagnostics, type DesktopDiagnostics } from './desktop-diagnostics';
import { sampleProcessMemory, shellRendererWorkingSet, tagRendererSurface } from './process-memory-diagnostics';
import { scheduleDeferredDesktopServices as scheduleAfterServiceQuiet } from './deferred-desktop-services';
import { installViewportGuard } from './viewport-guard';
import { computerUseOperates, createUserInputReporter, type UserInputReporter } from './user-input-report';
import { agentInputInFlight } from './browser/agent-input';
import { electronWindowForNativeId } from './computer/observation/window-handles';
import {
  gpuFallbackDecision,
  readActiveGpuFallbackMarker,
  writeGpuFallbackMarker,
  type GpuFallbackEnvironment,
} from './gpu-recovery';
import { registerDesktopIpc } from './ipc';
import { HOST_CAPABILITIES } from './host/connection';
import { notifyHostListsChanged } from './host-lists-changed';
import { watchHostListsFeed } from './remote-hosts';
import { createProtocolConnection } from './protocol/connection';
import { readOrCreateHostId, createLocalHostRole } from './protocol/desktop-host-wiring';
import { showRemoteScreenIndicator } from './remote-screen/screen-indicator';
import { openCore } from './protocol/open-core';
import type { WsEndpoint } from './protocol/ws-connector';
import {
  type CoreProcess,
  coreBinaryPath,
  coreEnvironment,
  coreExit,
  coreLaunchPath,
  desktopConfirmationWriter,
  forceEndCore,
  readCoreState,
  requestCoreStop,
  resolveLocalCore,
} from './protocol/local-core';
import { watchCore } from '../../../../packages/protocol-client/src/launch/ensure-core.mjs';
import { createOpenRequestedHandler } from './protocol/open-requested';
import { createVisualizePublisher } from './protocol/visualize-publish';
import type { VisualizeHostEvent } from '../shared/visualize';
import { createBootTimeline } from './boot-timeline';
import { reportDefaultsSeparation } from './protocol/defaults-separation';
import { ensurePrivateRuntimeRoot, resolveRuntimeRoot } from '../shared/core-src/runtime/shared/runtime-root.mjs';
import { createBrowserHost } from './browser/host';
import { BROWSER_PARTITION, type BrowserHost } from './browser/host-types';
import { claimResources } from './host/claim-resources';
import { browserUrlPolicyFromEnvironment } from './browser/host-policy';
import { createBrowserLoginPopup } from './browser/login-popup';
import { loginTakeoverOf } from './browser/login-takeover';
import { createComputerHost, type ComputerHost } from './computer';
import { readDisplays } from './computer/host/display-reads';
import { assertPublicComputerRequest } from './computer/host/request-policy';
import type { ComputerCommand } from './computer/shared/types';
import { bridgeDiscoveryDirectory } from './bridge/discovery-file';
import { createBridgeServer as createComputerBridge } from './computer/bridge/bridge-server';
import { bindSavedLoginOwner } from './computer/host/saved-login-owner';
import { defaultBrowserPermissionPolicy } from '../shared/browser-permission-policy';
import { VisualizeBridgeServer } from './visualize/bridge-server';
import { createDesktopVisualize } from './visualize/host';
import { coreLocalPages, createCoreLocalPages, setCoreLocalPages } from './core-local-pages';
import { BootReports } from './core-port/boot-progress';
import { watchRecovery } from './core-port/failure-recovery';
import { CorePortRelay } from './core-port/relay';
import { windowIdFor } from './core-port/window-ids';
import { createLinkLog } from '../../../../packages/protocol-client/src/link-log.mjs';
import { readComputerPermissions, requestComputerPermissions } from './computer/host/permission-reads';
import { createComputerUseOverlay, type ComputerUseOverlay } from './computer/overlay';
import { confirmComputerTurnsStopped } from './computer/overlay/stop-turns';
import { createComputerPillControls, createCoreUserControl } from './host/computer-user-control';
import { createComputerSwitch } from './host/computer-scope';
import { MEDIA_SCHEME, registerMediaProtocol, registerMediaScheme } from './media-protocol';
import { desktopPermissionAllowed } from './permission-policy';
import { installNativeMenu } from './menu';
import { installDefaultContextMenu } from './context-menu';
import { nativeT, refreshNativeUiLanguage } from './native-i18n';
import { readHostWindowDisplayPreferences } from './host-display-preferences';
import { DesktopSettingsStore, desktopSettingsPort } from './settings-store';
import { desktopUpdater, startAutoUpdater } from './updater';
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
import {
  createElectronScreenDisplays,
  createElectronScreenInputHost,
  createPillScreenIndicator,
} from './remote-screen/screen-electron';
import { createSecureDesktopAdapter } from './remote-screen/secure-desktop-adapter';
import { createSecureDesktopHelper } from './remote-screen/secure-desktop-helper';
import { createSecureDesktopClient, secureDesktopInstallerFor, type SecureDesktopInstaller } from './secure-desktop';
import { createPcAccess, pendingRevokesFile, type PcAccess } from './pc-access';
import { createAccountAdminCheck } from './secure-desktop/account-admin';
import type { RemoteControllerKeyRecord, RemoteControllerKeysOwed } from '../shared/remote-controller-key';
import { fileSnapshots } from './file-snapshot';
import { clampBoundsToWorkArea, persistWindowState, readWindowState } from './window-state';
import {
  normalizeTranscriptReadDiagnostic,
  setTranscriptReadDiagnosticSink,
} from '../shared/transcript-read-diagnostics';
import {
  normalizeRendererComposerActionDiagnostic,
  normalizeRendererDiagnostic,
  normalizeRendererFollowReleaseDiagnostic,
  normalizeRendererFollowRearmDiagnostic,
  normalizeRendererLongTaskDiagnostic,
  normalizeRendererWhatsNewDiagnostic,
  normalizeRendererCoreLinkDiagnostic,
  rendererRecoveryDecision,
} from './renderer-recovery';
import { acknowledgeAnnouncement, LAUNCH_VERSION_FILE, recordLaunchVersion } from './launch-version';
import { installWhatsNewAcknowledge } from './whats-new-acknowledge';
import { createLocalStorageRescue, type LocalStorageRescue } from './local-storage-rescue';
import { createRendererCache, type RendererCaches } from './ipc-renderer-cache';
import { createPaneLayoutFile, flushPaneLayoutFiles, PANE_LAYOUT_FILE } from './pane-layout-file';
import { RENDERER_CACHE_NAMES } from '../shared/renderer-cache';
import { displayExitCode } from './desktop-service-client';
import { installSyncSpawnDiagnostics } from './sync-spawn-diagnostics';
import { errorDiagnosticFields } from './diagnostic-error';

const desktopProcessStartedAt = Date.now();
// A closed launcher stdio pipe makes every later console write raise EPIPE, and an unhandled stream error becomes
// Electron's fatal main-process dialog.
for (const stream of [process.stdout, process.stderr]) {
  stream?.on?.('error', () => {
    /* dead stdio pipe: logging is best-effort */
  });
}
// V8 compile cache for the main process's dynamic imports (remote access,
// dialogs) and the daemon service adapter. Best-effort no-op when the
// running Node lacks the API.
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
// Start checks (app-start.electron.test.mjs) run the whole app with its window held off every display: the boot, the
// renderer handshake and the core connection happen as usual, only the show step is skipped.
const desktopWindowHeldHidden = process.env.MIXDOG_DESKTOP_HIDDEN_WINDOW === '1';
let launchFollowsUpdate: Promise<boolean> | null = null;
const launchVersionPath = () => join(app.getPath('userData'), LAUNCH_VERSION_FILE);
const launchRecordWriteFailure = (error: unknown) =>
  diagnostics?.write('launch-version-write-failed', {
    ...errorDiagnosticFields(error),
  });
/** Reports a profile file's read or write failure under `event`. */
const profileFileFailure =
  (event: string, details: Record<string, string> = {}) =>
  (stage: 'read' | 'write', error: unknown) =>
    diagnostics?.write(event, {
      ...details,
      stage,
      ...errorDiagnosticFields(error),
    });

// Unpackaged Electron derives userData from the package name (@mixdog/desktop); pin it to the packaged app's profile.
const PACKAGED_USER_DATA_DIRECTORY = 'mixdog-desktop';
if (process.env.MIXDOG_DESKTOP_USER_DATA) {
  app.setPath('userData', resolve(process.env.MIXDOG_DESKTOP_USER_DATA));
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
let quitCause: string | null = null;
function noteQuitCause(cause: string): void {
  quitCause ??= cause;
}
// With no window to close, a start check ends the app by creating this file in its profile.
if (desktopWindowHeldHidden) {
  const quitRequest = join(desktopUserData, 'quit-request');
  setInterval(() => {
    if (!existsSync(quitRequest)) return;
    noteQuitCause('quit-request-file');
    app.quit();
  }, 250);
}
app.setName(desktopBrand.name);
app.setPath('userData', desktopUserData);

// Decided before anything touches the core: a second launch does nothing to it and exits without the quit sequence.
const holdsSingleInstanceLock = app.requestSingleInstanceLock();
if (!holdsSingleInstanceLock) {
  // The dev shell now shares the installed app's profile, so a running
  // Mixdog holds the lock. Say so instead of exiting silently.
  if (!app.isPackaged) {
    console.error(
      'Mixdog desktop: another instance already owns the shared user profile. ' +
        'Close the running app, or set MIXDOG_DESKTOP_USER_DATA to run an isolated profile.'
    );
  }
  app.exit(0);
}

let crashReporterStatus = process.platform === 'win32' ? 'start-failed' : 'not-required';
let crashReporterErrorName = '';
if (holdsSingleInstanceLock && process.platform === 'win32') {
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
// A second crashReporter.start() is a silent no-op and children inherit CHROME_CRASHPAD_PIPE_NAME, so after the Crashpad
// handler dies the watcher drops the dead pipe and later children fall back to Windows' own handler.
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

const executableSuffix = process.platform === 'win32' ? '.exe' : '';
/** The kinds of native tool a bundled copy serves in this build: the core removes the copies an earlier version cached in the profile. */
const bundledNativeToolKinds: string[] = [];
if (app.isPackaged) {
  const nativeToolsDir = join(process.resourcesPath, 'native-tools');
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
  for (const { kind, names, path } of nativeOverrides) {
    if (!existsSync(path)) continue;
    for (const name of names) {
      if (!process.env[name]) process.env[name] = path;
    }
    if (names.every((name) => process.env[name] === path)) bundledNativeToolKinds.push(kind);
  }
}

if (!process.env.MIXDOG_COMPUTER_BIN) {
  const computerHelperName = `mixdog-computer${executableSuffix}`;
  const computerBackend = app.isPackaged
    ? join(process.resourcesPath, 'native-tools', computerHelperName)
    : join(app.getAppPath(), '..', '..', 'native', 'mixdog-computer', 'target', 'release', computerHelperName);
  if (existsSync(computerBackend)) process.env.MIXDOG_COMPUTER_BIN = computerBackend;
}
// The foreground-lease owner (mixdog_window.node, the same module as Mica) is loaded from here before the first lease
// ask (host/computer-lease.ts, computer/host/powershell-host.ts). Windows only.
if (process.platform === 'win32') {
  setForegroundLeaseLibrary(
    micaLibraryPath({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() })
  );
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

// Chromium's native occlusion tracking can leave a restored Windows window occluded: document.hidden stays true and
// requestAnimationFrame never fires.
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
}

const configuredRendererHeapMb = Number(process.env.MIXDOG_RENDERER_HEAP_MB);
const rendererHeapMb =
  Number.isFinite(configuredRendererHeapMb) && configuredRendererHeapMb >= 0 ? Math.floor(configuredRendererHeapMb) : 0;
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

if (process.env.MIXDOG_DESKTOP_PERF === '1') installSyncSpawnDiagnostics(() => app.getPath('userData'));

let diagnostics: DesktopDiagnostics | null = null;
// An uncaught exception is recorded and the app keeps running. With no listener Electron shows a modal error box that
// stops the main event loop until it is dismissed: the core's ping deadline passes and this window loses its host.
process.on('uncaughtException', (error) => {
  console.error('Mixdog desktop uncaught exception:', error);
  diagnostics?.write('uncaught-exception', { name: error.name, message: error.message, stack: error.stack });
});
const bootTimeline = createBootTimeline();
const writeBootDiagnostic = bootTimeline.write;
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
/** Where each connection's core listens (the same resolver its own link dials with), by connection id: a window's
 *  direct port to its core (core-port/relay.ts) opens with it. */
const coreEndpoints = new Map<string, () => Promise<WsEndpoint>>();
/** How far this PC's core has come in rebuilding its conversation index at start: the windows waiting for their core port are told. */
const bootReports = new BootReports();
// While a failure is confirmed nothing launches the core, so a core that comes up some other way is noticed here and the parked windows attach.
watchRecovery({
  reports: bootReports,
  runtimeRoot: resolveRuntimeRoot(),
  readState: () => readCoreState(resolveRuntimeRoot()),
  ensureRoot: () => void ensurePrivateRuntimeRoot(resolveRuntimeRoot()),
  log: writeBootDiagnostic,
  watch: (directory, onChange, onEnd) => {
    const watcher = watchDirectory(directory, { persistent: false }, () => onChange());
    watcher.on('error', onEnd);
    watcher.on('close', onEnd);
    return watcher;
  },
});
/** The last initialize reply each connection's core gave main (window scope, limits). */
const coreInitialized = new Map<string, InitializeResponse>();
const connectionDependencies: DesktopConnectionDependencies = {
  // This PC's core reads the discovery file; a server's core is reached through its SSH tunnel. Both use the
  // header token and re-resolve on every dial.
  createProtocol: (connection) => {
    const linkLog = createLinkLog(writeBootDiagnostic, {
      link: 'main',
      owner: connection.kind === 'local' ? 'local' : 'ssh',
      ownerKey: connectionStorageKey(connection),
    });
    const resolve =
      connection.kind === 'local'
        ? resolveLocalCore({
            runtimeRoot: resolveRuntimeRoot(),
            bin: () => coreLaunchPath(app.isPackaged, process.resourcesPath),
            env: () => coreEnvironment(app.isPackaged, process.resourcesPath, app.getPath('userData')),
            environmentReady: () => loginShellEnvironmentReady,
            reports: bootReports,
            desktopConfirmationPipe: true,
            onLaunched: (child) => {
              localCoreProcess = child;
              localCoreConfirmation = desktopConfirmationWriter(child);
              // A core of this app that stops answering is ended, and the next dial starts a replacement.
              coreWatcher ??= watchCore({
                readDiscovery: () => readCoreState(resolveRuntimeRoot()),
                ownedPid: () => localCoreProcess?.pid ?? null,
                log: (line: string) => console.error(line),
                // The one automatic kill of a core: why, in the diagnostics log beside the link lines.
                onEnding: (ending: Record<string, unknown>) => linkLog('core-ended-by-watch', ending),
              });
            },
          })
        : async () => {
            const record = serverWindows.get(connection.id);
            if (!record) throw new Error(`The server window "${connection.id}" is not open.`);
            return record.endpoint();
          };
    if (connection.kind === 'local') coreEndpoints.set(connection.id, resolve);
    // Only this PC's core separates this PC's defaults; Node recorded it for the local profile alone.
    const reportsDefaults = connection.kind === 'local';
    // Socket and link life-cycle lines of this connection's own (main-process) link to its core.
    return createProtocolConnection({
      log: linkLog,
      open: openCore({
        log: linkLog,
        resolve,
        version: app.getVersion(),
        capabilities: { approvalsInbox: true, host: HOST_CAPABILITIES },
        onInitialized: (reply) => {
          coreInitialized.set(connection.id, reply);
          if (reportsDefaults) reportDefaultsSeparation(reply, bootTimeline.defaultsSeparationFailed);
        },
      }),
    });
  },
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
  appVersion: app.getVersion(),
  operationHost: () => ({
    pcNotificationsSupported: () => Promise.resolve(Notification.isSupported()),
    readDisplayPreferences: () => readHostWindowDisplayPreferences(mainWindow, app.getLocale()),
  }),
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
    if (connection.kind !== 'local') return;
    if (generation <= 1) {
      firstLocalAttachment.resolve();
      return;
    }
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
// Every window's renderer talks to its core directly: main opens the socket (headers, no Origin) and hands the window a
// MessagePort over it. A server window gets its server's core (`primary`) and this PC's (`pc`), both under its role.
const corePortRelay = new CorePortRelay({
  diagnostic: writeBootDiagnostic,
  bootReports,
  endpointFor: async (webContentsId, slot) => {
    const connectionId = windowRoutes.connectionIdFor(webContentsId);
    if (connectionId === undefined) {
      throw new ConnectionError('connection-route-missing', 'This window is not attached to a Mixdog connection.');
    }
    const endpoint = await serverWindows.endpointFor(connectionId, slot);
    return endpoint ? [endpoint] : [];
  },
  coreWindowScope: async () => {
    const scope = coreInitialized.get(LOCAL_CONNECTION_ID)?.capabilities?.windowScope;
    return typeof scope === 'number' && scope > 0 ? scope : null;
  },
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
// File pages (project pages, granted files) and their owner revocations are served by the core page server; every
// window's local page IPC and the visualize html panes ask it through this client.
setCoreLocalPages(
  createCoreLocalPages(
    <T>(name: string, args: unknown[]) => localService.invokeDesktopOperation(name, args) as Promise<T>,
    // Large page files go to this PC's core as blobs (`blob/put`) on its own connection.
    localConnection.protocol
  )
);
// MIXDOG_SSH_TARGET (development and tests): the main window stays on this PC
// and a server window for that target opens beside it at startup.
const envSshTarget = process.env.MIXDOG_SSH_TARGET?.trim() ? process.env.MIXDOG_SSH_TARGET : null;
const connectionWindows = new Map<string, BrowserWindow>();
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
      hostRole.claimNow();
      refreshCorePageOrigin();
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
const settingsStore = new DesktopSettingsStore(desktopSettingsPort(localConnection));
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
// Sites may ask to connect a HID device (default off), read per request.
let browserHidDevices = false;
// Site permission defaults and exceptions of the built-in browser, read per request.
let browserPermissionPolicy = defaultBrowserPermissionPolicy();
let computerHost: ComputerHost | null = null;
let computerUseOverlay: ComputerUseOverlay | null = null;
let computerControlEnabled = false;
// What every core connection's automation scopes follow: off revokes them at once (host/computer-scope.ts).
const computerSwitch = createComputerSwitch(false);
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
// Agent `visualize` tool: shows produced artifacts in the session's side
// panel. Default-on built-in; the runtime gates the tool by its toggle, and
// the bridge runs for the app's lifetime.
let browserFeatureInstalled = false;
let hostRoleReady = false;
/** One diagnostics record for every failed visualize publish: change events and the claim-time snapshot. */
const reportVisualizePublishFailure = (target: 'host', error: unknown): void =>
  diagnostics?.write('visualize-publish-failed', {
    target,
    ...errorDiagnosticFields(error),
  });
const visualize = createDesktopVisualize({
  window: () => mainWindow,
  invokeDesktopOperation: (method, args) => localService.invokeDesktopOperation(method, args),
  browserAvailable: () => browserFeatureInstalled,
  watchBrowserTab: (sessionId, requestId) => browserHost?.watchNewTab(sessionId, requestId),
  // Paired remote clients: the core mirrors the tabs (`host/state/set{key:'visualize'}`, section `hostState`) and serves pane
  // bytes. The host role's publication queue is the only path: it slims and orders every publication; the host role
  // is built later.
  publishRemote: createVisualizePublisher<VisualizeHostEvent>({
    host: () => (hostRoleReady ? hostRole.host.publishVisualize : undefined),
    onFailure: reportVisualizePublishFailure,
  }),
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
// File and visualize pages come from the core page server: its origin is read once the core is up and again after each
// reconnect (a restarted core listens on a new port), which also sends the page revokes a lost link left queued.
function refreshCorePageOrigin(): void {
  void coreLocalPages()
    .refresh()
    .catch((error: unknown) => console.error('core page server origin read failed:', error));
}
// Keep-awake spans the app lifetime, not one window: agents keep working
// while the window is closed on macOS and through renderer reloads.
const awakeService = new AgentAwakeService(powerSaveBlocker);
let turnAttention: TurnAttention | null = null;
let unsubscribeAwake: (() => void) | null = null;
let unsubscribeServiceSettings: (() => void) | null = null;
let unsubscribeTakeovers: (() => void) | null = null;
let unsubscribeUpdaterRelay: (() => void) | null = null;
let unsubscribeCoreObservers: (() => void) | null = null;
const pcNotificationView = createPcNotificationView({ snapshot: () => localProtocol.snapshot() });
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
  // These Electron dialogs are not core requests. Paired phones get only their waiting session ids.
  onPendingSessions: (sessionIds) => hostRole.host.reports.browserApprovalSessions(sessionIds),
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
let unsubscribeSessionSources: (() => void) | null = null;
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
  browserHidDevices = settings.browserHidDevices === true;
  browserPermissionPolicy = settings.browserPermissions;
};
// Computer use is opt-in and high risk, so the bridge (and thus the agent
// `computer` tool) exists only while the setting is on. Toggling it starts or
// tears down the host live.
function applyComputerControlSetting(enabled: boolean): void {
  // macOS withholds input and the accessibility tree until Accessibility is granted, and other windows' pixels until Screen
  // Recording is; ask only when Computer Use is turned on, not on every settings re-apply.
  if (enabled && !computerControlEnabled && computerControlApplied) requestComputerPermissions();
  computerControlApplied = true;
  computerControlEnabled = enabled;
  // First, so that no host/computer/* effect commits once the setting went off, whatever the bridge's stop is still doing.
  computerSwitch.set(enabled);
  applyComputerBridge();
  // GNOME window control comes from Mixdog's own shell extension: the core keeps it in place and enabled exactly while
  // Computer Use is on (s3-15).
  computerHost?.setBridgeEnabled(computerControlEnabled);
}
let computerBridge: ReturnType<typeof createComputerBridge> | null = null;
function applyComputerBridge(): void {
  if (!computerBridge) return;
  if (computerControlEnabled) computerBridge.startBridge();
  else
    void computerBridge
      .stopBridge()
      .catch((error: unknown) => diagnostics?.write('computer-bridge-stop-failed', { error: String(error) }));
}
// Observation only: the bridge keeps serving reads while every input action is
// refused by the host, so a running agent turn is narrowed the moment it flips.
function applyComputerObserveOnlySetting(enabled: boolean): void {
  computerObserveOnly = enabled;
  computerHost?.setObserveOnly(computerObserveOnly);
}
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
const onTakeoverState = createTakeoverStateHandler({
  gate: takeoverGate,
  login: browserLogin,
  loginOf: loginTakeoverOf,
  browser: () => browserHost,
  capture: (sessionId, id, tab) => captureTakeoverOrDecline(takeoverCapture, sessionId, id, tab),
});
unsubscribeTakeovers = localService.subscribeSessionStates(onTakeoverState);
unsubscribeServiceSettings = localService.subscribeDesktopEvents(({ name, value }) => {
  if (name === 'session-runtime-released') {
    const event = value as { sessionId?: unknown; restore?: unknown } | null;
    if (isSessionId(event?.sessionId)) {
      browserHost?.releaseSession(event.sessionId, { restore: event.restore === true });
      // A session's secrets are redacted for its lifetime, then forgotten.
      if (event.restore !== true) secretInputs.forget(event.sessionId);
      // What it was allowed "for this session" ends with it (a restorable release keeps the session).
      if (event.restore !== true) endBrowserApprovalSession(event.sessionId);
    }
    return;
  }
  // The window-process requests Node's service sent as the browser-remote-request event (updater, display preferences,
  // visualize, file snapshot, local page, notification status, browser methods) are the core's host/* requests now,
  // served by the host role (host/); trashItem is the core's projectFs/trash, provideSecretInput its approval/provideSecret.
  if (name === 'desktop-settings-changed' && value && typeof value === 'object') {
    applyDesktopSettings(value as DesktopSettings);
  }
  // A paired phone's delivered key and owed access revocations are the core's PcAccessService's (it enrolls on
  // delivery and revokes owed keys).
});
// This PC's host role on its protocol connection: the in-app browser, OS toasts, the system proxy, power and
// updater reports (DS §12). The computer pill follows the core's `computer` section.
const localProtocol = localConnection.protocol;
if (!localProtocol) throw new Error("This PC's connection has no protocol link.");
// The loopback computer bridge (other tools on this PC reach Computer Use through it): every command goes to the core's
// computer/bridge/run, a dropped caller or a stop to computer/bridge/abort, so the bridge and the agent tool share the
// core's helper pool, foreground lane and user-control hold. It listens only while Computer Use is on.
computerBridge = createComputerBridge({
  dataDirectory: bridgeDiscoveryDirectory,
  isBridgeWanted: () => computerControlEnabled,
  isDisposed: () => quitApproved || quitAfterDispose,
  diagnose: (event, data) => diagnostics?.write(event, data),
  callCore: (method, params) => localProtocol.call(method, params),
  attachOwner: async (ownerId, pid) =>
    computerHost && computerControlEnabled ? bindSavedLoginOwner(computerHost.readProcessFate, ownerId, pid) : null,
});
applyComputerBridge();
onProtocolAttached(localProtocol, refreshCorePageOrigin);
if (holdsSingleInstanceLock && bundledNativeToolKinds.length > 0) {
  void localProtocol
    .call('desktop/nativeToolCache/gc', { bundledKinds: bundledNativeToolKinds })
    .then((result) => {
      for (const { kind, error } of (result as { failed: Array<{ kind: string; error: string }> }).failed) {
        console.warn(`Could not remove superseded ${kind} runtime cache:`, error);
      }
    })
    .catch((error: unknown) => console.warn('Could not remove the superseded runtime caches:', error));
}
// This PC's core adopts the Electron profile's moved files once (local core only: a server's core is not this PC's profile).
onProtocolAttached(localProtocol, () => {
  void adoptProfileIfBehind(localProtocol, app.getPath('userData'));
});
const hostRole = createLocalHostRole({
  showScreenIndicator: showRemoteScreenIndicator,
  // Where this desktop keeps what the core launches for ssh (server cores, the askpass helper): sent with host/claim.
  resources: claimResources(app.isPackaged, process.resourcesPath, existsSync),
  protocol: localProtocol,
  hostId: readOrCreateHostId(desktopUserData),
  browser: () => {
    if (!browserHost) throw new Error('The in-app browser is not open.');
    return browserHost.hostRole();
  },
  // The engine lane's record of every host/browser/* call, for the golden replay: a development build only, into the folder
  // MIXDOG_BROWSER_TRANSCRIPT names (a diagnostics location, not a choice of implementation).
  browserEngineTranscript: createTranscriptTap({
    dir: process.env.MIXDOG_BROWSER_TRANSCRIPT,
    devBuild: !app.isPackaged,
  }),
  visualize: () => ({
    execute: (command) => visualize.execute(command),
    exportForDevice: (command) => visualize.exportForDevice(command),
    snapshot: () => visualize.hostSnapshot(),
  }),
  onVisualizePublishFailed: (error) => reportVisualizePublishFailure('host', error),
  onBrowserViewFailed: (error) =>
    diagnostics?.write('browser-view-frames-failed', {
      ...errorDiagnosticFields(error),
    }),
  onUpdaterInstallFailed: (error) =>
    diagnostics?.write('updater-install-failed', {
      ...errorDiagnosticFields(error),
    }),
  files: () => ({
    captureFileSnapshot: (root, rel, grant) => fileSnapshots.capture(root, rel, grant),
    trashItem: (path) => shell.trashItem(path),
  }),
  resolveProxy: (url) => session.defaultSession.resolveProxy(url),
  // Every host/computer/* handler (host/register-s3.ts). The arrow of `host/computer/appInput` into the desktop's own windows is
  // drawn through the presence mirror; lock screen, suspend and display changes take the desktop from a core computer
  // execution (computer/userControl takeover) while the core drives the computer, bound once the app is ready.
  computer: {
    permissions: { read: readComputerPermissions, request: requestComputerPermissions },
    // Upload chunks follow this PC's core limit (its initialize answer); the default chunk before the first answer.
    pixels: { blobChunkBytes: () => coreInitialized.get(LOCAL_CONNECTION_ID)?.limits?.maxBlobPutChunkBytes },
    environment: {
      ready: app.whenReady(),
      sources: () => ({ power: powerMonitor, screen }),
      onError: (error) => console.warn('[mixdog-computer] environment takeover report failed:', error),
    },
    desktopHostScreen: () => {
      const host = computerControlEnabled ? computerHost : null;
      if (!host) return null;
      return {
        assertPublic: assertPublicComputerRequest,
        answer: (command, signal) => host.answerBridgeCommand(command as ComputerCommand, signal),
        displays: readDisplays,
      };
    },
    desktopHostCommand: () => {
      const host = computerControlEnabled ? computerHost : null;
      if (!host) return null;
      return {
        assertPublic: assertPublicComputerRequest,
        answerBridgeCommand: (command, signal) => host.answerBridgeCommand(command as ComputerCommand, signal),
      };
    },
    desktopHostProcessFate: () => (computerControlEnabled ? computerHost : null),
    computerSwitch,
  },
  notifications: {
    // A server's fixed words arrive in English (its core has no UI language): shown in this PC's.
    createNotification: (content) =>
      new Notification({
        ...localizeServerNotice(content, nativeT),
        ...(process.platform === 'win32' ? {} : { icon: trayIconPath() ?? undefined }),
        silent: process.platform === 'win32',
      }),
    ...(process.platform === 'win32' ? { playSound: () => playNotificationSound() } : {}),
    // A click opens the session the toast names; a session the pet overlay shows has no toast.
    activate: (threadId) => primaryActivation.activate(threadId),
    showsThread: (threadId) => desktopPet?.showsSession(threadId) ?? false,
    diagnostic: (event, details) => diagnostics?.write(event, details),
    translate: (key) => nativeT(key),
    isSupported: () => Notification.isSupported(),
    idleSeconds: () => powerMonitor.getSystemIdleTime(),
    // A click on a server's notification brings that server's window forward (on the thread it names).
    focusConnection: (connectionId, threadId) => focusConnectionWindow(connectionId, threadId),
  },
  windows: {
    // The core asks for a saved server's window (it has connected the server already): a record is made from the params and its window opens.
    open: async (params) => {
      const existing = connectionWindows.get(params.connectionId);
      const opened = await serverWindows.open(params);
      const current = connectionWindows.get(params.connectionId);
      if (!opened || !current || current.isDestroyed()) return { opened: false };
      if (params.windowToken) serverWindowTokens.set(current, params.windowToken);
      else serverWindowTokens.delete(current);
      return { opened: true, created: current !== existing };
    },
    close: (connectionId) => {
      const window = connectionWindows.get(connectionId);
      if (window && !window.isDestroyed()) {
        closingByCore.add(window);
        // Acknowledge only after this window can no longer be focused by the next open.
        window.destroy();
      }
    },
    focus: (connectionId, sessionId) => focusConnectionWindow(connectionId, sessionId),
  },
  updater: {
    check: () => desktopUpdater.check(),
    getState: () => desktopUpdater.getState(),
    confirmBusy: () => desktopUpdater.confirmBusy(),
    install: (confirmed) => desktopUpdater.install(confirmed),
  },
  onClaimFailed: (error) => {
    // A client-library failure's message is a sentence in the UI language: its kind is the field the log is read by.
    const kind = (error as { detail?: { kind?: unknown } } | null)?.detail?.kind;
    diagnostics?.write('host-claim-failed', {
      message: error instanceof Error ? error.message : String(error),
      ...(typeof kind === 'string' ? { kind } : {}),
    });
  },
  onHostFault: (where, error) =>
    diagnostics?.write('host-handler-failed', {
      where,
      ...errorDiagnosticFields(error),
    }),
});
hostRoleReady = true;
/** Shows a connection's window (`local` is the main window), on `sessionId` when one is named. */
function focusConnectionWindow(connectionId: string, sessionId: string | undefined): void {
  const window = connectionWindows.get(connectionId);
  if (!window || window.isDestroyed()) {
    const connection = connectionId === LOCAL_CONNECTION_ID ? localConnection : connectionPool.get(connectionId);
    if (!connection) return;
    void showConnectionWindow(connection)
      .then(() => {
        const shown = connectionWindows.get(connectionId);
        if (sessionId && shown && !shown.isDestroyed()) openDesktopNotificationSession(shown, sessionId);
      })
      .catch(() => {});
    return;
  }
  if (!sessionId || !openDesktopNotificationSession(window, sessionId)) activateDesktopWindow(window);
}
/** Every window's state for the core's server notifier (`host/state/set` windowFocus, a method every core serves). */
function publishWindowFocus(): void {
  const windowHost = hostRole.host.windowHost;
  if (!windowHost) return;
  const windows: WindowFocusEntry[] = [];
  for (const [connectionId, window] of connectionWindows) {
    if (window.isDestroyed()) continue;
    const sessionIds = screenSessionIds(window);
    windows.push({
      connectionId,
      visible: window.isVisible() && !window.isMinimized(),
      focused: window.isFocused(),
      sessionIds,
    });
  }
  windowHost.publishFocus(windows);
}
// Each host connection starts with nothing reported: the current windows once now and again whenever the link comes up.
publishWindowFocus();
localProtocol.onEvent((event) => {
  if (event.type === 'status' && (event as { status: { state: string } }).status.state === 'ready')
    publishWindowFocus();
});
// A window's painted sessions changed (the per-window listener of ipc.ts stores them first).
ipcMain.on(DESKTOP_IPC.reportScreenSessions, () => setImmediate(publishWindowFocus));
// Paired browsers that have not chosen a theme or language follow this PC's window: its preferences are the core's
// `hostState.displayPreferences`, sent whenever the link comes up and, by the operation lane, whenever a desktop
// setting change is announced.
localProtocol.onEvent((event) => {
  if (event.type !== 'status' || (event as { status: { state: string } }).status.state !== 'ready') return;
  void readHostWindowDisplayPreferences(mainWindow, app.getLocale())
    .then((value) => localProtocol.call('host/state/set', { key: 'displayPreferences', value }))
    .catch((error: unknown) =>
      diagnostics?.write('display-preferences-publish-failed', {
        message: error instanceof Error ? error.message : String(error),
      })
    );
});
// A deleted session lets go of its in-app browser pages. The window deletes over its own core link now, so main learns of
// it from the core's `thread/deleted` (what the old deleteSession IPC handler did after the delete).
localProtocol.onEvent((event) => {
  if (event.type !== 'notification') return;
  const { method, params } = (event as { notification: { method: string; params?: unknown } }).notification;
  if (method !== 'thread/deleted') return;
  const threadId = (params as { threadId?: unknown } | undefined)?.threadId;
  if (typeof threadId !== 'string' || !threadId) return;
  browserHost?.releaseSession(threadId);
  // No row edge follows a deleted session: a turn of it that visualize still holds ends here.
  void visualize.setTurnActive(threadId, false);
});
// Visualize holds the panel for each Lead turn: a row's own edge says when a turn starts and ends (the roster below
// coalesces turns that follow one another).
localProtocol.onEvent((event) => {
  if (event.type !== 'notification') return;
  const { method, params } = (event as { notification: { method: string; params?: unknown } }).notification;
  if (method !== 'thread/started' && method !== 'thread/summary/updated') return;
  void visualize.observeTurnEdge(
    (params as { thread?: { id?: unknown; leadWorking?: unknown } } | undefined)?.thread ?? {}
  );
});
// The core owns a takeover card as a server request: it starts the takeover here, and its resolution - an answer, or the
// card's own 15-minute expiry - ends it and the page it handed over.
localProtocol.onEvent(createTakeoverFeed((update) => onTakeoverState(update)));
localProtocol.onEvent(
  createOpenRequestedHandler({
    // Not delivered here: this process's browser host handed the request to its window directly before it reported it
    // (`host/browser/surface`); the core's `ui/openRequested` is for the other attached clients, paired phones.
    browser: () => {},
    // The window's own core link receives `ui/openRequested{kind: terminal}` itself (renderer core-direct/api-terminal.ts);
    terminal: () => {},
    visualize: (event) => visualize.openRequested(event),
    watchNewTab: (sessionId, requestId) => browserHost?.watchNewTab(sessionId, requestId),
    notify: (method, params) => localProtocol.notify(method, params),
  })
);
// A saved PC's presence is part of the core's pushed `remote` section: windows re-read their PC lists on it.
localProtocol.watchSection('remote', () => notifyHostListsChanged());
// Paired browsers show this machine's updater, so its state travels to the core.
unsubscribeUpdaterRelay = desktopUpdater.subscribe((state) => hostRole.host.reports.updateState(state));
// The core's settings changes main applies itself, and a deleted thread's browser session released.
unsubscribeCoreObservers = observeCoreForMain({
  connection: localProtocol,
  applyDesktopSettings,
  releaseBrowserSession: (sessionId) => browserHost?.releaseSession(sessionId),
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
  desktopTray = createDesktopTray({
    iconPath,
    open: activatePrimaryWindow,
    quit: () => {
      noteQuitCause('tray');
      app.quit();
    },
  });
}

let disposalPromise: Promise<void> | null = null;
const DESKTOP_DISPOSE_TIMEOUT_MS = 4_000;
/** The whole quit teardown's bound: the dispose (4 s), the core's stop request and exit wait (5 s), and margin. */
const DESKTOP_QUIT_TEARDOWN_TIMEOUT_MS = 15_000;
// Bounds persist per connection: each open window's writer, and the final
// flushes of the ones already closed.
const windowStates = new Map<BrowserWindow, ReturnType<typeof persistWindowState>>();
let windowStateFlush: Promise<void> = Promise.resolve();
let diagnosticsMemoryTimer: NodeJS.Timeout | null = null;
let idleReclaim: IdleReclaim | null = null;
let diagnosticsEventLoopTimer: NodeJS.Timeout | null = null;
let deferredServicesPromise: Promise<void> | null = null;
let deferredServicesScheduled = false;
// The first successful attachment to the local core, whenever it happens: a first connection that failed is opened again by
// the next call, and what waits for "the core is up" (deferred services, the updater) must still run after that attachment.
const firstLocalAttachment = (() => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
})();
let gpuCrashTimes: number[] = [];
let gpuFallbackScheduled = softwareRenderingThisLaunch;
let gpuFallbackPromptOpen = false;

function currentProcessMemory() {
  return sampleProcessMemory({
    getAppMetrics: () => app.getAppMetrics(),
    getAllWebContents: () => webContents.getAllWebContents(),
    browserPageWindow,
    ownerWindow: (contents) => BrowserWindow.fromWebContents(contents),
    connectionIdFor: (id) => windowRoutes.connectionIdFor(id),
    localConnectionId: LOCAL_CONNECTION_ID,
  });
}

/** Working set of the app's own shell renderers, for the idle-reclaim record. */
function rendererWorkingSetKb(): { workingSetKb: number; processes: number } {
  try {
    return shellRendererWorkingSet(currentProcessMemory());
  } catch {
    return { workingSetKb: 0, processes: 0 };
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
  // The relay starts at core boot from config (remote.enabled); the core is serving once the connection is open.
  deferredServicesPromise = localConnection.protocol
    .whenSynced()
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

/** The one secure-desktop installer (its single in-flight latch covers the
 *  phone's requests and PC access alike). */
let sharedSecureDesktopInstaller: SecureDesktopInstaller | null = null;
function secureDesktopInstaller(): SecureDesktopInstaller {
  sharedSecureDesktopInstaller ??= secureDesktopInstallerFor({
    isPackaged: app.isPackaged,
    platform: process.platform,
    resourcesPath: process.resourcesPath,
    cwd: process.cwd(),
    programData: process.env.ProgramData,
  });
  return sharedSecureDesktopInstaller;
}

/** Whether the Windows account running this app is an administrator. */
const accountIsAdmin = createAccountAdminCheck();

/** Windows "PC access" (main/pc-access.ts): the readiness row's install and
 *  enroll, the delegated enroll of a delivered key, and the revoke on unpair. */
let pcAccess: PcAccess | null = null;
function windowsPcAccess(): PcAccess | null {
  if (process.platform !== 'win32') return null;
  pcAccess ??= createPcAccess({
    installer: secureDesktopInstaller(),
    pending: pendingRevokesFile(join(app.getPath('userData'), 'pc-access-revokes.json')),
    keys: async () =>
      (await localService.invokeDesktopOperation('remoteAccessControllerKeys', [])) as RemoteControllerKeyRecord[],
    owed: async () =>
      (await localService.invokeDesktopOperation('remoteAccessOwedControllerKeys', [])) as RemoteControllerKeysOwed,
    settleOwed: async (keys, unknown) => {
      await localService.invokeDesktopOperation('remoteAccessSettleOwedControllerKeys', [keys, unknown]);
    },
  });
  return pcAccess;
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
    const { createRemoteHostWindows } = await import('./remote-host-windows');
    return createRemoteHostWindows(localProtocol, join(import.meta.dirname, '../preload/remote-window.js'), {
      showConnectionSettings: showLocalConnectionSettings,
    });
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
    awaitServiceReady: () => localConnection.start().catch(() => firstLocalAttachment.promise),
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
        async () => {
          const update = (await localProtocol.call('config/getUpdateSettings', {})) as { autoUpdate?: boolean } | null;
          return typeof update?.autoUpdate === 'boolean' ? update.autoUpdate : undefined;
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
  // Toasts this app still shows go with it.
  hostRole.host.closeNotifications();
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
  unsubscribeSessionSources?.();
  unsubscribeSessionSources = null;
  unsubscribeServiceSettings?.();
  unsubscribeServiceSettings = null;
  unsubscribeTakeovers?.();
  unsubscribeTakeovers = null;
  browserLogin.dispose();
  takeoverGate.dispose();
  unsubscribeUpdaterRelay?.();
  unsubscribeUpdaterRelay = null;
  unsubscribeCoreObservers?.();
  unsubscribeCoreObservers = null;
  awakeService.dispose();
  computerUseOverlay?.dispose();
  computerUseOverlay = null;
  desktopPet?.dispose();
  desktopPet = null;
  if (!disposalPromise) {
    diagnostics?.write('desktop-stop');
    // Paired phones' whole-PC screen sessions release their held keys and
    // buttons first, within SCREEN_QUIT_BUDGET_MS (Windows' hung-app timeout)
    // however long the rest of the teardown takes.
    const screensStopped = browserHost?.stopRemoteScreens() ?? Promise.resolve();
    const browserAndComputerCleanup = (async () => {
      await browserHost?.dispose();
      await browserHostDisposal;
      await computerHost?.dispose();
      await visualizeBridge.stop();
      visualize.dispose();
    })();
    const cleanup = Promise.all([
      browserAndComputerCleanup,
      // Quit detaches from every server: this process's connections to their cores close (the core closes the tunnels; the servers'
      // daemons keep running).
      serverConnections.closeAll(),
      Promise.resolve(stopHostListsFeed()),
      Promise.resolve(corePortRelay.dispose()),
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
    disposalPromise = Promise.all([Promise.race([cleanup, deadline]), screensStopped])
      .then(() => undefined)
      .finally(() => {
        if (timeout) clearTimeout(timeout);
      })
      .then(
        () => undefined,
        (error: unknown) => {
          console.error('Failed to detach from the Mixdog core during quit:', error);
        }
      );
  }
  return disposalPromise;
}

/** The core process this app started (none while it runs on one it found). */
let localCoreProcess: CoreProcess | null = null;
let localCoreConfirmation: (() => Promise<void>) | undefined;
let coreWatcher: { stop(): void } | null = null;

// Windows vanish the moment a quit begins; detach, daemon stop and the
// PostgreSQL behind it finish in this still-running main process afterwards.
const quitSequence = createDesktopQuitSequence({
  windows: () => BrowserWindow.getAllWindows(),
  teardown: async () => {
    for (const removeWindowIpc of windowIpcDisposers.values()) removeWindowIpc();
    windowIpcDisposers.clear();
    await disposeDesktopResources();
    // The core this app started is told to stop with its running work aborted (the app has left it, so nobody could confirm an
    // abort), then waited for: the app's exit would end it, and the PostgreSQL it runs, at once and without an exit hook.
    coreWatcher?.stop();
    const core = localCoreProcess;
    await stopCoreForQuit({
      request: (timeoutMs) =>
        requestCoreStop({
          child: core,
          bin: coreBinaryPath(app.isPackaged, process.resourcesPath),
          runtimeRoot: resolveRuntimeRoot(),
          env: coreEnvironment(app.isPackaged, process.resourcesPath, app.getPath('userData')),
          timeoutMs,
        }),
      exit: (remainingMs) => coreExit(core, remainingMs),
      record: async (outcome) => {
        diagnostics?.write('desktop-daemon-stop', { pid: core?.pid ?? null, ...outcome });
        await diagnostics?.flush();
        if (!outcome.exited) {
          console.error(`The Mixdog core did not stop within ${outcome.timeoutMs}ms of the quit; it is ended now.`);
          forceEndCore(core);
        }
      },
    });
  },
  // A teardown step that never settles (a detach or a stop waiting on a hung core) must not keep the quitting app, its core and
  // the single-instance lock alive: the next launch would wait on them behind a black window.
  teardownTimeoutMs: DESKTOP_QUIT_TEARDOWN_TIMEOUT_MS,
  onTeardownTimeout: () => {
    diagnostics?.write('desktop-quit-teardown-timeout', {
      timeoutMs: DESKTOP_QUIT_TEARDOWN_TIMEOUT_MS,
      corePid: localCoreProcess?.pid ?? null,
    });
    forceEndCore(localCoreProcess);
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
      noteQuitCause('gpu-fallback-restart');
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
    profileFileFailure('pane-layout-file-failed')
  );
}

/** The window's large caches (ipc-renderer-cache.ts), their files named like its pane layout file: a server window's
 *  are its own. */
function connectionRendererCaches(connection: ConnectionIdentity): RendererCaches {
  const owner = connection.kind === 'local' ? '' : `-ssh-${connectionStorageKey(connection)}`;
  const cache = (name: string) =>
    createRendererCache(
      join(app.getPath('userData'), `renderer-cache-${name}${owner}.json`),
      profileFileFailure('renderer-cache-file-failed', { cache: name })
    );
  return Object.fromEntries(RENDERER_CACHE_NAMES.map((name) => [name, cache(name)])) as RendererCaches;
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
    // Other responses keep their headers: stamped onto a previewed PDF and Chromium's PDF viewer page,
    // `frame-ancestors 'none'` blanks the editor's PDF preview.
    const rendererOrigin = process.env.ELECTRON_RENDERER_URL;
    if (!details.url.startsWith('file:') && !(rendererOrigin && details.url.startsWith(rendererOrigin))) {
      callback({});
      return;
    }
    const development = Boolean(process.env.ELECTRON_RENDERER_URL);
    // Visualize panes frame pages of the core's loopback page server (tokenized leases). Its port is picked when the
    // core starts, which is after this document and its policy are loaded, and again each time the core restarts, so
    // the policy names the loopback host, not one port. No other http host may be framed.
    const frameSrc = `frame-src 'self' blob: ${MEDIA_SCHEME}: http://127.0.0.1:*`;
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
function rendererDiagnosticListener(
  window: BrowserWindow,
  connection: ConnectionIdentity
): (event: Electron.IpcMainEvent, payload: unknown) => void {
  // Who is speaking comes from the validated sender, merged last, so the renderer's own fields cannot replace it. The window
  // id is the one the relay's `core-link-*` lines carry, so a window's two views of its link join.
  const coreLinkLog = createLinkLog(writeBootDiagnostic, {
    link: 'renderer',
    window: windowIdFor(window.webContents),
    owner: connection.kind === 'local' ? 'local' : 'ssh',
    ownerKey: connectionStorageKey(connection),
  });
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
    const coreLink = normalizeRendererCoreLinkDiagnostic(payload);
    if (coreLink) {
      coreLinkLog(coreLink.event, coreLink.fields);
      return;
    }
    const followRelease = normalizeRendererFollowReleaseDiagnostic(payload);
    if (followRelease) {
      diagnostics?.write('renderer-follow-release', followRelease);
      return;
    }
    const followRearm = normalizeRendererFollowRearmDiagnostic(payload);
    if (followRearm) {
      diagnostics?.write('renderer-follow-rearm', followRearm);
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

function installRendererCrashRecovery(
  window: BrowserWindow,
  reloadRenderer: () => void,
  followsStorageLoss: () => boolean
): void {
  let rendererFailureTimes: number[] = [];
  let rendererRecoveryPromptOpen = false;
  window.webContents.on('render-process-gone', (_event, details) => {
    if (followsStorageLoss()) {
      reloadRenderer();
      return;
    }
    const recovery = rendererRecoveryDecision(rendererFailureTimes, details.reason);
    rendererFailureTimes = recovery.failures;
    diagnostics?.write('render-process-gone', {
      reason: details.reason,
      exitCode: details.exitCode,
      exitText: displayExitCode(details.exitCode),
      recovery: recovery.action,
      ...currentProcessMemory(),
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

/** A hidden Chromium surface can throttle requestAnimationFrame and delay ready-to-show for seconds; the renderer's
  layout-commit handshake plus did-finish-load is sufficient, ready-to-show is used when it arrives first, and an absolute
  deadline shows the window either way. */
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
    if (desktopWindowHeldHidden) {
      diagnostics?.write('window-held-hidden', { durationMs: Date.now() - startupStartedAt, forced: force, reason });
      return;
    }
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
    call: (method, params) => localProtocol.call(method, params),
    reportError: (what, error) =>
      diagnostics?.write('desktop-pet-core-failed', {
        what,
        message: error instanceof Error ? error.message : String(error),
      }),
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
      tagRendererSurface(window, 'desktop-pet');
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
    // The approval card's own answer path (ipc-sessions.ts).
    decideApproval: (sessionId, id, decision) =>
      localService.resolveToolApprovalForSession(sessionId, id, { ...decision, device: hostDeviceName() }),
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

function windowsRemoteScreens() {
  const environment = {
    isPackaged: app.isPackaged,
    platform: process.platform,
    resourcesPath: process.resourcesPath,
    cwd: process.cwd(),
    programData: process.env.ProgramData,
  };
  return {
    displays: createElectronScreenDisplays(),
    createInputHost: createElectronScreenInputHost,
    secureDesktop: createSecureDesktopHelper({
      adapter: () => createSecureDesktopAdapter(createSecureDesktopClient({ environment })),
      installer: secureDesktopInstaller(),
    }),
    // The phone's Windows-password fallback goes through the same
    // PC access queue as Approve (revocation rules included).
    pcAccess: {
      accountIsAdmin,
      approveWithCredential: (
        request: Parameters<NonNullable<ReturnType<typeof windowsPcAccess>>['approveWithCredential']>[0]
      ) => windowsPcAccess()!.approveWithCredential(request),
    },
    indicator: createPillScreenIndicator,
  };
}

/** Hands a heavy renderer's memory back and reports the working set once it settles. */
async function reclaimRendererMemory(window: BrowserWindow): Promise<void> {
  if (window.isDestroyed()) return;
  const startedAt = Date.now();
  const before = rendererWorkingSetKb();
  await purgeRendererMemory(window.webContents);
  const totalMs = Date.now() - startedAt;
  setTimeout(() => {
    diagnostics?.write('renderer-idle-reclaim', {
      beforeKb: before.workingSetKb,
      afterKb: rendererWorkingSetKb().workingSetKb,
      shellProcesses: before.processes,
      totalMs,
      settleMs: RENDERER_RECLAIM_SETTLE_MS,
    });
  }, RENDERER_RECLAIM_SETTLE_MS).unref();
}

/** This PC's window carries the machine's single instances: Computer Use and
 *  its overlay, the Browser Use pane host, taskbar attention, idle reclaim and
 *  the close-to-background behavior. Returns its Browser Use host. */
function installLocalWindowFeatures(
  window: BrowserWindow,
  onGuest: (guest: Electron.WebContents) => void
): BrowserHost {
  mainWindow = window;
  const stopScreenSessions = publishScreenSessions(
    window,
    (method, params) => localProtocol?.notify(method, params),
    (listener) => (localProtocol ? onProtocolAttached(localProtocol, listener) : () => {})
  );
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
  if (computerHost && !computerUseOverlay) computerUseOverlay = createLocalComputerUseOverlay(computerHost);
  computerHost?.setObserveOnly(computerObserveOnly);
  computerHost?.setBridgeEnabled(computerControlEnabled);
  const windowBrowserHost = createLocalBrowserHost(window, onGuest);
  browserHost = windowBrowserHost;
  // Explicit reveals and hides reach paired clients as the core's `host/browser/surface` (failed opens are not sent).
  const stopSurfaceReport = hostRole.host.reportBrowserSurfaces(windowBrowserHost.hostRole().surfaces);
  windowBrowserHost.setBridgeEnabled(browserControlEnabled);
  attachLocalWindowLifecycle(window, windowBrowserHost, stopScreenSessions, stopSurfaceReport);
  return windowBrowserHost;
}

function createLocalComputerUseOverlay(overlayComputerHost: ComputerHost): ComputerUseOverlay {
  return createComputerUseOverlay(
    createComputerPillControls({
      core: createCoreUserControl((method, params) => localProtocol.call(method, params)),
      mirror: hostRole.computerPill,
      abortSession: async (sessionId) => localService.abortSession(sessionId),
      host: {
        // Control-renderer recovery pauses input without cancelling the task.
        pause: async () => overlayComputerHost.takeOver('user_pause'),
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
    }),
    app.getLocale(),
    {},
    hostRole.computerPill
  );
}

function createLocalBrowserHost(window: BrowserWindow, onGuest: (guest: Electron.WebContents) => void): BrowserHost {
  // Browser pane host: registers this window's browser-pane webviews. The
  // agent bridge (the runtime's `browser` tool) is opt-in and only serves
  // while the Browser Use setting is on, mirroring Computer Use.
  return createBrowserHost(window, {
    hostId: readOrCreateHostId(desktopUserData),
    // Only this PC's own window has a browser host (server windows refuse the
    // browser pane and agent bridge), so its sessions always work locally.
    remoteSession: false,
    onGuest,
    onDiagnostic: (event, data) => diagnostics?.write(event, data),
    autoSignIn: () => browserAutoSignIn,
    // The core runs a Computer Use saved-login fill; its worker steps go through the computer host.
    savedLoginWorker: {
      run: async (command) => {
        if (!computerHost) throw new Error('saved_login_unavailable: Computer Use is not running; no input was sent');
        return computerHost.executeSerialized(command as unknown as Parameters<ComputerHost['executeSerialized']>[0]);
      },
    },
    hidDevices: () => browserHidDevices,
    permissionPolicy: {
      policy: () => browserPermissionPolicy,
      save: (next) => {
        browserPermissionPolicy = next;
        void settingsStore.updateBrowserPermissions(next).catch((error: unknown) => {
          diagnostics?.write('browser-permissions-save-failed', {
            message: error instanceof Error ? error.message : String(error),
          });
        });
      },
    },
    cookieAutoImportSettings: {
      read: () => settingsStore.readBrowserCookieAutoImport(),
      write: (next) => settingsStore.updateBrowserCookieAutoImport(next),
    },
    // Live frames and explicit reveal/hide requests reach paired clients
    // through the service, which owns the relay and per-client pacing.
    publishRemoteFrame: (frame) => hostRole.host.publishRemoteFrame(frame),
    publishRemoteTabs: (tabs) => hostRole.host.publishRemoteTabs(tabs),
    // The streamed page's document and geometry reach the core as `host/browser/page`.
    onStreamedPageChanged: (sessionId) => hostRole.host.streamedPageChanged(sessionId),
    publishRemoteImportProgress: async (progress) => {
      await localService.invokeDesktopOperation('browserRemoteImportProgress', [progress]);
    },
    // The WebRTC live view: signals to one phone go through the service's
    // relay; the peer connections run in a hidden sender window.
    remoteWebrtc: {
      sendSignal: (clientId, signal) =>
        localService.invokeDesktopOperation('browserRemoteWebrtcSignal', [clientId, signal]),
      senderPage: (() => {
        const { developmentUrl, rendererUrl } = resolveRendererTarget();
        return {
          developmentUrl: developmentUrl ? rendererUrl.href : undefined,
          file: join(import.meta.dirname, '../renderer/remote-webrtc-sender.html'),
        };
      })(),
      screens: process.platform === 'win32' ? windowsRemoteScreens() : undefined,
    },
  });
}

function attachLocalWindowLifecycle(
  window: BrowserWindow,
  windowBrowserHost: BrowserHost,
  stopScreenSessions: () => void,
  stopSurfaceReport: () => void
): void {
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
  const windowIdleReclaim = attachWindowIdleReclaim(window, {
    reclaim: () => reclaimRendererMemory(window),
    // Whole seconds, rounded down: the upper bound, so input just before a
    // release never reads as newer than it.
    systemIdleMs: () => (powerMonitor.getSystemIdleTime() + 1) * 1000,
  });
  idleReclaim = windowIdleReclaim;
  window.on('focus', () => {
    turnAttention?.onFocus();
  });
  window.on('close', (event) => {
    backgroundWindow.onClose(event, () => window.hide());
  });
  window.on('closed', () => {
    if (idleReclaim === windowIdleReclaim) idleReclaim = null;
    stopScreenSessions();
    stopSurfaceReport();
    computerUseOverlay?.dispose();
    computerUseOverlay = null;
    // This window's host dies with it (macOS 'activate' builds a new one);
    // dispose is idempotent, so a later quit-time dispose is a no-op.
    if (browserHost === windowBrowserHost) browserHost = null;
    // The partition's guards go with the host: a sign-in popup on that partition must not outlive them.
    browserLogin.dispose();
    browserHostDisposal = Promise.all([browserHostDisposal, windowBrowserHost.dispose()]).then(() => undefined);
    mainWindow = null;
    turnAttention = null;
  });
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

/** The server windows the core asked for (`host/window/open`): one record each (its endpoint is asked of this PC's core), and
 *  for as long as the window lives this process's service connection to that server's core (the window's desktop
 *  operations, terminals, uploads and previews). The ssh session, the tunnel and the link are the core's. */
const serverHostSettings = createServerHostSettings(localProtocol);
const serverWindowTokens = new WeakMap<BrowserWindow, string>();
const closingByCore = new WeakSet<BrowserWindow>();
const serverConnections = createServerConnections<DesktopConnection>({
  pool: connectionPool,
  create: (record) =>
    createDesktopConnection({ id: record.id, kind: record.kind, name: record.name }, connectionDependencies),
});
const serverWindows = createServerWindows({
  core: localProtocol,
  showWindow: async (record) => {
    // The window's quota rules read the saved server as it is now.
    await serverHostSettings.refresh().catch(() => undefined);
    const existing = connectionPool.get(record.id);
    const connection = await serverConnections.attach(record);
    try {
      await showConnectionWindow(connection);
    } catch (error) {
      if (!existing && connectionPool.get(record.id) === connection) {
        await serverConnections.detach(record.id).catch(() => undefined);
      }
      throw error;
    }
  },
  localEndpoint: async () => {
    const resolve = coreEndpoints.get(LOCAL_CONNECTION_ID);
    if (!resolve) throw new Error('This PC has no core link.');
    const { url, token } = await resolve();
    return { url, token };
  },
});
// The saved hosts changed in another window or on the core: every window is told, and the settings the quota rules read are read again.
const stopHostListsFeed = holdsSingleInstanceLock
  ? watchHostListsFeed(
      localProtocol,
      () => {
        notifyHostListsChanged();
        void serverHostSettings.refresh().catch(() => undefined);
      },
      (message) => console.error(`[mixdog] ${message}`)
    )
  : () => undefined;

function reportWindowFocusChanges(window: BrowserWindow): void {
  window.on('show', publishWindowFocus);
  window.on('hide', publishWindowFocus);
  window.on('focus', publishWindowFocus);
  window.on('blur', publishWindowFocus);
  window.on('minimize', publishWindowFocus);
  window.on('restore', publishWindowFocus);
  publishWindowFocus();
}

/** Pins only the application shell; Browser Use guests keep their own zoom. */
function pinShellZoom(window: BrowserWindow): void {
  window.webContents.setZoomFactor(1);
  void window.webContents.setVisualZoomLevelLimits(1, 1);
  window.webContents.on('dom-ready', () => {
    window.webContents.setZoomFactor(1);
  });
}

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
  // The core's server notifier asks whether a window is on screen (windowFocus).
  reportWindowFocusChanges(window);
  installDesktopWindowMaterial(window, writeBootDiagnostic);
  // The user's operations in this window reach its connection's runtime.
  const inputReporter = createUserInputReporter({
    report: (at) => connection.protocol?.noteUserInput(at),
  });
  // Not while Computer Use is executing a command against this window (its
  // Browser Use pages, which live inside it, follow the same rule).
  const computerUseOnWindow = () => computerUseOperates(hostRole.computerPill, electronWindowForNativeId, window);
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
    noteQuitCause('os-session-end');
    quitApproved = true;
  });
  pinShellZoom(window);
  const reloadRenderer = () => {
    if (quitAfterDispose || window.isDestroyed() || window.webContents.isDestroyed()) return;
    window.webContents.reload();
  };
  const localStorageRescue = createLocalStorageRescue({
    endRenderer: () => {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.forcefullyCrashRenderer();
    },
    report: (details) => diagnostics?.write('local-storage-backend-lost', details),
  });
  const disposeWindowIpc = installWindowIpc(window, connection, windowBrowserHost, localStorageRescue);
  // A server window hears that the saved hosts changed; its link and notices, its OS notifications and its reopening at the
  // next launch are the core's.
  const stopLinkForward = local ? () => {} : forwardConnectionLink(window.webContents);
  windowIpcDisposers.set(window, () => {
    disposeWindowIpc();
    stopLinkForward();
  });
  diagnostics?.write('window-created', {
    totalMs: Date.now() - startupStartedAt,
  });

  const onRendererDiagnostic = rendererDiagnosticListener(window, connection);
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

  installRendererConsoleErrorTail(window.webContents, startupStartedAt, (fields) =>
    diagnostics?.write('renderer-console-error', fields)
  );
  installDefaultContextMenu(window.webContents);

  installRendererLoadDiagnostics(window, local, startupStartedAt, () => presentation);
  installRendererCrashRecovery(window, reloadRenderer, localStorageRescue.exited);

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
  windowBrowserHost: BrowserHost | null,
  localStorageRescue: LocalStorageRescue
): () => void {
  const local = connection.kind === 'local';
  const ipcScope = ipcRouter.scope(window.webContents.id, connection.id);
  const removeWindowIpc = registerDesktopIpc(window, connection.client, {
    app,
    translateUi: nativeT,
    ipcMain: ipcScope,
    dialog,
    shell,
    connectionKind: connection.kind,
    serverId: connection.id,
    // A server window's model calls run on this PC's sign-ins (model proxy,
    // filtered by the host's provider list): their quota is this PC's.
    pcHost: {
      invokeCapability: (capability, args, sessionId) => localService.invokeCapability(capability, args, sessionId),
      readCapabilities: (requests) => localService.readCapabilities(requests),
      // A server on its own logins reads its own quota.
      inUse: () => !serverHostSettings.modelAccess(connection.id).serverLogin,
      isProviderAllowed: (provider) => {
        const allowed = serverHostSettings.modelAccess(connection.id).allowedProviders;
        return allowed === null || allowed.includes(provider);
      },
    },
    protocol: connection.protocol,
    pcCore: localProtocol,
    ...(local ? { prepareConfirmedAllowAllActions: () => localCoreConfirmation } : {}),
    corePort: corePortRelay,
    // The updater and the notification sound are this PC's: a server window
    // gets neither (its channels are refused by the feature gates).
    ...(local && process.platform === 'win32' ? { previewNotificationSound: playNotificationSound } : {}),
    ...(local ? { updater: desktopUpdater } : {}),
    // This PC's settings, Browser Use, Computer Use and phone access exist only
    // in this PC's window; a server window refuses them (feature gates).
    ...(windowBrowserHost
      ? {
          browserHost: windowBrowserHost,
          browserLogin,
          computer: {
            readPermissions: readComputerPermissions,
            requestPermissions: requestComputerPermissions,
          },
          visualize,
        }
      : {}),
    remoteHosts: remoteHostsHandle(),
    paneLayoutFile: connectionPaneLayoutFile(connection),
    rendererCaches: connectionRendererCaches(connection),
    localStorageRescue,
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
    diagnostics?.write('renderer-unresponsive', currentProcessMemory());
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
      () => undefined,
      (error: unknown) => {
        console.error('Failed to flush desktop window state:', error);
      }
    );
    windowIpcDisposers.get(window)?.();
    windowIpcDisposers.delete(window);
    const current = connectionWindows.get(connection.id) === window;
    if (current) connectionWindows.delete(connection.id);
    publishWindowFocus();
    if (connection.kind !== 'local') {
      if (current) {
        serverWindows.release(connection.id);
        void serverConnections.detach(connection.id).catch((error: unknown) => {
          console.error(`Failed to detach from ${connection.name}:`, error);
        });
      }
      hostRole.host.windowHost?.windowClosed(
        connection.id,
        !quitApproved && !closingByCore.has(window),
        serverWindowTokens.get(window)
      );
    }
  });
}

/** Opens the desktop's diagnostics log and writes the boot timeline into it. */
function startDesktopDiagnostics(appReadyAt: number): void {
  const log = createDesktopDiagnostics(join(app.getPath('userData'), 'logs', 'desktop-diagnostics.jsonl'), {
    appVersion: app.getVersion(),
    packaged: app.isPackaged,
    bootId: desktopBootId,
    ...(desktopBootScenario ? { scenario: desktopBootScenario } : {}),
  });
  diagnostics = log;
  setTranscriptReadDiagnosticSink((entry) => {
    diagnostics?.write('transcript-read', { ...entry });
  });
  setPageFaultDiagnosticSink((entry) => diagnostics?.write('browser-page-fault', { ...entry }));
  log.write('process-entry', {
    occurredAt: new Date(desktopProcessStartedAt).toISOString(),
    totalMs: 0,
  });
  log.write('app-ready', {
    totalMs: appReadyAt - desktopProcessStartedAt,
  });
  // The daemon handshake is already running (started before whenReady);
  // stamp its start into the timeline now that the sink exists.
  reportDaemonServiceStart();
  bootTimeline.open(log, () =>
    log.write('desktop-start', {
      totalMs: Date.now() - desktopProcessStartedAt,
      electronVersion: process.versions.electron,
      chromeVersion: process.versions.chrome,
      nodeVersion: process.versions.node,
      sessionProcess: 'daemon',
      gpuRendering: softwareRenderingThisLaunch ? 'software-fallback' : 'hardware',
      crashReporterStatus,
      ...(crashReporterErrorName ? { crashReporterErrorName } : {}),
      ...(gpuFallbackMarker ? { gpuFallbackCrashes: gpuFallbackMarker.crashesInWindow } : {}),
    })
  );
  startCrashHandlerWatch();
  startDiagnosticsEventLoopMonitor();
}

/** Keep-awake, taskbar attention and the turn notifier feed on
 *  the session state, roster and agent pool lanes. */
function subscribeSessionLanes(): void {
  // Keep-awake + taskbar attention feed on the same session state lane.
  unsubscribeAwake = localService.subscribe((snapshot) => {
    awakeService.onSnapshot(snapshot);
    turnAttention?.onSnapshot(snapshot);
  });
  // Every session's roster and the agent pool, not just the active pane:
  // the final-answer rule needs background work as well as turn state.
  const unsubscribeRoster = localService.subscribeSessions((sessions) => {
    latestSessions = sessions;
    // Visualize holds the panel while a session's agent turn runs.
    void visualize.observeTurns(sessions);
  });
  const unsubscribeAgents = localService.subscribeAgentPool((agents) => {
    latestAgentPool = agents;
  });
  unsubscribeSessionSources = () => {
    unsubscribeRoster();
    unsubscribeAgents();
  };
}

/** Sleep, shutdown and network changes keep the relay and server links honest;
 *  a timer samples process memory into the diagnostics log. */
function watchPowerAndNetwork(): void {
  // macOS/Linux shutdown or logoff: the OS ends the session, nobody is asked.
  powerMonitor.on('shutdown', () => {
    noteQuitCause('os-shutdown');
    quitApproved = true;
  });
  powerMonitor.on('resume', () => {
    // The blocker may have been dropped across sleep; re-assert it, and
    // redial the relay leg instead of waiting for the ping cycle.
    awakeService.reevaluate();
    hostRole.host.reports.power('resume');
    // A window's core socket may have died silently across sleep: each window's port closes and the window reopens it,
    // reading its state afresh (what the old state bridge's resume resend did).
    corePortRelay.closeAll('system resume');
  });
  // The core pauses the server links (host/power): no attempts, no failure shown; on resume each probes before it touches its tunnel.
  powerMonitor.on('suspend', () => {
    hostRole.host.reports.power('suspend');
  });
  diagnosticsMemoryTimer = setInterval(
    () => {
      diagnostics?.write('process-memory', {
        ...currentProcessMemory(),
        browserPages: browserHost?.pageRetention() ?? [],
        systemMemory: currentSystemMemory(),
      });
    },
    // MIXDOG_MEMORY_SAMPLE_MS shortens the period for a development run that attributes memory.
    Math.max(2_000, Number(process.env.MIXDOG_MEMORY_SAMPLE_MS) || 5 * 60 * 1000)
  );
  diagnosticsMemoryTimer.unref();
}

if (holdsSingleInstanceLock) {
  app.on('second-instance', () => {
    // During a quit's teardown this instance still holds the lock: the new
    // launch exits, and this one relaunches the app on its way out.
    if (quitSequence.secondInstance()) {
      diagnostics?.write('second-instance-during-quit-relaunch', {});
      return;
    }
    activatePrimaryWindow();
  });

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
      startDesktopDiagnostics(appReadyAt);
      // The desktop pet window, when its setting is on (desktop-pet-window.ts).
      desktopPet = createDesktopPetController();
      if (mainWindow) desktopPet.attachAppWindow(mainWindow);
      desktopPet.start();
      subscribeSessionLanes();
      void settingsStore
        .read()
        .then(applyDesktopSettings)
        .catch(() => {
          /* default stays enabled */
        });
      // A desktop flag changed by any other writer (a hand edit of the config
      // file included) applies here without a restart.
      const settingsWatchFailed = (error: unknown): void => {
        diagnostics?.write('desktop-settings-watch-failed', {
          message: error instanceof Error ? error.message : String(error),
        });
      };
      void settingsStore.watch(applyDesktopSettings, settingsWatchFailed).catch(settingsWatchFailed);
      watchPowerAndNetwork();
      app.on('child-process-gone', (_event, details) => {
        diagnostics?.write('child-process-gone', {
          type: details.type,
          reason: details.reason,
          exitCode: details.exitCode,
          exitText: displayExitCode(details.exitCode),
          serviceName: details.serviceName,
          name: details.name,
        });
        if (details.type === 'GPU') {
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
      registerConnectionLinkIpc({
        ipcMain,
        routes: windowRoutes,
        closeWindow: (sender) => BrowserWindow.fromWebContents(sender)?.close(),
        showConnectionSettings: showLocalConnectionSettings,
      });
      await showConnectionWindow(localConnection);
      // The core reopens the windows it remembers once the host has claimed (host/window/open).
      // MIXDOG_SSH_TARGET: the core connects the target and asks this desktop for its window, beside this PC's.
      if (envSshTarget) {
        void hostRole.firstClaim
          .then(() => openEnvSshTarget(localProtocol, envSshTarget))
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
      noteQuitCause('desktop-initialize-failed');
      quitApproved = true;
      app.quit();
    });
}

let quitRequestLogged = false;
app.on('before-quit', (event) => {
  // The first before-quit of this run names its cause; the one after the
  // disposal (quitAfterDispose) is the same quit finishing.
  if (!quitRequestLogged) {
    quitRequestLogged = true;
    const focused = BrowserWindow.getFocusedWindow();
    diagnostics?.write('quit-requested', {
      cause: quitCause ?? 'unattributed',
      windows: BrowserWindow.getAllWindows().length,
      windowFocused: focused !== null,
      uptimeMs: Math.round(process.uptime() * 1000),
    });
  }
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
  if (process.platform !== 'darwin' || !runInBackground) {
    noteQuitCause('window-all-closed');
    app.quit();
  }
});

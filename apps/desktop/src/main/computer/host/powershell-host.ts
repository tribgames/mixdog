/**
 * Computer-use host — main-process owner of local desktop control and of the
 * loopback bridge that lets the session runtime's `computer` tool drive it.
 *
 * Engine: one resident worker per agent session holds accessibility state (an
 * element map that survives between snapshot and invoke, which spawning per
 * command could not) and dispatches native input. On Windows the worker is a
 * PowerShell host over .NET UI Automation and Win32; on macOS and Linux it is
 * the native `mixdog-computer` backend speaking the same protocol. Screenshots are captured
 * on demand from window-owned Electron or native render surfaces. The runtime half discovers
 * this bridge through a heartbeated data-dir file, so the tool surface exists
 * only while the desktop app runs with Computer Use enabled — no daemon
 * protocol change.
 *
 * The PowerShell recipes (UIA tree walk, InvokePattern/ValuePattern, Win32
 * input) follow the public Microsoft UI Automation and user32 APIs.
 *
 * This file only composes the host: the worker pool and session state come
 * from their own modules, and the lifecycle, input resolution, sequence runner,
 * command router, and bridge server are wired together here.
 */
import { screen, powerMonitor } from 'electron';
import { bindComputerEnvironmentGuard } from './environment-guard';
import { join } from 'node:path';
import type { ComputerAuthorizationStatus, ComputerAuthorizationWindow } from '../../../shared/computer-settings';
import { createComputerAuthorizationSettings } from './authorization-settings';
import { createComputerFailureDiagnostics } from '../session/failure-diagnostics';
import { bridgeDiscoveryDirectory } from '../../bridge/discovery-file';
import { mixdogDataDirectory } from '../shared/common';
import { createProcessFateReader } from './process-fate';
import { createCaptureAuthorizer, listAuthorizationWindows } from './host-authorization';
import { createSequenceHoldRelease, killSessionWorkers, retireBridgeWorkers } from './worker-control';
import { nativeDisplayGeometry } from '../shared/native-coordinates';
import { createWorkerPool } from '../backend/worker-pool';
import { createCaptureEngine } from '../observation/capture';
import { electronWindowForNativeId } from '../observation/window-handles';
import { createInspection } from '../observation/inspect';
import { createSessionState } from '../session/state';
import { createWindowTargeting } from '../input/targeting';
import {
  createChromeRemoteDebuggingSetup,
  type ChromeRemoteDebuggingSetup,
  type ChromeRemoteDebuggingTarget,
} from '../session/chrome-setup';
import { computerUseCoordinator } from '../session/coordinator';
import { createExecutionState } from './execution-state';
import { createWindowArrivals } from './window-arrivals';
import { createWindowReads } from './window-reads';
import { readDisplays } from './display-reads';
import { readComputerPermissions } from './permission-reads';
import { WINDOWS_NATIVE_SURFACE_BACKENDS } from '../shared/capture-attempts';
import { publishPointerProgress } from './pointer-cursor';
import { createSessionLifecycle } from './session-lifecycle';
import { createInputResolution } from './input-resolution';
import { createSequenceRunner, suppressCaptureAfter } from './sequence-runner';
import { createInputPreflight } from './input-preflight';
import { createCommandRouter } from './command-router';
import { createBridgeServer } from './bridge-server';
import { type ComputerExecutionPolicy, loadComputerExecutionPolicy } from './execution-policy';
import { createUserWaitService } from './user-wait-service';
import { createSavedLoginVault } from './saved-login-vault';
import { configureCursorDiagnostics } from '../overlay/cursor-diagnostics';

export type { ChromeRemoteDebuggingSetup, ChromeRemoteDebuggingTarget };

export interface PowerShellComputerHost {
  readAuthorization(): ComputerAuthorizationStatus;
  updateAuthorization(value: unknown): Promise<ComputerAuthorizationStatus>;
  authorizationWindows(): Promise<ComputerAuthorizationWindow[]>;
  readFailureDiagnostics(): unknown[];
  setBridgeEnabled(enabled: boolean): void;
  /** Observation-only opt-in: reads stay available, input is refused. */
  setObserveOnly(enabled: boolean): void;
  /** Yield all desktop control immediately without restoring stale input state. */
  takeOver(reason?: string): void;
  /** Allow new Computer Use commands after an explicit user takeover. */
  resumeAfterTakeover(generation: number, signal?: AbortSignal): Promise<void>;
  /** The overlay's Resume: recover a latched cleanup, then continue the paused task. */
  resumeByUser(generation: number): Promise<void>;
  configureIdleResume(seconds: number): void;
  /** Stop one session and perform its normal input-state cleanup. */
  abortSession(sessionId: string): Promise<void>;
  /** Stop every live or paused session; reopen input only after optional turn confirmation. */
  stopAllSessions(turnsStopped?: Promise<void>): Promise<void>;
  /** Live native worker PIDs, retained until each child actually exits. */
  residentWorkerPids(): number[];
  inspectChromeRemoteDebuggingTarget(): Promise<ChromeRemoteDebuggingTarget>;
  prepareChromeRemoteDebugging(target: ChromeRemoteDebuggingTarget): Promise<ChromeRemoteDebuggingSetup>;
  acceptChromeRemoteDebuggingConsent(setup: ChromeRemoteDebuggingSetup, signal?: AbortSignal): Promise<boolean>;
  finalizeChromeRemoteDebuggingSetup(setup: ChromeRemoteDebuggingSetup): Promise<void>;
  releaseChromeRemoteDebugging(setup: ChromeRemoteDebuggingSetup): Promise<void>;
  dispose(): Promise<void>;
}

/** The union of every display in native coordinates: the Wayland input
 *  device spans it when the compositor cannot report its outputs. */
function desktopBoundsEnvironment(): Record<string, string> {
  const areas = screen.getAllDisplays().map(nativeDisplayGeometry);
  const left = Math.min(...areas.map((area) => area.x));
  const top = Math.min(...areas.map((area) => area.y));
  const right = Math.max(...areas.map((area) => area.x + area.width));
  const bottom = Math.max(...areas.map((area) => area.y + area.height));
  return { MIXDOG_COMPUTER_DESKTOP_BOUNDS: `${left},${top},${right - left},${bottom - top}` };
}

/** The host's diagnostic sink: a failing listener never reaches the host. */
function advisoryDiagnostics(
  onDiagnostic: ((event: string, data: Record<string, unknown>) => void) | undefined
): (event: string, data?: Record<string, unknown>) => void {
  return (event, data = {}) => {
    try {
      onDiagnostic?.(event, data);
    } catch {
      /* diagnostics are advisory */
    }
  };
}

/** The host's read side: windows and their arrivals, targeting, inspection and capture. */
function createObservationLayer({
  policy,
  callPowerShell,
  sessionState,
  execution,
  isObserveOnly,
}: {
  policy: ComputerExecutionPolicy;
  callPowerShell: ReturnType<typeof createWorkerPool>['callPowerShell'];
  sessionState: ReturnType<typeof createSessionState>;
  execution: ReturnType<typeof createExecutionState>;
  isObserveOnly: () => boolean;
}) {
  const { sessionIdFor } = sessionState;
  const { assertExecutionNotAborted } = execution;
  const windowReads = createWindowReads({ callPowerShell, sessionIdFor });
  const { readComputerWindows, readInstalledApps } = windowReads;
  const windowArrivals = createWindowArrivals({
    policy,
    sessionIdFor,
    peekComputerWindows: windowReads.peekComputerWindows,
  });
  const targeting = createWindowTargeting({ readComputerWindows, readInstalledApps });
  const inspection = createInspection({
    callPowerShell,
    sessionIdFor,
    assertExecutionNotAborted,
    readComputerWindows,
    readInputState: () => computerUseCoordinator.snapshot(),
    readDisplays,
    readPermissions: readComputerPermissions,
    isObserveOnly,
  });
  const processFate = createProcessFateReader(callPowerShell);
  const captureEngine = createCaptureEngine({
    ...sessionState,
    callPowerShell,
    assertExecutionNotAborted,
    nativeSurfaceBackends: process.platform === 'win32' ? WINDOWS_NATIVE_SURFACE_BACKENDS : [],
    readPermissions: readComputerPermissions,
    beginObservation: execution.beginObservation,
    resolveAppWindowId: targeting.resolveAppWindowId,
    resolveForegroundWindowId: targeting.resolveForegroundWindowId,
    authorizeCapture: createCaptureAuthorizer({ policy, readComputerWindows, sessionIdFor, processFate }),
  });
  return { windowReads, windowArrivals, targeting, inspection, processFate, captureEngine };
}

/** The host's input side: target resolution and the bounded sequence runner. */
function createInputLayer({
  workerPool,
  sessionState,
  execution,
  windowReads,
  captureEngine,
  recordDiagnostic,
  runCommand,
}: {
  workerPool: ReturnType<typeof createWorkerPool>;
  sessionState: ReturnType<typeof createSessionState>;
  execution: ReturnType<typeof createExecutionState>;
  windowReads: ReturnType<typeof createWindowReads>;
  captureEngine: ReturnType<typeof createCaptureEngine>;
  recordDiagnostic: Parameters<typeof createSequenceRunner>[0]['recordDiagnostic'];
  runCommand: Parameters<typeof createSequenceRunner>[0]['runCommand'];
}) {
  const { callPowerShell, powerShellBySession } = workerPool;
  const { sessionIdFor } = sessionState;
  const { assertExecutionNotAborted } = execution;
  const inputResolution = createInputResolution({
    ...sessionState,
    ...windowReads,
    callPowerShell,
    assertExecutionNotAborted,
  });
  const sequenceRunner = createSequenceRunner({
    preflightSteps: createInputPreflight({
      callPowerShell,
      sessionIdFor,
      assertExecutionNotAborted,
      resolveElementAliases: sessionState.resolveElementAliases,
      isAppOwnedWindow: (windowId) => Boolean(electronWindowForNativeId(windowId)),
    }),
    sessionIdFor,
    recordDiagnostic,
    recordProgress: (completed, inFlight) => {
      const state = execution.executionContext.getStore();
      if (state) state.progress = { completed, inFlight };
    },
    freshObservedWindowScope: sessionState.freshObservedWindowScope,
    captureAfterAction: captureEngine.captureAfterAction,
    runCommand,
    releaseSequenceHolds: createSequenceHoldRelease({ powerShellBySession, callPowerShell }),
  });
  return { inputResolution, sequenceRunner };
}

export function createPowerShellComputerHost(
  options: {
    bridgeEnabled?: boolean;
    observeOnly?: boolean;
    policyFile?: string;
    maxWorkers?: number;
    onDiagnostic?: (event: string, data: Record<string, unknown>) => void;
    /** The desktop's Auto login setting; saved logins are refused without it. */
    savedLoginEnabled?: () => boolean;
  } = {}
): PowerShellComputerHost {
  let bridgeWanted = options.bridgeEnabled !== false;
  let observeOnly = options.observeOnly === true;
  let disposed = false;
  const basePolicy = loadComputerExecutionPolicy(options.policyFile);
  const failureDiagnostics = createComputerFailureDiagnostics(join(mixdogDataDirectory(), 'computer-failures'));
  const authorization = createComputerAuthorizationSettings({
    base: basePolicy,
    stop: () => {
      computerUseCoordinator.pauseForUser('authorization_changed');
      userWait.cancel();
      return lifecycle.stopAllComputerSessions(false);
    },
    windows: () => listAuthorizationWindows(readComputerWindows),
  });
  const policy = authorization.policy;
  configureCursorDiagnostics(join(mixdogDataDirectory(), 'computer-cursor-diagnostics.json'));
  const diagnose = advisoryDiagnostics(options.onDiagnostic);

  // Agent-scoped resident PowerShell workers + their shared pending-request table.
  const workerPool = createWorkerPool({
    dataDirectory: mixdogDataDirectory,
    isBridgeEnabled: () => bridgeWanted,
    isDisposed: () => disposed,
    onSessionRetired: (sessionId, child, interruptedInput) =>
      lifecycle.onSessionWorkerRetired(sessionId, child, interruptedInput),
    maxWorkers: options.maxWorkers,
    onPointerProgress: publishPointerProgress,
    nativeEnvironment: desktopBoundsEnvironment,
  });
  const { callPowerShell, powerShellBySession, retirePowerShell } = workerPool;

  const sessionState = createSessionState({ callPowerShell });
  const { sessionIdFor } = sessionState;
  const execution = createExecutionState();

  const { windowReads, windowArrivals, targeting, inspection, processFate, captureEngine } = createObservationLayer({
    policy,
    callPowerShell,
    sessionState,
    execution,
    isObserveOnly: () => observeOnly,
  });
  const { readComputerWindows } = windowReads;

  // The lifecycle owns the command chain, so the router it dispatches through
  // is bound late; the router itself needs the lifecycle's target claims.
  const lifecycle = createSessionLifecycle({
    ...workerPool,
    ...sessionState,
    releaseSessionState: (sessionId, releaseCaptureSession) => {
      sessionState.releaseSessionState(sessionId, releaseCaptureSession);
      windowArrivals.forget(sessionId);
    },
    releaseCaptureSession: captureEngine.releaseCaptureSession,
    execution,
    windowArrivals,
    recordDiagnostic: failureDiagnostics.record,
    runCommand: (command) => router.runCommand(command),
    recaptureRequiredReply: (command, error) => router.recaptureRequiredReply(command, error),
  });
  const { inputResolution, sequenceRunner } = createInputLayer({
    workerPool,
    sessionState,
    execution,
    windowReads,
    captureEngine,
    recordDiagnostic: failureDiagnostics.record,
    runCommand: (command) => router.runCommand(command),
  });
  const router = createCommandRouter({
    policy,
    windowArrivals,
    recordDiagnostic: failureDiagnostics.record,
    ...workerPool,
    ...sessionState,
    ...execution,
    ...lifecycle,
    ...inspection,
    ...targeting,
    ...captureEngine,
    ...windowReads,
    ...inputResolution,
    isObserveOnly: () => observeOnly,
    runBoundedSequence: sequenceRunner.runBoundedSequence,
    savedLogins: {
      enabled: () => options.savedLoginEnabled?.() === true,
      vault: createSavedLoginVault(),
    },
  });

  const chromeSetup = createChromeRemoteDebuggingSetup({
    executeSerialized: lifecycle.executeSerialized,
    readComputerWindows,
    normalizeElementRecords: sessionState.normalizeElementRecords,
    suppressCaptureAfter,
  });

  const userWait = createUserWaitService({
    directory: mixdogDataDirectory(),
    lifecycle,
    callPowerShell,
    recordDiagnostic: failureDiagnostics.record,
    enabled: () => bridgeWanted && !disposed && !observeOnly,
  });

  const bridge = createBridgeServer({
    ...workerPool,
    ...lifecycle,
    waitForUser: userWait.command,
    abortComputerSession: (command) => {
      // Runtime cancellation or a dropped HTTP caller ends only that session.
      // Only the trusted global Stop control latches user_stop; a transient
      // disconnect must not disable an existing user-intervention idle resume.
      userWait.cancel(sessionIdFor(command));
      return lifecycle.abortComputerSession(command);
    },
    // Discovery only: the worker script/cache stay in the data dir while the
    // published endpoint follows the isolation namespace, like Browser Use.
    dataDirectory: bridgeDiscoveryDirectory,
    isBridgeWanted: () => bridgeWanted,
    isDisposed: () => disposed,
    diagnose,
    processFate,
  });

  if (bridgeWanted) bridge.startBridge();
  const unbindEnvironment = bindComputerEnvironmentGuard(powerMonitor, screen, (reason) => {
    if (bridgeWanted && !disposed) lifecycle.takeOverComputer(reason);
  });

  return {
    readAuthorization: authorization.read,
    updateAuthorization: authorization.update,
    authorizationWindows: authorization.windows,
    readFailureDiagnostics: failureDiagnostics.read,
    setBridgeEnabled(enabled: boolean): void {
      if (disposed || bridgeWanted === enabled) return;
      bridgeWanted = enabled;
      if (enabled) bridge.startBridge();
      else {
        userWait.cancel();
        // Retired now instead of holding the processes until dispose.
        retireBridgeWorkers(powerShellBySession, retirePowerShell);
        // A bridge that refuses to stop would keep answering agent commands
        // after the user switched Computer Use off, so the failure is recorded.
        void bridge.stopBridge().catch((error) => {
          diagnose('computer_bridge_stop_failed', {
            message: String((error as Error)?.message || error),
          });
        });
      }
    },
    setObserveOnly(enabled: boolean): void {
      observeOnly = enabled === true;
    },
    takeOver(reason = 'user_takeover'): void {
      lifecycle.takeOverComputer(reason);
    },
    resumeAfterTakeover: lifecycle.resumeAfterTakeover,
    resumeByUser: lifecycle.resumeByUser,
    configureIdleResume: userWait.configure,
    async abortSession(sessionId: string): Promise<void> {
      userWait.cancel(sessionId);
      await lifecycle.abortComputerSession({ action: 'session_abort', session_id: sessionId });
    },
    async stopAllSessions(turnsStopped?: Promise<void>): Promise<void> {
      computerUseCoordinator.pauseForUser('user_stop');
      userWait.cancel();
      await lifecycle.stopAllComputerSessions(true, turnsStopped);
    },
    residentWorkerPids: workerPool.residentWorkerPids,
    inspectChromeRemoteDebuggingTarget: chromeSetup.inspectChromeRemoteDebuggingTarget,
    prepareChromeRemoteDebugging: chromeSetup.prepareChromeRemoteDebugging,
    acceptChromeRemoteDebuggingConsent: chromeSetup.acceptChromeRemoteDebuggingConsent,
    finalizeChromeRemoteDebuggingSetup: chromeSetup.finalizeChromeRemoteDebuggingSetup,
    releaseChromeRemoteDebugging: chromeSetup.releaseChromeRemoteDebugging,
    async dispose(): Promise<void> {
      if (disposed) return;
      unbindEnvironment();
      userWait.dispose();
      disposed = true;
      bridgeWanted = false;
      await bridge.stopBridge();
      killSessionWorkers(powerShellBySession);
      computerUseCoordinator.reset();
      workerPool.removeHostScript();
    },
  };
}

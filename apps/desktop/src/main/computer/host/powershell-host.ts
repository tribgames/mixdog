/**
 * Computer-use host — main-process owner of local Windows desktop control and
 * of the loopback bridge that lets the session runtime's `computer` tool drive
 * it. Windows only for now.
 *
 * Engine: one resident PowerShell worker per agent session holds .NET UI
 * Automation state (an element map that survives between snapshot and invoke,
 * which spawning per command could not) and dispatches Win32 input. Screenshots are captured
 * on demand in Electron via desktopCapturer, not PowerShell. The runtime half discovers
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
import { createWorkerPool } from '../backend/worker-pool';
import { createCaptureEngine } from '../observation/capture';
import { createInspection } from '../observation/inspect';
import { createSessionState } from '../session/state';
import { createWindowTargeting } from '../input/targeting';
import {
  createChromeRemoteDebuggingSetup,
  CHROME_SETUP_SESSION_ID,
  type ChromeRemoteDebuggingSetup,
  type ChromeRemoteDebuggingTarget,
} from '../session/chrome-setup';
import { computerUseCoordinator } from '../session/coordinator';
import { createExecutionState } from './execution-state';
import { createWindowReads } from './window-reads';
import { createSessionLifecycle } from './session-lifecycle';
import { createInputResolution } from './input-resolution';
import { createSequenceRunner, suppressCaptureAfter } from './sequence-runner';
import { createCommandRouter } from './command-router';
import { createBridgeServer } from './bridge-server';
import { loadComputerExecutionPolicy } from './execution-policy';
import { createUserWaitService } from './user-wait-service';

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
  configureIdleResume(seconds: number): void;
  /** Stop one session and perform its normal input-state cleanup. */
  abortSession(sessionId: string): Promise<void>;
  /** Stop every live or paused Computer Use session. */
  stopAllSessions(): Promise<void>;
  /** Live native worker PIDs, retained until each child actually exits. */
  residentWorkerPids(): number[];
  inspectChromeRemoteDebuggingTarget(): Promise<ChromeRemoteDebuggingTarget>;
  prepareChromeRemoteDebugging(
    target: ChromeRemoteDebuggingTarget,
  ): Promise<ChromeRemoteDebuggingSetup>;
  acceptChromeRemoteDebuggingConsent(
    setup: ChromeRemoteDebuggingSetup,
    signal?: AbortSignal,
  ): Promise<boolean>;
  finalizeChromeRemoteDebuggingSetup(setup: ChromeRemoteDebuggingSetup): Promise<void>;
  releaseChromeRemoteDebugging(setup: ChromeRemoteDebuggingSetup): Promise<void>;
  dispose(): Promise<void>;
}

export function createPowerShellComputerHost(
  options: {
    bridgeEnabled?: boolean;
    observeOnly?: boolean;
    policyFile?: string;
    maxWorkers?: number;
    onDiagnostic?: (event: string, data: Record<string, unknown>) => void;
  } = {},
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
    windows: async () => {
      const windows = await readComputerWindows({ action: 'list_windows', session_id: 'computer-settings' }, true);
      if (!windows) throw new Error('computer_windows_unavailable: could not read current app windows');
      return windows.map(({ id, pid, app, title }) => ({ id, pid, app, title }));
    },
  });
  const policy = authorization.policy;
  const diagnose = (event: string, data: Record<string, unknown> = {}): void => {
    try { options.onDiagnostic?.(event, data); } catch { /* diagnostics are advisory */ }
  };

  // Agent-scoped resident PowerShell workers + their shared pending-request table.
  const workerPool = createWorkerPool({
    dataDirectory: mixdogDataDirectory,
    isBridgeEnabled: () => bridgeWanted,
    isDisposed: () => disposed,
    onSessionRetired: (sessionId, child) => lifecycle.onSessionWorkerRetired(sessionId, child),
    maxWorkers: options.maxWorkers,
  });
  const { callPowerShell, powerShellBySession } = workerPool;

  const sessionState = createSessionState({ callPowerShell });
  const { sessionIdFor } = sessionState;
  const execution = createExecutionState();
  const { assertExecutionNotAborted } = execution;

  const windowReads = createWindowReads({ callPowerShell, sessionIdFor });
  const { readComputerWindows } = windowReads;
  const targeting = createWindowTargeting({ readComputerWindows });
  const inspection = createInspection({
    callPowerShell,
    sessionIdFor,
    assertExecutionNotAborted,
    readComputerWindows,
    readDisplays: () => {
      const primaryId = screen.getPrimaryDisplay().id;
      return screen.getAllDisplays().map((display, index) => ({
        index,
        id: String(display.id),
        primary: display.id === primaryId,
        scale_factor: display.scaleFactor,
        width: display.size.width,
        height: display.size.height,
      }));
    },
    isObserveOnly: () => observeOnly,
  });
  const captureEngine = createCaptureEngine({
    ...sessionState,
    callPowerShell,
    assertExecutionNotAborted,
    resolveAppWindowId: targeting.resolveAppWindowId,
    resolveForegroundWindowId: targeting.resolveForegroundWindowId,
    authorizeCapture: async (command, windowId) => {
      if (!policy.restricted || sessionIdFor(command) === CHROME_SETUP_SESSION_ID) return;
      if (!windowId) throw new Error('computer_policy_denied: full-screen capture is not authorized');
      policy.assertWindow({ ...command, action: 'capture', window_id: windowId }, await readComputerWindows(command));
    },
  });

  // The lifecycle owns the command chain, so the router it dispatches through
  // is bound late; the router itself needs the lifecycle's target claims.
  const lifecycle = createSessionLifecycle({
    ...workerPool,
    ...sessionState,
    releaseCaptureSession: captureEngine.releaseCaptureSession,
    execution,
    recordDiagnostic: failureDiagnostics.record,
    runCommand: (command) => router.runCommand(command),
    recaptureRequiredReply: (command, error) => router.recaptureRequiredReply(command, error),
  });
  const inputResolution = createInputResolution({
    ...sessionState,
    ...windowReads,
    callPowerShell,
    assertExecutionNotAborted,
  });
  const sequenceRunner = createSequenceRunner({
    sessionIdFor,
    freshObservedWindowScope: sessionState.freshObservedWindowScope,
    captureAfterAction: captureEngine.captureAfterAction,
    runCommand: (command) => router.runCommand(command),
  });
  const router = createCommandRouter({
    policy,
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
  });

  const chromeSetup = createChromeRemoteDebuggingSetup({
    executeSerialized: lifecycle.executeSerialized,
    readComputerWindows,
    normalizeElementRecords: sessionState.normalizeElementRecords,
    suppressCaptureAfter,
  });

  const userWait = createUserWaitService({
    directory: mixdogDataDirectory(), lifecycle, callPowerShell,
    enabled: () => bridgeWanted && !disposed && !observeOnly,
  });

  const bridge = createBridgeServer({
    ...workerPool,
    ...lifecycle,
    waitForUser: userWait.command,
    abortComputerSession: (command) => {
      computerUseCoordinator.pauseForUser('user_stop');
      userWait.cancel(sessionIdFor(command));
      return lifecycle.abortComputerSession(command);
    },
    // Discovery only: the worker script/cache stay in the data dir while the
    // published endpoint follows the isolation namespace, like Browser Use.
    dataDirectory: bridgeDiscoveryDirectory,
    isBridgeWanted: () => bridgeWanted,
    isDisposed: () => disposed,
    diagnose,
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
      else { userWait.cancel(); void bridge.stopBridge().catch(() => {}); }
    },
    setObserveOnly(enabled: boolean): void {
      observeOnly = enabled === true;
    },
    takeOver(reason = 'user_takeover'): void {
      lifecycle.takeOverComputer(reason);
    },
    resumeAfterTakeover: lifecycle.resumeAfterTakeover,
    configureIdleResume: userWait.configure,
    async abortSession(sessionId: string): Promise<void> {
      userWait.cancel(sessionId);
      await lifecycle.abortComputerSession({ action: 'session_abort', session_id: sessionId });
    },
    async stopAllSessions(): Promise<void> {
      computerUseCoordinator.pauseForUser('user_stop');
      userWait.cancel();
      await lifecycle.stopAllComputerSessions();
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
      for (const child of powerShellBySession.values()) {
        if (!child.killed) {
          try { child.kill(); } catch { /* already gone */ }
        }
      }
      powerShellBySession.clear();
      computerUseCoordinator.reset();
      workerPool.removeHostScript();
    },
  };
}

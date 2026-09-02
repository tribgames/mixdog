/**
 * Where an input lands and what the desktop looked like around it: frame
 * coordinates become physical ones, foreground input records the state it must
 * hand back, and a mutation waits for the desktop to settle before the window
 * transition is read.
 */
import {
  DEFAULT_CAPTURE_AFTER_DELAY_MS,
  MAX_CAPTURE_AFTER_DELAY_MS,
  elapsedMs,
} from '../shared/common';
import type {
  CaptureFrame,
  ComputerCommand,
  ObservedWindowScope,
  PowerShellResponse,
} from '../shared/types';
import {
  computeComputerWindowTransition,
  type ComputerWindowRecord,
  type ComputerWindowTransition,
} from '../shared/window-transition';
import { framePoint, screenshotInteger } from '../observation/analysis';
import {
  FOCUS_CONTINUATION_ACTIONS,
  OBSERVATION_BOUND_INPUT_ACTIONS,
} from './action-sets';
import type { InputRecoveryState } from './execution-state';

const LAUNCH_SUCCESSOR_TIMEOUT_MS = 4_000;
const LAUNCH_POLL_INTERVAL_MS = 100;

export interface InputResolutionHost {
  callPowerShell(request: Record<string, unknown>, timeoutMs?: number): Promise<PowerShellResponse>;
  sessionIdFor(command: ComputerCommand): string;
  assertExecutionNotAborted(): void;
  visualPointForRef(command: ComputerCommand, ref: string | undefined): { x: number; y: number } | undefined;
  requireValidFrame(command: ComputerCommand): Promise<CaptureFrame>;
  freshObservedWindowScope(command: ComputerCommand): ObservedWindowScope | undefined;
  readComputerWindows(
    command: ComputerCommand,
    includeApp?: boolean,
  ): Promise<ComputerWindowRecord[] | null>;
}

export interface ResolvedInputTarget {
  physicalX?: number;
  physicalY?: number;
  physicalToX?: number;
  physicalToY?: number;
  cursorX?: number;
  cursorY?: number;
  cursorToX?: number;
  cursorToY?: number;
  targetWindowId?: string;
  allowedWindowIds: string[];
  observedScope?: ObservedWindowScope;
}

export function createInputResolution(host: InputResolutionHost) {
  const {
    callPowerShell,
    sessionIdFor,
    assertExecutionNotAborted,
    visualPointForRef,
    requireValidFrame,
    freshObservedWindowScope,
    readComputerWindows,
  } = host;

  async function readInputRecovery(
    command: ComputerCommand,
    targetWindowId: string | undefined,
    includeRef = true,
  ): Promise<InputRecoveryState> {
    const response = await callPowerShell({
      action: 'input_recovery_state',
      window: command.window ?? null,
      window_id: targetWindowId ?? null,
      ref: includeRef ? command.ref ?? null : null,
      session_id: sessionIdFor(command),
      read_only: true,
    });
    if (!response.ok) throw new Error(response.error || 'foreground input recovery lookup failed');
    const result = response.result || {};
    const recovery: InputRecoveryState = {
      targetWindowId: String(result.target_window_id || ''),
      foregroundWindowId: String(result.foreground_window_id || ''),
      restoreWindowId: String(result.restore_window_id || result.foreground_window_id || ''),
      restoreOwnerWindowId: String(result.restore_owner_window_id || ''),
      cursorX: Number(result.cursor_x),
      cursorY: Number(result.cursor_y),
    };
    if (!recovery.targetWindowId || !Number.isFinite(recovery.cursorX) || !Number.isFinite(recovery.cursorY)) {
      throw new Error('foreground input recovery state is incomplete; no input was sent');
    }
    return recovery;
  }

  /** Where an input lands and whether it may be sent there: frame-bound
   *  coordinates become physical screen ones, and an observation-bound action
   *  must still target the window scope this session last observed. */
  async function resolveInputTarget(
    command: ComputerCommand,
    action: string,
    trustedSequenceContinuation: boolean,
  ): Promise<ResolvedInputTarget> {
    let physicalX = command.x;
    let physicalY = command.y;
    let physicalToX = command.to_x;
    let physicalToY = command.to_y;
    let targetWindowId = command.window_id;
    let allowedWindowIds: string[] = [];
    let observedScope: ObservedWindowScope | undefined;
    const semanticPoint = visualPointForRef(command, command.ref);
    const semanticDestination = visualPointForRef(command, command.to);
    const pixelActions = new Set(['click', 'double_click', 'right_click', 'middle_click', 'triple_click', 'mouse_move']);
    if ((pixelActions.has(action)
        || (action === 'type' && command.x !== undefined && command.y !== undefined))
      && !command.ref) {
      if (command.x === undefined || command.y === undefined) {
        throw new Error(`${action} requires ref or frame-bound x/y coordinates`);
      }
      const frame = await requireValidFrame(command);
      const point = framePoint(frame, command.x, command.y);
      physicalX = point.x;
      physicalY = point.y;
      targetWindowId = frame.windowId || targetWindowId;
      allowedWindowIds = frame.relatedWindowIds || (targetWindowId ? [targetWindowId] : []);
    }
    if (action === 'drag' && !command.ref) {
      if (command.x === undefined || command.y === undefined
        || command.to_x === undefined || command.to_y === undefined) {
        throw new Error('drag requires ref/to or frame-bound x/y/to_x/to_y coordinates');
      }
      const frame = await requireValidFrame(command);
      const from = framePoint(frame, command.x, command.y);
      const to = framePoint(frame, command.to_x, command.to_y);
      physicalX = from.x;
      physicalY = from.y;
      physicalToX = to.x;
      physicalToY = to.y;
      targetWindowId = frame.windowId || targetWindowId;
      if (!targetWindowId) throw new Error('coordinate drag requires a window capture frame');
      allowedWindowIds = frame.relatedWindowIds || [targetWindowId];
    }
    if (action === 'scroll' && !command.ref
      && (command.x !== undefined || command.y !== undefined)) {
      if (command.x === undefined || command.y === undefined) {
        throw new Error('coordinate scroll requires frame-bound x and y');
      }
      const frame = await requireValidFrame(command);
      const point = framePoint(frame, command.x, command.y);
      physicalX = point.x;
      physicalY = point.y;
      targetWindowId = frame.windowId || targetWindowId;
      if (!targetWindowId) throw new Error('coordinate scroll requires a window capture frame');
      allowedWindowIds = frame.relatedWindowIds || [targetWindowId];
    }
    if (OBSERVATION_BOUND_INPUT_ACTIONS.has(action)) {
      observedScope = freshObservedWindowScope(command);
      if (!observedScope && !(trustedSequenceContinuation && targetWindowId)) {
        throw new Error(`${action} requires a fresh capture/snapshot/find of the exact target window first`);
      }
      if (observedScope
        && targetWindowId
        && !observedScope.relatedWindowIds.includes(targetWindowId)) {
        throw new Error(
          `stale_target: ${action} targets ${targetWindowId}, but the latest observation is `
            + observedScope.primaryWindowId,
        );
      }
      targetWindowId = targetWindowId || observedScope?.primaryWindowId;
    }
    return {
      physicalX,
      physicalY,
      physicalToX,
      physicalToY,
      cursorX: physicalX ?? semanticPoint?.x,
      cursorY: physicalY ?? semanticPoint?.y,
      cursorToX: physicalToX ?? semanticDestination?.x,
      cursorToY: physicalToY ?? semanticDestination?.y,
      targetWindowId,
      allowedWindowIds,
      observedScope,
    };
  }

  /** Prove the desktop was handed back after foreground input: the window that
   *  held focus holds it again and the cursor sits where the user left it. One
   *  reassertion is allowed, and what actually happened is always reported. */
  async function verifyInputRecovery(
    command: ComputerCommand,
    targetWindowId: string | undefined,
    inputRecovery: InputRecoveryState,
    timings: Record<string, number>,
  ): Promise<Record<string, unknown>> {
    let current: InputRecoveryState | undefined;
    let reasserted = false;
    let restoredTarget = '';
    let readbackError = '';
    const preserveFocusForFollowup = FOCUS_CONTINUATION_ACTIONS.has(
      String(command.action || ''),
    );
    try {
      current = await readInputRecovery(command, targetWindowId, false);
    } catch (error) {
      readbackError = (error as Error).message || String(error);
    }
    try {
      const focusDrifted = !current
        || current.foregroundWindowId !== inputRecovery.restoreWindowId;
      const cursorDrifted = !current
        || current.cursorX !== inputRecovery.cursorX
        || current.cursorY !== inputRecovery.cursorY;
      if (!current || cursorDrifted || (focusDrifted && !preserveFocusForFollowup)) {
        const recoveryStartedAt = performance.now();
        const restored = await callPowerShell({
          action: 'restore_input_state',
          restore_window_id: inputRecovery.restoreWindowId,
          restore_owner_window_id: inputRecovery.restoreOwnerWindowId,
          cursor_x: inputRecovery.cursorX,
          cursor_y: inputRecovery.cursorY,
          restore_focus: !preserveFocusForFollowup,
          session_id: sessionIdFor(command),
        });
        timings.input_recovery_ms = elapsedMs(recoveryStartedAt);
        if (!restored.ok) throw new Error(restored.error || 'input recovery reassertion failed');
        restoredTarget = String(restored.result?.restored_target || '');
        current = {
          targetWindowId: inputRecovery.targetWindowId,
          foregroundWindowId: String(restored.result?.foreground_window_id || ''),
          restoreWindowId: inputRecovery.restoreWindowId,
          restoreOwnerWindowId: inputRecovery.restoreOwnerWindowId,
          cursorX: Number(restored.result?.cursor_x),
          cursorY: Number(restored.result?.cursor_y),
        };
        reasserted = true;
      }
      // Landing on the owner is the honest outcome when the action closed the
      // window that held focus; any other destination is still a miss.
      const focusRestored = current.foregroundWindowId === inputRecovery.restoreWindowId
        || (restoredTarget === 'owner'
          && inputRecovery.restoreOwnerWindowId !== ''
          && current.foregroundWindowId === inputRecovery.restoreOwnerWindowId);
      const focusPreservedForFollowup = preserveFocusForFollowup
        && current.foregroundWindowId !== ''
        && !focusRestored;
      const cursorRestored = current.cursorX === inputRecovery.cursorX
        && current.cursorY === inputRecovery.cursorY;
      return {
        ok: (focusRestored || focusPreservedForFollowup) && cursorRestored,
        focus_restored: focusRestored,
        focus_preserved_for_followup: focusPreservedForFollowup,
        focus_recovery: focusPreservedForFollowup ? 'session_release' : 'immediate',
        cursor_restored: cursorRestored,
        expected_focus_window_id: inputRecovery.restoreWindowId,
        actual_focus_window_id: current.foregroundWindowId,
        expected_cursor: [inputRecovery.cursorX, inputRecovery.cursorY],
        actual_cursor: [current.cursorX, current.cursorY],
        reasserted,
        ...(restoredTarget === 'owner' ? { restored_target: 'owner_after_close' } : {}),
        ...(readbackError ? { readback_error: readbackError } : {}),
      };
    } catch (error) {
      return {
        ok: false,
        focus_restored: false,
        cursor_restored: false,
        error: (error as Error).message || String(error),
        ...(readbackError ? { readback_error: readbackError } : {}),
      };
    }
  }

  /** Let the desktop settle after a mutation and report what moved. A launch
   *  polls until its successor window exists or the budget ends; every other
   *  action pays one settle and then reads the window list once. */
  async function settleWindowTransition(input: {
    command: ComputerCommand;
    action: string;
    windowsBefore: ComputerWindowRecord[] | null;
    targetWindowId: string;
    pid: number;
    appHint: string;
    timings: Record<string, number>;
  }): Promise<{ transition: ComputerWindowTransition | null; settleDelayMs: number }> {
    const { command, action, windowsBefore, timings } = input;
    const settleStartedAt = performance.now();
    let settleDelayMs = screenshotInteger(
      command.capture_after ? command.capture_delay_ms : undefined,
      DEFAULT_CAPTURE_AFTER_DELAY_MS,
      0,
      MAX_CAPTURE_AFTER_DELAY_MS,
      'capture_delay_ms',
    );
    let transition: ComputerWindowTransition | null = null;
    let windowScanMs = 0;
    const transitionFor = (windowsAfter: ComputerWindowRecord[] | null) =>
      windowsBefore && windowsAfter
        ? computeComputerWindowTransition(
            windowsBefore,
            windowsAfter,
            input.targetWindowId,
            input.pid,
            input.appHint,
          )
        : null;
    if (action === 'launch') {
      const deadline = settleStartedAt + Math.max(settleDelayMs, LAUNCH_SUCCESSOR_TIMEOUT_MS);
      const minimumLaunchSettleMs = Math.max(settleDelayMs, 500);
      let launchSuccessorReady = false;
      do {
        const remainingMs = Math.max(0, deadline - performance.now());
        if (remainingMs > 0) {
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(LAUNCH_POLL_INTERVAL_MS, remainingMs)));
        }
        assertExecutionNotAborted();
        const transitionStartedAt = performance.now();
        const includeAppMetadata =
          performance.now() - settleStartedAt >= minimumLaunchSettleMs;
        const windowsAfter = await readComputerWindows(command, includeAppMetadata);
        windowScanMs += elapsedMs(transitionStartedAt);
        transition = transitionFor(windowsAfter);
        launchSuccessorReady = Boolean(transition?.next_target)
          && performance.now() - settleStartedAt >= minimumLaunchSettleMs;
      } while (!launchSuccessorReady && performance.now() < deadline);
      settleDelayMs = Math.round(performance.now() - settleStartedAt);
    } else {
      // The settle budget is not shortened by watching for the transition to
      // START: a window closing or opening is the beginning of the move, and
      // the successor surface still needs this window to build its tree.
      // Measured: exiting on that signal returned empty parent trees.
      if (settleDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, settleDelayMs));
      assertExecutionNotAborted();
      const transitionStartedAt = performance.now();
      const windowsAfter = await readComputerWindows(command);
      windowScanMs = elapsedMs(transitionStartedAt);
      transition = transitionFor(windowsAfter);
    }
    timings.settle_ms = Math.max(0, elapsedMs(settleStartedAt) - windowScanMs);
    timings.after_windows_ms = Number(windowScanMs.toFixed(2));
    return { transition, settleDelayMs };
  }

  return {
    readInputRecovery,
    resolveInputTarget,
    verifyInputRecovery,
    settleWindowTransition,
  };
}

export type InputResolution = ReturnType<typeof createInputResolution>;

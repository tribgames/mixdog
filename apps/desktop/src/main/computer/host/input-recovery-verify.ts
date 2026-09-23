/**
 * Whether a foreground delivery handed the desktop back. The observer must
 * still be the one recorded and no user input may have intervened; then focus
 * and pointer must be where they were — or, for a follow-up action, on the
 * target. A refused input that left focus untouched needs no restoration;
 * anything that drifted is reasserted once and read back. A refused input is
 * never conflated with failed cleanup: the reply builder reports the refusal,
 * this only closes cleanup.
 */
import { elapsedMs } from '../shared/common';
import type { ComputerCommand } from '../shared/types';
import { FOCUS_CONTINUATION_ACTIONS, FOREGROUND_KEY_ACTIONS } from './action-sets';
import type { InputRecoveryState } from './execution-state';
import { readInputRecovery } from './input-recovery-read';
import type { InputResolutionHost } from './input-resolution';

export type InputRecoveryVerifyHost = Pick<InputResolutionHost, 'callPowerShell' | 'sessionIdFor'>;

type Verdict = Record<string, unknown>;

interface RecoveryCheck {
  command: ComputerCommand;
  targetWindowId: string | undefined;
  /** The state recorded before dispatch. */
  inputRecovery: InputRecoveryState;
  timings: Record<string, number>;
  nativeResult: Record<string, unknown>;
  /** Visible input retains target focus for the action that follows it. */
  preserveFocusForFollowup: boolean;
  /** More input follows in this sequence, so the pointer stays where it acts. */
  holdCursor: boolean;
  readbackError: string;
}

function preservesFocusForFollowup(command: ComputerCommand): boolean {
  return (
    command.action === 'focus_window' ||
    FOCUS_CONTINUATION_ACTIONS.has(String(command.action || '')) ||
    (command.delivery === 'foreground' && FOREGROUND_KEY_ACTIONS.has(command.action))
  );
}

const withReadback = (check: RecoveryCheck) => (check.readbackError ? { readback_error: check.readbackError } : {});

const cursorMatches = (current: InputRecoveryState, inputRecovery: InputRecoveryState) =>
  current.cursorX === inputRecovery.cursorX && current.cursorY === inputRecovery.cursorY;

/** The readback is only evidence when the same observer recorded both states. */
function inputKnown(current: InputRecoveryState, inputRecovery: InputRecoveryState): boolean {
  return (
    current.inputObserverReady === true &&
    inputRecovery.inputObserverReady === true &&
    Boolean(current.inputMonitorId) &&
    current.inputMonitorId === inputRecovery.inputMonitorId &&
    Number.isSafeInteger(current.inputUserSequence) &&
    Number.isSafeInteger(inputRecovery.inputUserSequence)
  );
}

/** Verdicts the readback settles on its own, before any restoration. */
function readbackVerdict(check: RecoveryCheck, current: InputRecoveryState): Verdict | null {
  const { inputRecovery, nativeResult } = check;
  if (current.inputUserSequence !== inputRecovery.inputUserSequence) {
    return {
      ok: false,
      recovery_skipped: true,
      user_control: true,
      code: 'user_input_active',
      ...withReadback(check),
    };
  }
  if (current.targetExists === false) {
    // The owner was recorded before dispatch, not inferred from the new
    // foreground. A missing observer or intervening user input still fails above.
    const returnedToOwner =
      Boolean(inputRecovery.targetOwnerWindowId) && current.foregroundWindowId === inputRecovery.targetOwnerWindowId;
    const cursorUnchanged = cursorMatches(current, inputRecovery);
    return {
      ok: returnedToOwner && cursorUnchanged,
      target_closed: true,
      focus_preserved_for_followup: returnedToOwner,
      cursor_restored: cursorUnchanged,
      reasserted: false,
    };
  }
  // An explicitly refused input that left focus where it was needs no
  // restoration to an older session focus.
  if (
    nativeResult.delivery_accepted === false &&
    current.foregroundWindowId === inputRecovery.foregroundWindowId &&
    cursorMatches(current, inputRecovery)
  ) {
    return {
      ok: true,
      recovery_skipped: true,
      focus_unchanged: true,
      input_not_dispatched: true,
      cursor_restored: true,
      reasserted: false,
    };
  }
  return null;
}

/** Put focus and pointer back once, and read the state the restore reports. */
async function reassertInputState(
  host: InputRecoveryVerifyHost,
  check: RecoveryCheck,
  current: InputRecoveryState
): Promise<{ current: InputRecoveryState; restoredTarget: string }> {
  const { command, targetWindowId, inputRecovery, timings, preserveFocusForFollowup } = check;
  const recoveryStartedAt = performance.now();
  const restored = await host.callPowerShell({
    action: 'restore_input_state',
    window_id: targetWindowId,
    restore_window_id: inputRecovery.restoreWindowId,
    restore_owner_window_id: inputRecovery.restoreOwnerWindowId,
    cursor_x: inputRecovery.cursorX,
    cursor_y: inputRecovery.cursorY,
    restore_focus: !preserveFocusForFollowup,
    expected_input_tick: current.inputTick,
    expected_input_monitor_id: current.inputMonitorId,
    expected_input_user_sequence: current.inputUserSequence,
    known_injection_tick: command.known_injection_tick,
    session_id: host.sessionIdFor(command),
  });
  timings.input_recovery_ms = elapsedMs(recoveryStartedAt);
  if (!restored.ok) throw new Error(restored.error || 'input recovery reassertion failed');
  const result = restored.result;
  return {
    restoredTarget: String(result?.restored_target || ''),
    current: {
      targetWindowId: inputRecovery.targetWindowId,
      foregroundWindowId: String(result?.foreground_window_id || ''),
      restoreWindowId: inputRecovery.restoreWindowId,
      restoreOwnerWindowId: inputRecovery.restoreOwnerWindowId,
      cursorX: Number(result?.cursor_x),
      cursorY: Number(result?.cursor_y),
      inputTick: Number(result?.input_tick),
      inputObserverReady: result?.input_observer_ready === true,
      inputMonitorId: String(result?.input_monitor_id || ''),
      inputUserSequence: Number(result?.input_user_sequence),
      syntheticInput: result?.synthetic_input === true,
      foregroundWithinTarget: result?.foreground_within_target === true,
    },
  };
}

function recoveryVerdict(
  check: RecoveryCheck,
  current: InputRecoveryState,
  reasserted: boolean,
  restoredTarget: string
): Verdict {
  const { command, targetWindowId, inputRecovery, preserveFocusForFollowup } = check;
  if (
    current.inputObserverReady !== true ||
    current.inputMonitorId !== inputRecovery.inputMonitorId ||
    !Number.isSafeInteger(current.inputUserSequence)
  ) {
    return { ok: false, recovery_skipped: true, code: 'input_observation_unavailable' };
  }
  if (current.inputUserSequence !== inputRecovery.inputUserSequence) {
    return { ok: false, recovery_skipped: true, user_control: true, code: 'user_input_active' };
  }
  // Landing on the owner is the honest outcome when the action closed the
  // window that held focus; any other destination is still a miss.
  const focusRestored =
    current.foregroundWindowId === inputRecovery.restoreWindowId ||
    (restoredTarget === 'owner' &&
      inputRecovery.restoreOwnerWindowId !== '' &&
      current.foregroundWindowId === inputRecovery.restoreOwnerWindowId);
  const focusPreservedForFollowup =
    preserveFocusForFollowup &&
    (current.foregroundWindowId === targetWindowId ||
      current.foregroundWithinTarget === true ||
      (command.delivery === 'foreground' && current.foregroundChildProcess === true)) &&
    !focusRestored;
  const cursorRestored = cursorMatches(current, inputRecovery);
  return {
    ok: (focusRestored || focusPreservedForFollowup) && (cursorRestored || check.holdCursor),
    ...(check.holdCursor ? { cursor_held_for_followup: true } : {}),
    focus_restored: focusRestored,
    focus_preserved_for_followup: focusPreservedForFollowup,
    focus_transition_to_child: focusPreservedForFollowup && current.foregroundChildProcess === true,
    focus_recovery: focusPreservedForFollowup ? 'session_release' : 'immediate',
    cursor_restored: cursorRestored,
    expected_focus_window_id: inputRecovery.restoreWindowId,
    actual_focus_window_id: current.foregroundWindowId,
    expected_cursor: [inputRecovery.cursorX, inputRecovery.cursorY],
    actual_cursor: [current.cursorX, current.cursorY],
    reasserted,
    ...(restoredTarget === 'owner' ? { restored_target: 'owner_after_close' } : {}),
    ...withReadback(check),
  };
}

export async function verifyInputRecovery(
  host: InputRecoveryVerifyHost,
  command: ComputerCommand,
  targetWindowId: string | undefined,
  inputRecovery: InputRecoveryState,
  timings: Record<string, number>,
  nativeResult: Record<string, unknown> = {},
  holdCursor = false
): Promise<Verdict> {
  const check: RecoveryCheck = {
    command,
    targetWindowId,
    inputRecovery,
    timings,
    nativeResult,
    preserveFocusForFollowup: preservesFocusForFollowup(command),
    holdCursor,
    readbackError: '',
  };
  let current: InputRecoveryState | undefined;
  try {
    current = await readInputRecovery(host, command, targetWindowId, false);
  } catch (error) {
    check.readbackError = (error as Error).message || String(error);
  }
  try {
    if (!current || !inputKnown(current, inputRecovery)) {
      return {
        ok: false,
        recovery_skipped: true,
        code: 'input_observation_unavailable',
        ...withReadback(check),
      };
    }
    const early = readbackVerdict(check, current);
    if (early) return early;
    let reasserted = false;
    let restoredTarget = '';
    const focusDrifted = current.foregroundWindowId !== inputRecovery.restoreWindowId;
    // Foreground input borrows the one system pointer and gives it back. A
    // sequence gives it back once, at the step that ends it: returning the
    // pointer between steps would send it across the screen twice for every
    // click or keystroke that still has input behind it.
    const cursorDrifted = !cursorMatches(current, inputRecovery);
    if ((cursorDrifted && !check.holdCursor) || (focusDrifted && !check.preserveFocusForFollowup)) {
      ({ current, restoredTarget } = await reassertInputState(host, check, current));
      reasserted = true;
    }
    return recoveryVerdict(check, current, reasserted, restoredTarget);
  } catch (error) {
    return {
      ok: false,
      ...(/user_input_active/.test(String(error)) ? { user_control: true, recovery_skipped: true } : {}),
      focus_restored: false,
      cursor_restored: false,
      error: (error as Error).message || String(error),
      ...withReadback(check),
    };
  }
}

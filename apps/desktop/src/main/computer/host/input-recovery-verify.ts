/**
 * Whether a foreground delivery left the desktop where it belongs. The observer
 * must still be the one recorded and no user input may have intervened; then
 * focus and pointer must be back where they were — unless a session holds the
 * desktop, which keeps both until its release. A refused input that left focus
 * untouched needs no restoration;
 * anything that drifted is reasserted once and read back. A refused input is
 * never conflated with failed cleanup: the reply builder reports the refusal,
 * this only closes cleanup.
 */
import { elapsedMs } from '../shared/common';
import type { ComputerCommand } from '../shared/types';
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
  /** Focus stays on the target for an explicit focus request or a session
   *  holding the desktop; the user's window gets it back only at release.
   *  Keys the user types between commands therefore reach the target, and the
   *  session stands down as soon as it observes them. */
  preserveFocusForFollowup: boolean;
  /** The session owns the desktop until it releases: focus stays on the target
   *  and the pointer where it acts; the user's own state returns at release. */
  holdDesktop: boolean;
  readbackError: string;
}

/** Focus stays on the target for an explicit focus request or a session
 *  holding the desktop until its release. */
function preservesFocusForFollowup(command: ComputerCommand, holdsDesktop: boolean): boolean {
  return command.action === 'focus_window' || holdsDesktop;
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
    // Focus that belongs back with the user's own window is returned by the
    // general restore; the owner is home only when the closed window held it.
    if (!check.preserveFocusForFollowup && inputRecovery.restoreWindowId !== check.targetWindowId) return null;
    // The owner was recorded before dispatch, not inferred from the new
    // foreground. A missing observer or intervening user input still fails above.
    const returnedToOwner =
      Boolean(inputRecovery.targetOwnerWindowId) && current.foregroundWindowId === inputRecovery.targetOwnerWindowId;
    const cursorSame = cursorMatches(current, inputRecovery);
    const cursorUnchanged = check.holdDesktop || cursorSame;
    // A held session keeps the pointer; focus that did not reach the owner is
    // sent home by the general restore.
    if (!returnedToOwner && check.holdDesktop) return null;
    // A click that closed its window still borrowed the pointer; focus is
    // already home, so the caller puts only the pointer back.
    if (returnedToOwner && !cursorUnchanged) return null;
    return {
      ok: returnedToOwner && cursorUnchanged,
      target_closed: true,
      focus_preserved_for_followup: returnedToOwner,
      ...(check.holdDesktop ? { cursor_held_for_followup: true } : {}),
      cursor_restored: cursorSame,
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
    // A held session never moves the pointer; it only sends focus home.
    cursor_x: check.holdDesktop ? current.cursorX : inputRecovery.cursorX,
    cursor_y: check.holdDesktop ? current.cursorY : inputRecovery.cursorY,
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
  // A held session hands nothing back until release, and no user input
  // intervened: a window the action itself brought forward is the session's.
  const focusMovedByAction = check.holdDesktop && !focusRestored && !focusPreservedForFollowup;
  return {
    ok: (focusRestored || focusPreservedForFollowup || check.holdDesktop) && (cursorRestored || check.holdDesktop),
    ...(check.holdDesktop ? { cursor_held_for_followup: true } : {}),
    focus_restored: focusRestored,
    focus_preserved_for_followup: focusPreservedForFollowup,
    ...(focusMovedByAction ? { focus_moved_by_action: true } : {}),
    focus_transition_to_child: focusPreservedForFollowup && current.foregroundChildProcess === true,
    focus_recovery: focusPreservedForFollowup || focusMovedByAction ? 'session_release' : 'immediate',
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
  holdDesktop = false
): Promise<Verdict> {
  const check: RecoveryCheck = {
    command,
    targetWindowId,
    inputRecovery,
    timings,
    nativeResult,
    preserveFocusForFollowup: preservesFocusForFollowup(command, holdDesktop),
    holdDesktop,
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
    // A closed target has no focus left to hold: focus goes home, pointer stays.
    if (current.targetExists === false && check.holdDesktop) check.preserveFocusForFollowup = false;
    if (current.targetExists === false && check.preserveFocusForFollowup) {
      ({ current } = await reassertInputState(host, check, current));
      const observed =
        current.inputObserverReady === true &&
        current.inputMonitorId === inputRecovery.inputMonitorId &&
        current.inputUserSequence === inputRecovery.inputUserSequence;
      const returnedToOwner = current.foregroundWindowId === inputRecovery.targetOwnerWindowId;
      const cursorRestored = cursorMatches(current, inputRecovery);
      return {
        ok: observed && returnedToOwner && cursorRestored,
        target_closed: true,
        focus_preserved_for_followup: returnedToOwner,
        cursor_restored: cursorRestored,
        reasserted: true,
        ...withReadback(check),
      };
    }
    let reasserted = false;
    let restoredTarget = '';
    const focusDrifted = current.foregroundWindowId !== inputRecovery.restoreWindowId;
    // A session gives pointer and focus back once, at release; returning them
    // between commands would send the pointer across the screen every time.
    const cursorDrifted = !cursorMatches(current, inputRecovery);
    if ((cursorDrifted && !check.holdDesktop) || (focusDrifted && !check.preserveFocusForFollowup)) {
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

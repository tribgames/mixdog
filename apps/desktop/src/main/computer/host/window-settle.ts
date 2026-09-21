/**
 * Let the desktop settle after a mutation and report what moved. A launch
 * polls until its successor window exists or the budget ends; every other
 * action pays one settle and then reads the window list once. The settle
 * budget is never shortened by watching for the transition to START: a
 * window closing or opening is the beginning of the move, and the successor
 * surface still needs this window to build its tree. Measured: exiting on
 * that signal returned empty parent trees.
 */
import { screenshotInteger } from '../observation/analysis';
import { DEFAULT_CAPTURE_AFTER_DELAY_MS, MAX_CAPTURE_AFTER_DELAY_MS, elapsedMs } from '../shared/common';
import type { ComputerCommand } from '../shared/types';
import {
  computeComputerWindowTransition,
  type ComputerWindowRecord,
  type ComputerWindowTransition,
} from '../shared/window-transition';
import type { InputResolutionHost } from './input-resolution';

const LAUNCH_SUCCESSOR_TIMEOUT_MS = 4_000;
const LAUNCH_POLL_INTERVAL_MS = 100;
/** A modal dialog is created after the action returns, so one scan taken at
 *  the settle mark can end before the dialog exists. Both watches below cost
 *  nothing when no dialog appears beyond the scans they take. */
const DIALOG_WATCH_TIMEOUT_MS = { expected: 1_200, focus_gap: 600 } as const;
const DIALOG_POLL_INTERVAL_MS = 100;

export type DialogSuccessorWatch = 'none' | 'expected' | 'focus_gap';

/** Windows labels a command that opens a dialog with a trailing ellipsis;
 *  invoking one is a promise that a window is coming. */
function menuPathOpensDialog(menuPath: unknown): boolean {
  if (!Array.isArray(menuPath)) return false;
  const leaf = String(menuPath.at(-1) || '').trim();
  return leaf.endsWith('...') || leaf.endsWith('…');
}

/** Whether the first scan may have run before the dialog existed: either the
 *  command promised one, or focus currently belongs to no listed window —
 *  the gap a modal leaves while it is being created. */
export function dialogSuccessorWatch(
  action: string,
  menuPath: unknown,
  transition: ComputerWindowTransition | null
): DialogSuccessorWatch {
  if (!transition || transition.opened_windows.length > 0) return 'none';
  if (action === 'invoke_menu' && menuPathOpensDialog(menuPath)) return 'expected';
  if (transition.closed_windows.length === 0 && transition.focused_after === '') return 'focus_gap';
  return 'none';
}

export function dialogWatchSettled(watch: DialogSuccessorWatch, transition: ComputerWindowTransition | null): boolean {
  if (!transition) return true;
  if (transition.opened_windows.length > 0) return true;
  // A promised dialog is worth the whole budget; a focus gap is settled as
  // soon as some window owns focus again.
  return watch === 'focus_gap' ? transition.focused_after !== '' : false;
}

export type WindowSettleHost = Pick<InputResolutionHost, 'assertExecutionNotAborted' | 'readComputerWindows'>;

export interface WindowSettleInput {
  command: ComputerCommand;
  action: string;
  windowsBefore: ComputerWindowRecord[] | null;
  targetWindowId: string;
  pid: number;
  appHint: string;
  timings: Record<string, number>;
}

export interface WindowSettleOutcome {
  transition: ComputerWindowTransition | null;
  settleDelayMs: number;
}

/** One read of the window list, accounted to `scan`, and the transition it
 *  shows against the list taken before the action. */
async function scanTransition(
  host: WindowSettleHost,
  input: WindowSettleInput,
  scan: { ms: number },
  includeAppMetadata?: boolean
): Promise<ComputerWindowTransition | null> {
  const startedAt = performance.now();
  const windowsAfter = await host.readComputerWindows(input.command, includeAppMetadata);
  scan.ms += elapsedMs(startedAt);
  return input.windowsBefore && windowsAfter
    ? computeComputerWindowTransition(input.windowsBefore, windowsAfter, input.targetWindowId, input.pid, input.appHint)
    : null;
}

async function awaitLaunchSuccessor(
  host: WindowSettleHost,
  input: WindowSettleInput,
  settleStartedAt: number,
  settleDelayMs: number,
  scan: { ms: number }
): Promise<WindowSettleOutcome> {
  const deadline = settleStartedAt + Math.max(settleDelayMs, LAUNCH_SUCCESSOR_TIMEOUT_MS);
  const minimumLaunchSettleMs = Math.max(settleDelayMs, 500);
  let transition: ComputerWindowTransition | null = null;
  let launchSuccessorReady = false;
  do {
    const remainingMs = Math.max(0, deadline - performance.now());
    if (remainingMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(LAUNCH_POLL_INTERVAL_MS, remainingMs)));
    }
    host.assertExecutionNotAborted();
    const includeAppMetadata = performance.now() - settleStartedAt >= minimumLaunchSettleMs;
    transition = await scanTransition(host, input, scan, includeAppMetadata);
    launchSuccessorReady =
      Boolean(transition?.next_target) && performance.now() - settleStartedAt >= minimumLaunchSettleMs;
  } while (!launchSuccessorReady && performance.now() < deadline);
  return { transition, settleDelayMs: Math.round(performance.now() - settleStartedAt) };
}

/** Keep scanning until the dialog the action opened is listed, or the watch
 *  settles, or the budget ends. */
async function awaitDialogSuccessor(
  host: WindowSettleHost,
  input: WindowSettleInput,
  scan: { ms: number },
  watch: Exclude<DialogSuccessorWatch, 'none'>,
  first: ComputerWindowTransition | null
): Promise<ComputerWindowTransition | null> {
  const deadline = performance.now() + DIALOG_WATCH_TIMEOUT_MS[watch];
  let transition = first;
  while (performance.now() < deadline) {
    const remainingMs = Math.max(0, deadline - performance.now());
    await new Promise((resolve) => setTimeout(resolve, Math.min(DIALOG_POLL_INTERVAL_MS, remainingMs)));
    host.assertExecutionNotAborted();
    const next = await scanTransition(host, input, scan);
    if (!next) break;
    transition = next;
    if (dialogWatchSettled(watch, next)) break;
  }
  return transition;
}

export async function settleWindowTransition(
  host: WindowSettleHost,
  input: WindowSettleInput
): Promise<WindowSettleOutcome> {
  const { command, action, timings } = input;
  const settleStartedAt = performance.now();
  const settleDelayMs = screenshotInteger(
    command.capture_after ? command.capture_delay_ms : undefined,
    DEFAULT_CAPTURE_AFTER_DELAY_MS,
    0,
    MAX_CAPTURE_AFTER_DELAY_MS,
    'capture_delay_ms'
  );
  const scan = { ms: 0 };
  let outcome: WindowSettleOutcome;
  if (action === 'launch') {
    outcome = await awaitLaunchSuccessor(host, input, settleStartedAt, settleDelayMs, scan);
  } else {
    if (settleDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, settleDelayMs));
    host.assertExecutionNotAborted();
    let transition = await scanTransition(host, input, scan);
    const watch = dialogSuccessorWatch(action, command.path, transition);
    if (watch !== 'none') {
      transition = await awaitDialogSuccessor(host, input, scan, watch, transition);
      outcome = { transition, settleDelayMs: Math.round(performance.now() - settleStartedAt) };
    } else {
      outcome = { transition, settleDelayMs };
    }
  }
  timings.settle_ms = Math.max(0, elapsedMs(settleStartedAt) - scan.ms);
  timings.after_windows_ms = Number(scan.ms.toFixed(2));
  return outcome;
}

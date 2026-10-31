/**
 * The input observer's view around a capture: the bounded read of its monitor
 * and sequence, and whether the two reads bracketing a capture prove the
 * foreground stayed untouched.
 */
import type { ComputerCommand, ComputerInputObservation } from '../shared/types';
import { CAPTURE_ACCESSIBILITY_TIMEOUT_MS, sleep } from '../shared/common';

/** The native observer's reason while it recovers from input it could not
 *  attribute: it is ready again after about 300 ms without input. */
export const INPUT_GAP_REASON = 'input_gap';
const INPUT_GAP_SETTLE_MS = 1_000;
const INPUT_GAP_POLL_MS = 100;

/** Re-reads while the observer is still recovering from an input gap, up to a
 *  bounded wait. A gap that outlasts it means input is still arriving. */
export async function settleInputGap<T>(
  read: () => Promise<T>,
  inGap: (value: T) => boolean,
  assertNotAborted: () => void
): Promise<T> {
  const deadline = performance.now() + INPUT_GAP_SETTLE_MS;
  let value = await read();
  while (inGap(value) && performance.now() < deadline) {
    await sleep(INPUT_GAP_POLL_MS);
    assertNotAborted();
    value = await read();
  }
  return value;
}

export interface InputObservationHost {
  callPowerShell(
    request: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }>;
  sessionIdFor(command: ComputerCommand): string;
  assertExecutionNotAborted(): void;
}

export function createInputObservationReader(host: InputObservationHost, command: ComputerCommand) {
  const readOnce = async (): Promise<ComputerInputObservation | undefined> => {
    host.assertExecutionNotAborted();
    try {
      const response = await host.callPowerShell(
        {
          action: 'input_idle_state',
          session_id: host.sessionIdFor(command),
          read_only: true,
        },
        CAPTURE_ACCESSIBILITY_TIMEOUT_MS
      );
      host.assertExecutionNotAborted();
      const result = response.result;
      if (
        !response.ok ||
        typeof result?.monitor !== 'string' ||
        !result.monitor ||
        !Number.isSafeInteger(result.sequence) ||
        Number(result.sequence) < 0
      )
        return undefined;
      const ready = result.observer_ready === true;
      const reason = !ready && typeof result.observer_reason === 'string' ? result.observer_reason : '';
      return { ready, monitor: result.monitor, sequence: Number(result.sequence), ...(reason ? { reason } : {}) };
    } catch {
      host.assertExecutionNotAborted();
      return undefined;
    }
  };
  return async (): Promise<ComputerInputObservation | undefined> => {
    const reads: Array<ComputerInputObservation | undefined> = [];
    const settled = await settleInputGap(
      async () => {
        const observation = await readOnce();
        reads.push(observation);
        return observation;
      },
      (observation) => observation?.ready === false && observation.reason === INPUT_GAP_REASON,
      () => host.assertExecutionNotAborted()
    );
    // The observer counts a gap once, when it opens, so the gap read already
    // carries that count and a clean recovery keeps it. Any later change is
    // more input during the wait: the gap read stays the refused baseline.
    const first = reads[0];
    return first && settled && (first.monitor !== settled.monitor || first.sequence !== settled.sequence)
      ? first
      : settled;
  };
}

/** A different monitor after the capture means its observation worker was replaced. */
export function inputMonitorChanged(
  before: ComputerInputObservation | undefined,
  after: ComputerInputObservation | undefined
): boolean {
  return Boolean(before && after && before.monitor !== after.monitor);
}

/** User input during the capture never fails it: the capture is published
 *  without a foreground-ready observation, so foreground input refuses it and
 *  background input proceeds. */
export function settleInputObservation(
  before: ComputerInputObservation | undefined,
  after: ComputerInputObservation | undefined
): {
  inputObservation: ComputerInputObservation | undefined;
  foregroundReady: boolean;
  foregroundInputReason?: string;
} {
  const { foregroundReady, foregroundInputReason } = foregroundInputState(before, after);
  if (!before) return { inputObservation: before, foregroundReady, foregroundInputReason };
  const inputObservation = {
    ...before,
    ready: foregroundReady,
    ...(foregroundReady ? {} : { reason: foregroundInputReason || 'unknown' }),
  };
  return { inputObservation, foregroundReady, foregroundInputReason };
}

export function foregroundInputState(
  before: ComputerInputObservation | undefined,
  after: ComputerInputObservation | undefined
): { foregroundReady: boolean; foregroundInputReason?: string } {
  const foregroundReady =
    before?.ready === true &&
    after?.ready === true &&
    before.monitor === after.monitor &&
    before.sequence === after.sequence;
  if (foregroundReady) return { foregroundReady };
  // A gap that outlasted the settle wait is input still arriving, not a broken observer.
  const unavailable = (observation: ComputerInputObservation | undefined) =>
    observation?.ready !== true && observation?.reason !== INPUT_GAP_REASON;
  return {
    foregroundReady,
    foregroundInputReason:
      unavailable(before) || unavailable(after) ? 'input_observer_unavailable' : 'user_input_during_capture',
  };
}

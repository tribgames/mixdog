/**
 * The input observer's view around a capture: the bounded read of its monitor
 * and sequence, and whether the two reads bracketing a capture prove the
 * foreground stayed untouched.
 */
import type { ComputerCommand, ComputerInputObservation } from '../shared/types';
import { CAPTURE_ACCESSIBILITY_TIMEOUT_MS } from '../shared/common';

export interface InputObservationHost {
  callPowerShell(
    request: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }>;
  sessionIdFor(command: ComputerCommand): string;
  assertExecutionNotAborted(): void;
}

export function createInputObservationReader(host: InputObservationHost, command: ComputerCommand) {
  return async (): Promise<ComputerInputObservation | undefined> => {
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
      return { ready: result.observer_ready === true, monitor: result.monitor, sequence: Number(result.sequence) };
    } catch {
      host.assertExecutionNotAborted();
      return undefined;
    }
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
  return {
    foregroundReady,
    foregroundInputReason:
      before?.ready !== true || after?.ready !== true ? 'input_observer_unavailable' : 'user_input_during_capture',
  };
}

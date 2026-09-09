/** Native batching stops at each step so pause and target transitions stay host-owned. */
import { electronWindowForNativeId } from '../observation/window-handles';
import { filterComputerUseInternalWindows } from '../overlay/internal-windows';
import { computerTimings } from '../shared/timings';
import { normalizeComputerWindowRecords, computeComputerWindowTransition } from '../shared/window-transition';
import type { ComputerCommand, PowerShellResponse } from '../shared/types';

export function canBatchSequenceInput(command: ComputerCommand, windowId?: string): boolean {
  // Foreground recovery and Electron insertText retain their existing owners.
  return Boolean(windowId)
    && command.delivery !== 'foreground'
    && !(command.action === 'type' && !command.ref && electronWindowForNativeId(windowId));
}

export function sequenceStepRequest(step: Record<string, unknown>): Record<string, unknown> {
  return {
    action: 'sequence_step', delivery: 'background',
    session_id: step.session_id, read_only: step.read_only, step,
  };
}

export function readSequenceStep(
  payload: PowerShellResponse['result'],
  windowId: string,
  roundtripMs: number,
) {
  if (!payload?.step_result || typeof payload.step_result !== 'object'
    || Array.isArray(payload.step_result)
    || !Array.isArray(payload.windows_before) || !Array.isArray(payload.windows_after)
    || typeof payload.settle_delay_ms !== 'number' || !Number.isFinite(payload.settle_delay_ms)
    || payload.settle_delay_ms < 0) {
    throw new Error('sequence_observation_unavailable: incomplete native step reply; input will not be retried');
  }
  const result = payload.step_result as NonNullable<PowerShellResponse['result']>;
  const before = filterComputerUseInternalWindows(normalizeComputerWindowRecords(payload.windows_before));
  const after = filterComputerUseInternalWindows(normalizeComputerWindowRecords(payload.windows_after));
  return {
    result,
    before,
    transition: computeComputerWindowTransition(before, after, windowId, Number(result.pid) || 0, ''),
    settleDelayMs: payload.settle_delay_ms,
    timings: { ...computerTimings(payload.timings_ms), backend_roundtrip_ms: roundtripMs },
  };
}

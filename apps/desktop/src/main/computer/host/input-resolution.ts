/**
 * Where an input lands and what the desktop looked like around it: frame
 * coordinates become physical ones, foreground input records the state it must
 * hand back, and a mutation waits for the desktop to settle before the window
 * transition is read.
 */
import type { CaptureFrame, ComputerCommand, ObservedWindowScope, PowerShellResponse } from '../shared/types';
import type { ComputerWindowRecord } from '../shared/window-transition';
import type { InputRecoveryState } from './execution-state';
import { readInputRecovery } from './input-recovery-read';
import { verifyInputRecovery } from './input-recovery-verify';
import { resolveInputTarget } from './input-target';
import { settleWindowTransition, type WindowSettleInput } from './window-settle';

export interface InputResolutionHost {
  callPowerShell(request: Record<string, unknown>, timeoutMs?: number): Promise<PowerShellResponse>;
  sessionIdFor(command: ComputerCommand): string;
  assertExecutionNotAborted(): void;
  requireValidFrame(command: ComputerCommand): Promise<CaptureFrame>;
  freshObservedWindowScope(command: ComputerCommand): ObservedWindowScope | undefined;
  readComputerWindows(command: ComputerCommand, includeApp?: boolean): Promise<ComputerWindowRecord[] | null>;
}

export interface ResolvedInputTarget {
  physicalX?: number;
  physicalY?: number;
  physicalToX?: number;
  physicalToY?: number;
  physicalPath?: Array<{ x: number; y: number }>;
  targetWindowId?: string;
  allowedWindowIds: string[];
  observedScope?: ObservedWindowScope;
}

export function createInputResolution(host: InputResolutionHost) {
  return {
    readInputRecovery: (command: ComputerCommand, targetWindowId: string | undefined, includeRef = true) =>
      readInputRecovery(host, command, targetWindowId, includeRef),
    resolveInputTarget: (command: ComputerCommand, action: string, trustedSequenceContinuation: boolean) =>
      resolveInputTarget(host, command, action, trustedSequenceContinuation),
    verifyInputRecovery: (
      command: ComputerCommand,
      targetWindowId: string | undefined,
      inputRecovery: InputRecoveryState,
      timings: Record<string, number>,
      nativeResult: Record<string, unknown> = {}
    ) => verifyInputRecovery(host, command, targetWindowId, inputRecovery, timings, nativeResult),
    settleWindowTransition: (input: WindowSettleInput) => settleWindowTransition(host, input),
  };
}

export type InputResolution = ReturnType<typeof createInputResolution>;

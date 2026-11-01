/**
 * What changed since the last capture of the same window with the same read
 * parameters: the per-session baseline and the change summary against it.
 */
import { captureIdentityMap, summarizeCaptureChanges } from './analysis';
import type { ComputerCommand, ComputerElementRecord } from '../shared/types';
import type { CaptureMode } from './capture-target';

export interface CaptureBaseline {
  windowId: string;
  baselineKey: string;
  elements: Map<string, string>;
  refIdentities: Map<string, string>;
}

/** The read parameters two captures must share before one can stand as the
 *  other's baseline, for both the change summary and the observation delta. */
export function captureBaselineKey(command: ComputerCommand, mode: CaptureMode, totalElementBudget: number): string {
  return JSON.stringify({
    mode,
    query: command.query ?? null,
    role: command.role ?? null,
    visible_only: command.visible_only ?? null,
    include_noninteractive: command.include_noninteractive ?? null,
    include_structure: command.include_structure ?? null,
    max_elements: totalElementBudget,
    continuation: command.continuation ?? null,
  });
}

export function recordCaptureBaseline(
  baselines: Map<string, CaptureBaseline>,
  sessionId: string,
  {
    mode,
    command,
    totalElementBudget,
    rawElements,
    observationWindowId,
  }: {
    mode: CaptureMode;
    command: ComputerCommand;
    totalElementBudget: number;
    rawElements: ComputerElementRecord[];
    observationWindowId: string;
  }
): Record<string, unknown> | undefined {
  const refIdentities = new Map<string, string>();
  const identities = captureIdentityMap(rawElements, refIdentities);
  const baselineKey = captureBaselineKey(command, mode, totalElementBudget);
  const baseline = baselines.get(sessionId);
  const changes =
    baseline && observationWindowId && baseline.windowId === observationWindowId && baseline.baselineKey === baselineKey
      ? summarizeCaptureChanges(baseline.elements, identities)
      : undefined;
  baselines.set(sessionId, { windowId: observationWindowId || '', baselineKey, elements: identities, refIdentities });
  return changes;
}

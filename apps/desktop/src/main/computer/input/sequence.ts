import type { ComputerCommand } from '../shared/types';

interface SequenceWindowTransition {
  next_target?: { id?: string };
  [key: string]: unknown;
}

export async function executeComputerSequenceSteps(
  stepCommands: ComputerCommand[],
  initialWindowId: string,
  executeStep: (
    command: ComputerCommand,
    index: number,
  ) => Promise<Record<string, unknown>>,
): Promise<{
  rows: Array<Record<string, unknown>>;
  completedSteps: number;
  stoppedReason: string;
  finalWindowId: string;
  lastTransition: SequenceWindowTransition | null;
}> {
  const rows: Array<Record<string, unknown>> = [];
  let completedSteps = 0;
  let stoppedReason = '';
  let finalWindowId = initialWindowId;
  let lastTransition: SequenceWindowTransition | null = null;
  for (let index = 0; index < stepCommands.length; index += 1) {
    const stepCommand = stepCommands[index];
    const stepAction = String(stepCommand.action || '');
    let payload: Record<string, unknown>;
    try {
      payload = await executeStep(stepCommand, index);
    } catch (error) {
      const message = (error as Error).message || String(error);
      const explicitCode = /^([a-z][a-z0-9_]+):/i.exec(message.trim())?.[1]?.toLowerCase();
      payload = {
        ok: false,
        action: stepAction,
        message,
        code: explicitCode || 'step_failed',
        effect: 'unverifiable',
        verified: false,
        verdict: { decision: 'escalate', recommended: 'inspect_failed_step' },
      };
    }
    const transition = payload.window_transition as SequenceWindowTransition | undefined;
    lastTransition = transition || null;
    if (transition?.next_target?.id) finalWindowId = transition.next_target.id;
    const verdict = payload.verdict as Record<string, unknown> | undefined;
    const failed = payload.ok === false || verdict?.decision === 'escalate';
    if (!failed) completedSteps += 1;
    rows.push({
      index: index + 1,
      action: stepAction,
      ok: !failed,
      status: failed ? 'failed' : 'succeeded',
      effect: payload.effect || 'unverifiable',
      verified: payload.verified === true,
      path: payload.path || 'unknown',
      ...(payload.message && failed ? { message: payload.message } : {}),
      ...(payload.code ? { code: payload.code } : {}),
      verdict: payload.verdict || null,
      ...(transition ? { window_transition: transition } : {}),
    });
    if (failed) {
      stoppedReason = String(payload.code || payload.escalation || 'step_failed');
      break;
    }
    if (transition?.next_target && index < stepCommands.length - 1) {
      stoppedReason = 'target_transition';
      break;
    }
  }
  for (let index = rows.length; index < stepCommands.length; index += 1) {
    rows.push({
      index: index + 1,
      action: String(stepCommands[index].action || ''),
      status: 'skipped',
      reason: stoppedReason || 'prior_step_failed',
    });
  }
  return {
    rows,
    completedSteps,
    stoppedReason,
    finalWindowId,
    lastTransition,
  };
}

export function classifyComputerSequenceObservation(
  metadata: Record<string, unknown>,
): { unavailable: boolean; pixelUnavailable: boolean } {
  return {
    unavailable: metadata.ok === false,
    pixelUnavailable: metadata.pixel_status === 'unavailable',
  };
}

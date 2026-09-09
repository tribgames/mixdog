import type { ComputerCommand, ComputerCommandResult } from '../shared/types';

/** Progress is private to the live request, not a replayable command token. */
export interface ComputerWorkProgress {
  completed: number;
  inFlight?: number;
}

export class PausedComputerWork extends Error {
  readonly progress: ComputerWorkProgress;

  constructor(progress: ComputerWorkProgress) {
    super('computer_resume_recapture_required: pending work needs fresh evidence after user input');
    this.progress = { ...progress };
  }
}

function workProgress(command: ComputerCommand, progress: ComputerWorkProgress) {
  const steps = Array.isArray(command.steps) ? command.steps : [command];
  const uncertain = progress.inFlight;
  return {
    completed: progress.completed === steps.length && uncertain === undefined,
    completed_steps: progress.completed,
    total_steps: steps.length,
    input_replayed: false,
    steps: steps.map((step, index) => ({
      index: index + 1,
      action: step.action,
      status: index < progress.completed ? 'succeeded'
        : index === uncertain ? 'uncertain' : 'pending',
    })),
    pending_work: {
      completed_steps: progress.completed,
      ...(uncertain !== undefined ? { uncertain_step: uncertain + 1 } : {}),
      pending_steps: steps.flatMap((_, index) =>
        index >= progress.completed && index !== uncertain ? [index + 1] : []),
    },
  };
}

/** End a bounded parked request without ending the user's pause/resume policy. */
export function pausedWorkReply(
  command: ComputerCommand,
  progress: ComputerWorkProgress,
  reason: string,
): ComputerCommandResult {
  return {
    text: JSON.stringify({
      ok: true,
      action: command.action,
      status: 'paused',
      code: 'computer_user_intervention_pending',
      ...workProgress(command, progress),
      completed: false,
      reason,
      fresh_capture_required: true,
      verdict: { decision: 'wait_for_user', recommended: 'wait_for_user' },
      recovery: {
        next: 'wait_for_user',
        guidance: 'User control is still active. This request stopped waiting and will not dispatch later. '
          + 'The configured idle/manual resume route remains available. Wait for confirmed resume, '
          + 'capture fresh state, and continue only the remaining intent. Completed or uncertain input '
          + 'must never be resent blindly.',
      },
    }),
  };
}

export function pendingWorkReply(
  command: ComputerCommand,
  result: ComputerCommandResult,
  progress: ComputerWorkProgress,
): ComputerCommandResult {
  const payload = JSON.parse(result.text) as Record<string, unknown>;
  const observation = payload.observation as Record<string, unknown> | undefined;
  const fresh = observation?.ok === true;
  return {
    ...result,
    text: JSON.stringify({
      ...payload,
      ok: fresh,
      error: undefined,
      status: 'resumed',
      ...workProgress(command, progress),
      verdict: {
        decision: fresh ? 'verify_fresh_state' : 'escalate',
        recommended: fresh ? 'continue_pending_work' : 'recapture',
      },
      recovery: {
        next: fresh ? 'continue_from_observation' : 'capture',
        guidance: 'The request waited for user control to end. Keep the task active. '
          + 'Use the fresh observation to check the target, focus and remaining intent, then continue pending steps. '
          + 'Completed steps must not be replayed. An uncertain step may already have dispatched input: '
          + 'resolve its effect before deciding what remains. Never resend it blindly.',
      },
    }),
  };
}

/**
 * Bounded input sequences: one observed window, one input step followed by
 * typing, keys, or short waits, then a single capture of the outcome. Step
 * commands are marked so the router neither captures after each one nor
 * demands a fresh observation for the continuation steps.
 */
import { elapsedMs } from '../shared/common';
import type { ComputerCommand, ComputerCommandResult, ObservedWindowScope } from '../shared/types';
import { assertSafeComputerInput } from '../input/guards';
import {
  classifyComputerSequenceObservation,
  executeComputerSequenceSteps,
} from '../input/sequence';
import type { createCaptureEngine } from '../observation/capture';

type CaptureEngine = ReturnType<typeof createCaptureEngine>;

const suppressedSequenceCaptures = new WeakSet<object>();
const trustedSequenceContinuations = new WeakSet<object>();

/** The command runs without its automatic post-action capture. */
export function suppressCaptureAfter(command: ComputerCommand): void {
  suppressedSequenceCaptures.add(command);
}

export function captureAfterSuppressed(command: ComputerCommand): boolean {
  return suppressedSequenceCaptures.has(command);
}

/** A continuation step reuses the focus its first step established. */
export function isTrustedSequenceContinuation(command: ComputerCommand): boolean {
  return trustedSequenceContinuations.has(command);
}

const FIRST_STEP_ACTIONS = [
  'invoke', 'click', 'right_click', 'middle_click', 'double_click',
  'mouse_move', 'drag', 'scroll', 'type', 'key',
];
const CONTINUATION_STEP_ACTIONS = ['type', 'key', 'wait'];
const ROOT_ONLY_FIELDS = ['window_id', 'window', 'app', 'screen', 'session_id', 'delivery'];
const TARGET_FIELDS = ['ref', 'element', 'frame_id', 'x', 'y'];
const ALLOWED_STEP_FIELDS: Record<string, Set<string>> = {
  invoke: new Set(['action', 'ref', 'modifiers']),
  click: new Set(['action', 'ref', 'element', 'frame_id', 'x', 'y', 'modifiers']),
  right_click: new Set(['action', 'ref', 'element', 'frame_id', 'x', 'y', 'modifiers']),
  middle_click: new Set(['action', 'ref', 'element', 'frame_id', 'x', 'y', 'modifiers']),
  double_click: new Set(['action', 'ref', 'element', 'frame_id', 'x', 'y', 'modifiers']),
  mouse_move: new Set(['action', 'ref', 'element', 'frame_id', 'x', 'y', 'modifiers']),
  drag: new Set([
    'action', 'ref', 'element', 'to', 'to_element',
    'frame_id', 'x', 'y', 'to_x', 'to_y', 'modifiers',
  ]),
  scroll: new Set([
    'action', 'ref', 'element', 'frame_id', 'x', 'y',
    'direction', 'amount', 'modifiers',
  ]),
  type: new Set(['action', 'ref', 'element', 'frame_id', 'x', 'y', 'text']),
  key: new Set(['action', 'ref', 'keys']),
  wait: new Set(['action', 'duration']),
};

export interface SequenceRunnerHost extends Pick<CaptureEngine, 'captureAfterAction'> {
  sessionIdFor(command: ComputerCommand): string;
  freshObservedWindowScope(command: ComputerCommand): ObservedWindowScope | undefined;
  /** Late-bound: each step goes back through the router. */
  runCommand(command: ComputerCommand): Promise<ComputerCommandResult>;
}

export function createSequenceRunner(host: SequenceRunnerHost) {
  const { sessionIdFor, freshObservedWindowScope, captureAfterAction, runCommand } = host;

  function validateSteps(command: ComputerCommand, windowId: string): ComputerCommand[] {
    const steps = Array.isArray(command.steps) ? command.steps : [];
    const stepCommands = steps.map((step, index) => {
      if (!step || typeof step !== 'object' || Array.isArray(step)) {
        throw new Error(`sequence step ${index + 1} must be an object`);
      }
      const stepAction = String(step.action || '');
      if (index === 0) {
        if (!FIRST_STEP_ACTIONS.includes(stepAction)) {
          throw new Error('sequence first step must be a supported input action');
        }
      } else if (!CONTINUATION_STEP_ACTIONS.includes(stepAction)) {
        throw new Error('sequence continuation steps must be type, key, or wait');
      }
      const targetOverrides = ROOT_ONLY_FIELDS
        .filter((field) => Object.prototype.hasOwnProperty.call(step, field));
      if (targetOverrides.length) {
        throw new Error(
          `sequence step ${index + 1} cannot override root field(s): ${targetOverrides.join(', ')}`,
        );
      }
      const extraFields = Object.keys(step)
        .filter((field) => !ALLOWED_STEP_FIELDS[stepAction]?.has(field));
      if (extraFields.length) {
        throw new Error(
          `sequence step ${index + 1} does not accept field(s): ${extraFields.join(', ')}`,
        );
      }
      if (index > 0
        && TARGET_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(step, field))) {
        throw new Error(`sequence step ${index + 1} reuses focus and cannot carry a target`);
      }
      if (stepAction === 'type' && typeof step.text !== 'string') {
        throw new Error(`sequence step ${index + 1} requires string text`);
      }
      if (stepAction === 'key' && typeof step.keys !== 'string') {
        throw new Error(`sequence step ${index + 1} requires string keys`);
      }
      if (stepAction === 'wait'
        && (typeof step.duration !== 'number'
          || !Number.isFinite(step.duration)
          || step.duration < 0
          || step.duration > 5)) {
        throw new Error(`sequence step ${index + 1} requires duration from 0 to 5 seconds`);
      }
      const stepCommand: ComputerCommand = {
        ...step,
        action: stepAction,
        window_id: windowId,
        delivery: command.delivery || 'background',
        session_id: sessionIdFor(command),
      };
      assertSafeComputerInput(stepCommand);
      return stepCommand;
    });
    const totalWaitSeconds = stepCommands.reduce(
      (total, step) => total + (step.action === 'wait' ? Number(step.duration) || 0 : 0),
      0,
    );
    if (totalWaitSeconds > 10) {
      throw new Error('sequence wait steps accept at most 10 total seconds; use verify for longer conditions');
    }
    return stepCommands;
  }

  async function runBoundedSequence(command: ComputerCommand): Promise<ComputerCommandResult> {
    const startedAt = performance.now();
    const windowId = String(command.window_id || '');
    const steps = Array.isArray(command.steps) ? command.steps : [];
    if (!windowId) throw new Error('sequence requires exact window_id');
    if (steps.length < 1 || steps.length > 6) throw new Error('sequence requires 1..6 steps');
    const observedScope = freshObservedWindowScope(command);
    if (!observedScope?.relatedWindowIds.includes(windowId)) {
      throw new Error(
        `stale_target: sequence targets ${windowId}, but the latest observation is `
          + `${observedScope?.primaryWindowId || 'missing'}`,
      );
    }
    const stepCommands = validateSteps(command, windowId);
    const sequence = await executeComputerSequenceSteps(
      stepCommands,
      windowId,
      async (stepCommand, index) => {
        const stepAction = String(stepCommand.action || '');
        suppressedSequenceCaptures.add(stepCommand);
        if (index > 0) trustedSequenceContinuations.add(stepCommand);
        const result = await runCommand(stepCommand);
        try {
          return JSON.parse(result.text) as Record<string, unknown>;
        } catch {
          return { ok: true, action: stepAction, message: result.text };
        }
      },
    );
    const {
      rows,
      completedSteps,
      stoppedReason,
      finalWindowId,
      lastTransition,
    } = sequence;
    const completed = completedSteps === steps.length && !stoppedReason;
    const capture = await captureAfterAction(command, finalWindowId, 0, 0);
    const {
      unavailable: observationUnavailable,
      pixelUnavailable,
    } = classifyComputerSequenceObservation(capture.metadata);
    const resultCode = stoppedReason
      || (observationUnavailable
        ? String(capture.metadata.code || 'observation_unavailable')
        : '');
    const payload: Record<string, unknown> = {
      ok: completed && !observationUnavailable,
      action: 'sequence',
      window_id: windowId,
      completed,
      completed_steps: completedSteps,
      total_steps: steps.length,
      steps: rows,
      ...(stoppedReason ? { stopped_reason: stoppedReason } : {}),
      ...(resultCode ? { code: resultCode } : {}),
      ...(lastTransition ? { window_transition: lastTransition } : {}),
      goal_verified: false,
      verdict: completed && !observationUnavailable
        ? {
            decision: 'verify_fresh_state',
            ...(pixelUnavailable ? { recommended: 'use_semantic_target' } : {}),
          }
        : {
            decision: 'escalate',
            recommended: stoppedReason === 'target_transition'
              ? 'switch_target'
              : observationUnavailable ? 'recapture' : 'inspect_failed_step',
          },
      capture_after: {
        ...capture.metadata,
        target_reason: finalWindowId === windowId ? 'original_target' : 'sequence_successor',
        ...(finalWindowId !== windowId ? { previous_window_id: windowId } : {}),
      },
      timings_ms: { total_ms: elapsedMs(startedAt) },
    };
    return {
      text: JSON.stringify(payload),
      ...(capture.image ? { image: capture.image } : {}),
    };
  }

  return { runBoundedSequence };
}

export type SequenceRunner = ReturnType<typeof createSequenceRunner>;

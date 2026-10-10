/**
 * Bounded input sequences: one observed window, one input step followed by
 * typing, keys, or short waits, then a single capture of the outcome. Step
 * commands are marked so the router neither captures after each one nor
 * demands a fresh observation for the continuation steps.
 */
import { elapsedMs } from '../shared/common';
import type { ComputerCommand, ComputerCommandResult, ObservedWindowScope } from '../shared/types';
import { assertSafeComputerInput } from '../input/guards';
import { classifyComputerSequenceObservation, executeComputerSequenceSteps } from '../input/sequence';
import type { createCaptureEngine } from '../observation/capture';
import { computerErrorCode } from '../../../../../../src/runtime/computer-bridge/error-code.mjs';

type CaptureEngine = ReturnType<typeof createCaptureEngine>;

const suppressedSequenceCaptures = new WeakSet<object>();
const trustedSequenceContinuations = new WeakSet<object>();
const sequenceStepCommands = new WeakSet<object>();
const refRetainingSteps = new WeakSet<object>();

export function isSequenceStep(command: ComputerCommand): boolean {
  return sequenceStepCommands.has(command);
}

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

/** A later step of the same sequence addresses a ref from the observation the
 *  sequence started from, so this step's delivery must not retire the refs. */
export function retainsSequenceRefs(command: ComputerCommand): boolean {
  return refRetainingSteps.has(command);
}

const FIRST_STEP_ACTIONS = [
  'invoke',
  'set_value',
  'click',
  'right_click',
  'middle_click',
  'double_click',
  'triple_click',
  'mouse_down',
  'mouse_up',
  'mouse_move',
  'drag',
  'scroll',
  'type',
  'key',
  'key_down',
  'key_up',
];
const CONTINUATION_STEP_ACTIONS = ['type', 'key', 'key_down', 'key_up', 'wait'];
// A later step may address another element of the sequence's observation by its
// ref; the backend re-proves that element's identity before delivering to it.
const CONTINUATION_REF_STEP_ACTIONS = [
  'invoke',
  'set_value',
  'click',
  'right_click',
  'middle_click',
  'double_click',
  'triple_click',
  'scroll',
];
const ROOT_ONLY_FIELDS = ['window_id', 'window', 'app', 'screen', 'session_id', 'delivery'];
// Marks and coordinates belong to a frame the first step already invalidated.
const CONTINUATION_FRAME_FIELDS = ['element', 'frame_id', 'x', 'y', 'to', 'to_element', 'to_x', 'to_y', 'waypoints'];
const POINT_STEP_FIELDS = ['action', 'ref', 'element', 'frame_id', 'x', 'y', 'modifiers'];
const ALLOWED_STEP_FIELDS: Record<string, Set<string>> = {
  invoke: new Set(['action', 'ref', 'modifiers']),
  // A value is written through the element, so it carries a semantic target and
  // its replacement text, never a pixel or a modifier.
  set_value: new Set(['action', 'ref', 'element', 'text']),
  click: new Set(POINT_STEP_FIELDS),
  right_click: new Set(POINT_STEP_FIELDS),
  middle_click: new Set(POINT_STEP_FIELDS),
  double_click: new Set(POINT_STEP_FIELDS),
  triple_click: new Set(POINT_STEP_FIELDS),
  mouse_down: new Set(POINT_STEP_FIELDS),
  mouse_up: new Set(POINT_STEP_FIELDS),
  mouse_move: new Set(POINT_STEP_FIELDS),
  drag: new Set([
    'action',
    'ref',
    'element',
    'to',
    'to_element',
    'frame_id',
    'x',
    'y',
    'to_x',
    'to_y',
    'waypoints',
    'modifiers',
  ]),
  scroll: new Set(['action', 'ref', 'element', 'frame_id', 'x', 'y', 'direction', 'amount', 'modifiers']),
  type: new Set(['action', 'ref', 'element', 'frame_id', 'x', 'y', 'text']),
  key: new Set(['action', 'ref', 'keys']),
  key_down: new Set(['action', 'ref', 'keys']),
  key_up: new Set(['action', 'ref', 'keys']),
  wait: new Set(['action', 'duration']),
};

type SequenceStep = NonNullable<ComputerCommand['steps']>[number];

// One step's shape: the action allowed at its position, no root-only or
// target fields, and the payload its action needs. Answers the action.
function assertSequenceStep(step: SequenceStep, index: number): string {
  if (!step || typeof step !== 'object' || Array.isArray(step)) {
    throw new Error(`sequence step ${index + 1} must be an object`);
  }
  const stepAction = String(step.action || '');
  if (index === 0) {
    if (!FIRST_STEP_ACTIONS.includes(stepAction)) {
      throw new Error('sequence first step must be a supported input action');
    }
  } else if (CONTINUATION_REF_STEP_ACTIONS.includes(stepAction)) {
    if (typeof step.ref !== 'string' || !step.ref) {
      throw new Error(`sequence step ${index + 1} ${stepAction} requires a ref from the same observation`);
    }
  } else if (!CONTINUATION_STEP_ACTIONS.includes(stepAction)) {
    throw new Error('sequence continuation steps must be type, key, wait, or a ref-addressed input');
  }
  const targetOverrides = ROOT_ONLY_FIELDS.filter((field) => Object.hasOwn(step, field));
  if (targetOverrides.length) {
    throw new Error(`sequence step ${index + 1} cannot override root field(s): ${targetOverrides.join(', ')}`);
  }
  const extraFields = Object.keys(step).filter((field) => !ALLOWED_STEP_FIELDS[stepAction]?.has(field));
  if (extraFields.length) {
    throw new Error(`sequence step ${index + 1} does not accept field(s): ${extraFields.join(', ')}`);
  }
  if (index > 0 && CONTINUATION_FRAME_FIELDS.some((field) => Object.hasOwn(step, field))) {
    throw new Error(`sequence step ${index + 1} addresses elements by ref only`);
  }
  if ((stepAction === 'type' || stepAction === 'set_value') && typeof step.text !== 'string') {
    throw new Error(`sequence step ${index + 1} requires string text`);
  }
  // A value is written through the control itself, so a target is mandatory here
  // rather than optional as it is for a type step that reuses focus.
  if (stepAction === 'set_value' && !Object.hasOwn(step, 'ref') && !Object.hasOwn(step, 'element')) {
    throw new Error(`sequence step ${index + 1} requires ref or element`);
  }
  if (stepAction === 'key' && typeof step.keys !== 'string') {
    throw new Error(`sequence step ${index + 1} requires string keys`);
  }
  if (
    stepAction === 'wait' &&
    (typeof step.duration !== 'number' || !Number.isFinite(step.duration) || step.duration < 0 || step.duration > 5)
  ) {
    throw new Error(`sequence step ${index + 1} requires duration from 0 to 5 seconds`);
  }
  return stepAction;
}

/** A sequence whose preflight refused its delivery: no step ran, and the reply
 *  says so step by step so the caller can pick another delivery. */
function preflightRefusedReply(
  windowId: string,
  stepCommands: ComputerCommand[],
  code: string,
  error: unknown,
  startedAt: number
): ComputerCommandResult {
  return {
    text: JSON.stringify({
      ok: false,
      action: 'sequence',
      window_id: windowId,
      completed: false,
      completed_steps: 0,
      total_steps: stepCommands.length,
      steps: stepCommands.map((step, index) => ({
        index: index + 1,
        action: step.action,
        status: 'skipped',
        reason: 'preflight_refused',
      })),
      code,
      stopped_reason: 'preflight_refused',
      message: (error as Error).message || String(error),
      delivery_accepted: false,
      input_may_have_executed: false,
      goal_verified: false,
      verdict: { decision: 'escalate', recommended: 'select_delivery' },
      timings_ms: { total_ms: elapsedMs(startedAt) },
    }),
  };
}

export interface SequenceRunnerHost extends Pick<CaptureEngine, 'captureAfterAction'> {
  sessionIdFor(command: ComputerCommand): string;
  freshObservedWindowScope(command: ComputerCommand): ObservedWindowScope | undefined;
  recordProgress?(completed: number, inFlight?: number): void;
  preflightSteps?(command: ComputerCommand, steps: ComputerCommand[]): Promise<void>;
  /** Late-bound: each step goes back through the router. */
  runCommand(command: ComputerCommand): Promise<ComputerCommandResult>;
  /** Ends the no-activate holds the session's worker keeps across a background
   *  sequence's steps; sent whenever a background sequence finishes or stops. */
  releaseSequenceHolds?(sessionId: string): Promise<void>;
}

function errorMessage(error: unknown): string {
  return (error as Error)?.message || String(error);
}

/** A worker reply refusing release_sequence_holds, as the error the sequence
 *  runner reports: its own code when it has one, else a cleanup failure. */
export function sequenceHoldReleaseError(error: unknown): Error {
  const message = String(error || 'the worker did not confirm the release');
  return new Error(
    computerErrorCode(message) ? message : `input_cleanup_unconfirmed: sequence holds were not released: ${message}`
  );
}

export function createSequenceRunner(host: SequenceRunnerHost) {
  const { sessionIdFor, freshObservedWindowScope, captureAfterAction, runCommand } = host;

  function validateSteps(command: ComputerCommand, windowId: string): ComputerCommand[] {
    const steps = Array.isArray(command.steps) ? command.steps : [];
    const delivery = command.delivery || 'background';
    const stepCommands = steps.map((step, index) => {
      const stepAction = assertSequenceStep(step, index);
      const stepCommand: ComputerCommand = {
        ...step,
        action: stepAction,
        window_id: windowId,
        delivery,
        session_id: sessionIdFor(command),
        // Swapping the system cursors costs far more than the keystroke it
        // decorates, so one lease covers the whole sequence and only its last
        // step pays the wait that protects a finished gesture. In the background
        // the same flag keeps one no-activate hold on the target across steps.
        ...(index < steps.length - 1 ? { input_continues: true } : {}),
      };
      assertSafeComputerInput(stepCommand);
      if (steps.slice(index + 1).some((later) => typeof later?.ref === 'string')) {
        refRetainingSteps.add(stepCommand);
      }
      return stepCommand;
    });
    const totalWaitSeconds = stepCommands.reduce(
      (total, step) => total + (step.action === 'wait' ? Number(step.duration) || 0 : 0),
      0
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
        `stale_target: sequence targets ${windowId}, but the latest observation is ` +
          `${observedScope?.primaryWindowId || 'missing'}`
      );
    }
    const stepCommands = validateSteps(command, windowId);
    try {
      await host.preflightSteps?.(command, stepCommands);
    } catch (error) {
      // A grammar refusal happens before the first step, not after a possibly
      // completed prefix. Keep that evidence so the caller need not guess.
      const code = computerErrorCode(error);
      if (code !== 'background_unsupported') throw error;
      return preflightRefusedReply(windowId, stepCommands, code, error, startedAt);
    }
    host.recordProgress?.(0);
    const stepsStartedAt = performance.now();
    let activationUnprotected = false;
    let sequence: Awaited<ReturnType<typeof executeComputerSequenceSteps>> | undefined;
    let holdCleanupError: unknown;
    let stepsError: unknown;
    try {
      sequence = await executeComputerSequenceSteps(
        stepCommands,
        windowId,
        async (stepCommand, index) => {
          host.recordProgress?.(index, index);
          const stepAction = String(stepCommand.action || '');
          suppressedSequenceCaptures.add(stepCommand);
          sequenceStepCommands.add(stepCommand);
          if (index > 0) trustedSequenceContinuations.add(stepCommand);
          const result = await runCommand(stepCommand);
          try {
            const parsed = JSON.parse(result.text) as Record<string, unknown>;
            if (parsed.activation_protection === 'unavailable') activationUnprotected = true;
            return parsed;
          } catch {
            return { ok: true, action: stepAction, message: result.text };
          }
        },
        (completed) => host.recordProgress?.(completed)
      );
    } catch (error) {
      stepsError = error;
    } finally {
      // A sequence that stopped early (failed step, target transition, abort)
      // never sends the last step that would end its hold, so every background
      // sequence ends the session's sequence holds itself, before the capture.
      if ((command.delivery || 'background') !== 'foreground' && host.releaseSequenceHolds) {
        try {
          await host.releaseSequenceHolds(sessionIdFor(command));
        } catch (error) {
          holdCleanupError = error;
        }
      }
    }
    if (!sequence) {
      // A target that may still be non-activatable outranks why the steps stopped.
      if (holdCleanupError !== undefined) {
        throw new Error(
          `input_cleanup_unconfirmed: ${errorMessage(holdCleanupError)}; the sequence had stopped: ${errorMessage(stepsError)}`,
          { cause: stepsError }
        );
      }
      throw stepsError;
    }
    const stepsMs = elapsedMs(stepsStartedAt);
    const { rows, completedSteps, stoppedReason, finalWindowId, lastTransition } = sequence;
    const completed = completedSteps === steps.length && !stoppedReason;
    const captureStartedAt = performance.now();
    const capture = await captureAfterAction(command, finalWindowId, 0, 0);
    const postCaptureMs = elapsedMs(captureStartedAt);
    const { unavailable: observationUnavailable, pixelUnavailable } = classifyComputerSequenceObservation(
      capture.metadata
    );
    // A hold that may still keep the target non-activatable outranks why the
    // steps stopped; the stop reason stays in stopped_reason.
    const holdCleanupCode = holdCleanupError === undefined ? '' : 'input_cleanup_unconfirmed';
    const resultCode =
      holdCleanupCode ||
      stoppedReason ||
      (observationUnavailable ? String(capture.metadata.code || 'observation_unavailable') : '');
    let escalation = 'inspect_failed_step';
    if (stoppedReason === 'target_transition') escalation = 'switch_target';
    else if (observationUnavailable) escalation = 'recapture';
    let verdict: Record<string, unknown> = { decision: 'escalate', recommended: escalation };
    if (completed && !observationUnavailable && !holdCleanupCode) {
      verdict = { decision: 'verify_fresh_state' };
      if (pixelUnavailable) verdict.recommended = 'use_semantic_target';
    }
    const payload: Record<string, unknown> = {
      ok: completed && !observationUnavailable && !holdCleanupCode,
      ...(activationUnprotected ? { activation_protection: 'unavailable' } : {}),
      ...(holdCleanupCode
        ? {
            hold_cleanup: {
              ok: false,
              message: errorMessage(holdCleanupError),
            },
          }
        : {}),
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
      verdict,
      capture_after: {
        ...capture.metadata,
        target_reason: finalWindowId === windowId ? 'original_target' : 'sequence_successor',
        ...(finalWindowId !== windowId ? { previous_window_id: windowId } : {}),
      },
      timings_ms: {
        total_ms: elapsedMs(startedAt),
        steps_ms: stepsMs,
        post_capture_ms: postCaptureMs,
      },
    };
    return {
      text: JSON.stringify(payload),
      ...(capture.image ? { image: capture.image } : {}),
    };
  }

  return { runBoundedSequence };
}

/**
 * The accessibility side of a state capture: its element budget, the bound
 * snapshot read and fold, the elements placed on the captured frame, and the
 * one content re-read a chrome-only answer earns.
 */
import { DEFAULT_CAPTURE_MAX_ELEMENTS } from '../shared/common';
import {
  frameElements,
  hasSemanticAccessibilityTarget,
  screenshotInteger,
  shouldRereadContentAccessibility,
} from './analysis';
import {
  type AccessibilityRead,
  type AccessibilityState,
  type CaptureReadsHost,
  applyAccessibilityRead,
  readAccessibilitySnapshot,
} from './capture-reads';
import type { CaptureMode } from './capture-target';
import type { CaptureFrame, ComputerCommand, ComputerElementRecord } from '../shared/types';

export interface AccessibilityReadContext {
  command: ComputerCommand;
  mode: CaptureMode;
  replacementRead: boolean;
  totalElementBudget: number;
  visualOnlyCacheHit: boolean;
  cachedAccessibilityError: string;
  timings: Record<string, number>;
}

/** The accessibility answer as the capture reports it: the folded snapshot and
 *  its elements placed on the captured frame. */
export interface AccessibilityView {
  state: AccessibilityState;
  elements: Array<Record<string, unknown>>;
  semanticAccessibilityAvailable: boolean;
}

export function captureElementBudget(command: ComputerCommand, mode: CaptureMode): number {
  return screenshotInteger(
    command.max_elements,
    mode === 'state' ? DEFAULT_CAPTURE_MAX_ELEMENTS : 200,
    1,
    1_000,
    'max_elements'
  );
}

/** Both reads take the window id current at their call, which the first
 *  applied read may have replaced. */
export function createAccessibilityReads(host: CaptureReadsHost, context: AccessibilityReadContext) {
  const { command, mode, replacementRead, totalElementBudget, visualOnlyCacheHit, cachedAccessibilityError, timings } =
    context;
  return {
    read: (windowId: string) =>
      readAccessibilitySnapshot(host, {
        command,
        mode,
        replacementRead,
        windowId,
        totalElementBudget,
        visualOnlyCacheHit,
        cachedAccessibilityError,
      }),
    apply: (read: AccessibilityRead, windowId: string) =>
      applyAccessibilityRead(host, read, {
        mode,
        command,
        windowId,
        cachedAccessibilityError,
        visualOnlyCacheHit,
        timings,
      }),
  };
}

export type AccessibilityReads = ReturnType<typeof createAccessibilityReads>;

/** The state of a capture that read no accessibility (vision, or a replaced worker). */
function emptyAccessibilityState(windowId: string): AccessibilityState {
  return { accessibilityError: '', rawElements: [], totalElements: 0, continuation: null, generation: null, windowId };
}

/** Fold the first read. A read that refuses still teaches the session that its
 *  provider stalls (`onRefusal`), then the refusal propagates. */
export function applyFirstAccessibilityRead(
  reads: AccessibilityReads,
  read: AccessibilityRead | null,
  windowId: string,
  onRefusal: (accessibilityError: string) => void
): AccessibilityState {
  if (!read) return emptyAccessibilityState(windowId);
  try {
    return reads.apply(read, windowId);
  } catch (error) {
    onRefusal((error as Error).message || String(error));
    throw error;
  }
}

function budgetedFrameElements(
  rawElements: ComputerElementRecord[],
  frame: CaptureFrame | undefined,
  mode: CaptureMode,
  totalElementBudget: number
) {
  return frameElements(rawElements, frame, mode !== 'som').slice(0, totalElementBudget);
}

export function viewAccessibility(
  state: AccessibilityState,
  frame: CaptureFrame | undefined,
  { mode, totalElementBudget }: Pick<AccessibilityReadContext, 'mode' | 'totalElementBudget'>
): AccessibilityView {
  return {
    state,
    elements: budgetedFrameElements(state.rawElements, frame, mode, totalElementBudget),
    semanticAccessibilityAvailable: hasSemanticAccessibilityTarget(state.rawElements, frame),
  };
}

/** A fresh first read whose answer is chrome only earns one content re-read. */
export function shouldRereadContent(
  { command, mode, replacementRead, visualOnlyCacheHit }: AccessibilityReadContext,
  { state, semanticAccessibilityAvailable }: AccessibilityView
): boolean {
  return (
    !visualOnlyCacheHit &&
    !replacementRead &&
    !command.continuation &&
    shouldRereadContentAccessibility(
      mode,
      semanticAccessibilityAvailable,
      state.accessibilityError,
      state.totalElements,
      command.include_ocr === true,
      Boolean(command.query || command.role)
    )
  );
}

/** Fold the content re-read. It replaced the session's refs, so only its answer
 *  names live ones, whether or not it found the content surface. */
export function applyContentReread(
  reads: AccessibilityReads,
  context: AccessibilityReadContext,
  contentRead: AccessibilityRead,
  windowId: string,
  frame: CaptureFrame | undefined
): AccessibilityView {
  const { timings } = context;
  const accessibilityMsBeforeReread = timings.accessibility_ms || 0;
  const state = reads.apply(contentRead, windowId);
  timings.accessibility_reread_ms = contentRead.elapsed;
  timings.accessibility_ms = accessibilityMsBeforeReread + contentRead.elapsed;
  return {
    state,
    elements: budgetedFrameElements(state.rawElements, frame, context.mode, context.totalElementBudget),
    semanticAccessibilityAvailable:
      !state.accessibilityError && hasSemanticAccessibilityTarget(state.rawElements, frame),
  };
}

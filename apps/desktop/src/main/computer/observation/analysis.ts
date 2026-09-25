/**
 * Pure observation shaping and judgment for Computer Use: element and OCR
 * normalization, frame geometry, capture-change summaries, and the predicate
 * evaluator. Nothing here reaches a live session, a worker, or the bridge, so
 * every function is decided by its arguments alone.
 */
import {
  DEFAULT_CAPTURE_AFTER_DELAY_MS,
  DEFAULT_CAPTURE_MAX_ELEMENTS,
  DEFAULT_OCR_MAX_WORDS,
  MAX_CAPTURE_AFTER_DELAY_MS,
  MAX_OCR_WORDS,
} from '../shared/common';
import { launchTransitionConfirmsTarget, type ComputerWindowTransition } from '../shared/window-transition';
import type {
  CaptureFrame,
  ComputerCommand,
  ComputerElementRecord,
  OcrWordRecord,
  PixelUnavailable,
} from '../shared/types';

/** How many changed identities a capture summary names before it only counts. */
const CAPTURE_CHANGE_SAMPLE = 8;
/** Below this the tree is too thin to prove anything, so the frame stays. */
const CAPTURE_IMAGE_SKIP_MIN_ELEMENTS = 3;

export { evaluateVerifyPredicate, type VerifyStatus } from './verify-predicate';

const OCR_LANGUAGE_TAG_PATTERN = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;

export function assertOcrLanguageTag(value: unknown, field = 'ocr_language'): void {
  if (value === undefined || value === null) return;
  if (
    typeof value !== 'string' ||
    value.length < 2 ||
    value.length > 64 ||
    value !== value.trim() ||
    !OCR_LANGUAGE_TAG_PATTERN.test(value)
  ) {
    throw new Error(`${field} must be a 2-64 character BCP-47 language tag such as ko or en-US`);
  }
}

export function framePoint(frame: CaptureFrame, x: number, y: number): { x: number; y: number } {
  if (
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    x < 0 ||
    y < 0 ||
    x >= frame.captureWidth ||
    y >= frame.captureHeight
  ) {
    throw new Error(`frame coordinates must be inside 0..${frame.captureWidth - 1},0..${frame.captureHeight - 1}`);
  }
  return {
    x: frame.originX + Math.round((x * frame.physicalWidth) / frame.captureWidth),
    y: frame.originY + Math.round((y * frame.physicalHeight) / frame.captureHeight),
  };
}

export function screenshotInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

/** The post-action capture accepts exactly the bounds the capture itself
 *  enforces, and is rejected before the mutation runs rather than after. */
export function assertCaptureAfterOptions(command: ComputerCommand): void {
  assertOcrLanguageTag(command.capture_after_ocr_language, 'capture_after_ocr_language');
  screenshotInteger(
    command.capture_delay_ms,
    DEFAULT_CAPTURE_AFTER_DELAY_MS,
    0,
    MAX_CAPTURE_AFTER_DELAY_MS,
    'capture_delay_ms'
  );
  if (command.capture_after_mode && !['state', 'som', 'vision', 'ax'].includes(command.capture_after_mode)) {
    throw new Error('capture_after_mode must be state, som, vision, or ax');
  }
  screenshotInteger(
    command.capture_after_max_elements,
    DEFAULT_CAPTURE_MAX_ELEMENTS,
    1,
    1_000,
    'capture_after_max_elements'
  );
  if (command.capture_after_include_ocr && command.capture_after_mode === 'ax') {
    throw new Error('capture_after_include_ocr requires capture_after_mode state, som, or vision');
  }
  if (command.capture_after_include_ocr) {
    screenshotInteger(
      command.capture_after_max_ocr_words,
      DEFAULT_OCR_MAX_WORDS,
      1,
      MAX_OCR_WORDS,
      'capture_after_max_ocr_words'
    );
  }
}

export function pixelUnavailable(
  reason: PixelUnavailable['reason'],
  message: string,
  details: Partial<PixelUnavailable> = {}
): PixelUnavailable {
  return {
    code: 'pixel_unavailable',
    reason,
    message,
    ...details,
  };
}

export function captureMode(command: ComputerCommand): 'state' | 'som' | 'vision' | 'ax' {
  const mode = command.mode || 'state';
  if (mode !== 'state' && mode !== 'som' && mode !== 'vision' && mode !== 'ax') {
    throw new Error('capture mode must be state, som, vision, or ax');
  }
  return mode;
}

type ElementBounds = [number, number, number, number];

function renderedElement(
  element: ComputerElementRecord,
  compact: boolean,
  bounds: ElementBounds,
  center: [number, number],
  screenBounds?: ElementBounds
): Record<string, unknown> {
  if (!compact) return { ...element, bounds, center, ...(screenBounds ? { screen_bounds: screenBounds } : {}) };
  return {
    mark: element.mark,
    ref: element.ref,
    source: element.source,
    role: element.role,
    name: element.name,
    ...(element.value ? { value: element.value } : {}),
    ...(element.state ? { state: element.state } : {}),
    // The app's own shortcut reaches a command without travelling to the
    // control, so the compact view keeps it too.
    ...(element.accelerator ? { accelerator: element.accelerator } : {}),
    ...(element.access_key ? { access_key: element.access_key } : {}),
    enabled: element.enabled,
    bounds,
    actions: element.actions,
  };
}

// The element's rectangle mapped into the frame's capture pixels and clipped
// to the frame; null when it lies entirely outside.
function clipElementToFrame(element: ComputerElementRecord, frame: CaptureFrame): ComputerElementRecord | null {
  const x = Math.round(((element.x - frame.originX) * frame.captureWidth) / frame.physicalWidth);
  const y = Math.round(((element.y - frame.originY) * frame.captureHeight) / frame.physicalHeight);
  const width = Math.max(1, Math.round((element.width * frame.captureWidth) / frame.physicalWidth));
  const height = Math.max(1, Math.round((element.height * frame.captureHeight) / frame.physicalHeight));
  if (x + width <= 0 || y + height <= 0 || x >= frame.captureWidth || y >= frame.captureHeight) return null;
  const clippedX = Math.max(0, x);
  const clippedY = Math.max(0, y);
  const clippedWidth = Math.max(1, Math.min(frame.captureWidth - clippedX, width - (clippedX - x)));
  const clippedHeight = Math.max(1, Math.min(frame.captureHeight - clippedY, height - (clippedY - y)));
  return {
    ...element,
    x: clippedX,
    y: clippedY,
    width: clippedWidth,
    height: clippedHeight,
    center_x: clippedX + Math.round(clippedWidth / 2),
    center_y: clippedY + Math.round(clippedHeight / 2),
  };
}

export function frameElements(
  elements: ComputerElementRecord[],
  frame?: CaptureFrame,
  compact = false
): Array<Record<string, unknown>> {
  return elements.flatMap((element) => {
    if (!frame) {
      return [
        renderedElement(
          element,
          compact,
          [element.x, element.y, element.width, element.height],
          [element.center_x, element.center_y]
        ),
      ];
    }
    const clipped = clipElementToFrame(element, frame);
    if (!clipped) return [];
    return [
      renderedElement(
        clipped,
        compact,
        [clipped.x, clipped.y, clipped.width, clipped.height],
        [clipped.center_x, clipped.center_y],
        [element.x, element.y, element.width, element.height]
      ),
    ];
  });
}

export function normalizeOcrWords(value: unknown): OcrWordRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const row = raw as Record<string, unknown>;
    const text = String(row.text || '');
    if (!text) return [];
    return [
      {
        text,
        line: Number(row.line) || 0,
        x: Number(row.x) || 0,
        y: Number(row.y) || 0,
        width: Number(row.width) || 0,
        height: Number(row.height) || 0,
        center_x: Number(row.center_x) || 0,
        center_y: Number(row.center_y) || 0,
      },
    ];
  });
}

/** Elements a command could actually address, whatever their placement. */
export function actionableAccessibilityElements(elements: ComputerElementRecord[]): ComputerElementRecord[] {
  const containerRoles = new Set(['Window', 'Pane', 'Document', 'Group', 'Custom', 'Image', 'Text']);
  return elements.filter(
    (element) =>
      element.enabled &&
      element.width > 1 &&
      element.height > 1 &&
      !containerRoles.has(element.role) &&
      element.actions.length > 0
  );
}

export function hasSemanticAccessibilityTarget(elements: ComputerElementRecord[], frame?: CaptureFrame): boolean {
  const largestElementArea = elements.reduce(
    (largest, element) => Math.max(largest, element.width * element.height),
    0
  );
  const contentSurfaceRoles = new Set(['Document', 'Custom', 'Image']);
  const dominantContentSurfaces = elements.filter(
    (element) =>
      contentSurfaceRoles.has(element.role) &&
      element.width > 1 &&
      element.height > 1 &&
      element.width * element.height * 2 >= largestElementArea
  );
  // An editor surface hands back its own text, so the window is already read.
  // Recognizing those same pixels would spend a second pass to return a
  // lossier copy of text the tree quotes exactly.
  if (dominantContentSurfaces.some((surface) => typeof surface.value === 'string' && surface.value.trim() !== ''))
    return true;

  const actionableElements = actionableAccessibilityElements(elements);
  if (!actionableElements.length) return false;

  if (!dominantContentSurfaces.length) {
    if (frame) {
      const menuStripBottom = frame.originY + Math.max(64, frame.physicalHeight * 0.12);
      const confinedToMenuStrip = actionableElements.every(
        (element) => element.y + element.height / 2 <= menuStripBottom
      );
      if (confinedToMenuStrip) return false;
    }
    return true;
  }

  return actionableElements.some((element) => {
    const centerX = element.x + element.width / 2;
    const centerY = element.y + element.height / 2;
    return dominantContentSurfaces.some(
      (surface) =>
        centerX >= surface.x &&
        centerY >= surface.y &&
        centerX <= surface.x + surface.width &&
        centerY <= surface.y + surface.height
    );
  });
}

function normalizeGroundingText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

export function dedupeOcrWords(
  words: OcrWordRecord[],
  accessibilityElements: Array<Record<string, unknown>>
): OcrWordRecord[] {
  const labelled = accessibilityElements.flatMap((element) => {
    const text = normalizeGroundingText(`${String(element.name || '')} ${String(element.value || '')}`);
    const bounds = Array.isArray(element.bounds) ? element.bounds.map(Number) : [];
    return text && bounds.length === 4 ? [{ text, bounds }] : [];
  });
  return words.filter((word) => {
    const text = normalizeGroundingText(word.text);
    if (text.length < 2 || word.width < 2 || word.height < 2) return false;
    const wordRight = word.x + word.width;
    const wordBottom = word.y + word.height;
    return !labelled.some((candidate) => {
      if (!candidate.text.includes(text)) return false;
      const [x, y, width, height] = candidate.bounds;
      const overlapWidth = Math.max(0, Math.min(wordRight, x + width) - Math.max(word.x, x));
      const overlapHeight = Math.max(0, Math.min(wordBottom, y + height) - Math.max(word.y, y));
      const overlap = overlapWidth * overlapHeight;
      return overlap / Math.max(1, word.width * word.height) >= 0.5;
    });
  });
}

export function captureIdentityMap(
  elements: ComputerElementRecord[],
  refIdentities: Map<string, string> = new Map()
): Map<string, string> {
  const identities = new Map<string, string>();
  const occurrences = new Map<string, number>();
  for (const element of elements) {
    if (element.source === 'ocr') continue;
    const base = `${element.role || ''}|${element.name || ''}`;
    const occurrence = (occurrences.get(base) || 0) + 1;
    occurrences.set(base, occurrence);
    const identity = occurrence > 1 ? `${base}#${occurrence}` : base;
    identities.set(
      identity,
      `${element.value ?? ''}\u0000${element.state ?? ''}\u0000${element.enabled === false ? 'disabled' : 'enabled'}`
    );
    if (element.ref) refIdentities.set(element.ref, identity);
  }
  return identities;
}

export function captureAfterImageIsRedundant(
  command: ComputerCommand,
  metadata: Record<string, unknown>,
  targetIdentity?: string
): boolean {
  if (command.include_ocr || command.capture_after_include_ocr || Number(metadata.ocr_elements || 0) > 0) return false;
  if (!command.ref || !['invoke', 'set_value', 'toggle'].includes(command.action)) return false;
  if (metadata.pixel_status !== 'available') return false;
  const mode = String(metadata.mode || 'state');
  if (mode !== 'state') return false;
  if (Number(metadata.returned_elements || 0) < CAPTURE_IMAGE_SKIP_MIN_ELEMENTS) return false;
  const changes = metadata.changes as
    | {
        added?: { count?: number };
        removed?: { count?: number };
        updated?: { count?: number; sample?: string[] };
      }
    | undefined;
  if (!changes || !targetIdentity) return false;
  // Only an update to an established semantic identity is strong enough to
  // replace pixels. Added/removed rows and updates to unrelated controls can be
  // late tree initialization or a transition unrelated to the requested action.
  return (
    Number(changes.updated?.count || 0) > 0 &&
    Array.isArray(changes.updated?.sample) &&
    changes.updated.sample.includes(targetIdentity)
  );
}

export function summarizeCaptureChanges(
  previous: Map<string, string>,
  current: Map<string, string>
): Record<string, unknown> {
  const added: string[] = [];
  const removed: string[] = [];
  const updated: string[] = [];
  let unchanged = 0;
  for (const [identity, signature] of current) {
    if (!previous.has(identity)) added.push(identity);
    else if (previous.get(identity) !== signature) updated.push(identity);
    else unchanged += 1;
  }
  for (const identity of previous.keys()) {
    if (!current.has(identity)) removed.push(identity);
  }
  const group = (values: string[]) => ({
    count: values.length,
    ...(values.length ? { sample: values.slice(0, CAPTURE_CHANGE_SAMPLE) } : {}),
  });
  return {
    baseline: 'previous_capture_of_same_window',
    added: group(added),
    removed: group(removed),
    updated: group(updated),
    unchanged,
  };
}

export function transitionConfirmsSemanticAction(
  action: string,
  result: Record<string, unknown>,
  transition: ComputerWindowTransition | null,
  targetWindowId: string | undefined,
  launchTarget = ''
): boolean {
  if (result.verified === true || !transition) return false;
  if (action === 'launch') return launchTransitionConfirmsTarget(transition, launchTarget);
  if (action !== 'invoke' || !targetWindowId) return false;
  const semanticPath = ['uia_invoke', 'uia_selection', 'msaa_default_action', 'a11y_invoke', 'a11y_selection'].includes(
    String(result.path || '')
  );
  if (!semanticPath) return false;
  return (
    transition.closed_windows.some((window) => window.id === targetWindowId) ||
    transition.changed_windows.some((window) => window.id === targetWindowId) ||
    transition.next_target !== undefined
  );
}

export function shouldUseOcrFallback(
  mode: string,
  semanticAccessibilityAvailable: boolean,
  explicitlyRequested: boolean,
  filteredRead = false
): boolean {
  if (explicitlyRequested) return true;
  // A query- or role-filtered read returns the slice that was asked for, so its
  // missing content proves nothing about the window. Recognizing the full frame
  // to answer a narrow question returns words the caller never asked for — but
  // only while a tree exists to filter. With no accessibility at all, the filter
  // would answer every question with nothing and cost the caller another read.
  if (filteredRead && semanticAccessibilityAvailable) return false;
  return !semanticAccessibilityAvailable && (mode === 'state' || mode === 'som');
}

/** A window that answers with its chrome but no content surface is usually mid
 *  transition rather than semantically empty: its provider is alive and the
 *  content tree is still arriving. Asking that provider once more costs a
 *  fraction of recognizing the same pixels and returns the text exactly, so the
 *  fallback is worth one re-read before it spends a recognition pass. */
export function shouldRereadContentAccessibility(
  mode: string,
  semanticAccessibilityAvailable: boolean,
  accessibilityError: string,
  chromeElementCount: number,
  explicitlyRequestedOcr: boolean,
  filteredRead = false
): boolean {
  if (semanticAccessibilityAvailable || accessibilityError || explicitlyRequestedOcr) return false;
  // Repeating a narrowed query returns the same narrow answer.
  if (filteredRead) return false;
  if (mode !== 'state' && mode !== 'som') return false;
  return chromeElementCount > 0;
}

export function recommendedRecovery(
  effect: string,
  code: string | undefined,
  delivery: string,
  transition: ComputerWindowTransition | null
): 'switch_target' | 'recapture' | 'user' | 'foreground' | undefined {
  if (transition?.next_target) return 'switch_target';
  if (code === 'target_mismatch' || code === 'stale_target' || code === 'stale_frame' || code === 'user_input_active') {
    return 'recapture';
  }
  if (code === 'foreground_unavailable' || code === 'foreground_changed') {
    return 'user';
  }
  // A target class that cannot accept posted input never becomes able to through
  // another observation, so recapturing would only loop. Explicit foreground
  // delivery is the route the refusal itself names.
  if (code === 'background_unsupported') return 'foreground';
  // A native browser window is a user-selected session. Delivery failure does
  // not authorize replacing it with the app's separate browser session.
  if (delivery === 'background' && (effect === 'suspected_noop' || code?.startsWith('background_'))) {
    return 'recapture';
  }
  return undefined;
}

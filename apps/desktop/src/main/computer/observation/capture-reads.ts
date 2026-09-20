/**
 * The two reads a capture is made of — the bounded accessibility snapshot and
 * the pixels — and how the snapshot's answer folds into the capture state.
 */
import { CAPTURE_ACCESSIBILITY_TIMEOUT_MS, elapsedMs } from '../shared/common';
import { captureAccessibilityError } from '../input/capability-policy';
import type { ComputerCommand, ComputerElementRecord, ScreenshotCapture } from '../shared/types';
import type { CaptureMode } from './capture-target';

type PowerShellResponse = { ok: boolean; result?: Record<string, unknown>; error?: string };

export interface CaptureReadsHost {
  callPowerShell(request: Record<string, unknown>, timeoutMs?: number): Promise<PowerShellResponse>;
  sessionIdFor(command: ComputerCommand): string;
  normalizeElementRecords(value: unknown): ComputerElementRecord[];
}

export interface AccessibilityRead {
  response: PowerShellResponse | null;
  error: string;
  elapsed: number;
  visualOnlyCacheHit?: boolean;
}

export async function readAccessibilitySnapshot(
  host: CaptureReadsHost,
  {
    command,
    mode,
    replacementRead,
    windowId,
    totalElementBudget,
    visualOnlyCacheHit,
    cachedAccessibilityError,
  }: {
    command: ComputerCommand;
    mode: CaptureMode;
    replacementRead: boolean;
    windowId: string;
    totalElementBudget: number;
    visualOnlyCacheHit: boolean;
    cachedAccessibilityError: string;
  }
): Promise<AccessibilityRead | null> {
  if (mode === 'vision' || replacementRead) return null;
  if (visualOnlyCacheHit) {
    return { response: null, error: cachedAccessibilityError, elapsed: 0, visualOnlyCacheHit: true };
  }
  const startedAt = performance.now();
  try {
    const response = await host.callPowerShell(
      {
        action: 'snapshot',
        window_id: windowId,
        query: command.query ?? null,
        role: command.role ?? null,
        visible_only: command.visible_only ?? null,
        include_noninteractive: command.include_noninteractive ?? null,
        include_structure: command.include_structure ?? null,
        max_elements: totalElementBudget,
        continuation: command.continuation ?? null,
        bounded: true,
        session_id: host.sessionIdFor(command),
        read_only: true,
      },
      CAPTURE_ACCESSIBILITY_TIMEOUT_MS
    );
    return { response, error: '', elapsed: elapsedMs(startedAt) };
  } catch (error) {
    return { response: null, error: (error as Error).message || String(error), elapsed: elapsedMs(startedAt) };
  }
}

export async function readScreenshotCapture(
  captureScreenshot: (command: ComputerCommand) => Promise<ScreenshotCapture>,
  {
    command,
    mode,
    windowId,
    explicitScreen,
  }: { command: ComputerCommand; mode: CaptureMode; windowId: string; explicitScreen: boolean }
): Promise<{ capture: ScreenshotCapture; elapsed: number } | null> {
  if (mode === 'ax') return null;
  const startedAt = performance.now();
  const capture = await captureScreenshot({
    ...command,
    action: 'screenshot',
    mode,
    window: undefined,
    window_id: windowId || undefined,
    ...(explicitScreen ? {} : { screen: undefined }),
    capture_after: false,
  });
  return { capture, elapsed: elapsedMs(startedAt) };
}

export interface AccessibilityState {
  accessibilityError: string;
  rawElements: ComputerElementRecord[];
  totalElements: number;
  continuation: unknown;
  generation: unknown;
  windowId: string;
}

/** Fold the snapshot answer into the capture: the error a caller sees (paging
 *  refuses to hide it), or the elements plus the host's own phase timings. */
export function applyAccessibilityRead(
  host: Pick<CaptureReadsHost, 'normalizeElementRecords'>,
  read: AccessibilityRead,
  {
    mode,
    command,
    windowId,
    cachedAccessibilityError,
    visualOnlyCacheHit,
    timings,
  }: {
    mode: CaptureMode;
    command: ComputerCommand;
    windowId: string;
    cachedAccessibilityError: string;
    visualOnlyCacheHit: boolean;
    timings: Record<string, number>;
  }
): AccessibilityState {
  const snapshot = read.response;
  timings.accessibility_ms = read.elapsed;
  const state: AccessibilityState = {
    accessibilityError:
      cachedAccessibilityError ||
      captureAccessibilityError(visualOnlyCacheHit, snapshot?.ok === true, read.error, snapshot?.error || ''),
    rawElements: [],
    totalElements: 0,
    continuation: null,
    generation: null,
    windowId,
  };
  if (state.accessibilityError) {
    // Paging depends on the accessibility read: swallowing its error would
    // answer a stale token with page one instead of refusing it.
    if (mode === 'ax' || command.continuation) throw new Error(state.accessibilityError);
    return state;
  }
  if (!snapshot?.ok) return state;
  state.rawElements = host.normalizeElementRecords(snapshot.result?.elements);
  state.totalElements = Number(snapshot.result?.total_elements) || state.rawElements.length;
  state.continuation = snapshot.result?.continuation ?? null;
  state.generation = snapshot.result?.generation ?? null;
  state.windowId = String(snapshot.result?.window_id || windowId);
  const hostTimings = snapshot.result?.timings_ms;
  if (hostTimings && typeof hostTimings === 'object') {
    for (const [phase, duration] of Object.entries(hostTimings)) {
      const value = Number(duration);
      if (Number.isFinite(value)) timings[`accessibility.${phase}`] = value;
    }
  }
  return state;
}

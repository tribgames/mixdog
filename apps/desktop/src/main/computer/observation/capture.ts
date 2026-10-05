/**
 * How an observation is produced: the screenshot paths, the zoom crop, the SOM
 * overlay, and the compact state capture that binds accessibility to pixels.
 * The host owns session state and passes in the few primitives this needs, so
 * the engine can be read without tracing a live bridge. Each phase of the
 * state capture lives in its own capture-*.ts module; this file sequences them.
 */
import { createPixelCapture } from './capture-pixels';
import { mergeCaptureOcr } from './capture-ocr';
import { finishCapture } from './capture-finish';
import { createCaptureAfter } from './capture-after';
import { createCaptureImageDedupStore } from './capture-image-dedup';
import {
  assertCaptureTargetShape,
  assertScreenTargetMode,
  explicitScreenCapture,
  resolveCaptureWindowId,
} from './capture-target';
import { createInputObservationReader, foregroundInputState } from './capture-input-observation';
import { createVisualOnlyCache, visualOnlyCapabilityKey, visualOnlyEligible } from './capture-visual-only';
import {
  type AccessibilityRead,
  applyAccessibilityRead,
  readAccessibilitySnapshot,
  readScreenshotCapture,
} from './capture-reads';
import type { CaptureBaseline } from './capture-baseline';

import { DEFAULT_CAPTURE_MAX_ELEMENTS, elapsedMs } from '../shared/common';
import { createOcrCapturePreferenceStore } from '../input/capability-policy';
import {
  actionableAccessibilityElements,
  captureMode,
  frameElements,
  hasSemanticAccessibilityTarget,
  screenshotInteger,
  shouldRereadContentAccessibility,
} from './analysis';
import type {
  CaptureFrame,
  ComputerCommand,
  ComputerElementRecord,
  ComputerInputObservation,
  ComputerObservationGuard,
  ElementAliasTarget,
} from '../shared/types';

export interface CaptureEngineHost {
  callPowerShell(
    request: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<{
    ok: boolean;
    result?: Record<string, unknown>;
    error?: string;
  }>;
  sessionIdFor(command: ComputerCommand): string;
  assertExecutionNotAborted(): void;
  beginObservation(windowId: string): ComputerObservationGuard;
  normalizeElementRecords(value: unknown): ComputerElementRecord[];
  rememberFrame(frame: CaptureFrame): void;
  rememberElementTargets(command: ComputerCommand, elements: ComputerElementRecord[]): void;
  rememberObservedWindowScope(
    command: ComputerCommand,
    windowId: string,
    relatedWindowIds?: string[],
    inputObservation?: ComputerInputObservation
  ): void;
  forgetObservedWindowScope(command: ComputerCommand): void;
  requireValidFrame(command: ComputerCommand): Promise<CaptureFrame>;
  /** Target resolution, so a capture can name its window the way callers do. */
  resolveAppWindowId(command: ComputerCommand): Promise<string>;
  resolveForegroundWindowId(command: ComputerCommand): Promise<string>;
  framesBySession: Map<string, Map<string, CaptureFrame>>;
  elementTargetsBySession: Map<string, Map<number, ElementAliasTarget>>;
  lastCaptureBySession: Map<string, CaptureBaseline>;
  allocateFrameId(): number;
  authorizeCapture?(command: ComputerCommand, windowId: string): Promise<void>;
}

export function createCaptureEngine(host: CaptureEngineHost) {
  const {
    sessionIdFor,
    assertExecutionNotAborted,
    forgetObservedWindowScope,
    framesBySession,
    elementTargetsBySession,
    lastCaptureBySession,
  } = host;
  const visualOnly = createVisualOnlyCache();
  const ocrPreferences = createOcrCapturePreferenceStore();

  const { captureScreenshot, captureZoom } = createPixelCapture(host);

  async function captureComputer(
    command: ComputerCommand,
    forcedWindowId?: string,
    replacementRead = false
  ): Promise<{
    payload: Record<string, unknown>;
    image?: { mimeType: string; data: string };
  }> {
    const captureStartedAt = performance.now();
    const timings: Record<string, number> = {};
    const mode = captureMode(command);
    assertCaptureTargetShape(command, forcedWindowId, mode);
    // A valid capture attempt replaces the actionable observation. Clear its
    // frames, element targets, and window scope before target resolution so a
    // failed lookup or screen-only capture cannot authorize older input.
    framesBySession.delete(sessionIdFor(command));
    elementTargetsBySession.delete(sessionIdFor(command));
    forgetObservedWindowScope(command);
    const explicitScreen = explicitScreenCapture(command, forcedWindowId, mode);
    assertScreenTargetMode(command, forcedWindowId, mode);
    let windowId = await resolveCaptureWindowId(host, command, forcedWindowId, explicitScreen);
    await host.authorizeCapture?.(command, windowId);
    assertExecutionNotAborted();
    const observationGuard = host.beginObservation(windowId);
    try {
      const readInputObservation = createInputObservationReader(host, command);
      let inputObservation = await readInputObservation();
      const visualOnlyKey = visualOnlyCapabilityKey(sessionIdFor(command), windowId);
      const visualOnlyOk = visualOnlyEligible(command, mode, windowId);
      const cached = visualOnly.resolve(visualOnlyKey, visualOnlyOk);
      const { cacheHit: visualOnlyCacheHit, cachedAccessibilityError } = cached;
      let accessibilityRetryAt = cached.retryAt;
      timings.target_resolution_ms = elapsedMs(captureStartedAt);
      const totalElementBudget = screenshotInteger(
        command.max_elements,
        mode === 'state' ? DEFAULT_CAPTURE_MAX_ELEMENTS : 200,
        1,
        1_000,
        'max_elements'
      );
      if (mode !== 'vision' && !windowId) {
        throw new Error(`${mode} capture requires an exact target window`);
      }
      // Complete accessibility before pixels. If its read worker is replaced,
      // bind the pixel fallback to the replacement's input observation, not the
      // obsolete worker or a concurrently queued bounds request.
      // Both reads see the window id current at their call, which the first
      // applied read may have replaced.
      const readAccessibility = () =>
        readAccessibilitySnapshot(host, {
          command,
          mode,
          replacementRead,
          windowId,
          totalElementBudget,
          visualOnlyCacheHit,
          cachedAccessibilityError,
        });
      const applyRead = (read: AccessibilityRead) =>
        applyAccessibilityRead(host, read, {
          mode,
          command,
          windowId,
          cachedAccessibilityError,
          visualOnlyCacheHit,
          timings,
        });
      const accessibilityRead = await readAccessibility();
      if (!visualOnlyCacheHit && (accessibilityRead?.error || accessibilityRead?.response?.ok === false)) {
        inputObservation = await readInputObservation();
      }
      const screenshotRead = await readScreenshotCapture(captureScreenshot, {
        command,
        mode,
        windowId,
        explicitScreen,
      });
      host.assertExecutionNotAborted();
      let rawElements: ComputerElementRecord[] = [];
      let totalElements = 0;
      let continuation: unknown = null;
      let generation: unknown = null;
      let accessibilityError = '';
      if (accessibilityRead) {
        let applied: ReturnType<typeof applyRead>;
        try {
          applied = applyRead(accessibilityRead);
        } catch (error) {
          // A read that refuses still taught the session that this provider
          // stalls; recording it here keeps the next observation cheap.
          if (visualOnlyOk && !visualOnlyCacheHit) {
            visualOnly.record(visualOnlyKey, cached, {
              semanticAccessibilityAvailable: false,
              accessibilityError: (error as Error).message || String(error),
            });
          }
          throw error;
        }
        ({ accessibilityError, rawElements, totalElements, continuation, generation, windowId } = applied);
      }
      const screenshot = screenshotRead?.capture ?? null;
      if (screenshotRead) timings.screenshot_ms = screenshotRead.elapsed;
      const requestedWindowId = windowId;
      const observationWindowId = screenshot?.frame?.windowId || windowId;

      let elements = frameElements(rawElements, screenshot?.frame, mode !== 'som').slice(0, totalElementBudget);
      let semanticAccessibilityAvailable = hasSemanticAccessibilityTarget(rawElements, screenshot?.frame);
      if (
        !visualOnlyCacheHit &&
        !replacementRead &&
        !command.continuation &&
        shouldRereadContentAccessibility(
          mode,
          semanticAccessibilityAvailable,
          accessibilityError,
          totalElements,
          command.include_ocr === true,
          Boolean(command.query || command.role)
        )
      ) {
        const accessibilityMsBeforeReread = timings.accessibility_ms || 0;
        const contentRead = await readAccessibility();
        if (contentRead) {
          const reread = applyRead(contentRead);
          timings.accessibility_reread_ms = contentRead.elapsed;
          timings.accessibility_ms = accessibilityMsBeforeReread + contentRead.elapsed;
          // The re-read replaced the session's refs, so only its answer names
          // live ones, whether or not it found the content surface.
          ({ accessibilityError, rawElements, totalElements, continuation, generation, windowId } = reread);
          elements = frameElements(rawElements, screenshot?.frame, mode !== 'som').slice(0, totalElementBudget);
          semanticAccessibilityAvailable =
            !accessibilityError && hasSemanticAccessibilityTarget(rawElements, screenshot?.frame);
        }
      }
      if (visualOnlyOk && !visualOnlyCacheHit) {
        accessibilityRetryAt = visualOnly.record(visualOnlyKey, cached, {
          semanticAccessibilityAvailable,
          accessibilityError,
          actionableElements: actionableAccessibilityElements(rawElements).length,
        });
      }
      const { ocrPayload, ocrElements, returnedAccessibilityElements } = replacementRead
        ? {
            ocrPayload: { ok: false, skipped: true, error: 'observation worker was replaced; fresh pixels only' },
            ocrElements: [] as ComputerElementRecord[],
            returnedAccessibilityElements: 0,
          }
        : await mergeCaptureOcr(host, {
            command,
            mode,
            screenshot,
            rawElements,
            elements,
            totalElementBudget,
            semanticAccessibilityAvailable,
            observationWindowId,
            timings,
          });
      host.assertExecutionNotAborted();
      const inputAfter = await readInputObservation();
      if (inputObservation && inputAfter && inputObservation.monitor !== inputAfter.monitor) {
        if (replacementRead || mode === 'ax') {
          throw new Error('input_observation_unavailable: observation worker changed during capture');
        }
        // One bounded fresh-pixel read; do not repeat the provider that timed out.
        return await captureComputer(command, forcedWindowId, true);
      }
      const { foregroundReady, foregroundInputReason } = foregroundInputState(inputObservation, inputAfter);
      if (foregroundInputReason === 'user_input_during_capture') {
        // Actual user input pauses the session; an unavailable observer does
        // not. Never publish actionable targets from the interrupted capture.
        throw new Error('user_input_active: user input changed during capture');
      }
      if (inputObservation) {
        inputObservation = {
          ...inputObservation,
          ready: foregroundReady,
          ...(foregroundReady ? {} : { reason: foregroundInputReason || 'unknown' }),
        };
      }
      return await finishCapture(
        host,
        { lastCaptureBySession, ocrPreferences },
        {
          command,
          mode,
          forcedWindowId,
          replacementRead,
          captureStartedAt,
          timings,
          totalElementBudget,
          screenshot,
          rawElements,
          ocrElements,
          elements,
          ocrPayload,
          returnedAccessibilityElements,
          observationWindowId,
          requestedWindowId,
          generation,
          continuation,
          totalElements,
          visualOnlyCacheHit,
          cachedAccessibilityError,
          accessibilityError,
          semanticAccessibilityAvailable,
          accessibilityRetryAt,
          inputObservation,
          foregroundReady,
          foregroundInputReason,
        }
      );
    } finally {
      observationGuard.close();
    }
  }

  const imageDedup = createCaptureImageDedupStore();
  const captureAfterAction = createCaptureAfter(host, ocrPreferences, captureComputer, imageDedup);

  function releaseCaptureSession(sessionId: string): void {
    ocrPreferences.release(sessionId);
    visualOnly.releasePrefix(`${sessionId}\u0000`);
    imageDedup.releasePrefix(`${sessionId}\u0000`);
  }

  return {
    captureScreenshot,
    captureZoom,
    captureComputer,
    captureAfterAction,
    releaseCaptureSession,
  };
}

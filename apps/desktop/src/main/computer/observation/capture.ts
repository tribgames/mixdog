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
import { createCaptureSessionStores } from './capture-session-stores';
import { beginCaptureAttempt, resolveCaptureWindowId } from './capture-target';
import { createInputObservationReader, inputMonitorChanged, settleInputObservation } from './capture-input-observation';
import { resolveVisualOnlyCapture } from './capture-visual-only';
import { readScreenshotCapture } from './capture-reads';
import {
  type AccessibilityReadContext,
  applyContentReread,
  captureElementBudget,
  createAccessibilityReads,
  applyFirstAccessibilityRead,
  shouldRereadContent,
  viewAccessibility,
} from './capture-accessibility';
import type { CaptureBaseline } from './capture-baseline';

import { elapsedMs } from '../shared/common';
import type { NativeCaptureBackend } from '../shared/capture-attempts';
import type { ComputerPermissions } from '../shared/permissions';
import { actionableAccessibilityElements } from './analysis';
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
  /** Window-owned surfaces this platform's worker renders after the
   *  composited capture, in order. */
  nativeSurfaceBackends: readonly NativeCaptureBackend[];
  readPermissions(): ComputerPermissions | Promise<ComputerPermissions>;
}

/** A replaced observation worker answers with fresh pixels only: no OCR. */
function replacedWorkerOcr() {
  return {
    ocrPayload: { ok: false, skipped: true, error: 'observation worker was replaced; fresh pixels only' },
    ocrElements: [] as ComputerElementRecord[],
    returnedAccessibilityElements: 0,
  };
}

export function createCaptureEngine(host: CaptureEngineHost) {
  const { sessionIdFor, assertExecutionNotAborted, lastCaptureBySession } = host;
  const { visualOnly, ocrPreferences, imageDedup, releaseCaptureSession } = createCaptureSessionStores();

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
    const { mode, explicitScreen } = beginCaptureAttempt(host, command, forcedWindowId);
    const windowId = await resolveCaptureWindowId(host, command, forcedWindowId, explicitScreen);
    await host.authorizeCapture?.(command, windowId);
    assertExecutionNotAborted();
    const observationGuard = host.beginObservation(windowId);
    try {
      const readInputObservation = createInputObservationReader(host, command);
      let inputObservation = await readInputObservation();
      const visualOnlyCapture = resolveVisualOnlyCapture(visualOnly, sessionIdFor(command), command, mode, windowId);
      const { cacheHit: visualOnlyCacheHit, cachedAccessibilityError } = visualOnlyCapture;
      timings.target_resolution_ms = elapsedMs(captureStartedAt);
      const totalElementBudget = captureElementBudget(command, mode);
      if (mode !== 'vision' && !windowId) {
        throw new Error(`${mode} capture requires an exact target window`);
      }
      // Complete accessibility before pixels. If its read worker is replaced,
      // bind the pixel fallback to the replacement's input observation, not the
      // obsolete worker or a concurrently queued bounds request.
      const accessibilityContext: AccessibilityReadContext = {
        command,
        mode,
        replacementRead,
        totalElementBudget,
        visualOnlyCacheHit,
        cachedAccessibilityError,
        timings,
      };
      const reads = createAccessibilityReads(host, accessibilityContext);
      const accessibilityRead = await reads.read(windowId);
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
      // Recording a refusal keeps the next observation of a stalled provider cheap.
      const firstState = applyFirstAccessibilityRead(reads, accessibilityRead, windowId, (accessibilityError) => {
        visualOnlyCapture.learn({ semanticAccessibilityAvailable: false, accessibilityError });
      });
      const screenshot = screenshotRead?.capture ?? null;
      if (screenshotRead) timings.screenshot_ms = screenshotRead.elapsed;
      const requestedWindowId = firstState.windowId;
      const observationWindowId = screenshot?.frame?.windowId || firstState.windowId;

      let accessibility = viewAccessibility(firstState, screenshot?.frame, accessibilityContext);
      if (shouldRereadContent(accessibilityContext, accessibility)) {
        const contentRead = await reads.read(firstState.windowId);
        if (contentRead) {
          accessibility = applyContentReread(
            reads,
            accessibilityContext,
            contentRead,
            firstState.windowId,
            screenshot?.frame
          );
        }
      }
      const { elements, semanticAccessibilityAvailable } = accessibility;
      const { accessibilityError, rawElements, totalElements, continuation, generation } = accessibility.state;
      const accessibilityRetryAt =
        visualOnlyCapture.learn({
          semanticAccessibilityAvailable,
          accessibilityError,
          actionableElements: actionableAccessibilityElements(rawElements).length,
        }) ?? visualOnlyCapture.retryAt;
      const { ocrPayload, ocrElements, returnedAccessibilityElements } = replacementRead
        ? replacedWorkerOcr()
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
      if (inputMonitorChanged(inputObservation, inputAfter)) {
        if (replacementRead || mode === 'ax') {
          throw new Error('input_observation_unavailable: observation worker changed during capture');
        }
        // One bounded fresh-pixel read; do not repeat the provider that timed out.
        return await captureComputer(command, forcedWindowId, true);
      }
      const settled = settleInputObservation(inputObservation, inputAfter);
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
          inputObservation: settled.inputObservation,
          foregroundReady: settled.foregroundReady,
          foregroundInputReason: settled.foregroundInputReason,
        }
      );
    } finally {
      observationGuard.close();
    }
  }

  const captureAfterAction = createCaptureAfter(host, ocrPreferences, captureComputer, imageDedup);

  return {
    captureScreenshot,
    captureZoom,
    captureComputer,
    captureAfterAction,
    releaseCaptureSession,
  };
}

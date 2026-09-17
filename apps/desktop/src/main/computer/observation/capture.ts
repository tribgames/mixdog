/**
 * How an observation is produced: the screenshot paths, the zoom crop, the SOM
 * overlay, and the compact state capture that binds accessibility to pixels.
 * The host owns session state and passes in the few primitives this needs, so
 * the engine can be read without tracing a live bridge.
 */
import { createPixelCapture } from './capture-pixels';
import { mergeCaptureOcr } from './capture-ocr';
import { captureResultPayload } from './capture-result';
import { computerErrorCode } from '../../../../../../src/runtime/computer-bridge/error-code.mjs';
import { createCaptureAfter } from './capture-after';

import { DEFAULT_CAPTURE_MAX_ELEMENTS, DEFAULT_SCREENSHOT_QUALITY, elapsedMs } from '../shared/common';
import { persistFrameImage } from '../../frame-files';
import { renderSomOverlay } from './som-overlay';
import {
  captureAccessibilityError,
  createOcrCapturePreferenceStore,
  createVisualOnlyCapabilityStore,
  shouldRecordVisualOnlyCapabilityMiss,
} from '../input/capability-policy';
import {
  assertOcrLanguageTag,
  captureIdentityMap,
  captureMode,
  frameElements,
  hasSemanticAccessibilityTarget,
  screenshotInteger,
  summarizeCaptureChanges,
} from './analysis';
import type {
  CaptureFrame,
  ComputerCommand,
  ComputerElementRecord,
  ComputerInputObservation,
  ComputerObservationGuard,
  ElementAliasTarget,
  ScreenshotCapture,
} from '../shared/types';

const CAPTURE_ACCESSIBILITY_TIMEOUT_MS = 2_500;
const VISUAL_ONLY_CACHE_TTL_MS = 30_000;
const VISUAL_ONLY_CACHE_MISS_THRESHOLD = 2;
const VISUAL_ONLY_CACHE_MAX_ENTRIES = 128;

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
  lastCaptureBySession: Map<
    string,
    {
      windowId: string;
      baselineKey: string;
      elements: Map<string, string>;
      refIdentities: Map<string, string>;
    }
  >;
  allocateFrameId(): number;
  authorizeCapture?(command: ComputerCommand, windowId: string): Promise<void>;
}

export function createCaptureEngine(host: CaptureEngineHost) {
  const {
    callPowerShell,
    sessionIdFor,
    assertExecutionNotAborted,
    normalizeElementRecords,
    rememberElementTargets,
    rememberObservedWindowScope,
    forgetObservedWindowScope,
    resolveAppWindowId,
    resolveForegroundWindowId,
    framesBySession,
    elementTargetsBySession,
    lastCaptureBySession,
  } = host;
  const visualOnlyCapabilities = createVisualOnlyCapabilityStore(VISUAL_ONLY_CACHE_MAX_ENTRIES);
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
    if (mode === 'ax' && command.include_ocr) {
      throw new Error('include_ocr requires capture mode state, som, or vision');
    }
    assertOcrLanguageTag(command.ocr_language);
    if (!forcedWindowId) {
      const explicitTargets = [
        command.window_id?.trim(),
        command.window?.trim(),
        command.app?.trim(),
        command.screen !== undefined ? String(command.screen) : '',
      ].filter(Boolean);
      if (explicitTargets.length > 1) {
        throw new Error('capture accepts only one exact window, app, or screen target');
      }
    }
    // A valid capture attempt replaces the actionable observation. Clear its
    // frames, element targets, and window scope before target resolution so a
    // failed lookup or screen-only capture cannot authorize older input.
    framesBySession.delete(sessionIdFor(command));
    elementTargetsBySession.delete(sessionIdFor(command));
    forgetObservedWindowScope(command);
    const explicitScreen =
      mode === 'vision' &&
      command.screen !== undefined &&
      !forcedWindowId &&
      !command.window_id &&
      !command.window &&
      !command.app;
    if (
      mode !== 'vision' &&
      command.screen !== undefined &&
      !forcedWindowId &&
      !command.window_id &&
      !command.window &&
      !command.app
    ) {
      throw new Error('screen capture supports mode=vision only; use app or window_id for state/som/ax');
    }
    let windowId = forcedWindowId || command.window_id || '';
    if (!windowId && command.window) {
      const bounds = await callPowerShell({
        action: 'window_bounds',
        window: command.window,
        session_id: sessionIdFor(command),
        read_only: true,
      });
      if (!bounds.ok) throw new Error(bounds.error || 'window lookup failed');
      windowId = String(bounds.result?.window_id || '');
    }
    if (!windowId && command.app) windowId = await resolveAppWindowId(command);
    if (!windowId && !explicitScreen) windowId = await resolveForegroundWindowId(command);
    await host.authorizeCapture?.(command, windowId);
    assertExecutionNotAborted();
    const observationGuard = host.beginObservation(windowId);
    try {
      const readInputObservation = async (): Promise<ComputerInputObservation | undefined> => {
        assertExecutionNotAborted();
        try {
          const response = await callPowerShell(
            {
              action: 'input_idle_state',
              session_id: sessionIdFor(command),
              read_only: true,
            },
            CAPTURE_ACCESSIBILITY_TIMEOUT_MS
          );
          assertExecutionNotAborted();
          const result = response.result;
          if (
            !response.ok ||
            typeof result?.monitor !== 'string' ||
            !result.monitor ||
            !Number.isSafeInteger(result.sequence) ||
            Number(result.sequence) < 0
          )
            return undefined;
          return { ready: result.observer_ready === true, monitor: result.monitor, sequence: Number(result.sequence) };
        } catch {
          assertExecutionNotAborted();
          return undefined;
        }
      };
      let inputObservation = await readInputObservation();
      const visualOnlyCapabilityKey = `${sessionIdFor(command)}\u0000${windowId}`;
      const visualOnlyEligible = Boolean(
        windowId &&
          (mode === 'state' || mode === 'som') &&
          !command.query &&
          !command.role &&
          !command.continuation &&
          command.include_noninteractive !== true &&
          command.include_structure !== true
      );
      const { capability: visualOnlyCapability, cacheHit: visualOnlyCacheHit } = visualOnlyEligible
        ? visualOnlyCapabilities.resolve(visualOnlyCapabilityKey, Date.now())
        : { capability: undefined, cacheHit: false };
      const cachedAccessibilityError = visualOnlyCacheHit ? visualOnlyCapability?.error || '' : '';
      let accessibilityRetryAt = cachedAccessibilityError ? visualOnlyCapability?.expiresAt || 0 : 0;
      timings.target_resolution_ms = elapsedMs(captureStartedAt);
      const totalElementBudget = screenshotInteger(
        command.max_elements,
        mode === 'state' ? DEFAULT_CAPTURE_MAX_ELEMENTS : 200,
        1,
        1_000,
        'max_elements'
      );

      let rawElements: ComputerElementRecord[] = [];
      let totalElements = 0;
      let continuation: unknown = null;
      let generation: unknown = null;
      let screenshot: ScreenshotCapture | null = null;
      let accessibilityError = '';
      if (mode !== 'vision' && !windowId) {
        throw new Error(`${mode} capture requires an exact target window`);
      }
      // Complete accessibility before pixels. If its read worker is replaced,
      // bind the pixel fallback to the replacement's input observation, not the
      // obsolete worker or a concurrently queued bounds request.
      const runScreenshotTask = async () => {
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
      };
      const runAccessibilityTask = async () => {
        if (mode === 'vision' || replacementRead) return null;
        if (visualOnlyCacheHit) {
          return { response: null, error: cachedAccessibilityError, elapsed: 0, visualOnlyCacheHit: true };
        }
        const startedAt = performance.now();
        try {
          const response = await callPowerShell(
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
              session_id: sessionIdFor(command),
              read_only: true,
            },
            CAPTURE_ACCESSIBILITY_TIMEOUT_MS
          );
          return { response, error: '', elapsed: elapsedMs(startedAt) };
        } catch (error) {
          return {
            response: null,
            error: (error as Error).message || String(error),
            elapsed: elapsedMs(startedAt),
          };
        }
      };
      const accessibilityTask = await runAccessibilityTask();
      if (!visualOnlyCacheHit && (accessibilityTask?.error || accessibilityTask?.response?.ok === false)) {
        inputObservation = await readInputObservation();
      }
      const captureResults = [accessibilityTask, await runScreenshotTask()] as const;
      host.assertExecutionNotAborted();
      const [accessibilityResult, screenshotResult] = captureResults;
      if (accessibilityResult) {
        const snapshot = accessibilityResult.response;
        timings.accessibility_ms = accessibilityResult.elapsed;
        accessibilityError = cachedAccessibilityError || captureAccessibilityError(
          visualOnlyCacheHit,
          snapshot?.ok === true,
          accessibilityResult.error,
          snapshot?.error || ''
        );
        if (accessibilityError) {
          if (mode === 'ax') throw new Error(accessibilityError);
        } else if (snapshot?.ok) {
          rawElements = normalizeElementRecords(snapshot.result?.elements);
          totalElements = Number(snapshot.result?.total_elements) || rawElements.length;
          continuation = snapshot.result?.continuation ?? null;
          generation = snapshot.result?.generation ?? null;
          windowId = String(snapshot.result?.window_id || windowId);
          const hostTimings = snapshot.result?.timings_ms;
          if (hostTimings && typeof hostTimings === 'object') {
            for (const [phase, duration] of Object.entries(hostTimings)) {
              const value = Number(duration);
              if (Number.isFinite(value)) timings[`accessibility.${phase}`] = value;
            }
          }
        }
      }
      if (screenshotResult) {
        screenshot = screenshotResult.capture;
        timings.screenshot_ms = screenshotResult.elapsed;
      }
      const requestedWindowId = windowId;
      const observationWindowId = screenshot?.frame?.windowId || windowId;

      const elements = frameElements(rawElements, screenshot?.frame, mode !== 'som').slice(0, totalElementBudget);
      const semanticAccessibilityAvailable = hasSemanticAccessibilityTarget(rawElements, screenshot?.frame);
      if (visualOnlyEligible && !visualOnlyCacheHit) {
        if (semanticAccessibilityAvailable) {
          visualOnlyCapabilities.delete(visualOnlyCapabilityKey);
        } else if (computerErrorCode(accessibilityError) === 'computer_command_timeout') {
          // Do not restart the same stalled provider after every input. Keep
          // its error visible while fresh pixels/OCR remain available.
          accessibilityRetryAt = Date.now() + VISUAL_ONLY_CACHE_TTL_MS;
          visualOnlyCapabilities.remember(visualOnlyCapabilityKey, {
            misses: 0,
            expiresAt: accessibilityRetryAt,
            error: accessibilityError,
          });
        } else if (shouldRecordVisualOnlyCapabilityMiss(semanticAccessibilityAvailable, accessibilityError)) {
          const priorMisses = visualOnlyCapability?.misses || 0;
          const misses = priorMisses + 1;
          visualOnlyCapabilities.remember(visualOnlyCapabilityKey, {
            misses,
            expiresAt: misses >= VISUAL_ONLY_CACHE_MISS_THRESHOLD ? Date.now() + VISUAL_ONLY_CACHE_TTL_MS : 0,
          });
        }
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
      const foregroundReady =
        inputObservation?.ready === true &&
        inputAfter?.ready === true &&
        inputObservation.monitor === inputAfter.monitor &&
        inputObservation.sequence === inputAfter.sequence;
      const foregroundInputReason = foregroundReady
        ? undefined
        : inputObservation?.ready !== true || inputAfter?.ready !== true
          ? 'input_observer_unavailable'
          : 'user_input_during_capture';
      if (inputObservation) inputObservation = { ...inputObservation, ready: foregroundReady };
      if (mode !== 'vision') {
        rememberElementTargets(command, [...rawElements, ...ocrElements]);
      }
      const captureOk = !screenshot?.pixelUnavailable || returnedAccessibilityElements > 0;
      if (captureOk && observationWindowId) {
        rememberObservedWindowScope(
          command,
          observationWindowId,
          screenshot?.frame?.relatedWindowIds || [observationWindowId],
          inputObservation
        );
      }
      let changes: Record<string, unknown> | undefined;
      if (mode !== 'vision' && captureOk) {
        const captureSessionId = sessionIdFor(command);
        const refIdentities = new Map<string, string>();
        const identities = captureIdentityMap(rawElements, refIdentities);
        const baselineKey = JSON.stringify({
          mode,
          query: command.query ?? null,
          role: command.role ?? null,
          visible_only: command.visible_only ?? null,
          include_noninteractive: command.include_noninteractive ?? null,
          include_structure: command.include_structure ?? null,
          max_elements: totalElementBudget,
          continuation: command.continuation ?? null,
        });
        const baseline = lastCaptureBySession.get(captureSessionId);
        if (
          baseline &&
          observationWindowId &&
          baseline.windowId === observationWindowId &&
          baseline.baselineKey === baselineKey
        ) {
          changes = summarizeCaptureChanges(baseline.elements, identities);
        }
        lastCaptureBySession.set(captureSessionId, {
          windowId: observationWindowId || '',
          baselineKey,
          elements: identities,
          refIdentities,
        });
      }
      const payload = captureResultPayload({
        captureOk,
        mode,
        screenshot,
        observationWindowId,
        requestedWindowId,
        generation,
        totalElements,
        ocrElementCount: ocrElements.length,
        returnedAccessibilityElements,
        elements,
        visualOnlyCacheHit: visualOnlyCacheHit && !cachedAccessibilityError,
        accessibilityError,
        semanticAccessibilityAvailable,
        changes,
        continuation,
        ocrPayload,
      });
      payload.foreground_input_ready = foregroundReady;
      if (foregroundInputReason) payload.foreground_input_reason = foregroundInputReason;
      if (accessibilityRetryAt) {
        payload.accessibility_cache = 'timed_out_provider';
        payload.accessibility_retry_after_ms = Math.max(0, accessibilityRetryAt - Date.now());
      }
      if (replacementRead) payload.observation_fallback = 'replacement_worker_pixels';
      let image = screenshot?.image;
      if (screenshot?.frame && screenshot.frameId) {
        payload.frame_id = screenshot.frameId;
        payload.width = screenshot.frame.captureWidth;
        payload.height = screenshot.frame.captureHeight;
        if (mode === 'som' && image) {
          const overlayStartedAt = performance.now();
          const quality = screenshotInteger(command.quality, DEFAULT_SCREENSHOT_QUALITY, 0, 100, 'quality');
          const overlay = await renderSomOverlay(
            image,
            screenshot.frame.captureWidth,
            screenshot.frame.captureHeight,
            elements,
            quality
          );
          image = overlay.image;
          payload.overlay_rendered = overlay.rendered;
          if (overlay.error) payload.overlay_error = overlay.error;
          timings.overlay_ms = elapsedMs(overlayStartedAt);
        }
      }
      timings.total_ms = elapsedMs(captureStartedAt);
      payload.timings_ms = timings;
      assertExecutionNotAborted();
      if (!forcedWindowId && captureOk) {
        ocrPreferences.remember(sessionIdFor(command), {
          includeOcr: command.include_ocr === true,
          ocrLanguage: command.ocr_language,
          maxOcrWords: command.max_ocr_words,
        });
      }
      if (image && String(command.image_output || 'inline') === 'file') {
        const stored = persistFrameImage('computer', sessionIdFor(command), String(payload.frame_id || ''), image);
        // A frame that could not be written stays inline: the caller asked for a
        // cheaper reply, not for the pixels to disappear.
        if (stored) {
          payload.image_file = {
            path: stored.path,
            bytes: stored.bytes,
            mime_type: image.mimeType,
          };
          image = undefined;
        }
      }
      return {
        payload,
        ...(image ? { image } : {}),
      };
    } finally {
      observationGuard.close();
    }
  }

  const captureAfterAction = createCaptureAfter(host, ocrPreferences, captureComputer);

  function releaseCaptureSession(sessionId: string): void {
    ocrPreferences.release(sessionId);
    const prefix = `${sessionId}\u0000`;
    visualOnlyCapabilities.releasePrefix(prefix);
  }

  return {
    captureScreenshot,
    captureZoom,
    captureComputer,
    captureAfterAction,
    releaseCaptureSession,
  };
}

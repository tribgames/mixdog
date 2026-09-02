/**
 * How an observation is produced: the screenshot paths, the zoom crop, the SOM
 * overlay, and the compact state capture that binds accessibility to pixels.
 * The host owns session state and passes in the few primitives this needs, so
 * the engine can be read without tracing a live bridge.
 */
import { desktopCapturer, nativeImage, screen, type NativeImage } from 'electron';

import {
  DEFAULT_CAPTURE_AFTER_DELAY_MS,
  DEFAULT_CAPTURE_MAX_ELEMENTS,
  DEFAULT_OCR_MAX_WORDS,
  DEFAULT_SCREENSHOT_MAX_WIDTH,
  DEFAULT_SCREENSHOT_QUALITY,
  DESKTOP_CAPTURE_TIMEOUT_MS,
  elapsedMs,
  MAX_CAPTURE_AFTER_DELAY_MS,
  MAX_OCR_WORDS,
  MAX_SCREENSHOT_MAX_WIDTH,
  MIN_SCREENSHOT_MAX_WIDTH,
  NATIVE_CAPTURE_VISIBLE_SAMPLES,
  OWNED_CAPTURE_TIMEOUT_MS,
  withTimeout,
} from '../shared/common';
import { persistFrameImage } from '../../frame-files';
import { frameQualityIssue } from './frame-quality';
import { renderSomOverlay } from './som-overlay';
import { electronWindowForNativeId } from './window-handles';
import {
  captureAccessibilityError,
  createOcrCapturePreferenceStore,
  createVisualOnlyCapabilityStore,
  shouldRecordVisualOnlyCapabilityMiss,
  shouldRunCaptureOcr,
} from '../input/capability-policy';
import {
  assertOcrLanguageTag,
  captureIdentityMap,
  captureMode,
  dedupeOcrWords,
  frameElements,
  framePoint,
  hasSemanticAccessibilityTarget,
  normalizeOcrWords,
  pixelUnavailable,
  screenshotInteger,
  shouldUseOcrFallback,
  summarizeCaptureChanges,
} from './analysis';
import type {
  CaptureFrame,
  ComputerCommand,
  ComputerElementRecord,
  ElementAliasTarget,
  OcrWordRecord,
  PixelUnavailable,
  ScreenshotCapture,
} from '../shared/types';

const CAPTURE_ACCESSIBILITY_TIMEOUT_MS = 2_500;
const CAPTURE_OCR_TIMEOUT_MS = 5_000;
const VISUAL_ONLY_CACHE_TTL_MS = 30_000;
const VISUAL_ONLY_CACHE_MISS_THRESHOLD = 2;
const VISUAL_ONLY_CACHE_MAX_ENTRIES = 128;

export interface CaptureEngineHost {
  callPowerShell(request: Record<string, unknown>, timeoutMs?: number): Promise<{
    ok: boolean;
    result?: Record<string, unknown>;
    error?: string;
  }>;
  sessionIdFor(command: ComputerCommand): string;
  assertExecutionNotAborted(): void;
  normalizeElementRecords(value: unknown): ComputerElementRecord[];
  rememberFrame(frame: CaptureFrame): void;
  rememberElementTargets(command: ComputerCommand, elements: ComputerElementRecord[]): void;
  rememberObservedWindowScope(
    command: ComputerCommand,
    windowId: string,
    relatedWindowIds?: string[],
  ): void;
  forgetObservedWindowScope(command: ComputerCommand): void;
  requireValidFrame(command: ComputerCommand): Promise<CaptureFrame>;
  /** Target resolution, so a capture can name its window the way callers do. */
  resolveAppWindowId(command: ComputerCommand): Promise<string>;
  resolveForegroundWindowId(command: ComputerCommand): Promise<string>;
  framesBySession: Map<string, Map<string, CaptureFrame>>;
  elementTargetsBySession: Map<string, Map<number, ElementAliasTarget>>;
  lastCaptureBySession: Map<string, {
    windowId: string;
    baselineKey: string;
    elements: Map<string, string>;
    refIdentities: Map<string, string>;
  }>;
  allocateFrameId(): number;
}

export function createCaptureEngine(host: CaptureEngineHost) {
  const {
    callPowerShell,
    sessionIdFor,
    assertExecutionNotAborted,
    normalizeElementRecords,
    rememberFrame,
    rememberElementTargets,
    rememberObservedWindowScope,
    forgetObservedWindowScope,
    requireValidFrame,
    resolveAppWindowId,
    resolveForegroundWindowId,
    framesBySession,
    elementTargetsBySession,
    lastCaptureBySession,
    allocateFrameId,
  } = host;
  const visualOnlyCapabilities = createVisualOnlyCapabilityStore(
    VISUAL_ONLY_CACHE_MAX_ENTRIES,
  );
  const ocrPreferences = createOcrCapturePreferenceStore();

  async function captureVisibleNativeWindow(
    windowId: string,
    sessionId: string,
    requireFullyVisible = false,
  ): Promise<{
    image: NativeImage;
    sourceId: string;
    sourceName: string;
    x: number;
    y: number;
    width: number;
    height: number;
  } | null> {
    try {
      const response = await callPowerShell({
        action: 'window_capture',
        window_id: windowId,
        session_id: sessionId,
        read_only: true,
      });
      const encoded = String(response.result?.image_base64 || '');
      if (!response.ok || !encoded) return null;
      // A direct grab reads the screen region the window occupies, so it is only
      // equivalent to the window's own pixels while nothing covers it.
      if (requireFullyVisible
        && Number(response.result?.visible_samples || 0) < NATIVE_CAPTURE_VISIBLE_SAMPLES) {
        return null;
      }
      const image = nativeImage.createFromBuffer(Buffer.from(encoded, 'base64'));
      const size = image.getSize();
      if (image.isEmpty() || size.width <= 0 || size.height <= 0) return null;
      return {
        image,
        sourceId: `native-window:${windowId}`,
        sourceName: String(response.result?.title || windowId),
        x: Math.round(Number(response.result?.x) || 0),
        y: Math.round(Number(response.result?.y) || 0),
        width: Math.round(Number(response.result?.width) || size.width),
        height: Math.round(Number(response.result?.height) || size.height),
      };
    } catch {
      return null;
    }
  }

  async function captureScreenshot(
    command: ComputerCommand,
    allowOwnerFallback = true,
  ): Promise<ScreenshotCapture> {
    const quality = screenshotInteger(command.quality, DEFAULT_SCREENSHOT_QUALITY, 0, 100, 'quality');
    const maxWidth = screenshotInteger(
      command.maxWidth,
      DEFAULT_SCREENSHOT_MAX_WIDTH,
      MIN_SCREENSHOT_MAX_WIDTH,
      MAX_SCREENSHOT_MAX_WIDTH,
      'maxWidth',
    );
    let sourceType: 'screen' | 'window' = 'screen';
    let sourceTitle = 'primary screen';
    let sourceWidth: number;
    let sourceHeight: number;
    let targetDisplayId = '';
    let targetWindowId = '';
    // Physical-pixel origin and width of the captured surface, so the caption
    // can state the exact image-to-screen coordinate mapping for click x/y.
    let originX = 0;
    let originY = 0;
    let physicalWidth = 0;
    let physicalHeight = 0;
    let targetWindowX = 0;
    let targetWindowY = 0;
    let targetWindowWidth = 0;
    let targetWindowHeight = 0;
    let captureOwnerWindowId = '';
    let clientOriginX = 0;
    let clientOriginY = 0;
    let clientWidth = 0;
    let clientHeight = 0;
    let relatedWindowIds: string[] | null = null;
    if (command.window_id?.trim() || command.window?.trim()) {
      const bounds = await callPowerShell({
        action: 'window_bounds',
        window: command.window?.trim() || null,
        window_id: command.window_id?.trim() || null,
        session_id: sessionIdFor(command),
        read_only: true,
      });
      if (!bounds.ok) throw new Error(bounds.error || 'window bounds lookup failed');
      sourceType = 'window';
      sourceTitle = String(bounds.result?.title || command.window?.trim() || command.window_id);
      targetWindowId = String(bounds.result?.window_id || command.window_id || '');
      captureOwnerWindowId = String(bounds.result?.owner_id || '');
      sourceWidth = Number(bounds.result?.width);
      sourceHeight = Number(bounds.result?.height);
      if (!Number.isFinite(sourceWidth) || sourceWidth <= 0 || !Number.isFinite(sourceHeight) || sourceHeight <= 0) {
        throw new Error(`window has no capturable bounds: ${sourceTitle}`);
      }
      originX = Math.round(Number(bounds.result?.x) || 0);
      originY = Math.round(Number(bounds.result?.y) || 0);
      physicalWidth = sourceWidth;
      physicalHeight = sourceHeight;
      targetWindowX = originX;
      targetWindowY = originY;
      targetWindowWidth = sourceWidth;
      targetWindowHeight = sourceHeight;
      clientOriginX = Math.round(Number(bounds.result?.client_x) || originX);
      clientOriginY = Math.round(Number(bounds.result?.client_y) || originY);
      clientWidth = Math.round(Number(bounds.result?.client_width) || 0);
      clientHeight = Math.round(Number(bounds.result?.client_height) || 0);
      const ids = Array.isArray(bounds.result?.related_window_ids)
        ? bounds.result.related_window_ids.map(String).filter(Boolean)
        : [];
      relatedWindowIds = ids.includes(targetWindowId) ? ids : [targetWindowId, ...ids];
    } else {
      const displays = screen.getAllDisplays();
      const primaryIndex = Math.max(0, displays.findIndex((display) => display.id === screen.getPrimaryDisplay().id));
      const index = screenshotInteger(command.screen, primaryIndex, 0, Math.max(0, displays.length - 1), 'screen');
      const display = displays[index] ?? screen.getPrimaryDisplay();
      targetDisplayId = String(display.id);
      sourceWidth = display.size.width;
      sourceHeight = display.size.height;
      const nativeOrigin = display.nativeOrigin ?? { x: display.bounds.x, y: display.bounds.y };
      originX = nativeOrigin.x;
      originY = nativeOrigin.y;
      physicalWidth = Math.round(display.size.width * display.scaleFactor);
      physicalHeight = Math.round(display.size.height * display.scaleFactor);
      if (displays.length > 1) sourceTitle = `screen ${index + 1}/${displays.length}`;
    }
    const scale = Math.min(1, maxWidth / Math.max(1, sourceWidth));
    let capturedImage: NativeImage | undefined;
    let capturedSourceId = '';
    let capturedSourceName = sourceTitle;
    const ownedWindow = targetWindowId ? electronWindowForNativeId(targetWindowId) : null;
    if (ownedWindow && !ownedWindow.isDestroyed() && !ownedWindow.webContents.isDestroyed()) {
      let timeout: NodeJS.Timeout | undefined;
      try {
        const ownedImage = await Promise.race([
          ownedWindow.capturePage(),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () => reject(new Error('app-owned capture timed out')),
              OWNED_CAPTURE_TIMEOUT_MS,
            );
          }),
        ]);
        const ownedSize = ownedImage.getSize();
        const candidateImage = ownedSize.width > maxWidth
          ? ownedImage.resize({ width: maxWidth, quality: 'best' })
          : ownedImage;
        const candidateSize = candidateImage.getSize();
        const candidateRatio = candidateSize.width / Math.max(1, candidateSize.height);
        const expectedGeometry = [
          { width: physicalWidth, height: physicalHeight },
          { width: clientWidth, height: clientHeight },
        ].filter((candidate) => candidate.width > 0 && candidate.height > 0)
          .reduce((best, candidate) => {
            const error = Math.abs(candidate.width / candidate.height - candidateRatio);
            const bestError = Math.abs(best.width / best.height - candidateRatio);
            return error < bestError ? candidate : best;
          });
        if (!frameQualityIssue(
          candidateImage,
          expectedGeometry.width,
          expectedGeometry.height,
        )) {
          capturedImage = candidateImage;
          capturedSourceId = `browser-window:${targetWindowId}`;
        }
      } catch {
        capturedImage = undefined;
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }
    const tryNativeWindowCapture = async (requireFullyVisible: boolean): Promise<boolean> => {
      if (capturedImage || !targetWindowId) return false;
      const nativeCapture = await captureVisibleNativeWindow(
        targetWindowId,
        sessionIdFor(command),
        requireFullyVisible,
      );
      if (!nativeCapture) return false;
      const nativeSize = nativeCapture.image.getSize();
      capturedImage = nativeSize.width > maxWidth
        ? nativeCapture.image.resize({ width: maxWidth, quality: 'best' })
        : nativeCapture.image;
      capturedSourceId = nativeCapture.sourceId;
      capturedSourceName = nativeCapture.sourceName;
      originX = nativeCapture.x;
      originY = nativeCapture.y;
      physicalWidth = nativeCapture.width;
      physicalHeight = nativeCapture.height;
      return true;
    };
    // desktopCapturer renders a thumbnail for EVERY window before we pick one,
    // so its cost grows with the user's open windows. A window that proved fully
    // visible is grabbed directly; anything partial falls through to compositing.
    await tryNativeWindowCapture(true);
    if (!capturedImage) {
      const sources = await withTimeout(
        desktopCapturer.getSources({
          types: [sourceType],
          thumbnailSize: {
            width: Math.max(1, Math.round(sourceWidth * scale)),
            height: Math.max(1, Math.round(sourceHeight * scale)),
          },
        }),
        DESKTOP_CAPTURE_TIMEOUT_MS,
        'desktop capture',
      ).catch(() => null);
      const windowHandleDecimal = targetWindowId
        ? Number.parseInt(targetWindowId.replace(/^hwnd:/i, '').replace(/^0x/i, ''), 16)
        : Number.NaN;
      const source = sources
        ? (sourceType === 'screen'
            ? sources.find((candidate) => candidate.display_id === targetDisplayId)
            : sources.find((candidate) => Number.isFinite(windowHandleDecimal)
                && candidate.id.split(':').some((part) => Number(part) === windowHandleDecimal)))
        : undefined;
      if (source) {
        capturedImage = source.thumbnail;
        capturedSourceId = source.id;
        capturedSourceName = source.name;
      }
      await tryNativeWindowCapture(false);
      if (!capturedImage) {
        if (allowOwnerFallback
          && targetWindowId
          && captureOwnerWindowId
          && captureOwnerWindowId !== targetWindowId) {
          const ownerCapture = await captureScreenshot({
            ...command,
            window: undefined,
            window_id: captureOwnerWindowId,
          }, false);
          if (ownerCapture.image && ownerCapture.frame && ownerCapture.frameId) {
            return {
              ...ownerCapture,
              description: `${ownerCapture.description}; requested child window ${targetWindowId}`
                + ` was captured through owner ${captureOwnerWindowId}`,
            };
          }
        }
        const unavailable = pixelUnavailable(
          'capture_source_unavailable',
          sources
            ? `exact ${sourceType} capture source is unavailable`
            : `exact ${sourceType} capture did not settle before the safety deadline`,
        );
        return {
          description: unavailable.message,
          ...(targetWindowId ? { windowId: targetWindowId } : {}),
          pixelUnavailable: unavailable,
        };
      }
    }
    const thumbnailSize = capturedImage.getSize();
    if (targetWindowId && clientWidth > 0 && clientHeight > 0) {
      const actualAspectRatio = thumbnailSize.width / Math.max(1, thumbnailSize.height);
      const candidates = [
        { x: originX, y: originY, width: physicalWidth, height: physicalHeight },
        { x: clientOriginX, y: clientOriginY, width: clientWidth, height: clientHeight },
      ];
      const geometry = candidates.reduce((best, candidate) => {
        const candidateRatio = candidate.width / Math.max(1, candidate.height);
        const candidateError = Math.abs(candidateRatio - actualAspectRatio)
          / Math.max(0.0001, candidateRatio);
        const bestRatio = best.width / Math.max(1, best.height);
        const bestError = Math.abs(bestRatio - actualAspectRatio)
          / Math.max(0.0001, bestRatio);
        return candidateError < bestError ? candidate : best;
      });
      originX = geometry.x;
      originY = geometry.y;
      physicalWidth = geometry.width;
      physicalHeight = geometry.height;
    }
    const qualityIssue = frameQualityIssue(
      capturedImage,
      physicalWidth || sourceWidth,
      physicalHeight || sourceHeight,
    );
    if (qualityIssue) {
      return {
        description: qualityIssue.message,
        ...(targetWindowId ? { windowId: targetWindowId } : {}),
        pixelUnavailable: qualityIssue,
      };
    }
    const jpeg = capturedImage.toJPEG(quality);
    if (!jpeg || jpeg.length === 0) {
      const unavailable = pixelUnavailable('empty_frame', 'capture could not encode a pixel frame');
      return {
        description: unavailable.message,
        ...(targetWindowId ? { windowId: targetWindowId } : {}),
        pixelUnavailable: unavailable,
      };
    }
    const frameId = `frame-${allocateFrameId()}`;
    const frame: CaptureFrame = {
      id: frameId,
      sessionId: sessionIdFor(command),
      capturedAt: performance.now(),
      kind: sourceType,
      sourceId: capturedSourceId,
      ...(targetWindowId ? { windowId: targetWindowId } : {}),
      ...(targetDisplayId ? { displayId: targetDisplayId } : {}),
      originX,
      originY,
      physicalWidth,
      physicalHeight,
      ...(targetWindowId ? {
        relatedWindowIds: relatedWindowIds || [targetWindowId],
      } : {}),
      captureWidth: thumbnailSize.width,
      captureHeight: thumbnailSize.height,
      ...(targetWindowId ? {
        windowX: originX,
        windowY: originY,
        windowWidth: physicalWidth,
        windowHeight: physicalHeight,
        targetWindowX,
        targetWindowY,
        targetWindowWidth,
        targetWindowHeight,
      } : {
        displayX: originX,
        displayY: originY,
        displayWidth: physicalWidth,
        displayHeight: physicalHeight,
      }),
    };
    rememberFrame(frame);
    const route = capturedSourceId.startsWith('browser-window:')
      ? 'app_owned' as const
      : capturedSourceId.startsWith('native-window:')
        ? 'window_region' as const
        : 'composited' as const;
    return {
      route,
      image: { mimeType: 'image/jpeg', data: jpeg.toString('base64') },
      description: `Screenshot of ${sourceType === 'window' ? `window "${capturedSourceName}"` : sourceTitle}`
        + ` (${thumbnailSize.width}x${thumbnailSize.height}, ${jpeg.length} bytes, JPEG quality ${quality});`
        + ` frame_id=${frameId}`
        + `${targetWindowId ? ` window_id=${targetWindowId}` : ''}; coordinates are pixels in this frame`,
      frameId,
      ...(targetWindowId ? { windowId: targetWindowId } : {}),
      frame,
    };
  }

  async function captureZoom(command: ComputerCommand): Promise<{
    image?: { mimeType: string; data: string };
    description: string;
    frameId?: string;
    pixelUnavailable?: PixelUnavailable;
  } | null> {
    const quality = screenshotInteger(command.quality, DEFAULT_SCREENSHOT_QUALITY, 0, 100, 'quality');
    const maxWidth = screenshotInteger(
      command.maxWidth,
      DEFAULT_SCREENSHOT_MAX_WIDTH,
      MIN_SCREENSHOT_MAX_WIDTH,
      MAX_SCREENSHOT_MAX_WIDTH,
      'maxWidth',
    );
    const region = command.region;
    if (!Array.isArray(region) || region.length !== 4 || region.some((value) => !Number.isInteger(value))) {
      throw new Error('zoom requires region [x0,y0,x1,y1] in frame_id image coordinates');
    }
    const frame = await requireValidFrame(command);
    const [fx0, fy0, fx1, fy1] = region;
    if (fx0 < 0 || fy0 < 0 || fx1 > frame.captureWidth || fy1 > frame.captureHeight
      || fx1 - fx0 < 8 || fy1 - fy0 < 8) {
      throw new Error(`zoom region must be at least 8x8 and inside frame ${frame.captureWidth}x${frame.captureHeight}`);
    }
    const x0 = frame.originX + Math.round((fx0 * frame.physicalWidth) / frame.captureWidth);
    const y0 = frame.originY + Math.round((fy0 * frame.physicalHeight) / frame.captureHeight);
    const x1 = frame.originX + Math.round((fx1 * frame.physicalWidth) / frame.captureWidth);
    const y1 = frame.originY + Math.round((fy1 * frame.physicalHeight) / frame.captureHeight);
    const baseOriginX = frame.kind === 'window' ? frame.windowX : frame.displayX;
    const baseOriginY = frame.kind === 'window' ? frame.windowY : frame.displayY;
    const baseWidth = frame.kind === 'window' ? frame.windowWidth : frame.displayWidth;
    const baseHeight = frame.kind === 'window' ? frame.windowHeight : frame.displayHeight;
    if (baseOriginX === undefined || baseOriginY === undefined
        || baseWidth === undefined || baseHeight === undefined) {
      throw new Error(`stale_frame: capture source geometry is missing (${frame.id})`);
    }
    let source: { id: string; thumbnail: NativeImage; display_id?: string } | undefined;
    if (frame.kind === 'window'
      && frame.sourceId.startsWith('native-window:')
      && frame.windowId) {
      const nativeCapture = await captureVisibleNativeWindow(frame.windowId, frame.sessionId);
      if (nativeCapture) {
        source = {
          id: nativeCapture.sourceId,
          thumbnail: nativeCapture.image,
        };
      }
    }
    if (!source) {
      const sources = await withTimeout(
        desktopCapturer.getSources({
          types: [frame.kind],
          thumbnailSize: { width: baseWidth, height: baseHeight },
        }),
        DESKTOP_CAPTURE_TIMEOUT_MS,
        'desktop zoom capture',
      );
      const windowHandleDecimal = frame.windowId
        ? Number.parseInt(frame.windowId.replace(/^hwnd:/i, '').replace(/^0x/i, ''), 16)
        : Number.NaN;
      source = sources.find((candidate) => candidate.id === frame.sourceId)
        || (frame.kind === 'window'
          ? sources.find((candidate) => Number.isFinite(windowHandleDecimal)
              && candidate.id.split(':').some((part) => Number(part) === windowHandleDecimal))
          : sources.find((candidate) => candidate.display_id === frame.displayId));
    }
    if (!source) throw new Error(`stale_frame: exact capture source is unavailable (${frame.id})`);
    const shot = source.thumbnail;
    const shotSize = shot.getSize();
    if (!shotSize.width || !shotSize.height) return null;
    const kx = shotSize.width / baseWidth;
    const ky = shotSize.height / baseHeight;
    const cropX = Math.min(shotSize.width - 1, Math.max(0, Math.round((x0 - baseOriginX) * kx)));
    const cropY = Math.min(shotSize.height - 1, Math.max(0, Math.round((y0 - baseOriginY) * ky)));
    const cropW = Math.min(shotSize.width - cropX, Math.max(1, Math.round((x1 - x0) * kx)));
    const cropH = Math.min(shotSize.height - cropY, Math.max(1, Math.round((y1 - y0) * ky)));
    let image = shot.crop({ x: cropX, y: cropY, width: cropW, height: cropH });
    if (image.getSize().width > maxWidth) image = image.resize({ width: maxWidth });
    const finalSize = image.getSize();
    const qualityIssue = frameQualityIssue(image, x1 - x0, y1 - y0);
    if (qualityIssue) {
      return {
        description: qualityIssue.message,
        pixelUnavailable: qualityIssue,
      };
    }
    const jpeg = image.toJPEG(quality);
    if (!jpeg || jpeg.length === 0) return null;
    const zoomFrameId = `frame-${allocateFrameId()}`;
    framesBySession.get(sessionIdFor(command))?.clear();
    rememberFrame({
      id: zoomFrameId,
      sessionId: sessionIdFor(command),
      capturedAt: performance.now(),
      kind: frame.kind,
      sourceId: source.id,
      ...(frame.windowId ? { windowId: frame.windowId } : {}),
      ...(frame.displayId ? { displayId: frame.displayId } : {}),
      originX: x0,
      originY: y0,
      physicalWidth: x1 - x0,
      physicalHeight: y1 - y0,
      captureWidth: finalSize.width,
      captureHeight: finalSize.height,
      ...(frame.windowId ? {
        windowX: frame.windowX,
        windowY: frame.windowY,
        windowWidth: frame.windowWidth,
        windowHeight: frame.windowHeight,
        targetWindowX: frame.targetWindowX,
        targetWindowY: frame.targetWindowY,
        targetWindowWidth: frame.targetWindowWidth,
        targetWindowHeight: frame.targetWindowHeight,
      } : {
        displayX: frame.displayX,
        displayY: frame.displayY,
        displayWidth: frame.displayWidth,
        displayHeight: frame.displayHeight,
      }),
    });
    return {
      image: { mimeType: 'image/jpeg', data: jpeg.toString('base64') },
      frameId: zoomFrameId,
      description: `Zoom of ${frame.id} region (${fx0},${fy0})-(${fx1},${fy1})`
        + ` (${finalSize.width}x${finalSize.height}, ${jpeg.length} bytes, JPEG quality ${quality});`
        + ` frame_id=${zoomFrameId}; coordinates are pixels in this frame`,
    };
  }

  async function captureComputer(
    command: ComputerCommand,
    forcedWindowId?: string,
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
    const explicitScreen = mode === 'vision'
      && command.screen !== undefined
      && !forcedWindowId
      && !command.window_id
      && !command.window
      && !command.app;
    if (mode !== 'vision' && command.screen !== undefined
      && !forcedWindowId && !command.window_id && !command.window && !command.app) {
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
    const visualOnlyCapabilityKey = `${sessionIdFor(command)}\u0000${windowId}`;
    const visualOnlyEligible = Boolean(
      windowId
      && (mode === 'state' || mode === 'som')
      && !command.query
      && !command.role
      && !command.continuation
      && command.include_noninteractive !== true
      && command.include_structure !== true,
    );
    const {
      capability: visualOnlyCapability,
      cacheHit: visualOnlyCacheHit,
    } = visualOnlyEligible
      ? visualOnlyCapabilities.resolve(visualOnlyCapabilityKey, Date.now())
      : { capability: undefined, cacheHit: false };
    timings.target_resolution_ms = elapsedMs(captureStartedAt);
    const totalElementBudget = screenshotInteger(
      command.max_elements,
      mode === 'state' ? DEFAULT_CAPTURE_MAX_ELEMENTS : 200,
      1,
      1_000,
      'max_elements',
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
    // External pixels can be captured while PowerShell walks UI Automation.
    // App-owned Chromium uses one renderer for both operations, so serialize it
    // to avoid a capturePage/UIA deadlock on newly opened BrowserWindows.
    const runScreenshotTask = async () => {
      if (mode === 'ax') return null;
      const startedAt = performance.now();
      const capture = await captureScreenshot({
        ...command,
        action: 'screenshot',
        window: undefined,
        window_id: windowId || undefined,
        ...(explicitScreen ? {} : { screen: undefined }),
        capture_after: false,
      });
      return { capture, elapsed: elapsedMs(startedAt) };
    };
    const runAccessibilityTask = async () => {
      if (mode === 'vision') return null;
      if (visualOnlyCacheHit) {
        return { response: null, error: '', elapsed: 0, visualOnlyCacheHit: true };
      }
      const startedAt = performance.now();
      try {
        const response = await callPowerShell({
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
        }, CAPTURE_ACCESSIBILITY_TIMEOUT_MS);
        return { response, error: '', elapsed: elapsedMs(startedAt) };
      } catch (error) {
        return {
          response: null,
          error: (error as Error).message || String(error),
          elapsed: elapsedMs(startedAt),
        };
      }
    };
    const serializeOwnedCapture = mode !== 'vision'
      && mode !== 'ax'
      && Boolean(windowId && electronWindowForNativeId(windowId));
    const captureResults = serializeOwnedCapture
      ? [await runAccessibilityTask(), await runScreenshotTask()] as const
      : await Promise.all([runAccessibilityTask(), runScreenshotTask()] as const);
    const [accessibilityResult, screenshotResult] = captureResults;
    if (accessibilityResult) {
      const snapshot = accessibilityResult.response;
      timings.accessibility_ms = accessibilityResult.elapsed;
      accessibilityError = captureAccessibilityError(
        visualOnlyCacheHit,
        snapshot?.ok === true,
        accessibilityResult.error,
        snapshot?.error || '',
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

    const elements = frameElements(rawElements, screenshot?.frame, mode !== 'som')
      .slice(0, totalElementBudget);
    const semanticAccessibilityAvailable = hasSemanticAccessibilityTarget(
      rawElements,
      screenshot?.frame,
    );
    if (visualOnlyEligible && !visualOnlyCacheHit) {
      if (semanticAccessibilityAvailable) {
        visualOnlyCapabilities.delete(visualOnlyCapabilityKey);
      } else if (shouldRecordVisualOnlyCapabilityMiss(
        semanticAccessibilityAvailable,
        accessibilityError,
      )) {
        const priorMisses = visualOnlyCapability?.misses || 0;
        const misses = priorMisses + 1;
        visualOnlyCapabilities.remember(visualOnlyCapabilityKey, {
          misses,
          expiresAt: misses >= VISUAL_ONLY_CACHE_MISS_THRESHOLD
            ? Date.now() + VISUAL_ONLY_CACHE_TTL_MS
            : 0,
        });
      }
    }
    const ocrFallbackEnabled = shouldUseOcrFallback(
      mode,
      semanticAccessibilityAvailable,
      command.include_ocr === true,
    );
    const runOcrForCapture = shouldRunCaptureOcr(
      ocrFallbackEnabled,
      semanticAccessibilityAvailable,
      command.include_ocr === true,
    );
    const requestedOcrLimit = ocrFallbackEnabled
      ? screenshotInteger(
          command.max_ocr_words,
          DEFAULT_OCR_MAX_WORDS,
          1,
          MAX_OCR_WORDS,
          'max_ocr_words',
        )
      : 0;
    const reservedOcrBudget = runOcrForCapture
      && screenshot?.image
      && screenshot.frame
      ? Math.min(requestedOcrLimit, Math.max(1, Math.floor(totalElementBudget / 2)))
      : 0;
    if (reservedOcrBudget > 0 && elements.length > totalElementBudget - reservedOcrBudget) {
      elements.splice(totalElementBudget - reservedOcrBudget);
    }
    const returnedAccessibilityElements = elements.length;
    let ocrWords: OcrWordRecord[] = [];
    let ocrPayload: Record<string, unknown> | undefined;
    let ocrElements: ComputerElementRecord[] = [];
    const remainingElementBudget = Math.max(0, totalElementBudget - returnedAccessibilityElements);
    const shouldRunOcr = Boolean(
      screenshot?.image
      && screenshot.frame
      && runOcrForCapture
      && remainingElementBudget > 0,
    );
    if (shouldRunOcr && screenshot?.image && screenshot.frame) {
      const ocrStartedAt = performance.now();
      try {
        const ocr = await callPowerShell({
          action: 'ocr_image',
          image_base64: screenshot.image.data,
          ocr_language: command.ocr_language ?? null,
          max_ocr_words: Math.min(requestedOcrLimit, remainingElementBudget),
          session_id: sessionIdFor(command),
          read_only: true,
        }, CAPTURE_OCR_TIMEOUT_MS);
        if (!ocr.ok) throw new Error(ocr.error || 'Windows OCR failed');
        ocrWords = dedupeOcrWords(
          normalizeOcrWords(ocr.result?.words),
          elements,
        ).slice(0, remainingElementBudget);
        if (mode === 'som' || mode === 'state') {
          let nextMark = rawElements.reduce(
            (maximumMark, element) => Math.max(maximumMark, element.mark),
            0,
          ) + 1;
          ocrElements = ocrWords.map((word) => {
            const mark = nextMark++;
            return {
              mark,
              ref: `ocr:${screenshot.frameId}:${mark}`,
              source: 'ocr',
              role: 'Text',
              name: word.text,
              value: '',
              state: 'ocr',
              enabled: true,
              x: word.x,
              y: word.y,
              width: Math.max(1, word.width),
              height: Math.max(1, word.height),
              center_x: word.center_x,
              center_y: word.center_y,
              actions: ['click', 'double_click', 'mouse_move', 'drag', 'scroll', 'type'],
              frame_id: screenshot.frameId,
              window_id: observationWindowId || undefined,
            };
          });
          for (const element of ocrElements) {
            const topLeft = framePoint(screenshot.frame, element.x, element.y);
            const bottomRight = framePoint(
              screenshot.frame,
              Math.min(screenshot.frame.captureWidth - 1, element.x + element.width - 1),
              Math.min(screenshot.frame.captureHeight - 1, element.y + element.height - 1),
            );
            const bounds: [number, number, number, number] = [
              element.x,
              element.y,
              element.width,
              element.height,
            ];
            elements.push(mode === 'state' ? {
              mark: element.mark,
              ref: element.ref,
              source: element.source,
              role: element.role,
              name: element.name,
              state: element.state,
              enabled: element.enabled,
              bounds,
              actions: element.actions,
            } : {
              ...element,
              bounds,
              center: [element.center_x, element.center_y],
              screen_bounds: [
                topLeft.x,
                topLeft.y,
                Math.max(1, bottomRight.x - topLeft.x + 1),
                Math.max(1, bottomRight.y - topLeft.y + 1),
              ],
            });
          }
        }
        const markedWords = mode === 'som' || mode === 'state'
          ? ocrWords.map((word, index) => ({
              ...word,
              mark: ocrElements[index]?.mark,
            }))
          : ocrWords;
        ocrPayload = {
          ok: true,
          mode: 'fallback',
          automatic: command.include_ocr !== true,
          language: String(ocr.result?.language || ''),
          lines: Array.isArray(ocr.result?.lines) ? ocr.result?.lines : [],
          words: markedWords,
          total_words: Number(ocr.result?.total_words) || 0,
          truncated_words: Number(ocr.result?.truncated_words) || 0,
        };
      } catch (error) {
        ocrPayload = {
          ok: false,
          error: (error as Error).message || String(error),
        };
      }
      timings.ocr_ms = elapsedMs(ocrStartedAt);
    } else if (ocrFallbackEnabled) {
      ocrPayload = {
        ok: true,
        mode: 'fallback',
        automatic: command.include_ocr !== true,
        skipped: true,
        reason: remainingElementBudget <= 0
          ? 'element_budget_exhausted'
          : semanticAccessibilityAvailable
            ? 'semantic_accessibility_available'
            : screenshot?.pixelUnavailable
              ? 'pixel_unavailable'
              : 'screenshot_unavailable',
        lines: [],
        words: [],
        total_words: 0,
        truncated_words: 0,
      };
    }
    if (mode !== 'vision') {
      rememberElementTargets(command, [...rawElements, ...ocrElements]);
    }
    const captureOk = !screenshot?.pixelUnavailable || returnedAccessibilityElements > 0;
    if (captureOk && observationWindowId) {
      rememberObservedWindowScope(
        command,
        observationWindowId,
        screenshot?.frame?.relatedWindowIds || [observationWindowId],
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
      if (baseline
        && observationWindowId
        && baseline.windowId === observationWindowId
        && baseline.baselineKey === baselineKey) {
        changes = summarizeCaptureChanges(baseline.elements, identities);
      }
      lastCaptureBySession.set(captureSessionId, {
        windowId: observationWindowId || '',
        baselineKey,
        elements: identities,
        refIdentities,
      });
    }
    const mergedTotalElements = totalElements + ocrElements.length;
    const truncatedAccessibilityElements = Math.max(
      0,
      totalElements - returnedAccessibilityElements,
    );
    const payload: Record<string, unknown> = {
      ok: captureOk,
      action: 'capture',
      mode,
      coordinate_space: screenshot?.frame ? 'frame' : 'screen',
      ...(screenshot?.route ? { capture_source: screenshot.route } : {}),
      ...(observationWindowId ? { window_id: observationWindowId } : {}),
      ...(requestedWindowId && requestedWindowId !== observationWindowId ? {
        requested_window_id: requestedWindowId,
        capture_target_reason: 'capturable_owner',
      } : {}),
      ...(generation !== null ? { generation } : {}),
      total_elements: mergedTotalElements,
      returned_elements: elements.length,
      accessibility_status: mode === 'vision'
        ? 'not_requested'
        : visualOnlyCacheHit
          ? 'visual_only_cached'
        : accessibilityError
          ? 'error'
          : semanticAccessibilityAvailable ? 'available' : 'empty',
      ...(visualOnlyCacheHit ? { accessibility_cache: 'visual_only' } : {}),
      ...(accessibilityError ? { accessibility_error: accessibilityError } : {}),
      ...(changes ? { changes } : {}),
      ...(mode !== 'vision' ? { total_accessibility_elements: totalElements } : {}),
      ...(ocrElements.length ? { ocr_elements: ocrElements.length } : {}),
      ...(continuation ? { continuation } : {}),
      ...(truncatedAccessibilityElements
        ? { truncated_elements: truncatedAccessibilityElements }
        : {}),
      ...(mode !== 'vision' ? { elements } : {}),
      ...(ocrPayload ? { ocr: ocrPayload } : {}),
      pixel_status: screenshot?.pixelUnavailable ? 'unavailable' : mode === 'ax' ? 'not_requested' : 'available',
      ...(screenshot?.pixelUnavailable ? {
        pixel_unavailable: screenshot.pixelUnavailable,
        escalation: 'recapture',
      } : {}),
    };
    let image = screenshot?.image;
    if (screenshot?.frame && screenshot.frameId) {
      payload.frame_id = screenshot.frameId;
      payload.width = screenshot.frame.captureWidth;
      payload.height = screenshot.frame.captureHeight;
      if (mode === 'som' && image) {
        const overlayStartedAt = performance.now();
        const quality = screenshotInteger(
          command.quality,
          DEFAULT_SCREENSHOT_QUALITY,
          0,
          100,
          'quality',
        );
        const overlay = await renderSomOverlay(
          image,
          screenshot.frame.captureWidth,
          screenshot.frame.captureHeight,
          elements,
          quality,
        );
        image = overlay.image;
        payload.overlay_rendered = overlay.rendered;
        if (overlay.error) payload.overlay_error = overlay.error;
        timings.overlay_ms = elapsedMs(overlayStartedAt);
      }
    }
    timings.total_ms = elapsedMs(captureStartedAt);
    payload.timings_ms = timings;
    if (!forcedWindowId && captureOk) {
      ocrPreferences.remember(sessionIdFor(command), {
        includeOcr: command.include_ocr === true,
        ocrLanguage: command.ocr_language,
        maxOcrWords: command.max_ocr_words,
      });
    }
    if (image && String(command.image_output || 'inline') === 'file') {
      const stored = persistFrameImage(
        'computer',
        sessionIdFor(command),
        String(payload.frame_id || ''),
        image,
      );
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
  }

  async function captureAfterAction(
    command: ComputerCommand,
    windowId: string,
    delayOverrideMs?: number,
    reportedDelayMs?: number,
  ): Promise<{
    metadata: Record<string, unknown>;
    image?: { mimeType: string; data: string };
  }> {
    const delayMs = delayOverrideMs ?? screenshotInteger(
        command.capture_delay_ms,
        DEFAULT_CAPTURE_AFTER_DELAY_MS,
        0,
        MAX_CAPTURE_AFTER_DELAY_MS,
        'capture_delay_ms',
      );
    if (!windowId) {
      return {
        metadata: {
          ok: false,
          error: 'exact target window is unavailable; no screen fallback was captured',
        },
      };
    }
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    assertExecutionNotAborted();
    try {
      const ocrPreference = ocrPreferences.resolve(sessionIdFor(command), {
        includeOcr: command.capture_after_include_ocr,
        ocrLanguage: command.capture_after_ocr_language,
        maxOcrWords: command.capture_after_max_ocr_words,
      });
      const capture = await captureComputer({
        ...command,
        action: 'capture',
        mode: command.capture_after_mode || 'state',
        max_elements: command.capture_after_max_elements || DEFAULT_CAPTURE_MAX_ELEMENTS,
        include_ocr: ocrPreference.includeOcr,
        ocr_language: ocrPreference.ocrLanguage,
        max_ocr_words: ocrPreference.maxOcrWords,
        image_output: command.capture_after_image_output,
        window: undefined,
        window_id: windowId,
        screen: undefined,
        capture_after: false,
      }, windowId);
      assertExecutionNotAborted();
      return {
        metadata: {
          ...capture.payload,
          delay_ms: reportedDelayMs ?? delayMs,
          verification: 'not_performed',
        },
        ...(capture.image ? { image: capture.image } : {}),
      };
    } catch (error) {
      assertExecutionNotAborted();
      return {
        metadata: {
          ok: false,
          window_id: windowId,
          error: (error as Error).message || String(error),
        },
      };
    }
  }

  function releaseCaptureSession(sessionId: string): void {
    ocrPreferences.release(sessionId);
    const prefix = `${sessionId}\u0000`;
    visualOnlyCapabilities.releasePrefix(prefix);
  }

  return {
    captureVisibleNativeWindow,
    captureScreenshot,
    captureZoom,
    captureComputer,
    captureAfterAction,
    releaseCaptureSession,
  };
}

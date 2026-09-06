/** Pixel acquisition and zoom geometry; no accessibility or OCR state. */
import { desktopCapturer, screen, type NativeImage } from 'electron';
import {
  DEFAULT_SCREENSHOT_MAX_WIDTH, DEFAULT_SCREENSHOT_QUALITY, DESKTOP_CAPTURE_TIMEOUT_MS,
  MAX_SCREENSHOT_MAX_WIDTH, MIN_SCREENSHOT_MAX_WIDTH, OWNED_CAPTURE_TIMEOUT_MS, withTimeout,
} from '../shared/common';
import { frameQualityIssue } from './frame-quality';
import { electronWindowForNativeId } from './window-handles';
import { pixelUnavailable, screenshotInteger } from './analysis';
import type { CaptureFrame, ComputerCommand, PixelUnavailable, ScreenshotCapture } from '../shared/types';
import type { CaptureEngineHost } from './capture';

export type PixelCaptureHost = Pick<CaptureEngineHost,
  'callPowerShell' | 'sessionIdFor' | 'assertExecutionNotAborted' | 'rememberFrame'
  | 'requireValidFrame' | 'framesBySession' | 'allocateFrameId' | 'authorizeCapture'>;

export function createPixelCapture(host: PixelCaptureHost) {
  const { callPowerShell, sessionIdFor, assertExecutionNotAborted, rememberFrame,
    requireValidFrame, framesBySession, allocateFrameId } = host;

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
    await host.authorizeCapture?.(command, targetWindowId);
    assertExecutionNotAborted();
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
        if (!frameQualityIssue(candidateImage, expectedGeometry.width, expectedGeometry.height)) {
          capturedImage = candidateImage;
          capturedSourceId = `browser-window:${targetWindowId}`;
        }
      } catch {
        capturedImage = undefined;
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }
    // Window captures use only a window-owned surface. Screen-region sampling
    // cannot prove that another window's private pixels are absent.
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
                && candidate.id.startsWith('window:')
                && Number(candidate.id.split(':')[1]) === windowHandleDecimal))
        : undefined;
      if (source) {
        capturedImage = source.thumbnail;
        capturedSourceId = source.id;
        capturedSourceName = source.name;
      }
      if (!capturedImage) {
        if (allowOwnerFallback && targetWindowId && captureOwnerWindowId && captureOwnerWindowId !== targetWindowId) {
          const ownerCapture = await captureScreenshot({
            ...command, window: undefined, window_id: captureOwnerWindowId,
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
          sources ? `exact ${sourceType} capture source is unavailable`
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
        const candidateError = Math.abs(candidateRatio - actualAspectRatio) / Math.max(0.0001, candidateRatio);
        const bestRatio = best.width / Math.max(1, best.height);
        const bestError = Math.abs(bestRatio - actualAspectRatio) / Math.max(0.0001, bestRatio);
        return candidateError < bestError ? candidate : best;
      });
      originX = geometry.x;
      originY = geometry.y;
      physicalWidth = geometry.width;
      physicalHeight = geometry.height;
    }
    const qualityIssue = frameQualityIssue(capturedImage, physicalWidth || sourceWidth, physicalHeight || sourceHeight);
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
      id: frameId, sessionId: sessionIdFor(command), capturedAt: performance.now(),
      kind: sourceType, sourceId: capturedSourceId,
      ...(targetWindowId ? { windowId: targetWindowId } : {}),
      ...(targetDisplayId ? { displayId: targetDisplayId } : {}),
      originX, originY, physicalWidth, physicalHeight,
      ...(targetWindowId ? { relatedWindowIds: relatedWindowIds || [targetWindowId] } : {}),
      captureWidth: thumbnailSize.width, captureHeight: thumbnailSize.height,
      ...(targetWindowId ? {
        windowX: originX, windowY: originY, windowWidth: physicalWidth, windowHeight: physicalHeight,
        targetWindowX, targetWindowY, targetWindowWidth, targetWindowHeight,
      } : {
        displayX: originX, displayY: originY, displayWidth: physicalWidth, displayHeight: physicalHeight,
      }),
    };
    rememberFrame(frame);
    const route = capturedSourceId.startsWith('browser-window:')
      ? 'app_owned' as const : capturedSourceId.startsWith('native-window:')
        ? 'window_region' as const : 'composited' as const;
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
    const maxWidth = screenshotInteger(command.maxWidth, DEFAULT_SCREENSHOT_MAX_WIDTH,
      MIN_SCREENSHOT_MAX_WIDTH, MAX_SCREENSHOT_MAX_WIDTH, 'maxWidth');
    const region = command.region;
    if (!Array.isArray(region) || region.length !== 4 || region.some((value) => !Number.isInteger(value))) {
      throw new Error('zoom requires region [x0,y0,x1,y1] in frame_id image coordinates');
    }
    const frame = await requireValidFrame(command);
    await host.authorizeCapture?.(command, frame.windowId || '');
    assertExecutionNotAborted();
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
    if (baseOriginX === undefined || baseOriginY === undefined || baseWidth === undefined || baseHeight === undefined) {
      throw new Error(`stale_frame: capture source geometry is missing (${frame.id})`);
    }
    const sources = await withTimeout(
      desktopCapturer.getSources({
        types: [frame.kind], thumbnailSize: { width: baseWidth, height: baseHeight },
      }), DESKTOP_CAPTURE_TIMEOUT_MS, 'desktop zoom capture',
    );
    const windowHandleDecimal = frame.windowId
      ? Number.parseInt(frame.windowId.replace(/^hwnd:/i, '').replace(/^0x/i, ''), 16) : Number.NaN;
    const source = sources.find((candidate) => candidate.id === frame.sourceId)
      || (frame.kind === 'window'
        ? sources.find((candidate) => Number.isFinite(windowHandleDecimal)
            && candidate.id.startsWith('window:')
            && Number(candidate.id.split(':')[1]) === windowHandleDecimal)
        : sources.find((candidate) => candidate.display_id === frame.displayId));
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
    if (qualityIssue) return { description: qualityIssue.message, pixelUnavailable: qualityIssue };
    const jpeg = image.toJPEG(quality);
    if (!jpeg || jpeg.length === 0) return null;
    const zoomFrameId = `frame-${allocateFrameId()}`;
    framesBySession.get(sessionIdFor(command))?.clear();
    rememberFrame({
      id: zoomFrameId, sessionId: sessionIdFor(command), capturedAt: performance.now(),
      kind: frame.kind, sourceId: source.id,
      ...(frame.windowId ? { windowId: frame.windowId } : {}),
      ...(frame.displayId ? { displayId: frame.displayId } : {}),
      originX: x0, originY: y0, physicalWidth: x1 - x0, physicalHeight: y1 - y0,
      captureWidth: finalSize.width, captureHeight: finalSize.height,
      ...(frame.windowId ? {
        windowX: frame.windowX, windowY: frame.windowY,
        windowWidth: frame.windowWidth, windowHeight: frame.windowHeight,
        targetWindowX: frame.targetWindowX, targetWindowY: frame.targetWindowY,
        targetWindowWidth: frame.targetWindowWidth, targetWindowHeight: frame.targetWindowHeight,
      } : {
        displayX: frame.displayX, displayY: frame.displayY,
        displayWidth: frame.displayWidth, displayHeight: frame.displayHeight,
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
  return { captureScreenshot, captureZoom };
}

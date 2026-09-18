/** Capture transport selection. No frame registration or input authority changes. */
import { desktopCapturer, nativeImage, type NativeImage } from 'electron';
import { DESKTOP_CAPTURE_TIMEOUT_MS, OWNED_CAPTURE_TIMEOUT_MS, withTimeout } from '../shared/common';
import {
  NATIVE_CAPTURE_TIMEOUT_MS,
  captureCleanup,
  attachCaptureAttempts,
  type CaptureAttempt,
  type CaptureBackend,
  type CaptureCleanup,
  type NativeCaptureBackend,
} from '../shared/capture-attempts';
import type { ComputerCommand, PixelUnavailable, ScreenshotCapture } from '../shared/types';
import type { CaptureEngineHost } from './capture';
import { frameQualityIssue } from './frame-quality';
import { electronWindowForNativeId } from './window-handles';
import { pixelUnavailable } from './analysis';
import { computerCaptureSize } from '../../../../../../src/runtime/computer-bridge/capture-size.mjs';
import { computerErrorCode } from '../../../../../../src/runtime/computer-bridge/error-code.mjs';

type Bounds = { x: number; y: number; width: number; height: number };
interface Surface {
  image: NativeImage;
  sourceId: string;
  sourceName: string;
  route: NonNullable<ScreenshotCapture['route']>;
  bounds?: Bounds;
  nativeBackend?: NativeCaptureBackend;
  cleanup?: CaptureCleanup;
}
class CaptureSourceError extends Error {
  constructor(
    message: string,
    readonly cleanup?: CaptureCleanup,
    readonly issue?: PixelUnavailable
  ) {
    super(message);
  }
}
const recoverable = new Set([
  'capture_source_unavailable',
  'capture_wgc_unavailable',
  'capture_timeout',
  'empty_frame',
  'blank_black_frame',
  'blank_white_frame',
  'coordinate_mismatch',
]);

export function fitCaptureImage(image: NativeImage, maxWidth: number): NativeImage {
  const size = image.getSize();
  const fitted = computerCaptureSize(size.width, size.height, maxWidth);
  return size.width === fitted.width && size.height === fitted.height
    ? image
    : image.resize({ ...fitted, quality: 'best' });
}

export function createCaptureSources(
  host: Pick<CaptureEngineHost, 'callPowerShell' | 'sessionIdFor' | 'assertExecutionNotAborted' | 'authorizeCapture'>
) {
  async function attempt(
    backend: CaptureBackend,
    attempts: CaptureAttempt[],
    acquire: () => Promise<Surface>,
    check: (surface: Surface) => PixelUnavailable | undefined
  ): Promise<Surface> {
    const started = performance.now();
    try {
      const surface = await acquire();
      host.assertExecutionNotAborted();
      const issue = check(surface);
      if (issue) throw new CaptureSourceError(`${issue.reason}: ${issue.message}`, surface.cleanup, issue);
      attempts.push({
        backend,
        scope: 'target',
        status: 'captured',
        elapsed_ms: Math.round(performance.now() - started),
        ...(surface.cleanup ? { cleanup: surface.cleanup } : {}),
      });
      return surface;
    } catch (error) {
      const cleanup = error instanceof CaptureSourceError ? error.cleanup : undefined;
      attempts.push({
        backend,
        scope: 'target',
        status: error instanceof CaptureSourceError && error.issue ? 'unavailable' : 'failed',
        elapsed_ms: Math.round(performance.now() - started),
        code: computerErrorCode(error) || 'capture_source_unavailable',
        ...(cleanup ? { cleanup } : {}),
      });
      throw attachCaptureAttempts(error, attempts);
    }
  }

  async function nativeWindowSurface(
    command: ComputerCommand,
    windowId: string,
    backend: NativeCaptureBackend,
    attempts: CaptureAttempt[]
  ): Promise<Surface & { bounds: Bounds }> {
    await host.authorizeCapture?.(command, windowId);
    host.assertExecutionNotAborted();
    const surface = await attempt(
      backend,
      attempts,
      async () => {
        const reply = await host.callPowerShell(
          {
            action: 'window_capture',
            window_id: windowId,
            capture_backend: backend,
            session_id: host.sessionIdFor(command),
            read_only: true,
          },
          NATIVE_CAPTURE_TIMEOUT_MS
        );
        const value = reply.result;
        const cleanup = captureCleanup(value?.capture_cleanup);
        if (!reply.ok)
          throw new CaptureSourceError(reply.error || 'capture_source_unavailable: native rendering failed', cleanup);
        if (cleanup && cleanup.status !== 'confirmed') {
          throw new CaptureSourceError('capture_cleanup_failed: native capture release was not confirmed', cleanup);
        }
        if (
          String(value?.window_id).toLowerCase() !== windowId.toLowerCase() ||
          value?.capture_source !== 'window_surface' ||
          typeof value.image_base64 !== 'string'
        ) {
          throw new CaptureSourceError(
            'capture_source_mismatch: response is not from the exact window-owned surface',
            cleanup
          );
        }
        const bounds = {
          x: Number(value.x),
          y: Number(value.y),
          width: Number(value.width),
          height: Number(value.height),
        };
        if (!Object.values(bounds).every(Number.isSafeInteger) || bounds.width <= 0 || bounds.height <= 0) {
          throw new CaptureSourceError('capture_geometry_invalid: native window bounds are invalid', cleanup);
        }
        const image = nativeImage.createFromBuffer(Buffer.from(value.image_base64, 'base64'));
        const size = image.getSize();
        if (size.width !== bounds.width || size.height !== bounds.height) {
          throw new CaptureSourceError(
            'capture_geometry_invalid: native pixels do not match their window bounds',
            cleanup
          );
        }
        return {
          image,
          bounds,
          nativeBackend: backend,
          route: 'window_surface',
          sourceId: `window-surface:${backend}:${windowId}`,
          sourceName: '',
          cleanup,
        };
      },
      (value) => frameQualityIssue(value.image, value.bounds!.width, value.bounds!.height)
    );
    return surface as Surface & { bounds: Bounds };
  }

  async function select(input: {
    command: ComputerCommand;
    sourceType: 'screen' | 'window';
    sourceTitle: string;
    windowId: string;
    displayId: string;
    width: number;
    height: number;
    clientWidth: number;
    clientHeight: number;
    maxWidth: number;
    preserveResolution?: boolean;
    attempts: CaptureAttempt[];
  }): Promise<{ surface?: Surface; unavailable?: PixelUnavailable; terminal: boolean }> {
    const {
      command,
      sourceType,
      sourceTitle,
      windowId,
      displayId,
      width,
      height,
      clientWidth,
      clientHeight,
      maxWidth,
      preserveResolution = false,
      attempts,
    } = input;
    const owned = windowId ? electronWindowForNativeId(windowId) : null;
    const plan: Array<{ backend: CaptureBackend; acquire: () => Promise<Surface> }> = [];
    const check = (surface: Surface) => {
      const issue = frameQualityIssue(surface.image, width, height);
      return issue && clientWidth > 0 && clientHeight > 0
        ? frameQualityIssue(surface.image, clientWidth, clientHeight)
        : issue;
    };
    if (owned && !owned.isDestroyed() && !owned.webContents.isDestroyed()) {
      plan.push({
        backend: 'app_owned',
        acquire: async () => {
          const image = await withTimeout(
            owned.capturePage(),
            OWNED_CAPTURE_TIMEOUT_MS,
            'capture_timeout: app-owned capture'
          );
          return {
            image: preserveResolution ? image : fitCaptureImage(image, maxWidth),
            sourceId: `browser-window:${windowId}`,
            sourceName: sourceTitle,
            route: 'app_owned',
          };
        },
      });
    }
    plan.push({
      backend: 'composited',
      acquire: async () => {
        const sources = await withTimeout(
          desktopCapturer.getSources({
            types: [sourceType],
            thumbnailSize: preserveResolution ? { width, height } : computerCaptureSize(width, height, maxWidth),
          }),
          DESKTOP_CAPTURE_TIMEOUT_MS,
          'capture_timeout: desktop capture'
        );
        const handle = Number.parseInt(windowId.replace(/^hwnd:/i, '').replace(/^0x/i, ''), 16);
        const source =
          sourceType === 'screen'
            ? sources.find((value) => value.display_id === displayId)
            : sources.find(
                (value) =>
                  Number.isFinite(handle) && value.id.startsWith('window:') && Number(value.id.split(':')[1]) === handle
              );
        if (!source)
          throw new CaptureSourceError(`capture_source_unavailable: exact ${sourceType} source is unavailable`);
        return { image: source.thumbnail, sourceId: source.id, sourceName: source.name, route: 'composited' };
      },
    });
    if (windowId)
      for (const backend of ['print_window', 'wgc'] as const) {
        plan.push({ backend, acquire: () => nativeWindowSurface(command, windowId, backend, attempts) });
      }
    let unavailable: PixelUnavailable | undefined;
    for (const entry of plan) {
      host.assertExecutionNotAborted();
      try {
        const surface =
          entry.backend === 'print_window' || entry.backend === 'wgc'
            ? await entry.acquire()
            : await attempt(entry.backend, attempts, entry.acquire, check);
        return { surface, terminal: false };
      } catch (error) {
        try {
          host.assertExecutionNotAborted();
        } catch (aborted) {
          throw attachCaptureAttempts(aborted, attempts);
        }
        const code = computerErrorCode(error) || 'capture_source_unavailable';
        const cleanup = error instanceof CaptureSourceError ? error.cleanup : undefined;
        unavailable =
          error instanceof CaptureSourceError && error.issue
            ? error.issue
            : pixelUnavailable(
                'capture_source_unavailable',
                `exact ${sourceType} capture unavailable; ${entry.backend}: ${code}`
              );
        if (!recoverable.has(code) || (cleanup && cleanup.status !== 'confirmed')) {
          return { unavailable, terminal: true };
        }
      }
    }
    return { unavailable, terminal: false };
  }
  return { select, nativeWindowSurface };
}

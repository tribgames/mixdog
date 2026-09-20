/** A window-owned surface rendered by the PowerShell worker (PrintWindow or
 *  Windows Graphics Capture), accepted only when it is provably that window. */
import { nativeImage } from 'electron';
import {
  NATIVE_CAPTURE_TIMEOUT_MS,
  captureCleanup,
  type CaptureAttempt,
  type NativeCaptureBackend,
} from '../shared/capture-attempts';
import type { ComputerCommand } from '../shared/types';
import type { CaptureEngineHost } from './capture';
import { attemptCapture, CaptureSourceError, type Bounds, type Surface } from './capture-source-attempt';
import { frameQualityIssue } from './frame-quality';

export type NativeSurfaceHost = Pick<
  CaptureEngineHost,
  'callPowerShell' | 'sessionIdFor' | 'assertExecutionNotAborted' | 'authorizeCapture'
>;

type WorkerReply = Awaited<ReturnType<NativeSurfaceHost['callPowerShell']>>;

/** The worker's reply, checked to be the exact window-owned surface with
 *  self-consistent geometry and a confirmed release. */
function nativeSurfaceFromReply(
  reply: WorkerReply,
  windowId: string,
  backend: NativeCaptureBackend
): Surface & { bounds: Bounds } {
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
    throw new CaptureSourceError('capture_geometry_invalid: native pixels do not match their window bounds', cleanup);
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
}

export async function nativeWindowSurface(
  host: NativeSurfaceHost,
  command: ComputerCommand,
  windowId: string,
  backend: NativeCaptureBackend,
  attempts: CaptureAttempt[]
): Promise<Surface & { bounds: Bounds }> {
  await host.authorizeCapture?.(command, windowId);
  host.assertExecutionNotAborted();
  const surface = await attemptCapture(
    host,
    backend,
    attempts,
    async () =>
      nativeSurfaceFromReply(
        await host.callPowerShell(
          {
            action: 'window_capture',
            window_id: windowId,
            capture_backend: backend,
            session_id: host.sessionIdFor(command),
            read_only: true,
          },
          NATIVE_CAPTURE_TIMEOUT_MS
        ),
        windowId,
        backend
      ),
    (value) => frameQualityIssue(value.image, value.bounds!.width, value.bounds!.height)
  );
  return surface as Surface & { bounds: Bounds };
}

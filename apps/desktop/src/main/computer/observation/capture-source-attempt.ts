/** One capture attempt against one backend, recorded in the attempt log
 *  whether it produced a surface or not. */
import type { NativeImage } from 'electron';
import {
  attachCaptureAttempts,
  type CaptureAttempt,
  type CaptureBackend,
  type CaptureCleanup,
  type NativeCaptureBackend,
} from '../shared/capture-attempts';
import type { PixelUnavailable, ScreenshotCapture } from '../shared/types';
import type { CaptureEngineHost } from './capture';
import { computerErrorCode } from '../../../../../../src/runtime/computer-bridge/error-code.mjs';

export type Bounds = { x: number; y: number; width: number; height: number };

export interface Surface {
  image: NativeImage;
  sourceId: string;
  sourceName: string;
  route: NonNullable<ScreenshotCapture['route']>;
  bounds?: Bounds;
  nativeBackend?: NativeCaptureBackend;
  cleanup?: CaptureCleanup;
}

export class CaptureSourceError extends Error {
  constructor(
    message: string,
    readonly cleanup?: CaptureCleanup,
    readonly issue?: PixelUnavailable
  ) {
    super(message);
  }
}

/** Failure codes after which the next backend in the plan may still succeed. */
export const RECOVERABLE_CAPTURE_CODES = new Set([
  'capture_source_unavailable',
  'capture_wgc_unavailable',
  'capture_timeout',
  'empty_frame',
  'blank_black_frame',
  'blank_white_frame',
  'coordinate_mismatch',
]);

export async function attemptCapture<T extends Surface>(
  host: Pick<CaptureEngineHost, 'assertExecutionNotAborted'>,
  backend: CaptureBackend,
  attempts: CaptureAttempt[],
  acquire: () => Promise<T>,
  check: (surface: T) => PixelUnavailable | undefined
): Promise<T> {
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

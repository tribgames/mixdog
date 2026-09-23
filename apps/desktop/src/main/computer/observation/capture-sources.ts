/** Capture transport selection. No frame registration or input authority changes. */
import { attachCaptureAttempts, type CaptureAttempt, type NativeCaptureBackend } from '../shared/capture-attempts';
import type { ComputerCommand, PixelUnavailable } from '../shared/types';
import { pixelUnavailable } from './analysis';
import type { CaptureEngineHost } from './capture';
import { nativeWindowSurface } from './capture-native-surface';
import { attemptCapture, CaptureSourceError, RECOVERABLE_CAPTURE_CODES, type Surface } from './capture-source-attempt';
import { buildCapturePlan, type CaptureSourceRequest } from './capture-source-plan';
import { frameQualityIssue } from './frame-quality';
import { computerErrorCode } from '../../../../../../src/runtime/computer-bridge/error-code.mjs';

export { fitCaptureImage } from './capture-source-plan';

/** A hidden window stays hidden however often it is captured again, so these
 *  say what brings it back instead of inviting a recapture loop. */
const HIDDEN_WINDOW_ADVICE: Record<string, string> = {
  capture_cloaked:
    'the shell hides this window (another virtual desktop or a suspended app), so it has no surface and may expose no UI; window focus brings it back, or ask the user to switch to it',
  capture_minimized:
    'the window is minimized and has no rendered surface; window focus restores it when the task needs this window, or ask the user',
};

export function createCaptureSources(
  host: Pick<CaptureEngineHost, 'callPowerShell' | 'sessionIdFor' | 'assertExecutionNotAborted' | 'authorizeCapture'>
) {
  /** The first backend in the plan that yields a checked surface wins. A
   *  failure the next backend cannot recover from, or an unconfirmed native
   *  release, ends the selection as terminal. */
  async function select(
    input: CaptureSourceRequest
  ): Promise<{ surface?: Surface; unavailable?: PixelUnavailable; terminal: boolean }> {
    const { sourceType, width, height, clientWidth, clientHeight, attempts } = input;
    const check = (surface: Surface) => {
      const issue = frameQualityIssue(surface.image, width, height);
      return issue && clientWidth > 0 && clientHeight > 0
        ? frameQualityIssue(surface.image, clientWidth, clientHeight)
        : issue;
    };
    let unavailable: PixelUnavailable | undefined;
    for (const entry of buildCapturePlan(host, input)) {
      host.assertExecutionNotAborted();
      try {
        const surface =
          entry.backend === 'print_window' || entry.backend === 'wgc'
            ? await entry.acquire()
            : await attemptCapture(host, entry.backend, attempts, entry.acquire, check);
        return { surface, terminal: false };
      } catch (error) {
        try {
          host.assertExecutionNotAborted();
        } catch (aborted) {
          throw attachCaptureAttempts(aborted, attempts);
        }
        const code = computerErrorCode(error) || 'capture_source_unavailable';
        const cleanup = error instanceof CaptureSourceError ? error.cleanup : undefined;
        const hidden = HIDDEN_WINDOW_ADVICE[code];
        unavailable =
          error instanceof CaptureSourceError && error.issue
            ? error.issue
            : hidden
              ? pixelUnavailable('window_hidden', `${entry.backend}: ${code}; ${hidden}`)
              : pixelUnavailable(
                  'capture_source_unavailable',
                  `exact ${sourceType} capture unavailable; ${entry.backend}: ${code}`
                );
        if (!RECOVERABLE_CAPTURE_CODES.has(code) || (cleanup && cleanup.status !== 'confirmed')) {
          return { unavailable, terminal: true };
        }
      }
    }
    return { unavailable, terminal: false };
  }

  return {
    select,
    nativeWindowSurface: (
      command: ComputerCommand,
      windowId: string,
      backend: NativeCaptureBackend,
      attempts: CaptureAttempt[]
    ) => nativeWindowSurface(host, command, windowId, backend, attempts),
  };
}

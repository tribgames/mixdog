/** Capture transport selection. No frame registration or input authority changes. */
import { attachCaptureAttempts, type CaptureAttempt, type NativeCaptureBackend } from '../shared/capture-attempts';
import type { ComputerCommand, PixelUnavailable } from '../shared/types';
import { pixelUnavailable } from './analysis';
import type { CaptureEngineHost } from './capture';
import { nativeWindowSurface } from './capture-native-surface';
import { captureBackendKey, createCaptureBackendMemory, type CaptureBackendMemory } from './capture-backend-memory';
import { attemptCapture, CaptureSourceError, RECOVERABLE_CAPTURE_CODES, type Surface } from './capture-source-attempt';
import { buildCapturePlan, type CaptureSourceRequest } from './capture-source-plan';
import { frameQualityIssue } from './frame-quality';
import { SCREEN_RECORDING_GUIDANCE, screenCaptureBlocked } from '../shared/permissions';
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
  host: Pick<
    CaptureEngineHost,
    | 'callPowerShell'
    | 'sessionIdFor'
    | 'assertExecutionNotAborted'
    | 'authorizeCapture'
    | 'nativeSurfaceBackends'
    | 'readPermissions'
  >,
  /** Owned by the capture engine, which releases a session's entries with the session. */
  backendMemory: CaptureBackendMemory = createCaptureBackendMemory()
) {
  /** The first backend in the plan that yields a checked surface wins, the
   *  window's last winner leading the plan. A failure the next backend cannot
   *  recover from, or an unconfirmed native release, ends the selection as
   *  terminal. */
  async function select(
    input: CaptureSourceRequest
  ): Promise<{ surface?: Surface; unavailable?: PixelUnavailable; terminal: boolean }> {
    const { sourceType, width, height, clientWidth, clientHeight, attempts } = input;
    const memoryKey = captureBackendKey(host.sessionIdFor(input.command), input.windowId);
    const remembered = backendMemory.recall(memoryKey);
    const check = (surface: Surface) => {
      const issue = frameQualityIssue(surface.image, width, height);
      return issue && clientWidth > 0 && clientHeight > 0
        ? frameQualityIssue(surface.image, clientWidth, clientHeight)
        : issue;
    };
    let unavailable: PixelUnavailable | undefined;
    let geometryChanged: { unavailable: PixelUnavailable | undefined; terminal: true } | undefined;
    const isNative = (backend: string) => backend === 'print_window' || backend === 'wgc';
    for (const entry of buildCapturePlan(host, input, remembered)) {
      if (geometryChanged && isNative(entry.backend)) continue;
      host.assertExecutionNotAborted();
      try {
        const surface =
          entry.backend === 'print_window' || entry.backend === 'wgc'
            ? await entry.acquire()
            : await attemptCapture(host, entry.backend, attempts, entry.acquire, check);
        backendMemory.remember(memoryKey, entry.backend);
        return { surface, terminal: false };
      } catch (error) {
        try {
          host.assertExecutionNotAborted();
        } catch (aborted) {
          throw attachCaptureAttempts(aborted, attempts);
        }
        if (entry.backend === remembered) backendMemory.forget(memoryKey);
        const code = computerErrorCode(error) || 'capture_source_unavailable';
        const cleanup = error instanceof CaptureSourceError ? error.cleanup : undefined;
        const hidden = HIDDEN_WINDOW_ADVICE[code];
        // Without Screen Recording macOS hands back no foreign window at all;
        // no later backend can recover that, and the grant is the user's.
        if (entry.backend === 'composited' && screenCaptureBlocked(await host.readPermissions())) {
          return {
            unavailable: pixelUnavailable('capture_source_unavailable', `composited: ${SCREEN_RECORDING_GUIDANCE}`),
            terminal: true,
          };
        }
        if (error instanceof CaptureSourceError && error.issue) unavailable = error.issue;
        else if (hidden) unavailable = pixelUnavailable('window_hidden', `${entry.backend}: ${code}; ${hidden}`);
        else {
          unavailable = pixelUnavailable(
            'capture_source_unavailable',
            `exact ${sourceType} capture unavailable; ${entry.backend}: ${code}`
          );
        }
        // A native surface that saw its window resize mid-capture says nothing
        // about the compositor, which is checked against the target's geometry
        // like any other frame. Another native backend would race the same
        // resize, so only the compositor is tried; if it fails too, the
        // geometry change is what is reported.
        if (
          code === 'capture_geometry_changed' &&
          entry.backend !== 'composited' &&
          entry.backend !== 'app_owned' &&
          (!cleanup || cleanup.status === 'confirmed')
        ) {
          geometryChanged ??= { unavailable, terminal: true };
          continue;
        }
        if (!RECOVERABLE_CAPTURE_CODES.has(code) || (cleanup && cleanup.status !== 'confirmed')) {
          return geometryChanged ?? { unavailable, terminal: true };
        }
      }
    }
    return geometryChanged ?? { unavailable, terminal: false };
  }

  return {
    select,
    /** A frame the engine rejects after selection was not a working capture. */
    forgetBackend: (command: ComputerCommand, windowId: string) =>
      backendMemory.forget(captureBackendKey(host.sessionIdFor(command), windowId)),
    nativeWindowSurface: (
      command: ComputerCommand,
      windowId: string,
      backend: NativeCaptureBackend,
      attempts: CaptureAttempt[]
    ) => nativeWindowSurface(host, command, windowId, backend, attempts),
  };
}

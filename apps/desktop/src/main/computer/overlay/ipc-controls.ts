import type { WebContents } from 'electron';
import { appendComputerRunRecord } from '../session/run-log';
import type { createComputerOverlayController, ComputerUseOverlayControls } from './controls';

/** Every press the overlay delivers leaves a record, so "the button did
 *  nothing" can be told apart from "the press never arrived". The record
 *  carries the control and its outcome, never anything the user typed. */
function recordOverlayPress(
  sessionIds: string[],
  action: string,
  generation: number,
  outcome: Record<string, unknown>
): void {
  appendComputerRunRecord(sessionIds[0] || 'overlay', {
    action: `overlay_${action}`,
    generation,
    sessions: sessionIds.length,
    ...outcome,
  });
}

export function bindComputerOverlayControls(
  contents: WebContents,
  controller: ReturnType<typeof createComputerOverlayController>,
  controls: ComputerUseOverlayControls,
  presentation: () => { sessionIds: string[]; generation: number }
): void {
  contents.ipc.handle('computer-overlay-control', async (event, request) => {
    if (
      event.sender !== contents ||
      event.senderFrame !== contents.mainFrame ||
      !request ||
      typeof request !== 'object' ||
      Array.isArray(request)
    ) {
      throw new Error('Invalid overlay sender');
    }
    if (
      request.action === 'configure' &&
      Object.keys(request).every((key) => ['action', 'seconds'].includes(key)) &&
      Number.isInteger(request.seconds) &&
      request.seconds >= 0 &&
      request.seconds <= 60
    ) {
      if (!controls.configureIdleResume) throw new Error('Idle resume configuration unavailable');
      controls.configureIdleResume(request.seconds);
      return { accepted: true };
    }
    if (
      !['resume', 'pause', 'stop'].includes(request.action) ||
      Object.keys(request).some((key) => !['action', 'generation'].includes(key)) ||
      !Number.isSafeInteger(request.generation) ||
      request.generation < 0
    ) {
      throw new Error('Invalid overlay request');
    }
    const current = presentation();
    if (request.action === 'resume' && request.generation !== current.generation) {
      recordOverlayPress(current.sessionIds, request.action, request.generation, {
        ok: false,
        error: 'stale',
        current_generation: current.generation,
      });
      return { accepted: false, error: 'stale' };
    }
    const applied = await controller.invoke(request.action, request.generation, current.sessionIds);
    recordOverlayPress(current.sessionIds, request.action, request.generation, {
      ...controller.state(request.generation),
      ok: applied,
      ...(applied ? {} : { error: 'busy' }),
    });
    // A press dropped because another control is still running must not read as
    // success: the overlay would clear its progress and look idle while nothing
    // happened.
    if (!applied) return { accepted: false, ...controller.state(request.generation), error: 'busy' };
    return { accepted: true, ...controller.state(request.generation) };
  });
}

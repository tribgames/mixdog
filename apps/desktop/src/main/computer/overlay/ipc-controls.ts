import type { WebContents } from 'electron';
import type { createComputerOverlayController, ComputerUseOverlayControls } from './controls';

export function bindComputerOverlayControls(
  contents: WebContents,
  controller: ReturnType<typeof createComputerOverlayController>,
  controls: ComputerUseOverlayControls,
  presentation: () => { sessionIds: string[]; generation: number },
): void {
  contents.ipc.handle('computer-overlay-control', async (event, request) => {
    if (event.sender !== contents || event.senderFrame !== contents.mainFrame
      || !request || typeof request !== 'object' || Array.isArray(request)) {
      throw new Error('Invalid overlay sender');
    }
    if (request.action === 'configure' && Object.keys(request).every((key) => ['action', 'seconds'].includes(key))
      && Number.isInteger(request.seconds) && request.seconds >= 0 && request.seconds <= 60) {
      if (!controls.configureIdleResume) throw new Error('Idle resume configuration unavailable');
      controls.configureIdleResume(request.seconds);
      return { accepted: true };
    }
    if (!['resume', 'pause', 'stop'].includes(request.action)
      || Object.keys(request).some((key) => !['action', 'generation'].includes(key))
      || !Number.isSafeInteger(request.generation) || request.generation < 0) {
      throw new Error('Invalid overlay request');
    }
    const current = presentation();
    if (request.action !== 'stop' && request.generation !== current.generation) {
      return { accepted: false, error: 'stale' };
    }
    await controller.invoke(request.action, request.generation, current.sessionIds);
    return { accepted: true, ...controller.state(request.generation) };
  });
}

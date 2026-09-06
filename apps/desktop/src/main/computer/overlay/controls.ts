export interface ComputerUseOverlayControls {
  stop(sessionIds: string[]): Promise<void>;
  pause?(): Promise<void>;
  resume(generation: number, signal?: AbortSignal): Promise<void>;
  configureIdleResume?(seconds: number): void;
}

export type ComputerOverlayControlError = '' | 'cleanup' | 'stale' | 'failed';

/** Trusted overlay only: never exported as a model/bridge command. */
export function createComputerOverlayController(
  controls: ComputerUseOverlayControls,
  changed: () => void,
) {
  let busy = false;
  let error: ComputerOverlayControlError = '';
  let errorGeneration: number | undefined;
  let pending: AbortController | undefined;
  let pendingAction = '';
  return {
    state(generation: number) {
      return { busy, error: errorGeneration === generation ? error : '' };
    },
    async invoke(action: 'stop' | 'resume' | 'pause', generation: number, sessionIds: string[]): Promise<void> {
      if (busy && action === 'resume') return;
      if (busy && action === 'pause' && pendingAction !== 'resume') return;
      if (action !== 'resume') pending?.abort();
      const request = new AbortController();
      pending = request;
      pendingAction = action;
      busy = true; error = ''; errorGeneration = generation; changed();
      try {
        if (action === 'resume') await controls.resume(generation, request.signal);
        else if (action === 'pause') {
          if (!controls.pause) throw new Error('Pause unavailable');
          await controls.pause();
        }
        else await controls.stop(sessionIds);
      } catch (reason) {
        const message = String((reason as Error)?.message || '');
        if (pending !== request) return;
        error = /computer_(cleanup_pending|abort_cleanup_unconfirmed)/.test(message) ? 'cleanup'
          : /computer_resume_stale/.test(message) ? 'stale' : 'failed';
      } finally {
        if (pending === request) { pending = undefined; busy = false; changed(); }
      }
    },
  };
}

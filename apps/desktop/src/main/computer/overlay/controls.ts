export interface ComputerUseOverlayControls {
  stop(sessionIds: string[]): Promise<void>;
  /** Pause input without ending the task, including when the control surface is lost. */
  pause?(): Promise<void>;
  resume(generation: number, signal?: AbortSignal): Promise<void>;
  configureIdleResume?(seconds: number): void;
}

export type ComputerOverlayControlError = '' | 'cleanup' | 'stop' | 'stale' | 'failed';

/** Trusted overlay only: never exported as a model/bridge command. */
export function createComputerOverlayController(
  controls: ComputerUseOverlayControls,
  changed: () => void,
) {
  let busy = false;
  let error: ComputerOverlayControlError = '';
  // Pause and Stop change the takeover generation themselves, so failure must outlive
  // the generation it was requested under or the user sees nothing.
  let errorGeneration: number | 'any' | undefined;
  let pending: AbortController | undefined;
  let pendingAction = '';
  let stopping: Promise<void> | undefined;
  const invoke = async (action: 'stop' | 'resume' | 'pause', generation: number, sessionIds: string[]): Promise<void> => {
    if (busy && action === 'resume') return;
    if (busy && action === 'pause' && pendingAction !== 'resume') return;
    if (action !== 'resume') pending?.abort();
    const request = new AbortController();
    pending = request;
    pendingAction = action;
    busy = true; error = ''; errorGeneration = action === 'resume' ? generation : 'any'; changed();
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
      error = /computer_(cleanup_pending|abort_cleanup_unconfirmed|background_cleanup_unconfirmed)/.test(message) ? 'cleanup'
        : /computer_stop_unconfirmed/.test(message) ? 'stop'
        : /computer_resume_stale/.test(message) ? 'stale' : 'failed';
    } finally {
      if (pending === request) { pending = undefined; busy = false; changed(); }
    }
  };
  return {
    state(generation: number) {
      return { busy, error: errorGeneration === 'any' || errorGeneration === generation ? error : '' };
    },
    invoke(action: 'stop' | 'resume' | 'pause', generation: number, sessionIds: string[]): Promise<void> {
      if (action === 'stop' && stopping) return stopping;
      const task = invoke(action, generation, sessionIds);
      if (action !== 'stop') return task;
      // A repeated press joins the same stop; it must not advance the takeover
      // generation while the original cleanup is still confirming that generation.
      stopping = task.finally(() => { stopping = undefined; });
      return stopping;
    },
  };
}

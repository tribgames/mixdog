export interface ComputerUseOverlayControls {
  stop(sessionIds: string[]): Promise<void>;
  /** Pause input without ending the task, including when the control surface is lost. */
  pause?(): Promise<void>;
  resume(generation: number, signal?: AbortSignal): Promise<void>;
  configureIdleResume?(seconds: number): void;
}

export type ComputerOverlayControlError = '' | 'cleanup' | 'stop' | 'stale' | 'failed';

/** A control the host never hears back from must not latch the pill: the
 *  request is released before the overlay's own wait ends, so the next press —
 *  including Stop and the emergency shortcut — is accepted instead of joining
 *  a request that never settles. */
const CONTROL_DEADLINE_MS = 15_000;

function withControlDeadline(work: Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  // The deadline may win the race; the abandoned work keeps its own handler so
  // a later rejection is not unhandled.
  work.catch(() => {});
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('computer_control_timeout')), CONTROL_DEADLINE_MS);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Trusted overlay only: never exported as a model/bridge command. */
export function createComputerOverlayController(controls: ComputerUseOverlayControls, changed: () => void) {
  let busy = false;
  let error: ComputerOverlayControlError = '';
  // Pause and Stop change the takeover generation themselves, so failure must outlive
  // the generation it was requested under or the user sees nothing.
  let errorGeneration: number | 'any' | undefined;
  let pending: AbortController | undefined;
  let pendingAction = '';
  let stopping: Promise<boolean> | undefined;
  /** Resolves false when the request was dropped because another control is
   *  still in flight, so the caller can say so instead of reporting success. */
  const invoke = async (
    action: 'stop' | 'resume' | 'pause',
    generation: number,
    sessionIds: string[]
  ): Promise<boolean> => {
    if (busy && action === 'resume') return false;
    if (busy && action === 'pause' && pendingAction !== 'resume') return false;
    if (action !== 'resume') pending?.abort();
    const request = new AbortController();
    pending = request;
    pendingAction = action;
    busy = true;
    error = '';
    errorGeneration = action === 'resume' ? generation : 'any';
    changed();
    try {
      if (action === 'resume') await withControlDeadline(controls.resume(generation, request.signal));
      else if (action === 'pause') {
        if (!controls.pause) throw new Error('Pause unavailable');
        await withControlDeadline(controls.pause());
      } else await withControlDeadline(controls.stop(sessionIds));
    } catch (reason) {
      const message = String((reason as Error)?.message || '');
      if (pending !== request) return true;
      // The host stopped waiting, so the work the pill no longer represents
      // stops too.
      if (message.includes('computer_control_timeout')) request.abort();
      error = 'failed';
      if (/computer_(cleanup_pending|abort_cleanup_unconfirmed|background_cleanup_unconfirmed)/.test(message)) {
        error = 'cleanup';
      } else if (/computer_stop_unconfirmed/.test(message)) error = 'stop';
      else if (/computer_resume_stale/.test(message)) error = 'stale';
    } finally {
      if (pending === request) {
        pending = undefined;
        busy = false;
        changed();
      }
    }
    return true;
  };
  return {
    state(generation: number) {
      return { busy, error: errorGeneration === 'any' || errorGeneration === generation ? error : '' };
    },
    invoke(action: 'stop' | 'resume' | 'pause', generation: number, sessionIds: string[]): Promise<boolean> {
      if (action === 'stop' && stopping) return stopping;
      const task = invoke(action, generation, sessionIds);
      if (action !== 'stop') return task;
      // A repeated press joins the same stop; it must not advance the takeover
      // generation while the original cleanup is still confirming that generation.
      stopping = task.finally(() => {
        stopping = undefined;
      });
      return stopping;
    },
  };
}

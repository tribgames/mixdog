// Background shell-job strip for the status bar. The engine has no push event
// for job counts, so the host polls the statusline module with an adaptive
// delay (fast while jobs run, slow while idle). Extracted from engine-host,
// which now only starts/stops it and reads the current status.
import type { StatuslineSegmentsModule } from './engine-host-support';
import { shellJobsPollDelay } from './engine-host-support';

export interface ShellJobsStatus {
  count: number;
  elapsedLabel: string;
}

export interface ShellJobsPollerOptions {
  /** Live engine state, or null once the engine is gone (polling stops). */
  getEngineState(): Record<string, unknown> | null;
  /** Resolved statusline module URL — imported lazily on the first poll. */
  moduleUrl(): string;
  /** Called only when the status actually changed. */
  onChange(): void;
}

export function createShellJobsPoller({ getEngineState, moduleUrl, onChange }: ShellJobsPollerOptions) {
  let timer: NodeJS.Timeout | null = null;
  let delayMs = 0;
  let status: ShellJobsStatus = { count: 0, elapsedLabel: '' };
  let modulePromise: Promise<StatuslineSegmentsModule> | null = null;

  function schedule(immediate = false): void {
    const state = getEngineState();
    if (!state) return;
    if (timer) clearTimeout(timer);
    delayMs = shellJobsPollDelay(state, status.count);
    timer = setTimeout(() => {
      timer = null;
      void poll();
    }, immediate ? 0 : delayMs);
    timer.unref?.();
  }

  async function poll(): Promise<void> {
    // Attached-viewer sessions mirror the OWNER's pid (live-share frames): the
    // registry's jobs belong to that process, not this one.
    const state = getEngineState();
    const ownerPid = Number(state?.ownerClientHostPid || state?.clientHostPid) || 0;
    if (!ownerPid) {
      schedule();
      return;
    }
    try {
      modulePromise ??= import(/* @vite-ignore */ moduleUrl()) as Promise<StatuslineSegmentsModule>;
      const module = await modulePromise;
      const value = module.shellJobsStatus({ clientHostPid: ownerPid });
      const next: ShellJobsStatus = {
        count: Math.max(0, Number(value?.count) || 0),
        elapsedLabel: String(value?.elapsedLabel || ''),
      };
      if (next.count !== status.count || next.elapsedLabel !== status.elapsedLabel) {
        status = next;
        onChange();
      }
    } catch {
      // The strip is optional: engine activity stays publishable when the
      // external runtime module is unavailable.
    } finally {
      schedule();
    }
  }

  return {
    get status(): ShellJobsStatus { return status; },
    start(): void {
      this.stop();
      schedule(true);
    },
    stop(): void {
      if (!timer) return;
      clearTimeout(timer);
      timer = null;
      delayMs = 0;
    },
    /** An engine event may shorten the desired delay — re-arm when it does. */
    onEngineEvent(): void {
      const state = getEngineState();
      if (!state) return;
      const desired = shellJobsPollDelay(state, status.count);
      if (!timer || desired < delayMs) schedule(true);
    },
  };
}

import type { DesktopUpdaterState } from '../shared/contract';

type UpdaterState = DesktopUpdaterState;

export type UpdaterReadyRecord = { version: string };

type UpdaterService = {
  checkForUpdates(): Promise<{ isUpdateAvailable?: boolean; updateInfo?: { version?: string } } | null | undefined>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
};

type UpdaterPersistence = {
  get(): UpdaterReadyRecord | undefined | Promise<UpdaterReadyRecord | undefined>;
  set(value: UpdaterReadyRecord): void | Promise<void>;
  clear(): void | Promise<void>;
};

type UpdaterController = ReturnType<typeof createUpdaterController>;

/** Unattended installs (the packaged dev loop): installs once the update
 *  first becomes ready, never confirmed. Only that first readiness starts an
 *  install: a return to `ready` from a failed install attempt (teardown or
 *  launch error) does not, so a failure is reported once and not looped. A
 *  hold for running or unknown work retries on a timer until the desktop's
 *  view of the current daemon connection reports idle, then installs once.
 *  The returned function stops it and cancels a pending retry. */
export function startUnattendedInstall(
  controller: UpdaterController,
  options: {
    retryMs?: number;
    /** Runs `retry` after `ms`; returns the cancel. */
    schedule?: (retry: () => void, ms: number) => () => void;
    log?: (message: string, data?: object) => void;
  } = {}
): () => void {
  const retryMs = options.retryMs ?? 5_000;
  const schedule =
    options.schedule ??
    ((retry: () => void, ms: number) => {
      const timer = setTimeout(retry, ms);
      timer.unref?.();
      return () => clearTimeout(timer);
    });
  let running = false;
  let stopped = false;
  let cancelRetry: (() => void) | null = null;
  let previous: UpdaterState['status'] | undefined;
  const attempt = (): void => {
    cancelRetry = null;
    if (stopped || running || controller.getState().status !== 'ready') return;
    running = true;
    controller
      .install()
      .catch((error: unknown) => {
        options.log?.('updater unattended install failed', {
          message: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        running = false;
        const after = controller.getState();
        if (!stopped && !cancelRetry && after.status === 'ready' && after.busyTasks !== undefined) {
          cancelRetry = schedule(attempt, retryMs);
        }
      });
  };
  const unsubscribe = controller.subscribe((next) => {
    const first = next.status === 'ready' && next.busyTasks === undefined && previous !== 'ready' && previous !== 'installing';
    previous = next.status;
    if (first) attempt();
  });
  return () => {
    stopped = true;
    cancelRetry?.();
    cancelRetry = null;
    unsubscribe();
  };
}

export function createUpdaterController(input: {
  enabled: boolean;
  currentVersion: string;
  service: UpdaterService;
  persistence: UpdaterPersistence;
  stop: () => Promise<void>;
  /** Agent tasks running now; null when that cannot be told. */
  busy?: () => Promise<number | null>;
  /** The daemon's admission barrier. `close` refuses new work and reports
   *  what runs in one step: 0 = idle (admission now closed), a count = busy
   *  (admission left open), null = unknown. `release` reopens admission. */
  barrier?: { close(): Promise<number | null>; release(): Promise<void> };
  scheduleInstall?: (install: () => void) => void;
  log?: (message: string, data?: object) => void;
}) {
  let state: UpdaterState = input.enabled ? { status: 'idle' } : { status: 'disabled' };
  let pending: Promise<UpdaterState> | undefined;
  let installing = false;
  const listeners = new Set<(state: UpdaterState) => void>();
  const scheduleInstall =
    input.scheduleInstall ??
    ((install: () => void) => {
      setImmediate(install);
    });

  const transition = (next: UpdaterState): UpdaterState => {
    input.log?.('updater state changed', { from: state.status, to: next.status });
    state = next;
    listeners.forEach((listener) => {
      listener(state);
    });
    return state;
  };

  const check = (): Promise<UpdaterState> => {
    if (!input.enabled) return Promise.resolve(state);
    if (pending) return pending;
    const readyAtStart = state.status === 'ready' ? state : undefined;

    pending = (async () => {
      // A downloaded target can become stale while the app stays open across
      // rapid releases. Keep it installable during the recheck, then replace
      // it only when the feed points at a different version.
      if (!readyAtStart) transition({ status: 'checking' });
      const result = await input.service.checkForUpdates();
      const version = result?.updateInfo?.version;
      if (!result?.isUpdateAvailable || !version || version === input.currentVersion) {
        await input.persistence.clear();
        return transition({ status: 'up-to-date' });
      }
      if (readyAtStart?.version === version) return readyAtStart;

      transition({ status: 'downloading', version });
      await input.service.downloadUpdate();
      await input.persistence.set({ version });
      return transition({ status: 'ready', version });
    })()
      .catch((error: unknown) => {
        if (readyAtStart) {
          input.log?.('updater ready recheck failed', {
            message: error instanceof Error ? error.message : String(error),
          });
          return readyAtStart;
        }
        return transition({ status: 'error', message: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };

  /** The ready state of a held-back install: `busyTasks` (null = unknown) is
   *  what the UI shows. Unchanged counts publish nothing, so a retrying
   *  caller does not re-notify every subscriber. */
  const hold = (version: string, tasks: number | null): void => {
    if (state.status === 'ready' && state.busyTasks === tasks) return;
    transition({ status: 'ready', version, busyTasks: tasks });
  };

  /** Tasks that hold the install back, from the desktop's own view of the
   *  daemon; undefined when none. Unreadable counts as unknown (null). */
  const viewTasks = async (): Promise<number | null | undefined> => {
    if (!input.busy) return undefined;
    let tasks: number | null;
    try {
      tasks = await input.busy();
    } catch {
      tasks = null;
    }
    return tasks === 0 ? undefined : tasks;
  };

  /** The daemon's own answer, with new-work admission closed in the same
   *  step when idle (the caller keeps it closed until shutdown or release).
   *  Busy or unknown leaves admission open. */
  const barrierTasks = async (): Promise<number | null | undefined> => {
    if (!input.barrier) return undefined;
    let tasks: number | null;
    try {
      tasks = await input.barrier.close();
    } catch {
      tasks = null;
    }
    if (tasks === 0) return undefined;
    if (tasks === null) await releaseBarrier();
    return tasks;
  };

  const releaseBarrier = async (): Promise<void> => {
    try {
      await input.barrier?.release();
    } catch (error) {
      input.log?.('updater barrier release failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  /** True when the install must wait for the user's confirmation: agent tasks
   *  are running, or their count could not be read. Then the ready state
   *  carries `busyTasks` for the UI to show. */
  const confirmBusy = async (version = state.status === 'ready' ? state.version : ''): Promise<boolean> => {
    if (!version) return false;
    const tasks = await viewTasks();
    if (tasks === undefined) return false;
    hold(version, tasks);
    return true;
  };

  return {
    getState: (): UpdaterState => state,
    subscribe(listener: (state: UpdaterState) => void): () => void {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    async start(): Promise<UpdaterState> {
      const ready = await input.persistence.get();
      if (ready?.version === input.currentVersion) await input.persistence.clear();
      return check();
    },
    check,
    confirmBusy,
    async install(options: { confirmed?: boolean } = {}): Promise<void> {
      if (state.status !== 'ready') throw new Error('Update is not ready to install');
      if (installing) throw new Error('Update install is already in progress');
      const version = state.version;
      installing = true;
      // Unconfirmed installs stop before touching anything while agent work
      // runs or its status is unknown; a confirmed one is the user's decision.
      // The daemon's barrier is the last step before teardown: when it
      // reports idle, new work is already refused and stays so until shutdown.
      if (!options.confirmed) {
        // null means unknown, so only undefined falls through to the barrier.
        let tasks = await viewTasks();
        if (tasks === undefined) tasks = await barrierTasks();
        if (tasks !== undefined) {
          installing = false;
          hold(version, tasks);
          return;
        }
      }
      transition({ status: 'installing', version });
      try {
        await input.stop();
        // ipcRenderer.invoke() must receive its acknowledgement before
        // electron-updater destroys the renderer during quitAndInstall().
        // Launching on the next event-loop turn keeps a successful install
        // from surfacing as "Object has been destroyed" in the UI.
        scheduleInstall(() => {
          try {
            input.service.quitAndInstall();
          } catch (error) {
            installing = false;
            transition({ status: 'ready', version });
            void releaseBarrier();
            input.log?.('updater install launch failed', {
              message: error instanceof Error ? error.message : String(error),
            });
          }
        });
      } catch (error) {
        installing = false;
        transition({ status: 'ready', version });
        await releaseBarrier();
        throw error;
      }
    },
  };
}

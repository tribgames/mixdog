import type { DesktopUpdaterState } from '../shared/contract';

export type UpdaterState = DesktopUpdaterState;

export type UpdaterReadyRecord = { version: string };

export type UpdaterService = {
  checkForUpdates(): Promise<{ isUpdateAvailable?: boolean; updateInfo?: { version?: string } } | null | undefined>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
};

type UpdaterPersistence = {
  get(): UpdaterReadyRecord | undefined | Promise<UpdaterReadyRecord | undefined>;
  set(value: UpdaterReadyRecord): void | Promise<void>;
  clear(): void | Promise<void>;
};

export function createUpdaterController(input: {
  enabled: boolean;
  currentVersion: string;
  service: UpdaterService;
  persistence: UpdaterPersistence;
  stop: () => Promise<void>;
  scheduleInstall?: (install: () => void) => void;
  log?: (message: string, data?: object) => void;
}) {
  let state: UpdaterState = input.enabled ? { status: 'idle' } : { status: 'disabled' };
  let pending: Promise<UpdaterState> | undefined;
  const listeners = new Set<(state: UpdaterState) => void>();
  const scheduleInstall = input.scheduleInstall ?? ((install: () => void) => {
    setImmediate(install);
  });

  const transition = (next: UpdaterState): UpdaterState => {
    input.log?.('updater state changed', { from: state.status, to: next.status });
    state = next;
    listeners.forEach((listener) => listener(state));
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
    async install(): Promise<void> {
      if (state.status !== 'ready') throw new Error('Update is not ready to install');
      const version = state.version;
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
            transition({ status: 'ready', version });
            input.log?.('updater install launch failed', {
              message: error instanceof Error ? error.message : String(error),
            });
          }
        });
      } catch (error) {
        transition({ status: 'ready', version });
        throw error;
      }
    },
  };
}

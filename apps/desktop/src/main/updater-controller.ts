import type { DesktopUpdaterState } from '../shared/contract';

export type UpdaterState = DesktopUpdaterState;

export type UpdaterBackend = {
  checkForUpdates(): Promise<{ isUpdateAvailable?: boolean; updateInfo?: { version?: string } } | null | undefined>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
};

export function createUpdaterController(input: {
  enabled: boolean;
  currentVersion: string;
  backend: UpdaterBackend;
  stop?: () => Promise<void>;
  log?: (message: string, data?: object) => void;
}) {
  let state: UpdaterState = input.enabled ? { status: 'idle' } : { status: 'disabled' };
  let pending: Promise<UpdaterState> | undefined;
  const listeners = new Set<(state: UpdaterState) => void>();

  const transition = (next: UpdaterState): UpdaterState => {
    input.log?.('updater state changed', { from: state.status, to: next.status });
    state = next;
    listeners.forEach((listener) => listener(state));
    return state;
  };

  const check = (): Promise<UpdaterState> => {
    if (!input.enabled || state.status === 'ready') return Promise.resolve(state);
    if (pending) return pending;

    pending = (async () => {
      transition({ status: 'checking' });
      const result = await input.backend.checkForUpdates();
      const version = result?.updateInfo?.version;
      if (!result?.isUpdateAvailable || !version || version === input.currentVersion) {
        return transition({ status: 'up-to-date' });
      }

      transition({ status: 'downloading', version });
      await input.backend.downloadUpdate();
      return transition({ status: 'ready', version });
    })()
      .catch((error: unknown) =>
        transition({ status: 'error', message: error instanceof Error ? error.message : String(error) }),
      )
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
    start: check,
    check,
    async install(): Promise<void> {
      if (state.status !== 'ready') throw new Error('Update is not ready to install');
      const version = state.version;
      transition({ status: 'installing', version });
      try {
        await input.stop?.();
        input.backend.quitAndInstall();
        transition({ status: 'ready', version });
      } catch (error) {
        transition({ status: 'ready', version });
        throw error;
      }
    },
  };
}

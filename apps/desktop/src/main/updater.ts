import { app } from 'electron';
// electron-updater is a CommonJS module; named imports fail in the packaged
// ESM main bundle (SyntaxError at startup). Use the default export instead.
import electronUpdater from 'electron-updater';

import { createUpdaterController } from './updater-controller';
import type { DesktopUpdaterState } from '../shared/contract';

const { autoUpdater } = electronUpdater;

const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

let controller: ReturnType<typeof createUpdaterController> | undefined;
let checkInterval: NodeJS.Timeout | undefined;
let state: DesktopUpdaterState = { status: 'disabled' };
const listeners = new Set<(state: DesktopUpdaterState) => void>();

function publish(next: DesktopUpdaterState): void {
  state = next;
  listeners.forEach((listener) => listener(state));
}

export const desktopUpdater = {
  getState: (): DesktopUpdaterState => state,
  subscribe(listener: (state: DesktopUpdaterState) => void): () => void {
    listeners.add(listener);
    listener(state);
    return () => listeners.delete(listener);
  },
  check(): Promise<DesktopUpdaterState> {
    return controller?.check() ?? Promise.resolve(state);
  },
  async install(): Promise<void> {
    if (!controller) throw new Error('Desktop updates are unavailable in this build.');
    await controller.install();
  },
};

export function startAutoUpdater(stop: () => Promise<void> = async () => {}): void {
  if (controller || checkInterval) return;
  if (!app.isPackaged || process.env.ELECTRON_RENDERER_URL) {
    // Dev/unpackaged builds silently disable updates; the state is already
    // published to the Settings UI. A console.info here leaks into whatever
    // terminal launched the app and reads like an in-app message.
    publish({ status: 'disabled' });
    return;
  }

  try {
    autoUpdater.channel = 'latest';
    autoUpdater.allowPrerelease = false;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    controller = createUpdaterController({
      enabled: true,
      currentVersion: app.getVersion(),
      backend: autoUpdater,
      stop,
      log(message, data) {
        console.info(`Mixdog ${message}`, data ?? '');
      },
    });
    controller.subscribe((state) => {
      console.info('Mixdog updater status:', state);
      publish(state);
    });

    void controller.start();
    checkInterval = setInterval(() => {
      void controller?.check();
    }, UPDATE_CHECK_INTERVAL_MS);
    checkInterval.unref();
  } catch (error) {
    // Missing or unreachable publish metadata must never delay application startup.
    console.warn('Mixdog auto-update initialization skipped:', error);
  }
}

export async function quitAndInstallUpdate(): Promise<void> {
  await desktopUpdater.install();
}

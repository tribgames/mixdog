import { app } from 'electron';
import { autoUpdater } from 'electron-updater';

import { createUpdaterController } from './updater-controller';

const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

let controller: ReturnType<typeof createUpdaterController> | undefined;
let checkInterval: NodeJS.Timeout | undefined;

export function startAutoUpdater(): void {
  if (controller || checkInterval) return;
  if (!app.isPackaged || process.env.ELECTRON_RENDERER_URL) {
    console.info('Auto-update is disabled outside packaged production builds.');
    return;
  }

  try {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    controller = createUpdaterController({
      enabled: true,
      currentVersion: app.getVersion(),
      backend: autoUpdater,
      log(message, data) {
        console.info(`Mixdog ${message}`, data ?? '');
      },
    });
    controller.subscribe((state) => {
      console.info('Mixdog updater status:', state);
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

export function quitAndInstallUpdate(): void {
  controller?.install();
}

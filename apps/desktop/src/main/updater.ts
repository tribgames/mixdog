import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { app } from 'electron';

import { createUpdaterController, type UpdaterReadyRecord } from './updater-controller';
import type { DesktopUpdaterState } from '../shared/contract';

const UPDATE_CHECK_INTERVAL_MS = 10 * 60 * 1000;

let controller: ReturnType<typeof createUpdaterController> | undefined;
let checkInterval: NodeJS.Timeout | undefined;
let startPromise: Promise<void> | undefined;
let state: DesktopUpdaterState = { status: 'disabled' };
const listeners = new Set<(state: DesktopUpdaterState) => void>();

type UpdaterLog = (message: string, data?: Readonly<Record<string, unknown>>) => void;

function publish(next: DesktopUpdaterState): void {
  state = next;
  listeners.forEach((listener) => listener(state));
}

function readyPersistence(filePath: string) {
  return {
    async get(): Promise<UpdaterReadyRecord | undefined> {
      try {
        const value = JSON.parse(await readFile(filePath, 'utf8')) as Partial<UpdaterReadyRecord>;
        return typeof value.version === 'string' && value.version ? { version: value.version } : undefined;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
        return undefined;
      }
    },
    async set(value: UpdaterReadyRecord): Promise<void> {
      await mkdir(dirname(filePath), { recursive: true });
      const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
        await rename(temporary, filePath);
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
    },
    async clear(): Promise<void> {
      await unlink(filePath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    },
  };
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

export function startAutoUpdater(
  stop: () => Promise<void> = async () => {},
  report?: UpdaterLog,
): void {
  if (controller || checkInterval || startPromise) return;
  if (!app.isPackaged || process.env.ELECTRON_RENDERER_URL) {
    // Dev/unpackaged builds silently disable updates; the state is already
    // published to the Settings UI. A console.info here leaks into whatever
    // terminal launched the app and reads like an in-app message.
    publish({ status: 'disabled' });
    return;
  }

  publish({ status: 'idle' });
  startPromise = (async () => {
    // Keep the import off the critical Electron bootstrap module evaluation,
    // while starting the updater immediately after app.whenReady().
    const electronUpdater = (await import('electron-updater')).default;
    const { autoUpdater } = electronUpdater;
    autoUpdater.logger = console;
    autoUpdater.channel = 'latest';
    autoUpdater.allowPrerelease = false;
    autoUpdater.allowDowngrade = true;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    controller = createUpdaterController({
      enabled: true,
      currentVersion: app.getVersion(),
      backend: autoUpdater,
      persistence: readyPersistence(join(app.getPath('userData'), 'updater-ready.json')),
      stop,
      log(message, data) {
        console.info(`Mixdog ${message}`, data ?? '');
        report?.(message, data as Readonly<Record<string, unknown>> | undefined);
      },
    });
    controller.subscribe((next) => {
      console.info('Mixdog updater status:', next);
      report?.('updater state', next);
      publish(next);
    });
    void controller.start();
    checkInterval = setInterval(() => {
      void controller?.check();
    }, UPDATE_CHECK_INTERVAL_MS);
    checkInterval.unref();
    app.once('will-quit', () => {
      if (checkInterval) clearInterval(checkInterval);
      checkInterval = undefined;
    });
  })().catch((error) => {
    // Missing or unreachable publish metadata must never delay application startup.
    console.warn('Mixdog auto-update initialization skipped:', error);
    report?.('updater initialization skipped', {
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

async function quitAndInstallUpdate(): Promise<void> {
  await desktopUpdater.install();
}

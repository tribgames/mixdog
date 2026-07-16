import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { BrowserWindow, Display, Rectangle } from 'electron';

export interface PersistedWindowState {
  bounds: Rectangle;
  maximized: boolean;
}

const MIN_VISIBLE_PIXELS = 80;
const SAVE_DELAY_MS = 250;

function finiteInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;
}

export function validateWindowState(
  candidate: unknown,
  displays: readonly Pick<Display, 'workArea'>[],
): PersistedWindowState | null {
  if (!candidate || typeof candidate !== 'object') return null;
  const record = candidate as Record<string, unknown>;
  const rawBounds = record.bounds;
  if (!rawBounds || typeof rawBounds !== 'object') return null;
  const boundsRecord = rawBounds as Record<string, unknown>;
  const x = finiteInteger(boundsRecord.x);
  const y = finiteInteger(boundsRecord.y);
  const width = finiteInteger(boundsRecord.width);
  const height = finiteInteger(boundsRecord.height);
  if (x === null || y === null || width === null || height === null || width < 900 || height < 600) {
    return null;
  }

  const visible = displays.some(({ workArea }) => {
    const intersectionWidth = Math.min(x + width, workArea.x + workArea.width) - Math.max(x, workArea.x);
    const intersectionHeight = Math.min(y + height, workArea.y + workArea.height) - Math.max(y, workArea.y);
    return intersectionWidth >= MIN_VISIBLE_PIXELS && intersectionHeight >= MIN_VISIBLE_PIXELS;
  });
  if (!visible) return null;
  return { bounds: { x, y, width, height }, maximized: record.maximized === true };
}

export async function readWindowState(
  filePath: string,
  displays: readonly Pick<Display, 'workArea'>[],
): Promise<PersistedWindowState | null> {
  try {
    const contents = await readFile(filePath, 'utf8');
    if (contents.length > 16 * 1024) return null;
    return validateWindowState(JSON.parse(contents), displays);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('Failed to read desktop window state:', error);
    }
    return null;
  }
}

export function persistWindowState(window: BrowserWindow, filePath: string): {
  flush(): Promise<void>;
  dispose(): void;
} {
  let lastNormalBounds = window.getNormalBounds();
  let timer: NodeJS.Timeout | null = null;
  let writes = Promise.resolve();
  let disposed = false;

  const write = (): void => {
    const state: PersistedWindowState = {
      bounds: lastNormalBounds,
      maximized: window.isMaximized(),
    };
    writes = writes.then(async () => {
      await mkdir(dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.${process.pid}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporaryPath, filePath);
    }).catch((error: unknown) => {
      console.error('Failed to persist desktop window state:', error);
    });
  };
  const schedule = (): void => {
    if (disposed) return;
    if (!window.isMaximized() && !window.isMinimized()) lastNormalBounds = window.getBounds();
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      write();
    }, SAVE_DELAY_MS);
  };

  window.on('move', schedule);
  window.on('resize', schedule);
  window.on('maximize', schedule);
  window.on('unmaximize', schedule);

  return {
    async flush(): Promise<void> {
      if (timer) {
        clearTimeout(timer);
        timer = null;
        write();
      }
      await writes;
    },
    dispose(): void {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      window.removeListener('move', schedule);
      window.removeListener('resize', schedule);
      window.removeListener('maximize', schedule);
      window.removeListener('unmaximize', schedule);
    },
  };
}

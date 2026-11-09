import { readFile } from 'node:fs/promises';

import type { BrowserWindow, Display, Rectangle } from 'electron';
import { writeJsonAtomicAsync } from '../../../../src/runtime/shared/atomic-file.mjs';
import { DESKTOP_WINDOW_MIN_WIDTH } from '../shared/window-layout';

interface PersistedWindowState {
  bounds: Rectangle;
  maximized: boolean;
}

const MIN_VISIBLE_PIXELS = 80;
const SAVE_DELAY_MS = 250;

function finiteInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;
}

function validateWindowState(
  candidate: unknown,
  displays: readonly Pick<Display, 'workArea'>[]
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
  if (
    x === null ||
    y === null ||
    width === null ||
    height === null ||
    width < DESKTOP_WINDOW_MIN_WIDTH ||
    height < 600
  ) {
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

/** Shrinks (never grows) bounds to fit the display work area and keeps the
 *  window inside it; the minimum window size still wins on tiny displays. */
export function clampBoundsToWorkArea(
  bounds: Partial<Rectangle>,
  workArea: Rectangle,
  minWidth = DESKTOP_WINDOW_MIN_WIDTH,
  minHeight = 600
): Partial<Rectangle> {
  const width = Math.max(minWidth, Math.min(bounds.width ?? workArea.width, workArea.width));
  const height = Math.max(minHeight, Math.min(bounds.height ?? workArea.height, workArea.height));
  const clamped: Partial<Rectangle> = { width, height };
  if (bounds.x !== undefined && bounds.y !== undefined) {
    clamped.x = Math.min(Math.max(bounds.x, workArea.x), Math.max(workArea.x, workArea.x + workArea.width - width));
    clamped.y = Math.min(Math.max(bounds.y, workArea.y), Math.max(workArea.y, workArea.y + workArea.height - height));
  }
  return clamped;
}

export async function readWindowState(
  filePath: string,
  displays: readonly Pick<Display, 'workArea'>[]
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

export function persistWindowState(
  window: BrowserWindow,
  filePath: string
): {
  flush(): Promise<void>;
  dispose(): void;
} {
  let lastNormalBounds = window.getNormalBounds();
  let timer: NodeJS.Timeout | null = null;
  let writes = Promise.resolve();
  let disposed = false;

  // Sampled only when the debounce settles: resize/move events fire while a
  // maximize/fullscreen transition is still in flight (isMaximized() not yet
  // true), and getBounds() then reports the transitional geometry — which is
  // what restored as a ~400x600 window.
  const captureNormalBounds = (): void => {
    if (window.isDestroyed()) return;
    if (window.isMaximized() || window.isMinimized() || window.isFullScreen()) return;
    lastNormalBounds = window.getBounds();
  };

  const write = (): void => {
    captureNormalBounds();
    const state: PersistedWindowState = {
      bounds: lastNormalBounds,
      maximized: window.isMaximized(),
    };
    writes = writes
      .then(async () => {
        await writeJsonAtomicAsync(filePath, state, { compact: true });
      })
      .catch((error: unknown) => {
        console.error('Failed to persist desktop window state:', error);
      });
  };
  const schedule = (): void => {
    if (disposed) return;
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

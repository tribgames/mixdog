import { errorMessage } from '../shared/common';
import { join } from 'node:path';

import { app, BrowserWindow, type Display, screen } from 'electron';

import { tagRendererSurface } from '../../process-memory-diagnostics';
import { overlayHtml, overlayScript } from './content';
import type { createComputerOverlayController, ComputerUseOverlayControls } from './controls';
import { recordCursorDiagnostic } from './cursor-diagnostics';
import { hardenWindowSurface, overlayWindowOptions } from './cursor-surface';
import { registerComputerUseInternalWindow } from './internal-windows';
import { bindComputerOverlayControls } from './ipc-controls';
import { boundsKey, clipWindowToPill, overlayBounds } from './overlay-layout';
import type { computerUseOverlayPresentation } from './model';

export interface OverlayWindowEntry {
  window: BrowserWindow;
  lastRenderedPresentation: string;
  /** Bounds last handed to the window manager, so an unchanged layout stays untouched. */
  appliedBounds: string;
}

type OverlayPresentation = ReturnType<typeof computerUseOverlayPresentation>;

export interface OverlayWindowsHost {
  locale: string;
  controls: ComputerUseOverlayControls;
  controller: ReturnType<typeof createComputerOverlayController>;
  presentation(): OverlayPresentation;
  isDisposed(): boolean;
  /** Re-render once a renderer backoff has elapsed. */
  requestRender?(): void;
}

const RENDERER_BACKOFF_BASE_MS = 5_000;
const RENDERER_BACKOFF_MAX_MS = 60_000;

// The built main process is CommonJS; runners loading the TypeScript sources as ESM have no `__dirname`.
function overlayPreloadPath(): string {
  const directory =
    typeof __dirname === 'string' ? join(__dirname, '../preload') : join(app.getAppPath(), 'out/preload');
  return join(directory, 'computer-overlay.js');
}

/** The shared overlay surface, always on top and carrying the controls preload. */
export function pillWindowOptions(display: Display): Electron.BrowserWindowConstructorOptions {
  const shared = overlayWindowOptions();
  return {
    ...overlayBounds(display),
    ...shared,
    alwaysOnTop: true,
    webPreferences: { ...shared.webPreferences, preload: overlayPreloadPath() },
  };
}

function createRendererBackoff(host: OverlayWindowsHost) {
  const failures = new Map<number, number>();
  const retryAfter = new Map<number, number>();
  const timers = new Set<NodeJS.Timeout>();

  return {
    blocked(displayId: number): boolean {
      return (failures.get(displayId) || 0) > 1 && Date.now() < (retryAfter.get(displayId) || 0);
    },
    recordFailure(displayId: number, bornAt: number | undefined): void {
      if (bornAt !== undefined && Date.now() - bornAt >= RENDERER_BACKOFF_MAX_MS) {
        failures.delete(displayId);
        retryAfter.delete(displayId);
      }
      const count = (failures.get(displayId) || 0) + 1;
      failures.set(displayId, count);
      if (count <= 1) return;
      const delay = Math.min(RENDERER_BACKOFF_BASE_MS * 2 ** (count - 2), RENDERER_BACKOFF_MAX_MS);
      retryAfter.set(displayId, Date.now() + delay);
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (!host.isDisposed()) host.requestRender?.();
      }, delay);
      timer.unref?.();
      timers.add(timer);
    },
    reset(): void {
      failures.clear();
      retryAfter.clear();
    },
    dispose(): void {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}

export function createOverlayWindows(host: OverlayWindowsHost) {
  const windows = new Map<number, OverlayWindowEntry>();
  const creatingWindows = new Map<number, Promise<BrowserWindow>>();
  const createdAt = new WeakMap<BrowserWindow, number>();
  const backoff = createRendererBackoff(host);

  const liveEntries = (): OverlayWindowEntry[] => [...windows.values()].filter((entry) => !entry.window.isDestroyed());

  async function createWindow(display: Display): Promise<BrowserWindow> {
    const next = new BrowserWindow(pillWindowOptions(display));
    tagRendererSurface(next, 'computer-pill');
    const unregisterInternalWindow = registerComputerUseInternalWindow(next);
    next.setAlwaysOnTop(true, 'screen-saver');
    hardenWindowSurface(next);
    // Only the pill takes clicks, so a pill stacked beneath it stays reachable.
    clipWindowToPill(next);
    next.webContents.on('will-navigate', (event) => event.preventDefault());
    const retireUnavailableWindow = (): void => {
      if (host.isDisposed() || next.isDestroyed()) return;
      backoff.recordFailure(display.id, createdAt.get(next));
      creatingWindows.delete(display.id);
      next.destroy();
      void host.controller.invoke('pause', host.presentation().sessionIds);
    };
    next.on('unresponsive', retireUnavailableWindow);
    next.webContents.on('render-process-gone', retireUnavailableWindow);
    bindComputerOverlayControls(next.webContents, host.controller, host.controls, host.presentation);
    next.on('closed', () => {
      unregisterInternalWindow();
      if (windows.get(display.id)?.window === next) windows.delete(display.id);
    });
    try {
      await next.loadURL(`data:text/html;base64,${Buffer.from(overlayHtml(host.locale)).toString('base64')}`);
      await next.webContents.executeJavaScript(overlayScript(host.locale));
      if (
        host.isDisposed() ||
        next.isDestroyed() ||
        !screen.getAllDisplays().some((current) => current.id === display.id)
      ) {
        throw new Error('Computer Use overlay disposed during creation');
      }
      windows.set(display.id, {
        window: next,
        lastRenderedPresentation: '',
        appliedBounds: boundsKey(overlayBounds(display)),
      });
      createdAt.set(next, Date.now());
      recordCursorDiagnostic('overlay_window_created');
      return next;
    } catch (error) {
      if (!next.isDestroyed()) next.destroy();
      throw error;
    }
  }

  async function ensureWindowForDisplay(display: Display): Promise<BrowserWindow> {
    if (backoff.blocked(display.id)) {
      throw new Error('computer_control_surface_unavailable: overlay renderer repeatedly failed');
    }
    const existing = windows.get(display.id);
    if (existing && !existing.window.isDestroyed()) return existing.window;
    const pending = creatingWindows.get(display.id);
    if (pending) return await pending;
    const creating = createWindow(display);
    creatingWindows.set(display.id, creating);
    try {
      return await creating;
    } finally {
      if (creatingWindows.get(display.id) === creating) creatingWindows.delete(display.id);
    }
  }

  function dropWindowsForMissingDisplays(displays: Display[]): void {
    const displayIds = new Set(displays.map((display) => display.id));
    for (const [displayId, entry] of windows) {
      if (displayIds.has(displayId)) continue;
      windows.delete(displayId);
      if (!entry.window.isDestroyed()) entry.window.destroy();
    }
  }

  async function syncToDisplays(): Promise<void> {
    const displays = screen.getAllDisplays();
    dropWindowsForMissingDisplays(displays);
    await Promise.all(
      displays.map((display) =>
        ensureWindowForDisplay(display).catch((error) => {
          // Silence here means the user never learns the agent is using their
          // computer, so the cause stays in the host log and the counters.
          recordCursorDiagnostic('overlay_window_unavailable');
          console.warn('[computer-overlay] window_unavailable', errorMessage(error));
          return null;
        })
      )
    );
  }

  function repositionAll(force = false): void {
    for (const display of screen.getAllDisplays()) {
      const entry = windows.get(display.id);
      if (!entry || entry.window.isDestroyed()) continue;
      const bounds = overlayBounds(display);
      const key = boundsKey(bounds);
      if (!force && entry.appliedBounds === key) continue;
      entry.appliedBounds = key;
      entry.window.setBounds(bounds, false);
    }
  }

  function forgetRendered(): void {
    for (const entry of windows.values()) entry.lastRenderedPresentation = '';
  }

  function destroyAll(): void {
    backoff.dispose();
    for (const entry of windows.values()) {
      if (!entry.window.isDestroyed()) entry.window.destroy();
    }
    windows.clear();
  }

  return {
    liveEntries,
    syncToDisplays,
    dropWindowsForMissingDisplays,
    repositionAll,
    forgetRendered,
    resetRendererFailures: backoff.reset,
    destroyAll,
  };
}

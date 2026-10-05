/**
 * One overlay window per display, keyed by Electron display id. Windows are
 * transparent, always on top, never focusable, and carry the controls
 * preload; a renderer that dies is retired once and recovered on the next
 * render, never spun into an automatic crash loop.
 */
import { join } from 'node:path';

import { app, BrowserWindow, type Display, screen } from 'electron';

import { OVERLAY_HEIGHT, OVERLAY_WIDTH, overlayHtml, overlayScript } from './content';
import type { createComputerOverlayController, ComputerUseOverlayControls } from './controls';
import { recordCursorDiagnostic } from './cursor-diagnostics';
import { hardenWindowSurface, overlayWindowOptions } from './cursor-surface';
import { registerComputerUseInternalWindow } from './internal-windows';
import { bindComputerOverlayControls } from './ipc-controls';
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

/** The controls need their bundled preload. The built main process is CommonJS,
 * where `__dirname` is the build output; runners that load the TypeScript
 * sources as ESM have no `__dirname` at all, and resolving it there threw
 * before the window was ever created. */
function overlayPreloadPath(): string {
  const directory =
    typeof __dirname === 'string' ? join(__dirname, '../preload') : join(app.getAppPath(), 'out/preload');
  return join(directory, 'computer-overlay.js');
}

function overlayBounds(display: Display): Electron.Rectangle {
  return {
    x: Math.round(display.workArea.x + (display.workArea.width - OVERLAY_WIDTH) / 2),
    y: display.workArea.y + 6,
    width: OVERLAY_WIDTH,
    height: OVERLAY_HEIGHT,
  };
}

function boundsKey(bounds: Electron.Rectangle): string {
  return `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
}

/** The shared overlay surface, always on top and carrying the controls preload. */
function pillWindowOptions(display: Display): Electron.BrowserWindowConstructorOptions {
  const shared = overlayWindowOptions();
  return {
    ...overlayBounds(display),
    ...shared,
    alwaysOnTop: true,
    webPreferences: { ...shared.webPreferences, preload: overlayPreloadPath() },
  };
}

export function createOverlayWindows(host: OverlayWindowsHost) {
  const windows = new Map<number, OverlayWindowEntry>();
  const creatingWindows = new Map<number, Promise<BrowserWindow>>();
  const rendererFailures = new Map<number, number>();
  const retryAfter = new Map<number, number>();
  const createdAt = new WeakMap<BrowserWindow, number>();
  const retryTimers = new Set<NodeJS.Timeout>();

  const liveEntries = (): OverlayWindowEntry[] => [...windows.values()].filter((entry) => !entry.window.isDestroyed());

  async function createWindow(display: Display): Promise<BrowserWindow> {
    const next = new BrowserWindow(pillWindowOptions(display));
    const unregisterInternalWindow = registerComputerUseInternalWindow(next);
    next.setAlwaysOnTop(true, 'screen-saver');
    hardenWindowSurface(next);
    next.webContents.on('will-navigate', (event) => event.preventDefault());
    const retireUnavailableWindow = (): void => {
      if (host.isDisposed() || next.isDestroyed()) return;
      // A recreated window that rendered and stayed up past the longest backoff
      // was healthy, so its eventual failure starts the count over.
      const born = createdAt.get(next);
      if (born !== undefined && Date.now() - born >= RENDERER_BACKOFF_MAX_MS) {
        rendererFailures.delete(display.id);
        retryAfter.delete(display.id);
      }
      const failures = (rendererFailures.get(display.id) || 0) + 1;
      rendererFailures.set(display.id, failures);
      if (failures > 1) {
        // Repeated failure: back off (5 s doubling to 60 s) instead of either
        // a crash loop or giving up while the user still needs the pill.
        const delay = Math.min(RENDERER_BACKOFF_BASE_MS * 2 ** (failures - 2), RENDERER_BACKOFF_MAX_MS);
        retryAfter.set(display.id, Date.now() + delay);
        const timer = setTimeout(() => {
          retryTimers.delete(timer);
          if (!host.isDisposed()) host.requestRender?.();
        }, delay);
        timer.unref?.();
        retryTimers.add(timer);
      }
      // A hung renderer cannot handle controls, navigation, or another render.
      // Retire only this control window; the host retains the input interlock.
      // Release its creation slot even if loadURL/executeJavaScript never settles.
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
    // Repeated renderer failure must not spawn a tight crash loop, but the pill
    // is the user's way out, so recreation is retried after a bounded backoff.
    if ((rendererFailures.get(display.id) || 0) > 1 && Date.now() < (retryAfter.get(display.id) || 0)) {
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
          console.warn('[computer-overlay] window_unavailable', String((error as Error)?.message || error));
          return null;
        })
      )
    );
  }

  /** Repeating identical bounds still hands the window back to the window
   * manager on every snapshot revision, which repaints a transparent
   * always-on-top surface for nothing; only a real work-area change moves the
   * pill. `force` re-asserts a position the OS itself may have shifted. */
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

  function resetRendererFailures(): void {
    rendererFailures.clear();
    retryAfter.clear();
  }

  function destroyAll(): void {
    for (const timer of retryTimers) clearTimeout(timer);
    retryTimers.clear();
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
    resetRendererFailures,
    destroyAll,
  };
}

import { BrowserWindow, globalShortcut, screen, type Display } from 'electron';
import { join } from 'node:path';
import {
  computerUseCoordinator,
  type ComputerUseSnapshot,
} from '../session/coordinator';
import {
  computerUseOverlayPresentation,
} from './model';
import { createComputerUseCursorOverlay } from './cursor-overlay';
import { registerComputerUseInternalWindow } from './internal-windows';
import { overlayHtml, overlayScript, OVERLAY_WIDTH, OVERLAY_HEIGHT } from './content';
import { createComputerOverlayController, type ComputerUseOverlayControls } from './controls';
import { bindComputerOverlayControls } from './ipc-controls';
export type { ComputerUseOverlayControls } from './controls';

const OVERLAY_FADE_OUT_MS = 180;
const STOP_SHORTCUT = 'CommandOrControl+Alt+Escape';

export interface ComputerUseOverlay {
  dispose(): void;
}

interface OverlayWindowEntry {
  window: BrowserWindow;
  lastRenderedPresentation: string;
}

function overlayBounds(display: Display): Electron.Rectangle {
  return {
    x: Math.round(display.workArea.x + ((display.workArea.width - OVERLAY_WIDTH) / 2)),
    y: display.workArea.y + 6,
    width: OVERLAY_WIDTH,
    height: OVERLAY_HEIGHT,
  };
}

export function createComputerUseOverlay(
  controls: ComputerUseOverlayControls,
  locale = 'en',
): ComputerUseOverlay {
  const cursorOverlay = createComputerUseCursorOverlay();
  /** One overlay window per display, keyed by Electron display id. */
  const windows = new Map<number, OverlayWindowEntry>();
  const creatingWindows = new Map<number, Promise<BrowserWindow>>();
  let disposed = false;
  let latestSnapshot: ComputerUseSnapshot = computerUseCoordinator.snapshot();
  let latestPresentation = computerUseOverlayPresentation(latestSnapshot, locale);
  let hideTimer: NodeJS.Timeout | null = null;
  let renderRevision = 0;
  const controller = createComputerOverlayController(controls, () => {
    if (!disposed) void render().catch(() => {});
  });

  const stop = (): void => {
    void controller.invoke('stop', latestPresentation.generation, latestPresentation.sessionIds);
  };
  const liveEntries = (): OverlayWindowEntry[] =>
    [...windows.values()].filter((entry) => !entry.window.isDestroyed());

  const createWindow = async (display: Display): Promise<BrowserWindow> => {
    const next = new BrowserWindow({
      ...overlayBounds(display),
      alwaysOnTop: true,
      backgroundColor: '#00000000',
      focusable: false,
      frame: false,
      fullscreenable: false,
      hasShadow: false,
      maximizable: false,
      minimizable: false,
      movable: false,
      resizable: false,
      show: false,
      skipTaskbar: true,
      transparent: true,
      webPreferences: {
        preload: join(__dirname, '../preload/computer-overlay.js'),
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    const unregisterInternalWindow = registerComputerUseInternalWindow(next);
    next.setTitle('');
    next.setAlwaysOnTop(true, 'screen-saver');
    next.setContentProtection(true);
    try {
      next.setVisibleOnAllWorkspaces(true, {
        skipTransformProcessType: true,
        visibleOnFullScreen: true,
      });
    } catch {
      // Best effort on Electron/Windows combinations without workspace flags.
    }
    next.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    next.webContents.on('will-navigate', (event) => event.preventDefault());
    bindComputerOverlayControls(next.webContents, controller, controls, () => latestPresentation);
    next.on('closed', () => {
      unregisterInternalWindow();
      if (windows.get(display.id)?.window === next) windows.delete(display.id);
    });
    await next.loadURL(
      `data:text/html;base64,${Buffer.from(overlayHtml(locale)).toString('base64')}`,
    );
    await next.webContents.executeJavaScript(overlayScript(locale));
    if (disposed) {
      next.destroy();
      throw new Error('Computer Use overlay disposed during creation');
    }
    windows.set(display.id, { window: next, lastRenderedPresentation: '' });
    return next;
  };

  const ensureWindowForDisplay = async (display: Display): Promise<BrowserWindow> => {
    const existing = windows.get(display.id);
    if (existing && !existing.window.isDestroyed()) return existing.window;
    const pending = creatingWindows.get(display.id);
    if (pending) return await pending;
    const creating = createWindow(display);
    creatingWindows.set(display.id, creating);
    try {
      return await creating;
    } finally {
      creatingWindows.delete(display.id);
    }
  };

  const dropWindowsForMissingDisplays = (displays: Display[]): void => {
    const displayIds = new Set(displays.map((display) => display.id));
    for (const [displayId, entry] of windows) {
      if (displayIds.has(displayId)) continue;
      windows.delete(displayId);
      if (!entry.window.isDestroyed()) entry.window.destroy();
    }
  };

  const syncWindowsToDisplays = async (): Promise<void> => {
    const displays = screen.getAllDisplays();
    dropWindowsForMissingDisplays(displays);
    await Promise.all(
      displays.map((display) => ensureWindowForDisplay(display).catch(() => null)),
    );
  };

  const repositionAll = (): void => {
    for (const display of screen.getAllDisplays()) {
      const entry = windows.get(display.id);
      if (entry && !entry.window.isDestroyed()) {
        entry.window.setBounds(overlayBounds(display), false);
      }
    }
  };

  const hideAll = (): void => {
    if (hideTimer) return;
    const fading = liveEntries().filter((entry) => entry.window.isVisible());
    if (fading.length === 0) return;
    for (const entry of fading) {
      void entry.window.webContents.executeJavaScript(
        'window.mixdogComputerOverlayHide?.()',
      ).catch(() => {});
    }
    hideTimer = setTimeout(() => {
      hideTimer = null;
      if (latestPresentation.visible) return;
      for (const entry of fading) {
        if (!entry.window.isDestroyed()) entry.window.hide();
      }
    }, OVERLAY_FADE_OUT_MS);
  };

  const render = async (): Promise<void> => {
    const currentRender = ++renderRevision;
    const revision = latestSnapshot.revision;
    const presentation = computerUseOverlayPresentation(latestSnapshot, locale,
      controller.state(latestSnapshot.takeoverGeneration ?? 0));
    latestPresentation = presentation;
    if (!presentation.visible) {
      for (const entry of windows.values()) entry.lastRenderedPresentation = '';
      hideAll();
      return;
    }
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    await syncWindowsToDisplays();
    if (disposed) return;
    if (currentRender !== renderRevision) return;
    if (latestSnapshot.revision !== revision) {
      void render().catch(() => {});
      return;
    }
    repositionAll();
    const serialized = JSON.stringify(presentation).replaceAll('<', '\\u003c');
    await Promise.all(liveEntries().map(async (entry) => {
      if (serialized !== entry.lastRenderedPresentation) {
        await entry.window.webContents.executeJavaScript(
          `window.mixdogComputerOverlay?.(${JSON.stringify({ ...presentation, renderRevision: currentRender }).replaceAll('<', '\\u003c')})`,
        );
        if (currentRender === renderRevision) entry.lastRenderedPresentation = serialized;
      }
      if (!entry.window.isVisible()) entry.window.showInactive();
    }));
  };

  const unsubscribe = computerUseCoordinator.subscribe((snapshot) => {
    latestSnapshot = snapshot;
    void render().catch(() => {});
  });
  const shortcutRegistered = globalShortcut.register(STOP_SHORTCUT, () => {
    if (latestPresentation.visible) stop();
  });
  const onDisplaysChanged = (): void => {
    if (disposed) return;
    if (latestPresentation.visible) {
      // Visible: create windows for new displays and reposition existing ones.
      void render().catch(() => {});
      return;
    }
    // Hidden: windows for new displays are created lazily on the next visible render.
    dropWindowsForMissingDisplays(screen.getAllDisplays());
    repositionAll();
  };
  screen.on('display-metrics-changed', onDisplaysChanged);
  screen.on('display-added', onDisplaysChanged);
  screen.on('display-removed', onDisplaysChanged);

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = null;
      screen.removeListener('display-metrics-changed', onDisplaysChanged);
      screen.removeListener('display-added', onDisplaysChanged);
      screen.removeListener('display-removed', onDisplaysChanged);
      if (shortcutRegistered) globalShortcut.unregister(STOP_SHORTCUT);
      for (const entry of windows.values()) {
        if (!entry.window.isDestroyed()) entry.window.destroy();
      }
      windows.clear();
      cursorOverlay.dispose();
    },
  };
}

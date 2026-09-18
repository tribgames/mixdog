import { app, BrowserWindow, globalShortcut, screen, type Display } from 'electron';
import { join } from 'node:path';
import { computerUseCoordinator, type ComputerUseSnapshot } from '../session/coordinator';
import { computerUseOverlayPresentation } from './model';
import { createComputerUseCursorOverlay } from './cursor-overlay';
import { recordCursorDiagnostic } from './cursor-diagnostics';
import { registerComputerUseInternalWindow } from './internal-windows';
import { overlayHtml, overlayScript, OVERLAY_WIDTH, OVERLAY_HEIGHT } from './content';
import { createComputerOverlayController, type ComputerUseOverlayControls } from './controls';
import { bindComputerOverlayControls } from './ipc-controls';
import { renderComputerOverlayWindows } from './render-windows';
export type { ComputerUseOverlayControls } from './controls';

const OVERLAY_FADE_OUT_MS = 180;
/** A command that settles within a few frames would otherwise flash the banner
 * too briefly to read, which the user experiences as never being told at all. */
const OVERLAY_MIN_VISIBLE_MS = 1_200;
const STOP_SHORTCUT = 'CommandOrControl+Alt+Escape';

export interface ComputerUseOverlay {
  dispose(): void;
}

interface OverlayWindowEntry {
  window: BrowserWindow;
  lastRenderedPresentation: string;
  /** Bounds last handed to the window manager, so an unchanged layout stays untouched. */
  appliedBounds: string;
}

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

export function createComputerUseOverlay(controls: ComputerUseOverlayControls, locale = 'en'): ComputerUseOverlay {
  const cursorOverlay = createComputerUseCursorOverlay();
  /** One overlay window per display, keyed by Electron display id. */
  const windows = new Map<number, OverlayWindowEntry>();
  const creatingWindows = new Map<number, Promise<BrowserWindow>>();
  const rendererFailures = new Map<number, number>();
  let disposed = false;
  let latestSnapshot: ComputerUseSnapshot = computerUseCoordinator.snapshot();
  let latestPresentation = computerUseOverlayPresentation(latestSnapshot, locale);
  let hideTimer: NodeJS.Timeout | null = null;
  /** Pending re-assert of the bounds that a first show may have shifted. */
  let settleTimer: NodeJS.Timeout | null = null;
  /** When the current visible stretch began; 0 while nothing is shown. */
  let shownAt = 0;
  let renderRevision = 0;
  const controller = createComputerOverlayController(controls, () => {
    if (!disposed) scheduleRender();
  });

  const stop = (): void => {
    void controller.invoke('stop', latestPresentation.generation, latestPresentation.sessionIds);
  };
  const liveEntries = (): OverlayWindowEntry[] => [...windows.values()].filter((entry) => !entry.window.isDestroyed());

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
        preload: overlayPreloadPath(),
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
    const retireUnavailableWindow = (): void => {
      if (disposed || next.isDestroyed()) return;
      rendererFailures.set(display.id, (rendererFailures.get(display.id) || 0) + 1);
      // A hung renderer cannot handle controls, navigation, or another render.
      // Retire only this control window; the host retains the input interlock.
      // Release its creation slot even if loadURL/executeJavaScript never settles.
      creatingWindows.delete(display.id);
      next.destroy();
      void controller.invoke('pause', latestPresentation.generation, latestPresentation.sessionIds);
    };
    next.on('unresponsive', retireUnavailableWindow);
    next.webContents.on('render-process-gone', retireUnavailableWindow);
    bindComputerOverlayControls(next.webContents, controller, controls, () => latestPresentation);
    next.on('closed', () => {
      unregisterInternalWindow();
      if (windows.get(display.id)?.window === next) windows.delete(display.id);
    });
    try {
      await next.loadURL(`data:text/html;base64,${Buffer.from(overlayHtml(locale)).toString('base64')}`);
      await next.webContents.executeJavaScript(overlayScript(locale));
      if (disposed || next.isDestroyed() || !screen.getAllDisplays().some((current) => current.id === display.id)) {
        throw new Error('Computer Use overlay disposed during creation');
      }
      windows.set(display.id, {
        window: next,
        lastRenderedPresentation: '',
        appliedBounds: boundsKey(overlayBounds(display)),
      });
      recordCursorDiagnostic('overlay_window_created');
      return next;
    } catch (error) {
      if (!next.isDestroyed()) next.destroy();
      throw error;
    }
  };

  const ensureWindowForDisplay = async (display: Display): Promise<BrowserWindow> => {
    // Recover controls once while paused. Repeated renderer failure must not
    // spawn an automatic crash loop; a subsequent user resume can try again.
    if ((rendererFailures.get(display.id) || 0) > 1) {
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
  };

  /** Repeating identical bounds still hands the window back to the window
   * manager on every snapshot revision, which repaints a transparent
   * always-on-top surface for nothing; only a real work-area change moves the
   * pill. `force` re-asserts a position the OS itself may have shifted. */
  const repositionAll = (force = false): void => {
    for (const display of screen.getAllDisplays()) {
      const entry = windows.get(display.id);
      if (!entry || entry.window.isDestroyed()) continue;
      const bounds = overlayBounds(display);
      const key = boundsKey(bounds);
      if (!force && entry.appliedBounds === key) continue;
      entry.appliedBounds = key;
      entry.window.setBounds(bounds, false);
    }
  };

  /** Windows lays out a transparent always-on-top window only once it actually
   * appears, so the DPI and frame correction arrives after the first show and
   * leaves the pill a few pixels off the bounds it was created with, which reads
   * as the overlay jumping into place. Re-assert the position once that show has
   * gone through the message loop. */
  const settleShownBounds = (): void => {
    if (settleTimer) return;
    settleTimer = setTimeout(() => {
      settleTimer = null;
      if (disposed) return;
      repositionAll(true);
    }, 0);
    settleTimer.unref?.();
  };

  const hideAll = (): void => {
    if (hideTimer) return;
    const fading = liveEntries().filter((entry) => entry.window.isVisible());
    if (fading.length === 0) return;
    const held = shownAt ? Math.max(0, OVERLAY_MIN_VISIBLE_MS - (Date.now() - shownAt)) : 0;
    hideTimer = setTimeout(() => {
      hideTimer = null;
      if (latestPresentation.visible) return;
      shownAt = 0;
      for (const entry of fading) {
        void entry.window.webContents.executeJavaScript('window.mixdogComputerOverlayHide?.()').catch(() => {});
      }
      hideTimer = setTimeout(() => {
        hideTimer = null;
        if (latestPresentation.visible) return;
        for (const entry of fading) {
          if (!entry.window.isDestroyed()) entry.window.hide();
        }
      }, OVERLAY_FADE_OUT_MS);
    }, held);
  };

  const render = async (): Promise<void> => {
    const currentRender = ++renderRevision;
    const revision = latestSnapshot.revision;
    const presentation = computerUseOverlayPresentation(
      latestSnapshot,
      locale,
      controller.state(latestSnapshot.takeoverGeneration ?? 0)
    );
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
    if (!shownAt) shownAt = Date.now();
    await syncWindowsToDisplays();
    if (disposed) return;
    if (currentRender !== renderRevision) return;
    if (latestSnapshot.revision !== revision) {
      scheduleRender();
      return;
    }
    repositionAll();
    const entries = liveEntries();
    const appearing = entries.filter((entry) => !entry.window.isVisible());
    await renderComputerOverlayWindows(
      entries,
      presentation,
      currentRender,
      () =>
        !disposed &&
        currentRender === renderRevision &&
        latestSnapshot.revision === revision &&
        latestPresentation.visible
    );
    if (appearing.some((entry) => !entry.window.isDestroyed() && entry.window.isVisible())) settleShownBounds();
  };

  /** This overlay is the user's only signal that an agent is driving their
   * desktop, so a render that dies must not vanish without a trace. */
  const scheduleRender = (): void => {
    void render().catch((error) => {
      console.warn('[computer-overlay] render_failed', String((error as Error)?.message || error));
    });
  };

  const unsubscribe = computerUseCoordinator.subscribe((snapshot) => {
    if (latestSnapshot.userControlActive && !snapshot.userControlActive) rendererFailures.clear();
    latestSnapshot = snapshot;
    scheduleRender();
  });
  const shortcutRegistered = globalShortcut.register(STOP_SHORTCUT, () => {
    if (latestPresentation.visible || latestSnapshot.userControlActive) stop();
  });
  const onDisplaysChanged = (): void => {
    if (disposed) return;
    if (latestPresentation.visible) {
      // Visible: create windows for new displays and reposition existing ones.
      scheduleRender();
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
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = null;
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

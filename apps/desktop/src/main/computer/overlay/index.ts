import { BrowserWindow, globalShortcut, screen, type Display } from 'electron';
import {
  computerUseCoordinator,
  type ComputerUseSnapshot,
} from '../session/coordinator';
import {
  computerUseOverlayPresentation,
} from './model';
import { createComputerUseCursorOverlay } from './cursor-overlay';
import { registerComputerUseInternalWindow } from './internal-windows';

const OVERLAY_WIDTH = 312;
const OVERLAY_HEIGHT = 76;
const OVERLAY_FADE_OUT_MS = 180;
const STOP_SHORTCUT = 'CommandOrControl+Alt+Escape';

export interface ComputerUseOverlayControls {
  /** End the agent turns of every session using the computer. */
  stop(sessionIds: string[]): Promise<void>;
}

export interface ComputerUseOverlay {
  dispose(): void;
}

interface OverlayWindowEntry {
  window: BrowserWindow;
  lastRenderedPresentation: string;
}

function overlayHtml(locale: string): string {
  const ko = locale.toLowerCase().startsWith('ko');
  const stopLabel = ko ? '중단' : 'Stop';
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none'">
  <style>
    :root { color-scheme: dark; font-family: "Segoe UI", system-ui, sans-serif; }
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent; }
    body { display: flex; align-items: flex-start; justify-content: center; padding: 10px; }
    #pill {
      display: flex; align-items: center; gap: 14px;
      padding: 10px 10px 10px 18px; border: 1px solid color-mix(in srgb, var(--accent) 58%, #ffffff22);
      border-radius: 999px; background: rgba(15, 18, 24, .94);
      box-shadow: 0 10px 34px rgba(0,0,0,.4), inset 0 0 0 1px rgba(255,255,255,.035);
      backdrop-filter: blur(18px); opacity: 1; transform: translateY(0) scale(1);
      transition: opacity 180ms ease, transform 180ms ease;
    }
    body.hiding #pill { opacity: 0; transform: translateY(-4px) scale(.985); }
    #dot { width: 11px; height: 11px; flex: 0 0 auto; border-radius: 999px; background: var(--accent); box-shadow: 0 0 14px var(--accent); }
    #title { white-space: nowrap; color: #f4f7fb; font-size: 16px; font-weight: 650; line-height: 22px; }
    button {
      appearance: none; border: 1px solid rgba(255,255,255,.12); border-radius: 999px;
      background: rgba(255,255,255,.075); color: #ffb4b4; padding: 0;
      width: 32px; height: 32px; display: inline-flex; align-items: center; justify-content: center;
      font: 600 14px/1 "Segoe UI", system-ui, sans-serif; cursor: pointer; flex: 0 0 auto;
    }
    button:hover { background: rgba(255,120,120,.18); }
    button svg { display: block; }
  </style>
</head>
<body>
  <div id="pill">
    <div id="dot"></div>
    <div id="title"></div>
    <button id="stop" title="${stopLabel}" aria-label="${stopLabel}"><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="1" y="1" width="10" height="10" rx="2" fill="currentColor"/></svg></button>
  </div>
  </body>
</html>`;
}

function overlayScript(): string {
  return `(() => {
    document.getElementById('stop').onclick = () => { location.href = 'mixdog-computer-overlay://stop'; };
    window.mixdogComputerOverlay = (state) => {
      document.body.classList.remove('hiding');
      document.documentElement.style.setProperty('--accent', state.accent || '#58a6ff');
      document.getElementById('title').textContent = state.title || '';
    };
    window.mixdogComputerOverlayHide = () => document.body.classList.add('hiding');
  })();`;
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

  const stop = (): void => {
    void controls.stop(latestPresentation.sessionIds).catch(() => {});
  };
  const invokeControl = (action: string): void => {
    if (action === 'stop') stop();
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
    next.webContents.on('will-navigate', (event, url) => {
      if (!url.startsWith('mixdog-computer-overlay://')) return;
      event.preventDefault();
      try {
        invokeControl(new URL(url).hostname);
      } catch {
        // Ignore malformed local control URLs.
      }
    });
    next.on('closed', () => {
      unregisterInternalWindow();
      if (windows.get(display.id)?.window === next) windows.delete(display.id);
    });
    await next.loadURL(
      `data:text/html;base64,${Buffer.from(overlayHtml(locale)).toString('base64')}`,
    );
    await next.webContents.executeJavaScript(overlayScript());
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
    const revision = latestSnapshot.revision;
    const presentation = computerUseOverlayPresentation(latestSnapshot, locale);
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
    if (latestSnapshot.revision !== revision) {
      void render().catch(() => {});
      return;
    }
    repositionAll();
    const serialized = JSON.stringify(presentation).replaceAll('<', '\\u003c');
    await Promise.all(liveEntries().map(async (entry) => {
      if (serialized !== entry.lastRenderedPresentation) {
        await entry.window.webContents.executeJavaScript(
          `window.mixdogComputerOverlay?.(${serialized})`,
        );
        entry.lastRenderedPresentation = serialized;
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

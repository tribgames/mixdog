import { BrowserWindow, globalShortcut, screen } from 'electron';
import {
  computerUseCoordinator,
  type ComputerUseSnapshot,
} from '../session/coordinator';
import {
  computerUseOverlayPresentation,
} from './model';
import { createComputerUseCursorOverlay } from './cursor-overlay';
import { registerComputerUseInternalWindow } from './internal-windows';

const OVERLAY_WIDTH = 620;
const OVERLAY_HEIGHT = 86;
const OVERLAY_FADE_OUT_MS = 180;
const TAKEOVER_SHORTCUT = 'CommandOrControl+Alt+Escape';

export interface ComputerUseOverlayControls {
  takeOver(reason?: string): void;
  resumeAfterTakeover(): void;
  abortSession(sessionId: string): Promise<void>;
  stopAllSessions(): Promise<void>;
}

export interface ComputerUseOverlay {
  dispose(): void;
}

function overlayHtml(locale: string): string {
  const ko = locale.toLowerCase().startsWith('ko');
  const labels = {
    takeover: ko ? '제어권 가져오기' : 'Take control',
    resume: ko ? '다시 시작' : 'Resume',
    stopSession: ko ? '이 세션 중지' : 'Stop session',
    stopAll: ko ? '모두 중지' : 'Stop all',
    shortcut: ko ? 'Ctrl+Alt+Esc로 즉시 제어권 가져오기' : 'Press Ctrl+Alt+Esc to take control',
  };
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none'">
  <style>
    :root { color-scheme: dark; font-family: "Segoe UI", system-ui, sans-serif; }
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent; }
    body { display: flex; align-items: flex-start; justify-content: center; padding: 8px; }
    #pill {
      width: 100%; min-height: 68px; display: flex; align-items: center; gap: 11px;
      padding: 10px 12px; border: 1px solid color-mix(in srgb, var(--accent) 58%, #ffffff22);
      border-radius: 15px; background: rgba(15, 18, 24, .94);
      box-shadow: 0 8px 30px rgba(0,0,0,.38), inset 0 0 0 1px rgba(255,255,255,.035);
      backdrop-filter: blur(18px); opacity: 1; transform: translateY(0) scale(1);
      transition: opacity 180ms ease, transform 180ms ease;
    }
    body.hiding #pill { opacity: 0; transform: translateY(-4px) scale(.985); }
    #dot { width: 10px; height: 10px; flex: 0 0 auto; border-radius: 999px; background: var(--accent); box-shadow: 0 0 14px var(--accent); }
    #copy { min-width: 0; flex: 1; }
    #title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #f4f7fb; font-size: 13px; font-weight: 650; line-height: 19px; }
    #chips { display: flex; min-width: 0; gap: 5px; overflow: hidden; }
    #chips:empty { display: none; }
    .chip {
      min-width: 0; max-width: 190px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      padding: 2px 6px; border-radius: 6px; background: rgba(255,255,255,.07);
      color: #aeb7c4; font-size: 10px; line-height: 14px;
    }
    #shortcut { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #aeb7c4; font-size: 11px; line-height: 16px; }
    #shortcut { color: #d7b65d; display: none; }
    #actions { display: flex; flex: 0 0 auto; align-items: center; gap: 6px; }
    button {
      appearance: none; border: 1px solid rgba(255,255,255,.12); border-radius: 9px;
      background: rgba(255,255,255,.075); color: #eef2f8; padding: 7px 9px;
      font: 600 11px/1 "Segoe UI", system-ui, sans-serif; cursor: pointer;
    }
    button:hover { background: rgba(255,255,255,.14); }
    button.primary { border-color: color-mix(in srgb, var(--accent) 65%, white 15%); background: color-mix(in srgb, var(--accent) 32%, transparent); }
    button.danger { color: #ffb4b4; }
  </style>
</head>
<body>
  <div id="pill">
    <div id="dot"></div>
    <div id="copy">
      <div id="title"></div>
      <div id="chips"></div>
      <div id="shortcut">${labels.shortcut}</div>
    </div>
    <div id="actions">
      <button id="takeover" class="primary">${labels.takeover}</button>
      <button id="resume" class="primary">${labels.resume}</button>
      <button id="stop-session">${labels.stopSession}</button>
      <button id="stop-all" class="danger">${labels.stopAll}</button>
    </div>
  </div>
  </body>
</html>`;
}

function overlayScript(): string {
  return `(() => {
    const action = (name) => { location.href = 'mixdog-computer-overlay://' + name; };
    document.getElementById('takeover').onclick = () => action('takeover');
    document.getElementById('resume').onclick = () => action('resume');
    document.getElementById('stop-session').onclick = () => action('stop-session');
    document.getElementById('stop-all').onclick = () => action('stop-all');
    window.mixdogComputerOverlay = (state) => {
      document.body.classList.remove('hiding');
      document.documentElement.style.setProperty('--accent', state.accent || '#58a6ff');
      document.getElementById('title').textContent = state.title || '';
      const chips = document.getElementById('chips');
      chips.replaceChildren(...(Array.isArray(state.chips) ? state.chips : []).map((text) => {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.textContent = String(text || '');
        return chip;
      }));
      chips.style.display = state.interactive ? '' : 'none';
      document.getElementById('shortcut').style.display = state.interactive ? 'none' : '';
      document.getElementById('takeover').style.display = state.showTakeover ? '' : 'none';
      document.getElementById('resume').style.display = state.showResume ? '' : 'none';
      document.getElementById('stop-session').style.display = state.showStopSession ? '' : 'none';
      document.getElementById('stop-all').style.display = state.showStopAll ? '' : 'none';
    };
    window.mixdogComputerOverlayHide = () => document.body.classList.add('hiding');
  })();`;
}

function overlayBounds(): Electron.Rectangle {
  const point = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(point);
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
  let overlayWindow: BrowserWindow | null = null;
  let creatingWindow: Promise<BrowserWindow> | null = null;
  let disposed = false;
  let latestSnapshot: ComputerUseSnapshot = computerUseCoordinator.snapshot();
  let latestPresentation = computerUseOverlayPresentation(latestSnapshot, locale);
  let hideTimer: NodeJS.Timeout | null = null;
  let lastRenderedPresentation = '';

  const invokeControl = (action: string): void => {
    if (action === 'takeover') {
      controls.takeOver('overlay_takeover');
      return;
    }
    if (action === 'resume') {
      controls.resumeAfterTakeover();
      return;
    }
    if (action === 'stop-session' && latestPresentation.sessionId) {
      void controls.abortSession(latestPresentation.sessionId).catch(() => {});
      return;
    }
    if (action === 'stop-all') {
      void controls.stopAllSessions().catch(() => {});
    }
  };

  const ensureWindow = async (): Promise<BrowserWindow> => {
    if (overlayWindow && !overlayWindow.isDestroyed()) return overlayWindow;
    if (creatingWindow) return await creatingWindow;
    creatingWindow = (async () => {
      const next = new BrowserWindow({
        ...overlayBounds(),
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
        if (overlayWindow === next) overlayWindow = null;
        lastRenderedPresentation = '';
      });
      await next.loadURL(
        `data:text/html;base64,${Buffer.from(overlayHtml(locale)).toString('base64')}`,
      );
      await next.webContents.executeJavaScript(overlayScript());
      if (disposed) {
        next.destroy();
        throw new Error('Computer Use overlay disposed during creation');
      }
      overlayWindow = next;
      return next;
    })();
    try {
      return await creatingWindow;
    } finally {
      creatingWindow = null;
    }
  };

  const render = async (): Promise<void> => {
    const revision = latestSnapshot.revision;
    const presentation = computerUseOverlayPresentation(latestSnapshot, locale);
    latestPresentation = presentation;
    if (!presentation.visible) {
      lastRenderedPresentation = '';
      if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible() && !hideTimer) {
        const fadingWindow = overlayWindow;
        void fadingWindow.webContents.executeJavaScript(
          'window.mixdogComputerOverlayHide?.()',
        ).catch(() => {});
        hideTimer = setTimeout(() => {
          hideTimer = null;
          if (!latestPresentation.visible && !fadingWindow.isDestroyed()) fadingWindow.hide();
        }, OVERLAY_FADE_OUT_MS);
      }
      return;
    }
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    const window = await ensureWindow();
    if (disposed || window.isDestroyed()) return;
    if (latestSnapshot.revision !== revision) {
      void render().catch(() => {});
      return;
    }
    window.setBounds(overlayBounds(), false);
    window.setIgnoreMouseEvents(!presentation.interactive, { forward: true });
    const serialized = JSON.stringify(presentation).replaceAll('<', '\\u003c');
    if (serialized !== lastRenderedPresentation) {
      await window.webContents.executeJavaScript(
        `window.mixdogComputerOverlay?.(${serialized})`,
      );
      lastRenderedPresentation = serialized;
    }
    if (!window.isVisible()) window.showInactive();
  };

  const unsubscribe = computerUseCoordinator.subscribe((snapshot) => {
    latestSnapshot = snapshot;
    void render().catch(() => {});
  });
  const shortcutRegistered = globalShortcut.register(TAKEOVER_SHORTCUT, () => {
    controls.takeOver('emergency_shortcut');
  });
  const reposition = (): void => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.setBounds(overlayBounds(), false);
    }
  };
  screen.on('display-metrics-changed', reposition);
  screen.on('display-added', reposition);
  screen.on('display-removed', reposition);

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = null;
      screen.removeListener('display-metrics-changed', reposition);
      screen.removeListener('display-added', reposition);
      screen.removeListener('display-removed', reposition);
      if (shortcutRegistered) globalShortcut.unregister(TAKEOVER_SHORTCUT);
      if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.destroy();
      overlayWindow = null;
      cursorOverlay.dispose();
    },
  };
}

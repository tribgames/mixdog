import { BrowserWindow, screen } from 'electron';

import {
  computerUseCoordinator,
  type ComputerUseSnapshot,
} from './computer-use-coordinator';
import {
  computerUseCursorPresentations,
  type ComputerUseCursorPresentation,
} from './computer-use-overlay-model';
import { registerComputerUseInternalWindow } from './computer-use-internal-windows';

const CURSOR_WIDTH = 210;
const CURSOR_HEIGHT = 82;
const HOTSPOT_X = 12;
const HOTSPOT_Y = 10;
const GLIDE_MS = 150;
const DRAG_MS = 280;

interface CursorSurface {
  window: BrowserWindow | null;
  creating: Promise<BrowserWindow> | null;
  timers: Set<NodeJS.Timeout>;
  lastEventId: number;
  position?: { x: number; y: number };
}

export interface ComputerUseCursorOverlay {
  dispose(): void;
}

function cursorHtml(): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none'">
  <style>
    :root { --accent: #58a6ff; color-scheme: dark; font-family: "Segoe UI", system-ui, sans-serif; }
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent; pointer-events: none; }
    #surface { position: relative; width: 100%; height: 100%; opacity: 0; transition: opacity 150ms ease; }
    #surface.visible { opacity: 1; }
    #halo {
      position: absolute; left: 0; top: 0; width: 25px; height: 25px; border-radius: 999px;
      border: 2px solid color-mix(in srgb, var(--accent) 82%, white 18%);
      background: color-mix(in srgb, var(--accent) 18%, transparent);
      box-shadow: 0 0 18px color-mix(in srgb, var(--accent) 62%, transparent);
      transform: translate(-1px, -1px) scale(.55); opacity: .7;
    }
    #arrow {
      position: absolute; left: 6px; top: 4px; width: 28px; height: 34px;
      filter: drop-shadow(0 3px 4px rgba(0,0,0,.55));
    }
    #arrow path.body { fill: var(--accent); stroke: white; stroke-width: 1.5; stroke-linejoin: round; }
    #arrow path.shine { fill: color-mix(in srgb, var(--accent) 38%, white 62%); opacity: .72; }
    #badge {
      position: absolute; left: 29px; top: 32px; display: flex; align-items: center; gap: 5px;
      max-width: 176px; min-height: 24px; padding: 4px 7px; border-radius: 8px;
      border: 1px solid color-mix(in srgb, var(--accent) 55%, white 12%);
      background: rgba(15,18,24,.92); color: #f4f7fb;
      box-shadow: 0 5px 16px rgba(0,0,0,.36); font-size: 10px; font-weight: 650;
    }
    #name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #context {
      flex: 0 0 auto; padding: 2px 4px; border-radius: 5px;
      background: color-mix(in srgb, var(--accent) 35%, transparent); color: white;
      font-size: 9px; letter-spacing: .03em;
    }
    #direction {
      position: absolute; left: 37px; top: 2px; color: var(--accent);
      font-size: 21px; font-weight: 800; opacity: 0;
      text-shadow: 0 2px 5px rgba(0,0,0,.6);
    }
    #surface.click #halo { animation: click 360ms ease-out; }
    #surface.double_click #halo { animation: click 300ms ease-out 2; }
    #surface.drag #halo { animation: drag 520ms ease-in-out; }
    #surface.scroll #direction { animation: direction 520ms ease-out; }
    #surface.type #halo { animation: type 430ms ease-out; }
    @keyframes click { 0% { transform: scale(.5); opacity: .95; } 100% { transform: scale(1.55); opacity: 0; } }
    @keyframes drag { 0%,100% { transform: scale(.62); opacity: .75; } 50% { transform: scale(1.05); opacity: .35; } }
    @keyframes direction { 0% { transform: translateY(7px); opacity: 0; } 35% { opacity: 1; } 100% { transform: translateY(-8px); opacity: 0; } }
    @keyframes type { 0% { transform: scale(.55); opacity: .8; } 45% { border-radius: 4px; transform: scale(.8); } 100% { transform: scale(1.25); opacity: 0; } }
  </style>
</head>
<body>
  <div id="surface">
    <div id="halo"></div>
    <svg id="arrow" viewBox="0 0 28 34" aria-hidden="true">
      <path class="body" d="M2.4 1.8 24.7 18.4l-10.1 1.2 5.2 10.1-5.1 2.6-5.1-10-6.4 7.7z"/>
      <path class="shine" d="M5.3 5.8 18.7 16l-7.1.8-3.9 7.2z"/>
    </svg>
    <div id="direction"></div>
    <div id="badge"><span id="name"></span><span id="context"></span></div>
  </div>
  </body>
</html>`;
}

function cursorScript(): string {
  return `(() => {
    let fadeTimer = 0;
    let effectTimer = 0;
    const surface = document.getElementById('surface');
    window.mixdogAgentCursor = (state) => {
      clearTimeout(fadeTimer);
      clearTimeout(effectTimer);
      document.documentElement.style.setProperty('--accent', state.accent || '#58a6ff');
      document.getElementById('name').textContent = state.badge || 'Mixdog';
      document.getElementById('context').textContent = state.context || '';
      document.getElementById('direction').textContent = ({
        up: '↑', down: '↓', left: '←', right: '→'
      })[state.direction] || '';
      surface.className = 'visible';
      effectTimer = setTimeout(() => {
        surface.className = 'visible ' + (state.effect || 'move');
      }, Math.max(0, Number(state.effectDelayMs) || 0));
      fadeTimer = setTimeout(() => {
        surface.className = '';
      }, Math.max(500, Number(state.holdMs) || 1250));
    };
  })();`;
}

function dipPoint(point: { x: number; y: number }): { x: number; y: number } {
  try {
    return screen.screenToDipPoint({
      x: Math.round(point.x),
      y: Math.round(point.y),
    });
  } catch {
    return { x: Math.round(point.x), y: Math.round(point.y) };
  }
}

function cursorBounds(point: { x: number; y: number }): Electron.Rectangle {
  const dip = dipPoint(point);
  return {
    x: Math.round(dip.x - HOTSPOT_X),
    y: Math.round(dip.y - HOTSPOT_Y),
    width: CURSOR_WIDTH,
    height: CURSOR_HEIGHT,
  };
}

function clearTimers(surface: CursorSurface): void {
  for (const timer of surface.timers) clearTimeout(timer);
  surface.timers.clear();
}

function scheduleMove(
  surface: CursorSurface,
  destination: { x: number; y: number },
  durationMs: number,
  delayMs = 0,
): void {
  const kickoff = setTimeout(() => {
    surface.timers.delete(kickoff);
    const origin = surface.position || destination;
    const steps = durationMs > 0 ? Math.max(1, Math.round(durationMs / 20)) : 1;
    for (let step = 1; step <= steps; step += 1) {
      const timer = setTimeout(() => {
        surface.timers.delete(timer);
        const progress = step / steps;
        const eased = 1 - ((1 - progress) ** 3);
        const point = {
          x: origin.x + ((destination.x - origin.x) * eased),
          y: origin.y + ((destination.y - origin.y) * eased),
        };
        surface.position = point;
        if (surface.window && !surface.window.isDestroyed()) {
          surface.window.setBounds(cursorBounds(point), false);
        }
      }, Math.round((durationMs * step) / steps));
      surface.timers.add(timer);
    }
  }, delayMs);
  surface.timers.add(kickoff);
}

export function createComputerUseCursorOverlay(): ComputerUseCursorOverlay {
  const surfaces = new Map<string, CursorSurface>();
  let disposed = false;
  let latestSnapshot: ComputerUseSnapshot = computerUseCoordinator.snapshot();

  const surfaceFor = (sessionId: string): CursorSurface => {
    let surface = surfaces.get(sessionId);
    if (!surface) {
      surface = {
        window: null,
        creating: null,
        timers: new Set(),
        lastEventId: 0,
      };
      surfaces.set(sessionId, surface);
    }
    return surface;
  };

  const ensureWindow = async (
    sessionId: string,
    surface: CursorSurface,
  ): Promise<BrowserWindow> => {
    if (surface.window && !surface.window.isDestroyed()) return surface.window;
    if (surface.creating) return await surface.creating;
    surface.creating = (async () => {
      const next = new BrowserWindow({
        ...cursorBounds(surface.position || { x: 0, y: 0 }),
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
      next.setIgnoreMouseEvents(true, { forward: true });
      try {
        next.setVisibleOnAllWorkspaces(true, {
          skipTransformProcessType: true,
          visibleOnFullScreen: true,
        });
      } catch {
        // Best effort where workspace flags are unavailable.
      }
      next.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      next.on('closed', () => {
        unregisterInternalWindow();
        if (surface.window === next) surface.window = null;
      });
      await next.loadURL(
        `data:text/html;base64,${Buffer.from(cursorHtml()).toString('base64')}`,
      );
      await next.webContents.executeJavaScript(cursorScript());
      if (disposed || surfaces.get(sessionId) !== surface) {
        next.destroy();
        throw new Error('Computer Use cursor disposed during creation');
      }
      surface.window = next;
      return next;
    })();
    try {
      return await surface.creating;
    } finally {
      surface.creating = null;
    }
  };

  const renderCursor = async (cursor: ComputerUseCursorPresentation): Promise<void> => {
    const surface = surfaceFor(cursor.sessionId);
    if (cursor.eventId <= surface.lastEventId) return;
    surface.lastEventId = cursor.eventId;
    clearTimers(surface);
    const source = { x: cursor.x, y: cursor.y };
    const hadPosition = Boolean(surface.position);
    if (!surface.position) surface.position = source;
    const window = await ensureWindow(cursor.sessionId, surface);
    if (disposed || window.isDestroyed() || surface.lastEventId !== cursor.eventId) return;
    const travelMs = hadPosition ? GLIDE_MS : 0;
    const isDrag = cursor.effect === 'drag'
      && Number.isFinite(cursor.toX)
      && Number.isFinite(cursor.toY);
    const effectDelayMs = travelMs + (isDrag ? Math.round(DRAG_MS * 0.45) : 0);
    const serialized = JSON.stringify({
      ...cursor,
      effectDelayMs,
      holdMs: effectDelayMs + 1_250,
    }).replaceAll('<', '\\u003c');
    await window.webContents.executeJavaScript(
      `window.mixdogAgentCursor?.(${serialized})`,
    );
    if (!window.isVisible()) window.showInactive();
    scheduleMove(surface, source, travelMs);
    if (isDrag) {
      scheduleMove(
        surface,
        { x: cursor.toX as number, y: cursor.toY as number },
        DRAG_MS,
        travelMs + 20,
      );
    }
  };

  const render = (): void => {
    const cursors = computerUseCursorPresentations(latestSnapshot);
    const desired = new Set(cursors.map((cursor) => cursor.sessionId));
    for (const [sessionId, surface] of surfaces) {
      if (desired.has(sessionId)) continue;
      clearTimers(surface);
      if (surface.window && !surface.window.isDestroyed()) surface.window.destroy();
      surfaces.delete(sessionId);
    }
    for (const cursor of cursors) void renderCursor(cursor).catch(() => {});
  };

  const unsubscribe = computerUseCoordinator.subscribe((snapshot) => {
    latestSnapshot = snapshot;
    render();
  });
  const reposition = (): void => {
    for (const surface of surfaces.values()) {
      if (!surface.position || !surface.window || surface.window.isDestroyed()) continue;
      surface.window.setBounds(cursorBounds(surface.position), false);
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
      screen.removeListener('display-metrics-changed', reposition);
      screen.removeListener('display-added', reposition);
      screen.removeListener('display-removed', reposition);
      for (const surface of surfaces.values()) {
        clearTimers(surface);
        if (surface.window && !surface.window.isDestroyed()) surface.window.destroy();
      }
      surfaces.clear();
    },
  };
}

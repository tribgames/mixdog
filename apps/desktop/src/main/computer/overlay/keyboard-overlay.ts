/**
 * The typing board, one window per session that is typing. It sits under the
 * window being typed into, close enough to read together with it but clear of
 * the text itself, and it disappears with the session that raised it.
 */
import { BrowserWindow, screen } from 'electron';

import { computerUseCoordinator, type ComputerUseSnapshot } from '../session/coordinator';
import { recordCursorDiagnostic } from './cursor-diagnostics';
import { hardenOverlayWindow, overlayWindowOptions } from './cursor-surface';
import { registerComputerUseInternalWindow } from './internal-windows';
import { KEYBOARD_HEIGHT, KEYBOARD_WIDTH, keyboardHtml, keyboardScript } from './keyboard-art';
import { SESSION_COLORS, sessionColor } from './model';

/** Gap between the window being typed into and the board below it. */
const BOARD_GAP = 14;
/** A board with no keystroke behind it for this long has nothing left to say. */
const BOARD_IDLE_MS = 2_000;

interface BoardSurface {
  window: BrowserWindow | null;
  creating: Promise<BrowserWindow> | null;
  lastEventId: number;
  idleTimer?: ReturnType<typeof setTimeout>;
}

/** Bottom centre of the display the typing is happening on. The board cannot
 *  know where the text lands, so it keeps to an edge instead of guessing. */
function boardBounds(point: { x: number; y: number }): Electron.Rectangle {
  let dip = point;
  try {
    dip = screen.screenToDipPoint({ x: Math.round(point.x), y: Math.round(point.y) });
  } catch {
    dip = { x: Math.round(point.x), y: Math.round(point.y) };
  }
  const area = screen.getDisplayNearestPoint(dip).workArea;
  return {
    x: Math.round(area.x + area.width / 2 - KEYBOARD_WIDTH / 2),
    y: Math.round(area.y + area.height - KEYBOARD_HEIGHT - BOARD_GAP),
    width: KEYBOARD_WIDTH,
    height: KEYBOARD_HEIGHT,
  };
}

async function openBoardWindow(surface: BoardSurface, isCurrent: () => boolean): Promise<BrowserWindow> {
  const next = new BrowserWindow({ ...boardBounds({ x: 0, y: 0 }), ...overlayWindowOptions() });
  surface.window = next;
  const unregisterInternalWindow = registerComputerUseInternalWindow(next);
  next.on('closed', () => {
    unregisterInternalWindow();
    if (surface.window === next) {
      surface.window = null;
      surface.creating = null;
    }
  });
  try {
    hardenOverlayWindow(next);
    await next.loadURL(`data:text/html;base64,${Buffer.from(keyboardHtml()).toString('base64')}`);
    if (!isCurrent() || next.isDestroyed()) throw new Error('Computer Use keyboard disposed during creation');
    await next.webContents.executeJavaScript(keyboardScript());
    recordCursorDiagnostic('keyboard_created');
    return next;
  } catch (error) {
    if (!next.isDestroyed()) next.destroy();
    throw error;
  }
}

async function ensureBoardWindow(surface: BoardSurface, isCurrent: () => boolean): Promise<BrowserWindow> {
  if (surface.creating) return await surface.creating;
  if (surface.window && !surface.window.isDestroyed()) return surface.window;
  const creating = openBoardWindow(surface, isCurrent);
  surface.creating = creating;
  try {
    return await creating;
  } finally {
    if (surface.creating === creating) surface.creating = null;
  }
}

export interface ComputerUseKeyboardOverlay {
  dispose(): void;
}

export function createComputerUseKeyboardOverlay(): ComputerUseKeyboardOverlay {
  const surfaces = new Map<string, BoardSurface>();
  let disposed = false;
  let latestSnapshot: ComputerUseSnapshot = computerUseCoordinator.snapshot();

  const destroySurface = (sessionId: string, surface: BoardSurface): void => {
    if (surface.idleTimer) clearTimeout(surface.idleTimer);
    if (surface.window && !surface.window.isDestroyed()) surface.window.destroy();
    surfaces.delete(sessionId);
    recordCursorDiagnostic('keyboard_removed');
  };

  const show = async (keystroke: ComputerUseSnapshot['keystrokes'][number]): Promise<void> => {
    const surface = surfaces.get(keystroke.sessionId);
    if (!surface || surface.lastEventId !== keystroke.eventId) return;
    const isCurrent = (): boolean =>
      !disposed && surfaces.get(keystroke.sessionId) === surface && surface.lastEventId === keystroke.eventId;
    const window = await ensureBoardWindow(surface, isCurrent);
    if (!isCurrent() || window.isDestroyed()) return;
    window.setBounds(boardBounds(keystroke), false);
    const multipleSessions = latestSnapshot.activities.length > 1;
    await window.webContents.executeJavaScript(
      `window.mixdogAgentKeyboard(${JSON.stringify({
        accent: multipleSessions ? sessionColor(keystroke.sessionId) : SESSION_COLORS[0],
        // A masked keystroke sends no key names at all: what the board never
        // receives, it can never light up, whatever a later bug does to it.
        keys: keystroke.masked ? [] : keystroke.keys,
        masked: keystroke.masked,
      }).replaceAll('<', '\\u003c')})`
    );
    if (!isCurrent() || window.isDestroyed()) return;
    window.setAlwaysOnTop(true, 'screen-saver');
    if (!window.isVisible()) window.showInactive();
    recordCursorDiagnostic('keyboard_visible');
    if (surface.idleTimer) clearTimeout(surface.idleTimer);
    surface.idleTimer = setTimeout(() => {
      if (surfaces.get(keystroke.sessionId) === surface) destroySurface(keystroke.sessionId, surface);
    }, BOARD_IDLE_MS);
    surface.idleTimer.unref?.();
  };

  const render = (): void => {
    if (disposed) return;
    const blocked = latestSnapshot.userControlActive || latestSnapshot.cleanupState === 'failed';
    const live = new Set(blocked ? [] : latestSnapshot.keystrokes.map((keystroke) => keystroke.sessionId));
    for (const [sessionId, surface] of surfaces) {
      if (!live.has(sessionId)) destroySurface(sessionId, surface);
    }
    if (blocked) return;
    for (const keystroke of latestSnapshot.keystrokes) {
      let surface = surfaces.get(keystroke.sessionId);
      if (!surface) {
        surface = { window: null, creating: null, lastEventId: 0 };
        surfaces.set(keystroke.sessionId, surface);
      }
      if (surface.lastEventId >= keystroke.eventId) continue;
      surface.lastEventId = keystroke.eventId;
      void show(keystroke).catch(() => {
        // No typed content or raw Electron error enters the diagnostic.
        if (!disposed && surfaces.has(keystroke.sessionId)) recordCursorDiagnostic('keyboard_failed');
      });
    }
  };

  const unsubscribe = computerUseCoordinator.subscribe((snapshot) => {
    latestSnapshot = snapshot;
    render();
  });

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      for (const [sessionId, surface] of [...surfaces]) destroySurface(sessionId, surface);
      surfaces.clear();
    },
  };
}

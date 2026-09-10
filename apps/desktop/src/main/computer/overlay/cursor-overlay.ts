import { BrowserWindow, screen } from 'electron';

import {
  computerUseCoordinator,
  type ComputerUseSnapshot,
} from '../session/coordinator';
import {
  computerUseCursorPresentations,
  type ComputerUseCursorPresentation,
} from './model';
import { registerComputerUseInternalWindow } from './internal-windows';
import { createCursorTail } from './cursor-tail';
import { cursorHtml, cursorScript, CURSOR_SIZE, CURSOR_HOTSPOT } from './cursor-art';
import { recordCursorDiagnostic } from './cursor-diagnostics';
import { bindCursorPreparation } from './cursor-readiness';

const CURSOR_WIDTH = CURSOR_SIZE;
const CURSOR_HEIGHT = CURSOR_SIZE;
const HOTSPOT_X = CURSOR_HOTSPOT;
const HOTSPOT_Y = CURSOR_HOTSPOT;

interface CursorSurface {
  window: BrowserWindow | null;
  creating: Promise<BrowserWindow> | null;
  lastEventId: number;
  position?: { x: number; y: number };
}

export interface ComputerUseCursorOverlay {
  dispose(): void;
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

export function createComputerUseCursorOverlay(): ComputerUseCursorOverlay {
  const surfaces = new Map<string, CursorSurface>();
  let visibleCursorEvents = new Map<string, number>();
  let disposed = false;
  let latestSnapshot: ComputerUseSnapshot = computerUseCoordinator.snapshot();
  const tail = createCursorTail(() => render());
  const arrivals = new Map<string, { eventId: number; promise: Promise<void> }>();

  const surfaceFor = (sessionId: string): CursorSurface => {
    let surface = surfaces.get(sessionId);
    if (!surface) {
      surface = {
        window: null,
        creating: null,
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
      next.webContents.on('render-process-gone', () => {
        recordCursorDiagnostic('renderer_gone');
        // Retire the dead surface. A fresh event or preparation creates its replacement;
        // never replay an old effect or loop on the same crashed renderer.
        if (!next.isDestroyed()) next.destroy();
      });
      next.on('closed', () => {
        unregisterInternalWindow();
        if (surface.window === next) surface.window = null;
      });
      try {
        await next.loadURL(
          `data:text/html;base64,${Buffer.from(cursorHtml()).toString('base64')}`,
        );
        await next.webContents.executeJavaScript(cursorScript());
        if (disposed || next.isDestroyed() || surfaces.get(sessionId) !== surface) {
          throw new Error('Computer Use cursor disposed during creation');
        }
        surface.window = next;
        recordCursorDiagnostic('window_created');
        return next;
      } catch (error) {
        if (!next.isDestroyed()) next.destroy();
        throw error;
      }
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
    recordCursorDiagnostic('render_started');
    const source = { x: cursor.x, y: cursor.y };
    surface.position = source;
    const window = await ensureWindow(cursor.sessionId, surface);
    if (disposed || window.isDestroyed() || surface.lastEventId !== cursor.eventId
      || visibleCursorEvents.get(cursor.sessionId) !== cursor.eventId) {
      recordCursorDiagnostic('render_superseded'); return;
    }
    const serialized = JSON.stringify({
      ...cursor,
    }).replaceAll('<', '\\u003c');
    window.setBounds(cursorBounds(source), false);
    const evidence = await window.webContents.executeJavaScript(
      `(() => {
        if (typeof window.mixdogAgentCursor !== 'function') return { handler: false };
        window.mixdogAgentCursor(${serialized});
        const ring = document.getElementById('ring');
        return { handler: true, ring: Boolean(ring), opacity: ring ? Number(getComputedStyle(ring).opacity) : 0 };
      })()`,
    );
    recordCursorDiagnostic(evidence?.handler ? 'handler_called' : 'handler_missing');
    recordCursorDiagnostic(evidence?.ring ? 'ring_present' : 'ring_missing');
    recordCursorDiagnostic(evidence?.opacity > 0 ? 'ring_visible_style' : 'ring_transparent_style');
    if (disposed || window.isDestroyed() || surfaces.get(cursor.sessionId) !== surface
      || latestSnapshot.userControlActive || surface.lastEventId !== cursor.eventId
      || visibleCursorEvents.get(cursor.sessionId) !== cursor.eventId) return;
    if (!window.isVisible()) window.showInactive();
    recordCursorDiagnostic(window.isVisible() ? 'window_visible' : 'window_not_visible');
    const bounds = window.getBounds();
    const onDisplay = screen.getAllDisplays().some(display => {
      const area = display.bounds;
      return bounds.x < area.x + area.width && bounds.x + bounds.width > area.x
        && bounds.y < area.y + area.height && bounds.y + bounds.height > area.y;
    });
    recordCursorDiagnostic(onDisplay ? 'window_on_display' : 'window_off_display');
  };

  const render = (): void => {
    const backgroundSessions = new Set(latestSnapshot.activities
      .filter(activity => activity.mode === 'background').map(activity => activity.sessionId));
    const cursors = tail.update(computerUseCursorPresentations(latestSnapshot),
      latestSnapshot.userControlActive || latestSnapshot.cleanupState === 'failed', backgroundSessions);
    visibleCursorEvents = new Map(cursors.map(cursor => [cursor.sessionId, cursor.eventId]));
    const desired = new Set(cursors.map((cursor) => cursor.sessionId));
    if (!latestSnapshot.userControlActive && latestSnapshot.cleanupState !== 'failed') {
      for (const activity of latestSnapshot.activities) {
        if (activity.mode === 'foreground') desired.add(activity.sessionId);
      }
    }
    for (const [sessionId, surface] of surfaces) {
      if (desired.has(sessionId)) {
        if (!visibleCursorEvents.has(sessionId) && surface.window && !surface.window.isDestroyed()) {
          surface.window.hide();
        }
        continue;
      }
      if (surface.window && !surface.window.isDestroyed()) surface.window.destroy();
      surfaces.delete(sessionId);
      recordCursorDiagnostic('window_removed');
      arrivals.delete(sessionId);
    }
    for (const cursor of cursors) {
      if (arrivals.get(cursor.sessionId)?.eventId === cursor.eventId) continue;
      const promise = renderCursor(cursor);
      arrivals.set(cursor.sessionId, { eventId: cursor.eventId, promise });
      void promise.catch(() => {
      // No user content or raw Electron error enters the diagnostic.
      if (!disposed && surfaces.has(cursor.sessionId)) {
        console.warn('[computer-cursor] render_failed');
        recordCursorDiagnostic('render_failed');
      }
      });
    }
  };

  const unsubscribe = computerUseCoordinator.subscribe((snapshot) => {
    latestSnapshot = snapshot;
    render();
  });
  const unbindPreparation = bindCursorPreparation(async sessionId => {
    if (disposed || latestSnapshot.userControlActive || latestSnapshot.cleanupState === 'failed') {
      throw new Error('cursor presentation unavailable');
    }
    if (!latestSnapshot.activities.some(activity => activity.sessionId === sessionId && activity.mode === 'foreground')) {
      throw new Error('cursor presentation is foreground-only');
    }
    await ensureWindow(sessionId, surfaceFor(sessionId));
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
      tail.dispose();
      unsubscribe();
      unbindPreparation();
      screen.removeListener('display-metrics-changed', reposition);
      screen.removeListener('display-added', reposition);
      screen.removeListener('display-removed', reposition);
      for (const surface of surfaces.values()) {
        if (surface.window && !surface.window.isDestroyed()) surface.window.destroy();
      }
      surfaces.clear();
    },
  };
}

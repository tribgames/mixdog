import { BrowserWindow, screen } from 'electron';

import { computerUseCoordinator, type ComputerUseSnapshot } from '../session/coordinator';
import { computerUseCursorPresentations, type ComputerUseCursorPresentation } from './model';
import { registerComputerUseInternalWindow } from './internal-windows';
import { createCursorTail } from './cursor-tail';
import { cursorHtml, cursorScript, CURSOR_SIZE, CURSOR_HOTSPOT } from './cursor-art';
import { recordCursorDiagnostic } from './cursor-diagnostics';
import { bindCursorPreparation } from './cursor-readiness';
import { glideAllowed, glideFinished, glidePosition, planGlide, type GlidePoint } from './cursor-glide';

const CURSOR_WIDTH = CURSOR_SIZE;
const CURSOR_HEIGHT = CURSOR_SIZE;
const HOTSPOT_X = CURSOR_HOTSPOT;
const HOTSPOT_Y = CURSOR_HOTSPOT;
const GLIDE_FRAME_MS = 16;
const GLIDE_ZORDER_MS = 80;

interface CursorSurface {
  window: BrowserWindow | null;
  creating: Promise<BrowserWindow> | null;
  lastEventId: number;
  position?: { x: number; y: number };
  /** Where the virtual pointer was last drawn (DIP); the next glide starts here. */
  shown?: GlidePoint;
  glide?: { eventId: number; timer: ReturnType<typeof setInterval> };
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

function cursorBoundsDip(dip: GlidePoint): Electron.Rectangle {
  return {
    x: Math.round(dip.x - HOTSPOT_X),
    y: Math.round(dip.y - HOTSPOT_Y),
    width: CURSOR_WIDTH,
    height: CURSOR_HEIGHT,
  };
}

function cursorBounds(point: { x: number; y: number }): Electron.Rectangle {
  return cursorBoundsDip(dipPoint(point));
}

function displayAreaFor(dip: GlidePoint): Electron.Rectangle {
  try {
    return screen.getDisplayNearestPoint(dip).bounds;
  } catch {
    return { x: dip.x, y: dip.y, width: 0, height: 0 };
  }
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

  const ensureWindow = async (sessionId: string, surface: CursorSurface): Promise<BrowserWindow> => {
    if (surface.creating) return await surface.creating;
    if (surface.window && !surface.window.isDestroyed()) return surface.window;
    const creating = (async () => {
      const next = new BrowserWindow({
        ...cursorBounds(surface.position || { x: 0, y: 0 }),
        alwaysOnTop: false,
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
      // Own the native window immediately, including while its renderer is still loading.
      surface.window = next;
      const unregisterInternalWindow = registerComputerUseInternalWindow(next);
      let rejectCreation: ((error: Error) => void) | undefined;
      next.on('closed', () => {
        unregisterInternalWindow();
        if (surface.window === next) {
          surface.window = null;
          surface.creating = null;
        }
        rejectCreation?.(new Error('Computer Use cursor closed during creation'));
      });
      try {
        next.setTitle('');
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
        const retireRenderer = (stage: string): void => {
          recordCursorDiagnostic(stage);
          // Retire the dead surface. A fresh event or preparation creates its replacement;
          // never replay an old effect or loop on the same crashed renderer.
          if (!next.isDestroyed()) next.destroy();
        };
        next.webContents.on('render-process-gone', () => retireRenderer('renderer_gone'));
        next.on('unresponsive', () => retireRenderer('renderer_unresponsive'));
        const closed = new Promise<never>((_resolve, reject) => {
          rejectCreation = reject;
        });
        const assertCurrentSurface = (): void => {
          if (disposed || next.isDestroyed() || surfaces.get(sessionId) !== surface) {
            throw new Error('Computer Use cursor disposed during creation');
          }
        };
        await Promise.race([
          next.loadURL(`data:text/html;base64,${Buffer.from(cursorHtml()).toString('base64')}`),
          closed,
        ]);
        assertCurrentSurface();
        await Promise.race([next.webContents.executeJavaScript(cursorScript()), closed]);
        assertCurrentSurface();
        recordCursorDiagnostic('window_created');
        return next;
      } catch (error) {
        if (!next.isDestroyed()) next.destroy();
        throw error;
      } finally {
        rejectCreation = undefined;
      }
    })();
    surface.creating = creating;
    try {
      return await creating;
    } finally {
      if (surface.creating === creating) surface.creating = null;
    }
  };

  const stopGlide = (surface: CursorSurface): void => {
    if (!surface.glide) return;
    clearInterval(surface.glide.timer);
    surface.glide = undefined;
  };

  const applyEffect = async (
    window: BrowserWindow,
    cursor: ComputerUseCursorPresentation,
    effect: string
  ): Promise<void> => {
    const serialized = JSON.stringify({ ...cursor, effect }).replaceAll('<', '\\u003c');
    const evidence = await window.webContents.executeJavaScript(
      `(() => {
        if (typeof window.mixdogAgentCursor !== 'function') return { handler: false };
        window.mixdogAgentCursor(${serialized});
        const ring = document.getElementById('ring');
        return { handler: true, ring: Boolean(ring), opacity: ring ? Number(getComputedStyle(ring).opacity) : 0 };
      })()`
    );
    recordCursorDiagnostic(evidence?.handler ? 'handler_called' : 'handler_missing');
    recordCursorDiagnostic(evidence?.ring ? 'ring_present' : 'ring_missing');
    // Animated effects start their keyframes at zero opacity, so reading the
    // style in the same frame says nothing about whether they became visible.
    const animated = ['click', 'type', 'scroll', 'prepare'].includes(effect);
    const unseenRing = animated ? 'ring_animation_start' : 'ring_transparent_style';
    recordCursorDiagnostic(evidence?.opacity > 0 ? 'ring_visible_style' : unseenRing);
  };

  const pinAboveTarget = (window: BrowserWindow, windowId: string): void => {
    // Place only the feedback above its target, never raise or activate the target.
    window.moveAbove(`window:${BigInt(windowId.slice(5)).toString()}:0`);
  };

  const renderCursor = async (cursor: ComputerUseCursorPresentation): Promise<void> => {
    const surface = surfaceFor(cursor.sessionId);
    if (cursor.eventId <= surface.lastEventId) return;
    surface.lastEventId = cursor.eventId;
    stopGlide(surface);
    recordCursorDiagnostic('render_started');
    const source = { x: cursor.x, y: cursor.y };
    surface.position = source;
    const window = await ensureWindow(cursor.sessionId, surface);
    const current = (): boolean =>
      !disposed &&
      !window.isDestroyed() &&
      surfaces.get(cursor.sessionId) === surface &&
      surface.lastEventId === cursor.eventId &&
      visibleCursorEvents.get(cursor.sessionId) === cursor.eventId;
    if (!current()) {
      recordCursorDiagnostic('render_superseded');
      return;
    }
    const target = dipPoint(source);
    // A virtual pointer travels from where it was last drawn; the action effect
    // plays only once it has arrived, mirroring where the worker then acts.
    const plan = glideAllowed(cursor) ? planGlide(surface.shown, target, displayAreaFor(target)) : null;
    const start = plan ? glidePosition(plan, 0) : target;
    surface.shown = start;
    window.setBounds(cursorBoundsDip(start), false);
    await applyEffect(window, cursor, plan ? 'move' : cursor.effect);
    if (!current() || latestSnapshot.userControlActive) return;
    if (cursor.mode === 'background') {
      if (!cursor.windowId || !/^hwnd:0x[0-9a-f]+$/i.test(cursor.windowId)) {
        window.hide();
        throw new Error('background cursor requires an exact target window');
      }
      window.setAlwaysOnTop(false);
      try {
        if (!window.isVisible()) window.showInactive();
        pinAboveTarget(window, cursor.windowId);
      } catch (error) {
        window.hide();
        throw error;
      }
    } else {
      window.setAlwaysOnTop(true, 'screen-saver');
      if (!window.isVisible()) window.showInactive();
    }
    if (plan) {
      recordCursorDiagnostic('glide_started');
      const startedAt = Date.now();
      let lastPin = startedAt;
      const windowId = cursor.windowId as string;
      const timer = setInterval(() => {
        if (!current() || surface.glide?.timer !== timer) {
          clearInterval(timer);
          if (surface.glide?.timer === timer) surface.glide = undefined;
          recordCursorDiagnostic('glide_superseded');
          return;
        }
        const now = Date.now();
        const elapsed = now - startedAt;
        const point = glidePosition(plan, elapsed);
        surface.shown = point;
        window.setBounds(cursorBoundsDip(point), false);
        // The target may be restacked while the pointer travels; keep the feedback just above it.
        if (now - lastPin >= GLIDE_ZORDER_MS) {
          lastPin = now;
          try {
            pinAboveTarget(window, windowId);
          } catch {
            // A closed target ends the travel silently; the arrival check below decides visibility.
          }
        }
        if (!glideFinished(plan, elapsed)) return;
        clearInterval(timer);
        surface.glide = undefined;
        recordCursorDiagnostic('glide_completed');
        void applyEffect(window, cursor, cursor.effect).catch(() => {
          recordCursorDiagnostic('render_failed');
        });
      }, GLIDE_FRAME_MS);
      timer.unref?.();
      surface.glide = { eventId: cursor.eventId, timer };
    }
    recordCursorDiagnostic(window.isVisible() ? 'window_visible' : 'window_not_visible');
    const bounds = window.getBounds();
    const onDisplay = screen.getAllDisplays().some((display) => {
      const area = display.bounds;
      return (
        bounds.x < area.x + area.width &&
        bounds.x + bounds.width > area.x &&
        bounds.y < area.y + area.height &&
        bounds.y + bounds.height > area.y
      );
    });
    recordCursorDiagnostic(onDisplay ? 'window_on_display' : 'window_off_display');
  };

  const render = (): void => {
    if (disposed) return;
    const modes = new Map(latestSnapshot.activities.map((activity) => [activity.sessionId, activity.mode]));
    const cursors = tail.update(
      computerUseCursorPresentations(latestSnapshot),
      latestSnapshot.userControlActive || latestSnapshot.cleanupState === 'failed',
      modes
    );
    visibleCursorEvents = new Map(cursors.map((cursor) => [cursor.sessionId, cursor.eventId]));
    const desired = new Set(cursors.map((cursor) => cursor.sessionId));
    if (!latestSnapshot.userControlActive && latestSnapshot.cleanupState !== 'failed') {
      for (const activity of latestSnapshot.activities) {
        desired.add(activity.sessionId);
      }
    }
    for (const [sessionId, surface] of surfaces) {
      if (desired.has(sessionId)) {
        if (!visibleCursorEvents.has(sessionId)) {
          stopGlide(surface);
          if (surface.window && !surface.window.isDestroyed()) surface.window.hide();
        }
        continue;
      }
      stopGlide(surface);
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
  const unbindPreparation = bindCursorPreparation(async (sessionId) => {
    if (disposed || latestSnapshot.userControlActive || latestSnapshot.cleanupState === 'failed') {
      throw new Error('cursor presentation unavailable');
    }
    if (!latestSnapshot.activities.some((activity) => activity.sessionId === sessionId)) {
      throw new Error('cursor presentation requires an active session');
    }
    await ensureWindow(sessionId, surfaceFor(sessionId));
  });
  const reposition = (): void => {
    for (const surface of surfaces.values()) {
      if (!surface.position || !surface.window || surface.window.isDestroyed()) continue;
      stopGlide(surface);
      surface.shown = dipPoint(surface.position);
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
        stopGlide(surface);
        if (surface.window && !surface.window.isDestroyed()) surface.window.destroy();
      }
      surfaces.clear();
      visibleCursorEvents.clear();
      arrivals.clear();
    },
  };
}

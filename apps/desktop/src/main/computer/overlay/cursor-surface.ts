/**
 * One session's cursor window: a transparent, click-through, never-focused
 * BrowserWindow that draws the virtual pointer. It is owned the moment it is
 * created — even while its renderer still loads — so a dispose or a crash
 * midway retires it instead of leaking a stray window.
 */
import { BrowserWindow, screen } from 'electron';

import { nativeToDip } from '../shared/native-coordinates';
import { CURSOR_HOTSPOT, CURSOR_SIZE, cursorHtml, cursorScript } from './cursor-art';
import { recordCursorDiagnostic } from './cursor-diagnostics';
import type { GlidePoint } from './cursor-glide';
import { registerComputerUseInternalWindow } from './internal-windows';

export interface CursorSurface {
  window: BrowserWindow | null;
  creating: Promise<BrowserWindow> | null;
  lastEventId: number;
  position?: { x: number; y: number };
  /** Where the virtual pointer was last drawn (DIP); the next glide starts here. */
  shown?: GlidePoint;
  glide?: { eventId: number; timer: ReturnType<typeof setInterval> };
}

export function newCursorSurface(): CursorSurface {
  return { window: null, creating: null, lastEventId: 0 };
}

export function dipPoint(point: { x: number; y: number }): { x: number; y: number } {
  return nativeToDip(point);
}

export function cursorBoundsDip(dip: GlidePoint): Electron.Rectangle {
  return {
    x: Math.round(dip.x - CURSOR_HOTSPOT),
    y: Math.round(dip.y - CURSOR_HOTSPOT),
    width: CURSOR_SIZE,
    height: CURSOR_SIZE,
  };
}

export function cursorBounds(point: { x: number; y: number }): Electron.Rectangle {
  return cursorBoundsDip(dipPoint(point));
}

export function displayAreaFor(dip: GlidePoint): Electron.Rectangle {
  try {
    return screen.getDisplayNearestPoint(dip).bounds;
  } catch {
    return { x: dip.x, y: dip.y, width: 0, height: 0 };
  }
}

export function stopGlide(surface: CursorSurface): void {
  if (!surface.glide) return;
  clearInterval(surface.glide.timer);
  surface.glide = undefined;
}

/** What every Computer Use overlay surface has in common: never focusable,
 *  never in the taskbar, never painting a background of its own. */
export function overlayWindowOptions(): Electron.BrowserWindowConstructorOptions {
  return {
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
  };
}

function cursorWindowOptions(position: { x: number; y: number }): Electron.BrowserWindowConstructorOptions {
  return { ...cursorBounds(position), ...overlayWindowOptions() };
}

/** What every overlay window shares once created: untitled, hidden from screen
 *  capture, on every workspace, and never a window opener. */
export function hardenWindowSurface(next: BrowserWindow): void {
  next.setTitle('');
  next.setContentProtection(true);
  try {
    next.setVisibleOnAllWorkspaces(true, {
      skipTransformProcessType: true,
      visibleOnFullScreen: true,
    });
  } catch {
    // Best effort where workspace flags are unavailable.
  }
  next.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

/** Never focusable, never a target for input, never a window opener; a dead
 *  renderer retires the surface so a fresh event creates its replacement
 *  rather than replaying an old effect on the same crashed renderer. */
function hardenOverlayWindow(next: BrowserWindow): void {
  hardenWindowSurface(next);
  next.setIgnoreMouseEvents(true, { forward: true });
  const retireRenderer = (stage: string): void => {
    recordCursorDiagnostic(stage);
    if (!next.isDestroyed()) next.destroy();
  };
  next.webContents.on('render-process-gone', () => retireRenderer('renderer_gone'));
  next.on('unresponsive', () => retireRenderer('renderer_unresponsive'));
}

async function openCursorWindow(surface: CursorSurface, isCurrent: () => boolean): Promise<BrowserWindow> {
  const next = new BrowserWindow(cursorWindowOptions(surface.position || { x: 0, y: 0 }));
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
    hardenOverlayWindow(next);
    const closed = new Promise<never>((_resolve, reject) => {
      rejectCreation = reject;
    });
    const assertCurrentSurface = (): void => {
      if (!isCurrent() || next.isDestroyed()) {
        throw new Error('Computer Use cursor disposed during creation');
      }
    };
    await Promise.race([next.loadURL(`data:text/html;base64,${Buffer.from(cursorHtml()).toString('base64')}`), closed]);
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
}

/** The surface's live window, opening it once; concurrent callers share the
 *  creation. */
async function ensureSurfaceWindow(
  surface: { window: BrowserWindow | null; creating: Promise<BrowserWindow> | null },
  open: () => Promise<BrowserWindow>
): Promise<BrowserWindow> {
  if (surface.creating) return await surface.creating;
  if (surface.window && !surface.window.isDestroyed()) return surface.window;
  const creating = open();
  surface.creating = creating;
  try {
    return await creating;
  } finally {
    if (surface.creating === creating) surface.creating = null;
  }
}

/** `isCurrent` says whether the surface still belongs to the overlay. */
export function ensureCursorWindow(surface: CursorSurface, isCurrent: () => boolean): Promise<BrowserWindow> {
  return ensureSurfaceWindow(surface, () => openCursorWindow(surface, isCurrent));
}

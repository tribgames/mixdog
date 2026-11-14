/**
 * `host/computer/appWindows`: the desktop's own windows a session may read and drive, spelled as the helper spells
 * windows (`hwnd:0x..` on Windows, `cg:<n>` on macOS, `x11:0x..` on Linux). The cursor overlay, pill and screen
 * indicator are not listed: they stay in `host/computer/internalWindows`. `computer-app-input.ts` resolves the same
 * ids, so a window is app-owned for input exactly when it is listed here.
 */
import { BrowserWindow, screen } from 'electron';
import type {
  HostComputerAppWindow,
  HostComputerAppWindowKind,
  HostComputerAppWindowsResult,
  HostComputerBounds,
} from '../../../../../packages/protocol/src/index.ts';
import { nativeWindowNumber } from '../computer/observation/native-window-id';
import { listComputerUseInternalWindowIds } from '../computer/overlay/internal-windows';
import { dipToNative } from '../computer/shared/native-coordinates';
import type { HostConnection } from './connection';

export const HOST_COMPUTER_APP_WINDOWS = 'host/computer/appWindows';

/** The window's id as the native helper lists it; empty when the window has no native handle yet. */
export function appWindowId(window: BrowserWindow): string {
  const value = nativeWindowNumber(window);
  if (value <= 0n) return '';
  if (process.platform === 'darwin') return `cg:${value}`;
  return `${process.platform === 'win32' ? 'hwnd' : 'x11'}:0x${value.toString(16).toUpperCase()}`;
}

function normalized(id: string): string {
  return id.trim().toLowerCase();
}

/** The window's rectangle in native (physical) coordinates. */
export function appWindowBounds(window: BrowserWindow): HostComputerBounds {
  const bounds = window.getBounds();
  const topLeft = dipToNative({ x: bounds.x, y: bounds.y });
  const bottomRight = dipToNative({ x: bounds.x + bounds.width, y: bounds.y + bounds.height });
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: Math.max(0, bottomRight.x - topLeft.x),
    height: Math.max(0, bottomRight.y - topLeft.y),
  };
}

/** The windows of this process a session may drive: alive, with a native handle, and not one of the Computer Use
 *  overlay's own. */
export function appOwnedWindows(): Array<{ id: string; window: BrowserWindow }> {
  const internal = new Set(listComputerUseInternalWindowIds().map(normalized));
  const owned: Array<{ id: string; window: BrowserWindow }> = [];
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    const id = appWindowId(window);
    if (id && !internal.has(normalized(id))) owned.push({ id, window });
  }
  return owned;
}

/** The live window an id names, or `null` when the id is not an app-owned window. */
export function appWindowById(windowId: string): BrowserWindow | null {
  const wanted = normalized(windowId);
  if (!wanted) return null;
  return appOwnedWindows().find((entry) => normalized(entry.id) === wanted)?.window ?? null;
}

function appWindowKind(window: BrowserWindow): HostComputerAppWindowKind {
  return window.getParentWindow() ? 'aux' : 'main';
}

function describe(id: string, window: BrowserWindow): HostComputerAppWindow {
  const display = screen.getDisplayMatching(window.getBounds());
  return {
    windowId: id,
    kind: appWindowKind(window),
    title: window.getTitle(),
    bounds: appWindowBounds(window),
    scaleFactor: display.scaleFactor,
    displayId: String(display.id),
    focused: window.isFocused(),
  };
}

export function computerAppWindows(): HostComputerAppWindowsResult {
  const windows: HostComputerAppWindow[] = [];
  for (const { id, window } of appOwnedWindows()) {
    try {
      windows.push(describe(id, window));
    } catch {
      // A window destroyed since the enumeration is simply not listed.
    }
  }
  return { windows };
}

export function registerComputerAppWindows(connection: HostConnection): void {
  connection.handleRequest(HOST_COMPUTER_APP_WINDOWS, async () => computerAppWindows());
}

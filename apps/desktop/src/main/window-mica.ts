import { join } from 'node:path';
import type { BrowserWindow } from 'electron';

const WM_NCACTIVATE = 0x0086;
const WM_THEMECHANGED = 0x031a;
const WM_DWMCOLORIZATIONCOLORCHANGED = 0x0320;

/** The Node-API module built from native/mixdog-window; packaged in
 *  resources/native-tools. */
export const MICA_LIBRARY_FILE = 'mixdog_window.node';
/** What cargo names the same library in native/mixdog-window/target (the
 *  packaged copy is renamed by build.ps1); a dev build loads it from there. */
export const MICA_BUILD_FILE = 'mixdog_window.dll';

type MicaWindow = Pick<
  BrowserWindow,
  'getNativeWindowHandle' | 'hookWindowMessage' | 'isDestroyed' | 'isMinimized' | 'isVisible' | 'on' | 'once'
>;

export interface MicaNative {
  /** Paints the frame and backdrop active; not SetFocus/SetForegroundWindow. */
  activate(handle: bigint): void;
  /** Installs the native window procedure that answers every deactivation
   *  (WM_NCACTIVATE) as an activation before anything paints it. False when
   *  the library is unavailable or the window refused it. */
  keepActive(handle: bigint): boolean;
  /** Removes it; a no-op once the window's WM_NCDESTROY has removed it. */
  release(handle: bigint): void;
}

export type MicaReport = (event: string, details: Record<string, unknown>) => void;

export function micaLibraryPath(environment: { isPackaged: boolean; resourcesPath: string; appPath: string }): string {
  return environment.isPackaged
    ? join(environment.resourcesPath, 'native-tools', MICA_LIBRARY_FILE)
    : join(
        process.env.CARGO_TARGET_DIR ?? join(environment.appPath, '..', '..', 'native', 'mixdog-window', 'target'),
        'release',
        MICA_BUILD_FILE
      );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface MicaModule {
  install(hwnd: bigint): boolean;
  uninstall(hwnd: bigint): boolean;
  activate(hwnd: bigint): void;
}

/** Loads a Node-API module from any file name (the dev build keeps cargo's
 *  .dll name). */
function loadModule(library: string): MicaModule {
  const module = { exports: {} as MicaModule };
  process.dlopen(module as NodeJS.Module, library);
  return module.exports;
}

/** The native bindings: the Node-API module's three functions, nothing else.
 *  The library's functions are plain calls: nothing in it calls back into
 *  JavaScript. A module that fails to load (a stale dev build) leaves
 *  keepActive false and activate a no-op, and is reported as
 *  mica-native-unavailable. */
export function nativeMica(
  library: string,
  report: MicaReport,
  load: (library: string) => MicaModule = loadModule
): MicaNative {
  let native: MicaModule | undefined;
  try {
    native = load(library);
  } catch (error) {
    report('mica-native-unavailable', { library, message: errorMessage(error) });
  }
  return {
    activate(handle) {
      native?.activate(handle);
    },
    keepActive(handle) {
      if (!native) return false;
      if (native.install(handle)) return true;
      report('mica-native-install-failed', { library });
      return false;
    },
    release(handle) {
      native?.uninstall(handle);
    },
  };
}

/** Keep a Mica window's backdrop visually active without changing input focus.
 *  The caller limits this to supported Windows Mica windows.
 *  The window's messages never pass through a JavaScript window procedure:
 *  forwarding one is a foreign call, which runs on the callback stack, and the
 *  title-bar move and resize loops run Chromium's tasks inside it, where a V8
 *  garbage collection aborts the whole app (issue #325). The native library's
 *  window procedure keeps deactivations from painting at all; without it each
 *  one is repainted active right after it, a brief inactive blink. */
export function installMicaActiveAppearance(window: MicaWindow, native: MicaNative): void {
  // Both supported Windows architectures (x64 and arm64) have 64-bit HWNDs.
  const handle = window.getNativeWindowHandle().readBigUInt64LE();
  let pending: NodeJS.Immediate | undefined;
  let closed = false;

  // A window shown or restored without activation, or a theme change, repaints
  // the frame on its own; put the active appearance back after that, once.
  const schedule = () => {
    if (closed || pending) return;
    // Electron's hook observes the message before its normal handler. Apply
    // the appearance afterwards, otherwise that handler would overwrite it.
    pending = setImmediate(() => {
      pending = undefined;
      if (closed || window.isDestroyed() || window.isMinimized() || !window.isVisible()) return;
      native.activate(handle);
    });
  };

  const nativeActive = native.keepActive(handle);
  const messages = [WM_THEMECHANGED, WM_DWMCOLORIZATIONCOLORCHANGED];
  if (!nativeActive) messages.push(WM_NCACTIVATE);
  for (const message of messages) window.hookWindowMessage(message, schedule);
  window.on('show', schedule);
  window.on('restore', schedule);
  window.once('closed', () => {
    closed = true;
    if (pending) clearImmediate(pending);
    pending = undefined;
    // Electron owns and releases the message hooks when the HWND is destroyed;
    // the native procedure removes itself with WM_NCDESTROY.
    if (nativeActive) native.release(handle);
  });
  schedule();
}

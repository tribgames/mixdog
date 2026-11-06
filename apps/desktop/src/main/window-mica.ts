import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';

const WM_NCACTIVATE = 0x0086;
const WM_THEMECHANGED = 0x031a;
const WM_DWMCOLORIZATIONCOLORCHANGED = 0x0320;

/** Built from native/mixdog-window; packaged in resources/native-tools. */
export const MICA_LIBRARY_FILE = 'mixdog_window.dll';

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
        MICA_LIBRARY_FILE
      );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The native bindings. The library's functions are plain calls: nothing in
 *  it calls back into JavaScript. A library that fails to load leaves
 *  keepActive false and is reported. */
export function nativeMica(library: string, report: MicaReport): MicaNative {
  // Only the Windows 11 Mica path loads the native module.
  const koffi: typeof import('koffi') = createRequire(import.meta.url)('koffi');
  const defWindowProc = koffi
    .load('user32.dll')
    .func('intptr_t __stdcall DefWindowProcW(uintptr_t hwnd, uint32_t message, uintptr_t wParam, intptr_t lParam)');
  let install: ((hwnd: bigint) => boolean) | undefined;
  let uninstall: ((hwnd: bigint) => boolean) | undefined;
  try {
    const window = koffi.load(library);
    install = window.func('bool __stdcall install(uintptr_t hwnd)');
    uninstall = window.func('bool __stdcall uninstall(uintptr_t hwnd)');
  } catch (error) {
    report('mica-native-load-failed', { library, message: errorMessage(error) });
  }
  return {
    activate(handle) {
      // -1 prevents the native caption from being painted over our custom bar.
      defWindowProc(handle, WM_NCACTIVATE, 1, -1);
    },
    keepActive(handle) {
      if (!install) return false;
      if (install(handle)) return true;
      report('mica-native-install-failed', { library });
      return false;
    },
    release(handle) {
      uninstall?.(handle);
    },
  };
}

/** Keep a Mica window's backdrop visually active without changing input focus.
 *  The caller limits this to supported Windows Mica windows.
 *  The window's messages never pass through a JavaScript window procedure:
 *  forwarding one is a koffi call, which runs on koffi's own stack, and the
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

import { createRequire } from 'node:module';
import type { BrowserWindow } from 'electron';

const WM_NCACTIVATE = 0x0086;
const WM_THEMECHANGED = 0x031a;
const WM_DWMCOLORIZATIONCOLORCHANGED = 0x0320;

type MicaWindow = Pick<
  BrowserWindow,
  'getNativeWindowHandle' | 'hookWindowMessage' | 'isDestroyed' | 'isMinimized' | 'isVisible' | 'on' | 'once'
>;

export interface MicaNative {
  /** Paints the frame and backdrop active; not SetFocus/SetForegroundWindow. */
  activate(handle: bigint): void;
}

let shared: MicaNative | undefined;

/** The process-wide native binding, declared once and reused by every window. */
export function nativeMica(): MicaNative {
  if (shared) return shared;
  // Only the Windows 11 Mica path loads the native module.
  const koffi: typeof import('koffi') = createRequire(import.meta.url)('koffi');
  const defWindowProc = koffi
    .load('user32.dll')
    .func('intptr_t __stdcall DefWindowProcW(uintptr_t hwnd, uint32_t message, uintptr_t wParam, intptr_t lParam)');
  shared = {
    activate(handle) {
      // -1 prevents the native caption from being painted over our custom bar.
      defWindowProc(handle, WM_NCACTIVATE, 1, -1);
    },
  };
  return shared;
}

/** Keep a Mica window's backdrop visually active without changing input focus.
 *  The caller limits this to supported Windows Mica windows.
 *  The window's messages never pass through a JavaScript window procedure:
 *  forwarding one is a koffi call, which runs on koffi's own stack, and the
 *  title-bar move and resize loops run Chromium's tasks inside it, where a V8
 *  garbage collection aborts the whole app (issue #325). */
export function installMicaActiveAppearance(window: MicaWindow, native: MicaNative = nativeMica()): void {
  // Both supported Windows architectures (x64 and arm64) have 64-bit HWNDs.
  const handle = window.getNativeWindowHandle().readBigUInt64LE();
  let pending: NodeJS.Immediate | undefined;
  let closed = false;

  const schedule = () => {
    if (closed || pending) return;
    // Electron's hook observes the message before its normal handler. Apply
    // the appearance afterwards, otherwise deactivation would overwrite it.
    pending = setImmediate(() => {
      pending = undefined;
      if (closed || window.isDestroyed() || window.isMinimized() || !window.isVisible()) return;
      native.activate(handle);
    });
  };

  for (const message of [WM_NCACTIVATE, WM_THEMECHANGED, WM_DWMCOLORIZATIONCOLORCHANGED]) {
    window.hookWindowMessage(message, schedule);
  }
  window.on('show', schedule);
  window.on('restore', schedule);
  window.once('closed', () => {
    closed = true;
    if (pending) clearImmediate(pending);
    pending = undefined;
    // Electron owns and releases the message hooks when the HWND is destroyed.
  });
  schedule();
}

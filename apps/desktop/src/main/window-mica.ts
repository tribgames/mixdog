import { createRequire } from 'node:module';
import type { BrowserWindow } from 'electron';

const WM_NCACTIVATE = 0x0086;
const WM_THEMECHANGED = 0x031a;
const WM_DWMCOLORIZATIONCOLORCHANGED = 0x0320;

type MicaWindow = Pick<
  BrowserWindow,
  'getNativeWindowHandle' | 'hookWindowMessage' | 'isDestroyed' | 'isMinimized' | 'isVisible' | 'on' | 'once'
>;
const WM_NCDESTROY = 0x0082;
const SUBCLASS_ID = 0x4d494341; // 'MICA'

export interface MicaNative {
  /** Paints the frame and backdrop active; not SetFocus/SetForegroundWindow. */
  activate(handle: bigint): void;
  /** Rewrites each WM_NCACTIVATE the window receives through `rewrite` before
   *  any handler (Chromium's, DefWindowProc, DWM) sees it. Returns its removal,
   *  which is a no-op once the window's WM_NCDESTROY has removed it. */
  keepActive(handle: bigint, rewrite: (wParam: bigint) => bigint): () => void;
}

type Word = number | bigint;
export type SubclassProc = (hwnd: Word, message: number, wParam: Word, lParam: Word) => Word;

/** The user32/comctl32 calls behind MicaNative. `proc` is the native callback
 *  `register` returned. */
export interface MicaUser32 {
  defWindowProc(hwnd: bigint, message: number, wParam: Word, lParam: Word): unknown;
  setWindowSubclass(hwnd: bigint, proc: unknown, id: number, data: number): boolean;
  removeWindowSubclass(hwnd: bigint, proc: unknown, id: number): boolean;
  defSubclassProc(hwnd: bigint, message: number, wParam: Word, lParam: Word): Word;
  register(proc: SubclassProc): unknown;
}

/** WM_NCACTIVATE as an activation: its low word says active, its high word
 *  (set around minimize/restore) is kept. */
export function asActiveNcActivate(wParam: bigint): bigint {
  return (wParam & ~0xffffn) | 1n;
}

export function createMicaNative(api: MicaUser32): MicaNative {
  type Entry = { rewrite: (wParam: bigint) => bigint };
  const windows = new Map<bigint, Entry>();
  // One callback serves every window and stays registered for the process,
  // so no window can ever deliver a message to a released callback.
  let proc: unknown;
  const detach = (hwnd: bigint, entry: Entry) => {
    // A recycled HWND may already belong to a newer window.
    if (windows.get(hwnd) !== entry) return;
    api.removeWindowSubclass(hwnd, proc, SUBCLASS_ID);
    windows.delete(hwnd);
  };
  const dispatch: SubclassProc = (hwnd, message, wParam, lParam) => {
    const handle = BigInt(hwnd);
    const entry = windows.get(handle);
    const forwarded = entry && message === WM_NCACTIVATE ? entry.rewrite(BigInt(wParam)) : wParam;
    // MSDN: remove the subclass on WM_NCDESTROY, then still forward it.
    if (entry && message === WM_NCDESTROY) detach(handle, entry);
    return api.defSubclassProc(handle, message, forwarded, lParam);
  };
  return {
    activate(handle) {
      // -1 prevents the native caption from being painted over our custom bar.
      api.defWindowProc(handle, WM_NCACTIVATE, 1, -1);
    },
    keepActive(handle, rewrite) {
      proc ??= api.register(dispatch);
      const entry = { rewrite };
      windows.set(handle, entry);
      if (!api.setWindowSubclass(handle, proc, SUBCLASS_ID, 0)) {
        windows.delete(handle);
        throw new Error('Mica window subclass was refused');
      }
      return () => detach(handle, entry);
    },
  };
}

let shared: MicaNative | undefined;

/** The process-wide native bindings: koffi keeps named types globally, so
 *  they are declared once and reused by every window. */
export function nativeMica(): MicaNative {
  if (shared) return shared;
  // Only the Windows 11 Mica path loads the native module.
  const koffi: typeof import('koffi') = createRequire(import.meta.url)('koffi');
  const user32 = koffi.load('user32.dll');
  // Window subclassing lives in comctl32 (v6 under Electron's manifest).
  const comctl32 = koffi.load('comctl32.dll');
  const subclassProc = koffi.proto(
    'intptr_t __stdcall MixdogMicaSubclassProc(uintptr_t hwnd, uint32_t message, uintptr_t wParam, intptr_t lParam, uintptr_t id, uintptr_t data)'
  );
  const defWindowProc = user32.func(
    'intptr_t __stdcall DefWindowProcW(uintptr_t hwnd, uint32_t message, uintptr_t wParam, intptr_t lParam)'
  );
  const setWindowSubclass = comctl32.func(
    'bool __stdcall SetWindowSubclass(uintptr_t hwnd, MixdogMicaSubclassProc *proc, uintptr_t id, uintptr_t data)'
  );
  const removeWindowSubclass = comctl32.func(
    'bool __stdcall RemoveWindowSubclass(uintptr_t hwnd, MixdogMicaSubclassProc *proc, uintptr_t id)'
  );
  const defSubclassProc = comctl32.func(
    'intptr_t __stdcall DefSubclassProc(uintptr_t hwnd, uint32_t message, uintptr_t wParam, intptr_t lParam)'
  );
  shared = createMicaNative({
    defWindowProc,
    setWindowSubclass,
    removeWindowSubclass,
    defSubclassProc,
    register: (proc) => koffi.register(proc, koffi.pointer(subclassProc)),
  });
  return shared;
}

/** Keep a Mica window's backdrop visually active without changing input focus.
 *  The caller limits this to supported Windows Mica windows.
 *  A deactivation is answered as an activation before anything paints it, so
 *  the window never paints inactive at all. Repainting it active after the
 *  fact (once the inactive frame and backdrop had been drawn) made the window
 *  blink every time another window, such as a Computer Use target, came to
 *  the front. Input activation itself (WM_ACTIVATE, focus, blur) is untouched. */
export function installMicaActiveAppearance(window: MicaWindow, native: MicaNative = nativeMica()): void {
  // Both supported Windows architectures (x64 and arm64) have 64-bit HWNDs.
  const handle = window.getNativeWindowHandle().readBigUInt64LE();
  let pending: NodeJS.Immediate | undefined;
  let closed = false;

  // A shown, theme-changed or restored window repaints its backdrop on its own;
  // put the active appearance back after that, once.
  const schedule = () => {
    if (closed || pending) return;
    pending = setImmediate(() => {
      pending = undefined;
      if (closed || window.isDestroyed() || window.isMinimized() || !window.isVisible()) return;
      native.activate(handle);
    });
  };

  // MSDN: a minimized window's activation change goes through unchanged.
  const release = native.keepActive(handle, (wParam) =>
    closed || window.isDestroyed() || window.isMinimized() ? wParam : asActiveNcActivate(wParam)
  );
  for (const message of [WM_THEMECHANGED, WM_DWMCOLORIZATIONCOLORCHANGED]) {
    window.hookWindowMessage(message, schedule);
  }
  window.on('show', schedule);
  window.on('restore', schedule);
  window.once('closed', () => {
    closed = true;
    if (pending) clearImmediate(pending);
    pending = undefined;
    // Electron owns and releases the message hooks when the HWND is destroyed.
    // The subclass normally went with WM_NCDESTROY; this covers any other path.
    release();
  });
  schedule();
}

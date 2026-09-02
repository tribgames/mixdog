/**
 * Resolving an exact native window id to the app's own BrowserWindow. It lives
 * apart from the shared constants so pure observation code can import those
 * without pulling Electron into a plain Node test.
 */
import { BrowserWindow } from 'electron';

export function electronWindowForNativeId(windowId: string | undefined): BrowserWindow | null {
  const raw = String(windowId || '')
    .trim()
    .replace(/^hwnd:/i, '')
    .replace(/^0x/i, '');
  if (!/^[0-9a-f]+$/i.test(raw)) return null;
  const expected = BigInt(`0x${raw}`);
  try {
    return BrowserWindow.getAllWindows().find((candidate) => {
      if (candidate.isDestroyed()) return false;
      const handle = candidate.getNativeWindowHandle();
      let value = 0n;
      for (let index = handle.length - 1; index >= 0; index -= 1) {
        value = (value << 8n) | BigInt(handle[index] ?? 0);
      }
      return value === expected;
    }) ?? null;
  } catch {
    return null;
  }
}

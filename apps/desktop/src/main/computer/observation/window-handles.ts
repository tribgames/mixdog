import { BrowserWindow } from 'electron';
import { nativeWindowNumber } from './native-window-id';

export function electronWindowForNativeId(windowId: string | undefined): BrowserWindow | null {
  const raw = String(windowId || '')
    .trim()
    .replace(/^hwnd:/i, '')
    .replace(/^0x/i, '');
  if (!/^[0-9a-f]+$/i.test(raw)) return null;
  const expected = BigInt(`0x${raw}`);
  try {
    return (
      BrowserWindow.getAllWindows().find(
        (candidate) => !candidate.isDestroyed() && nativeWindowNumber(candidate) === expected
      ) ?? null
    );
  } catch {
    return null;
  }
}

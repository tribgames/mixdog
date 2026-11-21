import type { BrowserWindow } from 'electron';

export type NativeWindowSource = Pick<BrowserWindow, 'getNativeWindowHandle' | 'getMediaSourceId'>;

/** On macOS the native handle is an NSView pointer while the backend lists CGWindowIDs, which Electron's media source id (`window:<id>:0`) carries. */
export function nativeWindowNumber(window: NativeWindowSource): bigint {
  if (process.platform === 'darwin') {
    const match = /^window:(\d+):/.exec(window.getMediaSourceId());
    return match ? BigInt(match[1]) : 0n;
  }
  const handle = window.getNativeWindowHandle();
  if (!Buffer.isBuffer(handle) || handle.length < 4) return 0n;
  return handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));
}

/** The id used by the native backend and the app-window protocol. */
export function nativeWindowId(window: NativeWindowSource): string {
  const value = nativeWindowNumber(window);
  if (value <= 0n) return '';
  if (process.platform === 'darwin') return `cg:${value}`;
  return `${process.platform === 'win32' ? 'hwnd' : 'x11'}:0x${value.toString(16).toUpperCase()}`;
}

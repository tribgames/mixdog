import type { BrowserWindow } from 'electron';

export type NativeWindowSource = Pick<BrowserWindow, 'getNativeWindowHandle' | 'getMediaSourceId'>;

/** The number the native backend names this window by (`hwnd:0x…`). Windows
 *  and Linux list the platform handle itself; on macOS the handle is an NSView
 *  pointer while the backend lists CGWindowIDs, which Electron's media source
 *  id (`window:<id>:0`) carries. */
export function nativeWindowNumber(window: NativeWindowSource): bigint {
  if (process.platform === 'darwin') {
    const match = /^window:(\d+):/.exec(window.getMediaSourceId());
    return match ? BigInt(match[1]) : 0n;
  }
  const handle = window.getNativeWindowHandle();
  if (!Buffer.isBuffer(handle) || handle.length < 4) return 0n;
  return handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));
}

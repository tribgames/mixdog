import type { BrowserWindow } from 'electron';

const internalWindowIds = new Set<string>();

function normalizedWindowId(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

function nativeWindowId(window: Pick<BrowserWindow, 'getNativeWindowHandle'>): string {
  const handle = window.getNativeWindowHandle();
  if (!Buffer.isBuffer(handle) || handle.length < 4) return '';
  const value = handle.length >= 8
    ? handle.readBigUInt64LE(0)
    : BigInt(handle.readUInt32LE(0));
  return value > 0n ? `hwnd:0x${value.toString(16).toUpperCase()}` : '';
}

export function registerComputerUseInternalWindow(
  window: Pick<BrowserWindow, 'getNativeWindowHandle'>,
): () => void {
  const id = normalizedWindowId(nativeWindowId(window));
  if (!id) return () => {};
  internalWindowIds.add(id);
  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    internalWindowIds.delete(id);
  };
}

export function filterComputerUseInternalWindows<T>(windows: readonly T[]): T[] {
  return windows.filter((window) => {
    const id = normalizedWindowId((window as { id?: unknown })?.id);
    return !id || !internalWindowIds.has(id);
  });
}

export function filterComputerUseWindowListText(
  value: unknown,
  windows: readonly unknown[],
): string {
  const text = String(value || '');
  const lines = text.split(/\r?\n/);
  if (lines[0] !== 'Windows:') return text;
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const visibleIds = new Set(
    windows
      .map((window) => normalizedWindowId((window as { id?: unknown })?.id))
      .filter(Boolean),
  );
  const visibleLines = lines.slice(1).filter((line) => {
    const separator = line.indexOf(' |');
    if (separator < 0) return false;
    return visibleIds.has(normalizedWindowId(line.slice(0, separator)));
  });
  return visibleLines.length > 0
    ? ['Windows:', ...visibleLines].join(newline)
    : 'No windows found.';
}

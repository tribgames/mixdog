import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';

export const DESKTOP_BACKGROUND_COLOR = '#080808';

const titleBarOverlay = Object.freeze({
  color: '#00000000',
  symbolColor: '#e5e5e5',
  height: 36,
});

function themeId(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const record = value as { id?: unknown; value?: unknown };
  return record.id === undefined ? themeId(record.value) : String(record.id);
}

export function setDesktopTitleBarTheme(
  window: Pick<BrowserWindow, 'setTitleBarOverlay'>,
  value: unknown,
): void {
  if (process.platform !== 'win32') return;
  window.setTitleBarOverlay({
    ...titleBarOverlay,
    symbolColor: themeId(value) === 'light' ? '#202020' : '#e5e5e5',
  });
}

const webPreferences = Object.freeze({
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
});

// Shared by the real entry and the excluded capture harness so evidence uses
// the same immutable window/chrome/security settings as production.
export const DESKTOP_WINDOW_OPTIONS = Object.freeze({
  width: 1280,
  height: 820,
  minWidth: 640,
  minHeight: 600,
  show: false,
  autoHideMenuBar: true,
  titleBarStyle: 'hidden',
  titleBarOverlay: process.platform === 'win32' ? titleBarOverlay : false,
  backgroundColor: DESKTOP_BACKGROUND_COLOR,
  webPreferences,
}) satisfies Readonly<BrowserWindowConstructorOptions>;

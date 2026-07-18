import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';

export const DESKTOP_BACKGROUND_COLOR = '#080808';
export const DESKTOP_LIGHT_BACKGROUND_COLOR = '#fafafa';
export const DESKTOP_TITLEBAR_HEIGHT = 40;

type DesktopTitleBarWindow = Pick<BrowserWindow, 'setBackgroundColor' | 'setTitleBarOverlay'>;

const titleBarThemes = new WeakMap<object, boolean>();
const titleBarZoomFactors = new WeakMap<object, number>();

function titleBarOverlay(light = false, zoom = 1) {
  return {
    color: '#00000000',
    symbolColor: light ? 'black' : 'white',
    height: Math.max(DESKTOP_TITLEBAR_HEIGHT, Math.round(DESKTOP_TITLEBAR_HEIGHT * zoom)),
  };
}

const defaultTitleBarOverlay = Object.freeze(titleBarOverlay());

function themeId(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const record = value as { id?: unknown; value?: unknown };
  return record.id === undefined ? themeId(record.value) : String(record.id);
}

export function setDesktopTitleBarTheme(
  window: DesktopTitleBarWindow,
  value: unknown,
): void {
  const light = themeId(value) === 'light';
  titleBarThemes.set(window as object, light);
  window.setBackgroundColor(light ? DESKTOP_LIGHT_BACKGROUND_COLOR : DESKTOP_BACKGROUND_COLOR);
  if (process.platform !== 'win32') return;
  window.setTitleBarOverlay(titleBarOverlay(
    light,
    titleBarZoomFactors.get(window as object) ?? 1,
  ));
}

export function setDesktopTitleBarZoom(window: DesktopTitleBarWindow, zoom: number): void {
  const normalized = Number.isFinite(zoom) ? Math.min(10, Math.max(0.2, zoom)) : 1;
  titleBarZoomFactors.set(window as object, normalized);
  if (process.platform !== 'win32') return;
  window.setTitleBarOverlay(titleBarOverlay(
    titleBarThemes.get(window as object) ?? false,
    normalized,
  ));
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
  ...(process.platform === 'win32'
    ? { frame: false, titleBarOverlay: defaultTitleBarOverlay }
    : { titleBarOverlay: false }),
  backgroundColor: DESKTOP_BACKGROUND_COLOR,
  webPreferences,
}) satisfies Readonly<BrowserWindowConstructorOptions>;

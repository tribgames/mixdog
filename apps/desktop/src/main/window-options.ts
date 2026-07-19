import { readFileSync, writeFile } from 'node:fs';

import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';

export const DESKTOP_BACKGROUND_COLOR = '#201e1c';
/* Light window band (warm neutral set) — must track --oc-window-band. */
export const DESKTOP_LIGHT_BACKGROUND_COLOR = '#f1efec';
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
  // Remember the applied band for the NEXT launch: the window constructor
  // reads it so a light-theme start never flashes the dark default band
  // (user-reported titlebar/tab pop right after launch).
  if (titleBarThemePersistPath) {
    writeFile(titleBarThemePersistPath, light ? 'light' : 'dark', () => { /* best effort */ });
  }
  if (process.platform !== 'win32') return;
  window.setTitleBarOverlay(titleBarOverlay(
    light,
    titleBarZoomFactors.get(window as object) ?? 1,
  ));
}

let titleBarThemePersistPath: string | null = null;

export function configureTitleBarThemePersistence(path: string): void {
  titleBarThemePersistPath = path;
}

/** Constructor overrides for the persisted theme (empty when dark/unknown). */
export function initialTitleBarWindowOverrides(): Partial<BrowserWindowConstructorOptions> {
  if (!titleBarThemePersistPath) return {};
  let light = false;
  try {
    light = readFileSync(titleBarThemePersistPath, 'utf8').trim() === 'light';
  } catch {
    return {};
  }
  if (!light) return {};
  return {
    backgroundColor: DESKTOP_LIGHT_BACKGROUND_COLOR,
    ...(process.platform === 'win32' ? { titleBarOverlay: titleBarOverlay(true) } : {}),
  };
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
  /* First-install layout (user reference): a compact ~1040×700 window with
     the sidebar open and the dock closed. Later launches restore the saved
     bounds via window-state. */
  width: 1040,
  height: 700,
  /* 880 keeps the window ABOVE the ≤760px mobile-overlay band (sidebar
     backdrop over the workspace) and the 760–860 squeeze zone that broke
     the layout when users shrank the window. */
  minWidth: 880,
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

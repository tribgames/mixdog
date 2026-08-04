import { readFileSync, writeFile } from 'node:fs';

import * as electron from 'electron';
import type { BrowserWindow, BrowserWindowConstructorOptions, NativeTheme } from 'electron';
import { DESKTOP_WINDOW_MIN_WIDTH } from '../shared/window-layout';

export const DESKTOP_BACKGROUND_COLOR = '#181818';
/* Light window band (warm neutral set) — must track --mx-window-band. */
export const DESKTOP_LIGHT_BACKGROUND_COLOR = '#f1efec';
export const DESKTOP_TITLEBAR_HEIGHT = 35;

type DesktopTitleBarWindow = Pick<BrowserWindow, 'setBackgroundColor' | 'setTitleBarOverlay'>;

const titleBarThemes = new WeakMap<object, boolean>();
const titleBarZoomFactors = new WeakMap<object, number>();
/** Scrim-composited caption colors while a fullscreen modal dims the app. */
export type DesktopTitleBarDim = { color: string; symbolColor: string };
const titleBarDims = new WeakMap<object, DesktopTitleBarDim>();

// DWM paints the frame pixels exposed while the user enlarges the window
// BEFORE Chromium presents a frame there. Without a native theme hint a
// light-OS machine fills that band with the system white brush under a dark
// app (user-reported white frame while widening). 'system' keeps the OS in
// charge so the renderer's prefers-color-scheme tracking stays truthful.
// Namespace access instead of a named import: in plain-node test contexts the
// electron package resolves to a path string and has no nativeTheme export.
const nativeTheme: NativeTheme | undefined =
  (electron as { nativeTheme?: NativeTheme }).nativeTheme;

function pinNativeThemeSource(source: 'system' | 'light' | 'dark'): void {
  if (nativeTheme) nativeTheme.themeSource = source;
}

function titleBarOverlay(light = false, zoom = 1) {
  return {
    // Keep the native controls region opaque: Windows may expose this surface
    // before Chromium repaints newly revealed pixels during maximize/restore.
    color: light ? DESKTOP_LIGHT_BACKGROUND_COLOR : DESKTOP_BACKGROUND_COLOR,
    symbolColor: light ? 'black' : 'white',
    height: Math.max(DESKTOP_TITLEBAR_HEIGHT, Math.round(DESKTOP_TITLEBAR_HEIGHT * zoom)),
  };
}

const defaultTitleBarOverlay = Object.freeze(titleBarOverlay());

function currentTitleBarOverlay(window: DesktopTitleBarWindow) {
  const base = titleBarOverlay(
    titleBarThemes.get(window as object) ?? false,
    titleBarZoomFactors.get(window as object) ?? 1,
  );
  const dim = titleBarDims.get(window as object);
  return dim ? { ...base, color: dim.color, symbolColor: dim.symbolColor } : base;
}

function themeId(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const record = value as { id?: unknown; value?: unknown };
  return record.id === undefined ? themeId(record.value) : String(record.id);
}

export function setDesktopTitleBarTheme(
  window: DesktopTitleBarWindow,
  value: unknown,
  systemPreference = false,
): void {
  const light = themeId(value) === 'light';
  titleBarThemes.set(window as object, light);
  pinNativeThemeSource(systemPreference ? 'system' : light ? 'light' : 'dark');
  window.setBackgroundColor(light ? DESKTOP_LIGHT_BACKGROUND_COLOR : DESKTOP_BACKGROUND_COLOR);
  // Remember the applied band for the NEXT launch: the window constructor
  // reads it so a light-theme start never flashes the dark default band
  // (user-reported titlebar/tab pop right after launch).
  if (titleBarThemePersistPath) {
    writeFile(
      titleBarThemePersistPath,
      systemPreference ? 'system' : light ? 'light' : 'dark',
      () => { /* best effort */ },
    );
  }
  if (process.platform !== 'win32') return;
  window.setTitleBarOverlay(currentTitleBarOverlay(window));
}

/** The WCO caption controls are NATIVE: DOM scrims cannot cover them, so a
 *  fullscreen modal used to dim everything EXCEPT the min/max/close band
 *  (user: 딤드도 안 먹고 색도 튀던데). The renderer sends the composited
 *  scrim-over-band colors while a modal is open; null restores the theme. */
export function setDesktopTitleBarDim(
  window: DesktopTitleBarWindow,
  dim: DesktopTitleBarDim | null,
): void {
  if (dim) titleBarDims.set(window as object, dim);
  else titleBarDims.delete(window as object);
  if (process.platform !== 'win32') return;
  window.setTitleBarOverlay(currentTitleBarOverlay(window));
}

let titleBarThemePersistPath: string | null = null;

export function configureTitleBarThemePersistence(path: string): void {
  titleBarThemePersistPath = path;
}

/** Constructor overrides for the persisted theme (empty when dark/unknown). */
export function initialTitleBarWindowOverrides(): Partial<BrowserWindowConstructorOptions> {
  if (!titleBarThemePersistPath) return {};
  let persisted = '';
  try {
    persisted = readFileSync(titleBarThemePersistPath, 'utf8').trim();
  } catch {
    persisted = '';
  }
  // Pin DWM's frame theme BEFORE the window exists so even the first enlarge
  // never exposes the OS light brush under the default dark band.
  pinNativeThemeSource(persisted === 'system' || persisted === 'light' ? persisted : 'dark');
  const light = persisted === 'light' ||
    (persisted === 'system' && !nativeThemePrefersDark());
  if (!light) return {};
  return {
    backgroundColor: DESKTOP_LIGHT_BACKGROUND_COLOR,
    ...(process.platform === 'win32' ? { titleBarOverlay: titleBarOverlay(true) } : {}),
  };
}

function nativeThemePrefersDark(): boolean {
  return nativeTheme ? nativeTheme.shouldUseDarkColors : true;
}

export function setDesktopTitleBarZoom(window: DesktopTitleBarWindow, zoom: number): void {
  const normalized = Number.isFinite(zoom) ? Math.min(10, Math.max(0.2, zoom)) : 1;
  titleBarZoomFactors.set(window as object, normalized);
  if (process.platform !== 'win32') return;
  window.setTitleBarOverlay(currentTitleBarOverlay(window));
}

const webPreferences = Object.freeze({
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  // Enables Chromium's sandboxed built-in PDF viewer for editor previews.
  plugins: true,
});

// Shared by the real entry and the excluded capture harness so evidence uses
// the same immutable window/chrome/security settings as production.
export const DESKTOP_WINDOW_OPTIONS = Object.freeze({
  /* First-install layout (user reference): a compact ~1040×700 window with
     the sidebar open and the dock closed. Later launches restore the saved
     bounds via window-state. */
  width: 1040,
  height: 700,
  /* The side panels shrink from their preferred widths to their own floors;
     stop once sidebar + workspace + dock + shell spacing reach that floor. */
  minWidth: DESKTOP_WINDOW_MIN_WIDTH,
  minHeight: 600,
  show: false,
  autoHideMenuBar: true,
  titleBarStyle: 'hidden',
  ...(process.platform === 'win32'
    // `hidden` + Window Controls Overlay already provides the custom chrome.
    // Retaining the native frame keeps Windows' DWM maximize/restore path and
    // avoids the white edge exposed by fully frameless BrowserWindows.
    ? { frame: true, titleBarOverlay: defaultTitleBarOverlay }
    : { titleBarOverlay: false }),
  backgroundColor: DESKTOP_BACKGROUND_COLOR,
  webPreferences,
}) satisfies Readonly<BrowserWindowConstructorOptions>;

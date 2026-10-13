import {
  DESKTOP_THEME_PREFERENCE_KEY,
  readHostDisplayPreferences,
  type HostDisplayPreferences,
} from '../shared/host-display-preferences';
import { UI_LANGUAGE_STORAGE_KEY, selectUiLanguage } from '../shared/ui-language';

interface HostDisplayWindow {
  isDestroyed(): boolean;
  webContents: { executeJavaScript(code: string): Promise<unknown> };
}

/** The theme and UI language the host PC's own window uses. Both live only in
 *  that window's localStorage, so it is asked; a window that is gone or still
 *  loading answers "unknown" rather than guessing. */
export async function readHostWindowDisplayPreferences(
  window: HostDisplayWindow | null,
  fallbackLocale: string
): Promise<HostDisplayPreferences | null> {
  if (!window || window.isDestroyed()) return null;
  try {
    const raw = await window.webContents.executeJavaScript(
      `(() => { let theme = null; let language = null; try { theme = localStorage.getItem(${JSON.stringify(DESKTOP_THEME_PREFERENCE_KEY)}); language = localStorage.getItem(${JSON.stringify(UI_LANGUAGE_STORAGE_KEY)}); } catch {} return { theme, language, locales: navigator.languages?.length ? Array.from(navigator.languages) : [navigator.language] }; })()`
    );
    const { theme, language, locales } = (raw ?? {}) as { theme?: unknown; language?: unknown; locales?: unknown };
    const systemLocales = Array.isArray(locales) && locales.length ? locales.map(String) : [fallbackLocale];
    return readHostDisplayPreferences({ theme, language: selectUiLanguage(language, systemLocales) });
  } catch {
    return null;
  }
}

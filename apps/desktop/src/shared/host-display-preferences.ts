import { SUPPORTED_UI_LANGUAGES, type UiLanguage } from './ui-language';

/** localStorage key of the desktop theme preference (renderer + host reader). */
export const DESKTOP_THEME_PREFERENCE_KEY = 'mixdog.desktop-theme-preference';

/** What the host PC's own window currently shows, for paired browsers that
 *  have not chosen a theme/language on their own device. `null` = unknown. */
export interface HostDisplayPreferences {
  /** Raw stored theme preference; the receiver validates it against its registry. */
  theme: string | null;
  /** The language the host PC's UI resolved to. */
  language: UiLanguage | null;
}

export function readHostDisplayPreferences(value: unknown): HostDisplayPreferences | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const theme = typeof record.theme === 'string' ? record.theme.trim() : '';
  const language = SUPPORTED_UI_LANGUAGES.find((entry) => entry.value === record.language)?.value ?? null;
  return { theme: theme && theme.length <= 64 ? theme : null, language };
}

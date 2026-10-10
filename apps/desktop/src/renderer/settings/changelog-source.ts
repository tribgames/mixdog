import changelogSource from '../../../../../CHANGELOG.md?raw';
import { type UiLanguage, uiFormatLocale } from '../i18n';
import { type ChangelogRelease, localizeReleases, parseChangelog } from './changelog';

// Locale files stay out of the main bundle: each is its own lazy chunk,
// fetched only when that language's changelog is opened.
const LOCALE_FILES = import.meta.glob('../../../../../changelog/*.md', {
  query: '?raw',
  import: 'default',
}) as Record<string, () => Promise<string>>;

const localeLoader = (language: UiLanguage) =>
  Object.entries(LOCALE_FILES).find(([path]) => path.endsWith(`/${language}.md`))?.[1];

/** Releases in the current UI language, English for versions the locale file lacks. */
export async function loadReleases(language: UiLanguage = uiFormatLocale()): Promise<ChangelogRelease[]> {
  const english = parseChangelog(changelogSource);
  const load = language === 'en' ? undefined : localeLoader(language);
  if (!load) return english;
  try {
    return localizeReleases(english, parseChangelog(await load()));
  } catch {
    return english;
  }
}

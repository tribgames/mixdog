// Who decided this device's theme / UI language: the user here ('local') or the
// host PC this browser follows ('host'). A paired browser only adopts the host's
// choice while the setting is not a local one.
//
// Values stored BEFORE this marker existed carry no source. They count as a local
// choice only when they differ from the default (theme other than 'dark', any
// explicit UI language): a default-looking value was most likely never chosen, and
// treating it as a choice would pin every existing browser to its defaults.
const SOURCE_KEY = 'mixdog.display-preference-source.v1';

export type DisplaySetting = 'theme' | 'language';
type Source = 'local' | 'host';

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readSources(): Partial<Record<DisplaySetting, Source>> {
  try {
    const parsed = JSON.parse(storage()?.getItem(SOURCE_KEY) || '{}') as Record<string, unknown>;
    const sources: Partial<Record<DisplaySetting, Source>> = {};
    for (const setting of ['theme', 'language'] as const) {
      if (parsed[setting] === 'local' || parsed[setting] === 'host') sources[setting] = parsed[setting];
    }
    return sources;
  } catch {
    return {};
  }
}

function writeSource(setting: DisplaySetting, source: Source): void {
  try {
    const sources = readSources();
    sources[setting] = source;
    storage()?.setItem(SOURCE_KEY, JSON.stringify(sources));
  } catch {
    /* storage-less hosts keep no marker; the value itself is then not persisted either */
  }
}

export function markLocalDisplayChoice(setting: DisplaySetting): void {
  writeSource(setting, 'local');
}

/** Also how a device returns to following the host: the value is replaced on the next sync. */
export function markHostDisplayChoice(setting: DisplaySetting): void {
  writeSource(setting, 'host');
}

/** `storedValueIsNonDefault` decides pre-marker values (see the header). */
export function hasLocalDisplayChoice(setting: DisplaySetting, storedValueIsNonDefault: boolean): boolean {
  const source = readSources()[setting];
  return source ? source === 'local' : storedValueIsNonDefault;
}

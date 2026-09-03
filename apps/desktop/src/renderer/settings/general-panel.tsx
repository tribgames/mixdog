import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  desktopThemeOptions,
  desktopThemePreferenceForTheme,
  getDesktopThemePreference,
  setDesktopThemePreference,
  type DesktopThemePreference,
} from '../desktop-theme';
import {
  getUiLanguagePreference,
  resolveUiLanguage,
  setUiLanguagePreference,
  SUPPORTED_UI_LANGUAGES,
  t,
  type UiLanguagePreference,
} from '../i18n';
import { record } from '../record-utils';
import {
  getSidePanelMode,
  setSidePanelMode,
  subscribeSidePanelMode,
  type SidePanelMode,
} from '../side-panel-preferences';
import {
  AutoSaveRow,
  Group,
  SelectRow,
  ToggleRow,
} from './capability-controls';
import {
  label,
  rows,
  type PanelContext,
} from './capability-data';
import { PushNotificationToggle } from './push-notification-toggle';

function ThemeChoices({ data, pending }: Pick<PanelContext, 'data' | 'pending'>) {
  const loadedTheme = String(data.theme || 'basic');
  const [preference, setPreference] = useState<DesktopThemePreference>(() =>
    getDesktopThemePreference() || desktopThemePreferenceForTheme(loadedTheme));
  useEffect(() => {
    setPreference(getDesktopThemePreference() || desktopThemePreferenceForTheme(loadedTheme));
  }, [loadedTheme]);
  const choose = (next: string) => {
    const selected = next as DesktopThemePreference;
    setPreference(selected);
    setDesktopThemePreference(selected);
  };
  return <Group title="Theme">
    <SelectRow title="Theme" value={preference} disabled={Boolean(pending)}
      options={desktopThemeOptions()}
      onChange={choose} />
  </Group>;
}

function UiLanguageChoices({ pending }: Pick<PanelContext, 'pending'>) {
  const [preference, setPreference] = useState<UiLanguagePreference>(() =>
    getUiLanguagePreference());
  return <Group title="Display language">
    <SelectRow title="Display language" value={preference} disabled={Boolean(pending)}
      options={[
        { value: 'system', label: 'System default' },
        ...SUPPORTED_UI_LANGUAGES,
      ]}
      onChange={(next) => {
        const selected = next as UiLanguagePreference;
        const previous = resolveUiLanguage();
        setPreference(selected);
        setUiLanguagePreference(selected);
        if (resolveUiLanguage(selected) !== previous) window.location.reload();
      }} />
  </Group>;
}

function SidePanelChoices({ pending }: Pick<PanelContext, 'pending'>) {
  const configuredMode = useSyncExternalStore(
    subscribeSidePanelMode,
    getSidePanelMode,
    () => 'close-both',
  );
  const narrow = window.matchMedia?.('(max-width: 760px)').matches === true;
  const mode = narrow ? 'close-both' : configuredMode;
  return <Group title="Side panels">
    <SelectRow title="Side panels" value={mode} disabled={Boolean(pending) || narrow}
      options={[
        { value: 'close-left', label: 'Left closed' },
        { value: 'close-right', label: 'Right closed' },
        { value: 'close-both', label: 'Both closed' },
        { value: 'keep-open', label: 'Keep open' },
      ]}
      onChange={(next) => setSidePanelMode(next as SidePanelMode)} />
  </Group>;
}

export function GeneralPanel({ data, pending, run, api }: PanelContext) {
  const profile = record(data.profile);
  const webSearchModule = record(record(data.toolModules).webSearch);
  const languageOptions = rows(profile.languages).map((entry) => ({
    value: String(entry.id || entry.value || 'system'),
    label: label(entry),
  }));
  const experienceLevelOptions = rows(profile.experienceLevels).map((entry) => ({
    value: String(entry.id || entry.value || ''),
    label: label(entry),
  }));
  const busy = Boolean(pending);
  return <>
    <Group title="Profile">
      <AutoSaveRow title="Title" name="title" value={String(profile.title || '')}
        placeholder="Your name or role" disabled={busy}
        onSave={(title) => void run('setProfile', [{ title }])} />
      <SelectRow title="Language" value={String(profile.language || 'system')} disabled={busy}
        options={languageOptions}
        onChange={(language) => void run('setProfile', [{ language }])} />
      <SelectRow title="Experience level" value={String(profile.experienceLevel || '')}
        disabled={busy} options={experienceLevelOptions}
        onChange={(experienceLevel) => void run('setProfile', [{ experienceLevel }])} />
    </Group>
    <Group title="Features">
      <ToggleRow title="Web search"
        description={t('Expose web search and web fetch tools to new sessions.')}
        checked={webSearchModule.enabled !== false} disabled={busy}
        onChange={(enabled) => void run('setWebSearchEnabled', [enabled])} />
    </Group>
    <PushNotificationToggle api={api} />
    <UiLanguageChoices pending={pending} />
    <ThemeChoices data={data} pending={pending} />
    <SidePanelChoices pending={pending} />
  </>;
}

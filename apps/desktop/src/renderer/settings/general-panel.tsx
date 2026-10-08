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
import { AutoSaveRow, Group, SelectRow, ToggleRow } from './capability-controls';
import { label, rows, type PanelContext } from './capability-data';
import { DesktopNotificationToggle } from './desktop-notification-toggle';
import { PushNotificationToggle } from './push-notification-toggle';
import { NARROW_SHELL_QUERY } from '../use-responsive-shell-bands';

function ThemeChoices({ data, pending }: Pick<PanelContext, 'data' | 'pending'>) {
  const loadedTheme = String(data.theme || 'basic');
  const [preference, setPreference] = useState<DesktopThemePreference>(
    () => getDesktopThemePreference() || desktopThemePreferenceForTheme(loadedTheme)
  );
  useEffect(() => {
    setPreference(getDesktopThemePreference() || desktopThemePreferenceForTheme(loadedTheme));
  }, [loadedTheme]);
  const choose = (next: string) => {
    const selected = next as DesktopThemePreference;
    setPreference(selected);
    setDesktopThemePreference(selected);
  };
  return (
    <Group title={t('Theme')}>
      <SelectRow
        title={t('Theme')}
        value={preference}
        disabled={Boolean(pending)}
        options={desktopThemeOptions().map((option) => ({ ...option, label: t(option.label) }))}
        onChange={choose}
      />
    </Group>
  );
}

function UiLanguageChoices({ pending }: Pick<PanelContext, 'pending'>) {
  const [preference, setPreference] = useState<UiLanguagePreference>(() => getUiLanguagePreference());
  const [error, setError] = useState('');
  return (
    <Group title={t('Display language')}>
      <SelectRow
        title={t('Display language')}
        value={preference}
        disabled={Boolean(pending)}
        options={[{ value: 'system', label: t('System default') }, ...SUPPORTED_UI_LANGUAGES]}
        onChange={(next) => {
          const selected = next as UiLanguagePreference;
          const previous = resolveUiLanguage();
          if (!setUiLanguagePreference(selected)) {
            setError(t('Display language could not be saved. Allow browser storage and try again.'));
            return;
          }
          setError('');
          setPreference(selected);
          if (resolveUiLanguage(selected) !== previous) window.location.reload();
        }}
      />
      {error && <p role="alert">{error}</p>}
    </Group>
  );
}

function SidePanelChoices({ pending }: Pick<PanelContext, 'pending'>) {
  const configuredMode = useSyncExternalStore(subscribeSidePanelMode, getSidePanelMode, () => 'close-both');
  const narrow = window.matchMedia?.(NARROW_SHELL_QUERY).matches === true;
  const mode = narrow ? 'close-both' : configuredMode;
  return (
    <Group title={t('Side panels')}>
      <SelectRow
        title={t('Side panels')}
        value={mode}
        disabled={Boolean(pending) || narrow}
        options={[
          { value: 'close-left', label: t('Left closed') },
          { value: 'close-right', label: t('Right closed') },
          { value: 'close-both', label: t('Both closed') },
          { value: 'keep-open', label: t('Keep open') },
        ]}
        onChange={(next) => setSidePanelMode(next as SidePanelMode)}
      />
    </Group>
  );
}

export function GeneralPanel({ data, pending, run, api }: PanelContext) {
  const profile = record(data.profile);
  const webSearchModule = record(record(data.toolModules).webSearch);
  const languageOptions = rows(profile.languages).map((entry) => ({
    value: String(entry.id || entry.value || 'system'),
    label: t(label(entry)),
  }));
  const experienceLevelOptions = rows(profile.experienceLevels).map((entry) => ({
    value: String(entry.id || entry.value || ''),
    label: t(label(entry)),
  }));
  const busy = Boolean(pending);
  return (
    <>
      <Group title={t('Profile')}>
        <AutoSaveRow
          title={t('Title')}
          name="title"
          value={String(profile.title || '')}
          placeholder={t('Your name or role')}
          disabled={busy}
          onSave={(title) => void run('setProfile', [{ title }])}
        />
        <SelectRow
          title={t('Language')}
          value={String(profile.language || 'system')}
          disabled={busy}
          options={languageOptions}
          onChange={(language) => void run('setProfile', [{ language }])}
        />
        <SelectRow
          title={t('Experience level')}
          value={String(profile.experienceLevel || '')}
          disabled={busy}
          options={experienceLevelOptions}
          onChange={(experienceLevel) => void run('setProfile', [{ experienceLevel }])}
        />
      </Group>
      <Group title={t('Features')}>
        <ToggleRow
          title={t('Web search')}
          description={t('Expose web search and web fetch tools to new sessions.')}
          checked={webSearchModule.enabled !== false}
          disabled={busy}
          onChange={(enabled) => void run('setWebSearchEnabled', [enabled])}
        />
      </Group>
      <PushNotificationToggle api={api} />
      <DesktopNotificationToggle />
      <UiLanguageChoices pending={pending} />
      <ThemeChoices data={data} pending={pending} />
      <SidePanelChoices pending={pending} />
    </>
  );
}

import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  getUiLanguagePreference,
  resolveUiLanguage,
  setUiLanguagePreference,
  SUPPORTED_UI_LANGUAGES,
  t,
  type UiLanguagePreference,
} from '../i18n';
import type { DesktopApi, DesktopEditorSettings } from '../../shared/contract';
import { DEFAULT_DESKTOP_EDITOR_SETTINGS } from '../../shared/editor-settings';
import { getLinkPreview, setLinkPreview, subscribeLinkPreview } from '../link-preview-preference';
import { record } from '../record-utils';
import { getTimeFormat, setTimeFormat, subscribeTimeFormat, type TimeFormat } from '../time-format-preference';
import { isRemoteBrowserRenderer, isRemoteHostRenderer } from '../remote-ui-projection';
import {
  getSidePanelMode,
  getSidePanelPosition,
  setSidePanelMode,
  setSidePanelPosition,
  subscribeSidePanelMode,
  subscribeSidePanelPosition,
  type SidePanelMode,
  type SidePanelPosition,
} from '../side-panel-preferences';
import { followHostDisplay } from '../host-display-sync';
import { ActionButton, AutoSaveRow, Group, ResourceRow, SelectRow, ToggleRow } from './capability-controls';
import { label, rows, type PanelContext } from './capability-data';
import { ImportConversationsDialog } from './import-conversations-dialog';
import { DesktopNotificationToggle } from './desktop-notification-toggle';
import { PushNotificationToggle } from './push-notification-toggle';
import { WorktreeSettings } from './worktree-settings';
import { NARROW_SHELL_QUERY } from '../use-responsive-shell-bands';

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

/** Per-device clock style. Reloads on a change, like the language: times are formatted
 *  where they render, so one reload refreshes every visible time. */
function TimeFormatChoice({ pending }: Pick<PanelContext, 'pending'>) {
  const format = useSyncExternalStore(subscribeTimeFormat, getTimeFormat, () => 'system' as TimeFormat);
  const [error, setError] = useState('');
  return (
    <Group title={t('Time format')}>
      <SelectRow
        title={t('Time format')}
        value={format}
        disabled={Boolean(pending)}
        options={[
          { value: 'system', label: t('System default') },
          { value: '12h', label: t('12-hour') },
          { value: '24h', label: t('24-hour') },
        ]}
        onChange={(next) => {
          if (next === format) return;
          if (!setTimeFormat(next as TimeFormat)) {
            setError(t('The setting could not be saved.'));
            return;
          }
          setError('');
          window.location.reload();
        }}
      />
      {error && <p role="alert">{error}</p>}
    </Group>
  );
}

/** Renderer-only UI preference; applies to open panes without a restart. */
function LinkPreviewToggle({ pending }: Pick<PanelContext, 'pending'>) {
  const enabled = useSyncExternalStore(subscribeLinkPreview, getLinkPreview, () => true);
  return (
    <ToggleRow
      title={t('Link preview')}
      description={t('Open chat links in a preview tab that the next link replaces.')}
      checked={enabled}
      disabled={Boolean(pending)}
      onChange={setLinkPreview}
    />
  );
}

/** Which view a Markdown file opens in until the user picks one for it. */
function MarkdownDefaultViewChoice({ pending }: Pick<PanelContext, 'pending'>) {
  const api = (window as unknown as { mixdogDesktop?: Partial<DesktopApi> }).mixdogDesktop;
  const [view, setView] = useState<DesktopEditorSettings['markdownDefaultView']>(
    DEFAULT_DESKTOP_EDITOR_SETTINGS.markdownDefaultView
  );
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    void api
      ?.readMarkdownDefaultView?.()
      .then((configured) => {
        if (live) setView(configured);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [api]);
  const choose = (next: DesktopEditorSettings['markdownDefaultView']) => {
    const writer = api?.writeMarkdownDefaultView;
    if (!writer) return;
    setError('');
    void writer(next)
      .then(setView)
      .catch(() => setError(t('Default view could not be saved to your user settings.')));
  };
  return (
    <Group title={t('Markdown files')}>
      <SelectRow
        title={t('Default view')}
        value={view}
        disabled={Boolean(pending) || !api?.writeMarkdownDefaultView}
        options={[
          { value: 'preview', label: t('Preview') },
          { value: 'rich', label: t('Rich') },
          { value: 'source', label: t('Source') },
        ]}
        onChange={(next) => choose(next as DesktopEditorSettings['markdownDefaultView'])}
      />
      {error && <p role="alert">{error}</p>}
    </Group>
  );
}

function SidePanelChoices({ pending }: Pick<PanelContext, 'pending'>) {
  const configuredMode = useSyncExternalStore(subscribeSidePanelMode, getSidePanelMode, () => 'close-both');
  const narrow = window.matchMedia?.(NARROW_SHELL_QUERY).matches === true;
  const mode = narrow ? 'close-both' : configuredMode;
  const position = useSyncExternalStore(subscribeSidePanelPosition, getSidePanelPosition, () => 'right');
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
      <SelectRow
        title={t('Side panel position')}
        value={position}
        disabled={Boolean(pending)}
        options={[
          { value: 'right', label: t('Right') },
          { value: 'bottom', label: t('Bottom') },
          { value: 'auto', label: t('Auto') },
        ]}
        onChange={(next) => setSidePanelPosition(next as SidePanelPosition)}
      />
    </Group>
  );
}

/** Remote surfaces: the settings this device stores for itself (localStorage),
 *  split out of General so the page says where they apply. */
export function DisplayPanel({ pending }: PanelContext) {
  const hostApi = (window as unknown as { mixdogDesktop?: Partial<DesktopApi> }).mixdogDesktop;
  const followable = isRemoteBrowserRenderer() && Boolean(hostApi?.readHostDisplayPreferences);
  return (
    <>
      {followable && (
        <Group title={t('Host computer')}>
          <ResourceRow
            title={t('Use host computer settings')}
            meta={t('Take the theme and language of the computer you are connected to.')}
            actions={
              <ActionButton disabled={Boolean(pending)} onClick={() => void followHostDisplay(hostApi ?? {})}>
                {t('Use host settings')}
              </ActionButton>
            }
          />
        </Group>
      )}
      <UiLanguageChoices pending={pending} />
      <TimeFormatChoice pending={pending} />
      <Group title={t('Link preview')}>
        <LinkPreviewToggle pending={pending} />
      </Group>
      <SidePanelChoices pending={pending} />
    </>
  );
}

/** Opens the dialog that copies Codex / Claude Code conversations into new sessions. */
function ImportConversationsRow({ pending }: Pick<PanelContext, 'pending'>) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <ResourceRow
        title={t('Import conversations from other apps')}
        meta={t('Bring in conversations from Codex or Claude Code and continue them here.')}
        actions={
          <ActionButton disabled={Boolean(pending)} onClick={() => setOpen(true)}>
            {t('Import…')}
          </ActionButton>
        }
      />
      {open && <ImportConversationsDialog onClose={() => setOpen(false)} />}
    </>
  );
}

export function GeneralPanel({ data, pending, run, api }: PanelContext) {
  const remoteSurface = isRemoteHostRenderer();
  const profile = record(data.profile);
  const webSearchModule = record(record(data.toolModules).webSearch);
  const rawInstructionFiles = record(data.toolModules).instructionFiles;
  const autoEffortBase = ['low', 'medium', 'high'].includes(String(record(data.toolModules).autoEffortBase))
    ? String(record(data.toolModules).autoEffortBase)
    : 'medium';
  const instructionFilesMode = ['all', 'agents', 'claude', 'off'].includes(String(rawInstructionFiles))
    ? String(rawInstructionFiles)
    : 'off';
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
        {!remoteSurface && <ImportConversationsRow pending={pending} />}
        <SelectRow
          title={t('Load instruction files')}
          description={t(
            'Automatically include AGENTS.md / CLAUDE.md rules from your home folder and the project folder in new sessions. Enabled files are trusted as instructions, so only enable this for repositories you trust.'
          )}
          value={instructionFilesMode}
          disabled={busy}
          options={[
            { value: 'all', label: t('All') },
            { value: 'agents', label: 'AGENTS.md' },
            { value: 'claude', label: 'CLAUDE.md' },
            { value: 'off', label: t('Off') },
          ]}
          onChange={(mode) => void run('setInstructionFiles', [mode])}
        />
        <SelectRow
          title={t('Auto reasoning base')}
          description={t(
            'The reasoning effort Auto works around: it goes lower for easy requests and higher for hard ones.'
          )}
          value={autoEffortBase}
          disabled={busy}
          options={[
            { value: 'low', label: t('Low') },
            { value: 'medium', label: t('Medium') },
            { value: 'high', label: t('High') },
          ]}
          onChange={(level) => void run('setAutoEffortBase', [level])}
        />
        {!remoteSurface && <LinkPreviewToggle pending={pending} />}
      </Group>
      <PushNotificationToggle api={api} />
      <DesktopNotificationToggle />
      <WorktreeSettings />
      {!remoteSurface && (
        <>
          <UiLanguageChoices pending={pending} />
          <TimeFormatChoice pending={pending} />
          <SidePanelChoices pending={pending} />
        </>
      )}
      <MarkdownDefaultViewChoice pending={pending} />
    </>
  );
}

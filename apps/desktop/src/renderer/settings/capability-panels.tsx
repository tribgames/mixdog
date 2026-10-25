import { Fragment, useEffect, useState } from 'react';
import { ErrorNotice } from '../ErrorNotice';

import type { DesktopApi } from '../../shared/contract';
import { requestOpenDoctor } from '../command-surface-doctor-event';
import { t } from '../i18n';
import { customProviderDisplayNames, resolveProviderDisplayName } from '../model-catalog';
import { record } from '../record-utils';
import { isSshConnectionWindow } from '../desktop-connection';
import { isRemoteHostRenderer } from '../remote-ui-projection';
import { subscribeSetupChanges } from '../setup-change-refresh';
import {
  setToolActivityExpansion,
  useStoredToolActivityExpansion,
  type ToolActivityExpansion,
} from '../tool-activity-expansion';
import { AboutPanel } from './about-panel';
import { AuthPanel } from './auth-panel';
import { BuiltInFeaturesPanel } from './built-in-features-panel';
import { ConnectionPanel } from './connection-panel';
import { DeveloperPanel } from './developer-panel';
import { getCachedDesktopStatus, readDesktopStatus, storeDesktopStatus } from './desktop-status-cache';
import { DisplayPanel, GeneralPanel, WorkPanel } from './general-panel';
import { SkinPanel } from './skin-panel';
import { BotsPanel } from './desktop-pet-toggle';
import { NotificationsPanel } from './notification-panel';

import { ActionButton, AutoSaveRow, Group, ListEmpty, ResourceRow, SelectRow, ToggleRow } from './capability-controls';
import {
  durationTextInput,
  formatDuration,
  label,
  rows,
  sectionError,
  sectionLoaded,
  type CapabilityCategory,
  type PanelContext,
  type RecordValue,
} from './capability-data';
import { McpPanel, PluginExtensionsPanel, SkillExtensionsPanel, SkillsPanel } from './extension-panels';
import { ConnectorsPanel } from './connectors-panel';
import { PhoneUpdatePanel } from './phone-app-update-group';
import { ProvidersPanel } from './provider-panel';
import { ModelManagementPanel } from './model-management-panel';

export { OAuthControl } from './provider-panel';

export function CategoryPanel({ category, context }: { category: CapabilityCategory; context: PanelContext }) {
  if (category === 'builtins') return <BuiltInFeaturesPanel {...context} />;
  if (category === 'output-style') return <OutputStylePanel {...context} />;
  if (category === 'providers') return <ProvidersPanel {...context} />;
  if (category === 'models') return <ModelManagementPanel {...context} />;
  if (category === 'git') return <BuiltInFeaturesPanel {...context} initialFeature="git" />;
  if (category === 'mcp') return <McpPanel {...context} />;
  if (category === 'plugins') return <PluginExtensionsPanel {...context} />;
  if (category === 'skills') return <SkillExtensionsPanel {...context} />;
  if (category === 'connectors') return <ConnectorsPanel {...context} />;
  if (category === 'user-skills') return <SkillsPanel {...context} />;
  if (category === 'context') return <ContextPanel {...context} />;
  if (category === 'system') return <SystemPanel {...context} />;
  if (category === 'shortcuts') return <ShortcutsPanel />;
  if (category === 'connection') return <ConnectionPanel api={context.api} openCategory={context.openCategory} />;
  if (category === 'auth') return <AuthPanel api={context.api} />;
  if (category === 'notifications') return <NotificationsPanel api={context.api} openCategory={context.openCategory} />;
  if (category === 'developer') return <DeveloperPanel {...context} />;
  if (category === 'about') return <AboutPanel />;
  if (category === 'display') return <DisplayPanel {...context} />;
  if (category === 'skin') return <SkinPanel {...context} />;
  if (category === 'bots') return <BotsPanel {...context} />;
  if (category === 'work') return <WorkPanel {...context} />;
  return <GeneralPanel {...context} />;
}

// Keybind reference (read-only). Bindings live in App.tsx's
// global keydown handler and the composer key map; keep this list in sync.
export const SHORTCUT_GROUPS: ReadonlyArray<
  readonly [string, ReadonlyArray<readonly [ReadonlyArray<string>, string]>]
> = [
  [
    'Tasks and tabs',
    [
      [['Ctrl+N'], 'New task'],
      [['Ctrl+Alt+N'], 'New task without a project'],
      [['Ctrl+W'], 'Close tab'],
      [['Ctrl+Tab', 'Ctrl+Shift+]'], 'Next tab'],
      [['Ctrl+Shift+Tab', 'Ctrl+Shift+['], 'Previous tab'],
      [['Ctrl+1–8', 'Ctrl+9'], 'Go to tab / last tab'],
      [['Ctrl+[', 'Ctrl+]'], 'Go back / forward'],
    ],
  ],
  [
    'Find and move',
    [
      [['Ctrl+P'], 'Quick Open'],
      [['Ctrl+Shift+P', 'Ctrl+K', 'Ctrl+/'], 'Command Palette'],
      [['Ctrl+F'], 'Search sessions (no tab open)'],
      [['Ctrl+←', 'Ctrl+→'], 'Switch tab / pane'],
      [['Ctrl+↑', 'Ctrl+↓'], 'Focus pane above / below'],
    ],
  ],
  [
    'Layout',
    [
      [['Ctrl+Shift+B'], 'Toggle left side bar'],
      [['Ctrl+B'], 'Toggle right utility panel'],
      [['Ctrl+`', 'Ctrl+T'], 'Toggle terminal panel'],
      [['Ctrl+,'], 'Open settings'],
      [['Esc'], 'Close menus and popovers'],
    ],
  ],
  [
    'Composer',
    [
      [['Enter'], 'Send message'],
      [['Shift+Enter', 'Ctrl+Enter', 'Ctrl+J'], 'Insert new line'],
      [['Ctrl+U'], 'Delete to line start'],
      [['↑', '↓'], 'Prompt history (empty draft)'],
      [['/'], 'Command palette'],
      [['@'], 'File and context mentions'],
    ],
  ],
  [
    'Conversation',
    [
      [['PageUp', 'PageDown'], 'Scroll conversation'],
      [['Home', 'End'], 'First / latest message'],
      [['Ctrl+O'], 'Expand or collapse all tool activity'],
    ],
  ],
  [
    'Editor',
    [
      [['F2'], 'Rename symbol'],
      [['Ctrl+.'], 'Quick Fix'],
      [['Shift+Alt+F'], 'Format document'],
      [['F12', 'Shift+F12'], 'Go to definition / references'],
    ],
  ],
];

function ShortcutsPanel() {
  return (
    <>
      {SHORTCUT_GROUPS.map(([title, shortcuts]) => (
        <Group key={title} title={t(title)}>
          <div className="settings-shortcut-list">
            {shortcuts.map(([keys, action]) => (
              <div className="settings-shortcut-row" key={action}>
                <span>{t(action)}</span>
                <span className="settings-shortcut-keys">
                  {keys.map((key, index) => (
                    <Fragment key={key}>
                      {index > 0 && <span className="settings-shortcut-or">{t('or')}</span>}
                      <kbd>{key}</kbd>
                    </Fragment>
                  ))}
                </span>
              </div>
            ))}
          </div>
        </Group>
      ))}
    </>
  );
}

function ChoicePanel({
  title,
  values,
  active,
  pending,
  emptyText,
  loadingRows = 0,
  onChoose,
}: {
  title: string;
  values: RecordValue[];
  active: string;
  pending: string;
  emptyText: string;
  /** Placeholder rows to hold the list's height while it loads. */
  loadingRows?: number;
  onChoose(id: string): void;
}) {
  return (
    <Group title={title}>
      {values.length ? (
        values.map((entry) => {
          const id = String(entry.id);
          return (
            <ResourceRow
              key={id}
              title={label(entry)}
              meta={
                String(entry.description || entry.source || '')
                  ? t(String(entry.description || entry.source))
                  : undefined
              }
              selected={id === active || entry.active === true}
              actions={
                id !== active &&
                !entry.active && (
                  <ActionButton disabled={Boolean(pending)} onClick={() => onChoose(id)}>
                    {t('Choose')}
                  </ActionButton>
                )
              }
            />
          );
        })
      ) : loadingRows ? (
        <div role="status" aria-busy="true" aria-label={emptyText}>
          {Array.from({ length: loadingRows }, (_, index) => (
            <ResourceRow
              // biome-ignore lint/suspicious/noArrayIndexKey: identical static placeholders.
              key={index}
              className="is-skeleton"
              title={'\u00a0'}
              actions={
                <ActionButton disabled onClick={() => undefined}>
                  {t('Choose')}
                </ActionButton>
              }
            />
          ))}
        </div>
      ) : (
        <ListEmpty text={emptyText} />
      )}
    </Group>
  );
}

// Rows the output-style list showed the last time it loaded: the placeholder
// reserves that many so the loaded list replaces it in place.
let lastOutputStyleRows = 4;

function OutputStylePanel({ data, pending, run }: PanelContext) {
  const output = record(data.outputStyles);
  const failure = sectionError(data, 'outputStyles');
  const styleRows = rows(output, 'styles');
  const loaded = sectionLoaded(data, 'outputStyles');
  if (loaded && styleRows.length) lastOutputStyleRows = styleRows.length;
  return (
    <>
      {failure ? (
        <ErrorNotice error={failure} role="status" />
      ) : (
        <ChoicePanel
          title={t('Response style')}
          values={styleRows}
          active={String(record(output.current).id || output.configured || 'default')}
          pending={pending}
          emptyText={loaded ? t('No output styles available.') : t('Loading output styles…')}
          loadingRows={loaded ? 0 : lastOutputStyleRows}
          onChoose={(id) => void run('setOutputStyle', [id])}
        />
      )}
      <ToolActivityExpansionGroup />
    </>
  );
}

const TOOL_ACTIVITY_EXPANSION_OPTIONS: ReadonlyArray<{ value: ToolActivityExpansion; label: string }> = [
  { value: 'collapsed', label: 'Collapsed' },
  { value: 'commands', label: 'Commands and edits' },
  { value: 'all', label: 'Everything' },
];

function ToolActivityExpansionGroup() {
  const value = useStoredToolActivityExpansion();
  return (
    <Group title={t('Tool activity')}>
      <SelectRow
        title={t('Expand tool activity')}
        value={value}
        options={TOOL_ACTIVITY_EXPANSION_OPTIONS.map((option) => ({ value: option.value, label: t(option.label) }))}
        onChange={(next) => setToolActivityExpansion(next as ToolActivityExpansion)}
      />
    </Group>
  );
}

function updaterInstallLabel(state: PanelContext['updaterState']): string {
  switch (state.status) {
    case 'ready':
      return t('Update to v{{version}}', { version: state.version });
    case 'installing':
      return t('Installing v{{version}}…', { version: state.version });
    case 'downloading':
      return t('Downloading v{{version}}…', { version: state.version });
    case 'checking':
      return t('Checking for update…');
    case 'up-to-date':
      return t('Up to date');
    case 'error':
      return t('Update unavailable');
    default:
      return t('Check for update');
  }
}

function UpdatePanel({ data, pending, run, updaterState, checkDesktopUpdate, installDesktopUpdate }: PanelContext) {
  const update = record(data.update);
  const version = 'version' in updaterState ? updaterState.version : String(update.latestVersion || '');
  const busy =
    Boolean(pending) ||
    updaterState.status === 'checking' ||
    updaterState.status === 'downloading' ||
    updaterState.status === 'installing';
  const installLabel = updaterInstallLabel(updaterState);
  const current = String(update.currentVersion || '');
  let versionMeta: string | undefined;
  if (updaterState.status === 'checking') versionMeta = t('Checking for update…');
  else if (updaterState.status === 'error') versionMeta = t('Update unavailable');
  else if (updaterState.status === 'up-to-date') versionMeta = t('Up to date');
  else if (version && version !== current) versionMeta = t('Version {{version}} is available', { version });
  else if (version) versionMeta = t('Up to date');
  // Over remote access the updater is the host computer's, not this device's.
  // A host without the updater methods reports 'disabled': keep the old wording.
  const onHost = isRemoteHostRenderer() && updaterState.status !== 'disabled';
  return (
    <Group title={onHost ? t('Update (host computer)') : t('Update')}>
      <ResourceRow
        title={t('Mixdog {{version}}', { version: current || t('unknown') })}
        meta={versionMeta}
        actions={
          <ActionButton disabled={busy} onClick={() => void checkDesktopUpdate()}>
            {onHost ? t('Check on host computer') : t('Check now')}
          </ActionButton>
        }
      />
      <ToggleRow
        title={t('Auto-update')}
        checked={update.autoUpdate === true}
        disabled={busy}
        onChange={(enabled) => void run('setAutoUpdate', [enabled])}
      />
      {(updaterState.status === 'ready' ||
        updaterState.status === 'downloading' ||
        updaterState.status === 'installing') && (
        <ResourceRow
          title={onHost ? t('Install update on host computer') : t('Install update')}
          actions={
            <ActionButton
              disabled={busy || updaterState.status !== 'ready'}
              onClick={() => void installDesktopUpdate()}
            >
              {installLabel}
            </ActionButton>
          }
        />
      )}
    </Group>
  );
}

// Typed/shown for a provider that never auto-clears; the runtime stores 0.
const AUTO_CLEAR_UNLIMITED_INPUT = 'unlimited';

function autoClearSource(autoClear: ReturnType<typeof record>): string {
  if (autoClear.providerCustom) return t('{{value0}} override', { value0: String(autoClear.provider) });
  if (autoClear.custom) return t('global duration');
  return t('{{value0}} default', { value0: String(autoClear.provider || 'default') });
}

// Context management (user decision): ONE page owns how a session's context
// evolves — auto-compact, idle auto-clear, and the memory that carries over.
function ContextPanel({ data, pending, run }: PanelContext) {
  const autoClear = record(data.autoClear);
  const compaction = record(data.compaction);
  const sessionTitles = record(data.sessionTitles);
  const providerDefaults = rows(autoClear.providerDefaults);
  // A custom provider's idle window is named by what the user registered.
  const providerNames = customProviderDisplayNames(data.providerSetup);
  const busy = Boolean(pending);
  return (
    <>
      <Group title={t('Session names')}>
        <ToggleRow
          title={t('Let AI rename sessions')}
          description={t('Allow the assistant to give a session a descriptive title.')}
          checked={sessionTitles.aiSessionTitles !== false}
          disabled={busy}
          onChange={(enabled) => void run('setAiSessionTitles', [enabled])}
        />
      </Group>
      <Group title={t('Compaction')}>
        <ToggleRow
          title={t('Auto-compact')}
          description={t('Compact automatically as the active context reaches its limit.')}
          checked={compaction.auto !== false}
          disabled={busy}
          onChange={(enabled) => void run('setCompactionSettings', [{ auto: enabled }])}
        />
        <ToggleRow
          title={t('Auto-compact on model change')}
          description={t(
            'Compact the conversation on its current model before the chat switches to another model. Skipped when the current model has run out of usage.'
          )}
          checked={compaction.onModelChange !== false}
          disabled={busy}
          onChange={(enabled) => void run('setCompactionSettings', [{ onModelChange: enabled }])}
        />
        <SelectRow
          title={t('Compaction summary model')}
          description={t(
            'Smart reuses the conversation’s cache while it is warm, otherwise the Maintainer or a lighter model.'
          )}
          value={String(compaction.summaryMode || 'smart')}
          disabled={busy}
          options={[
            { value: 'smart', label: t('Smart') },
            { value: 'maintainer', label: t('Maintainer') },
            { value: 'self', label: t('Conversation model') },
          ]}
          onChange={(summaryMode) => void run('setCompactionSettings', [{ summaryMode }])}
        />
      </Group>
      <Group
        title={t('Idle session cleanup')}
        description={t(
          'Sessions left unused this long are cleared automatically. Each provider can have its own time.'
        )}
      >
        <ToggleRow
          title={t('Auto-clear')}
          description={
            autoClear.unlimited === true
              ? t(
                  'Never clear idle sessions ({{value0}}). A provider idle window below overrides the global duration.',
                  {
                    value0: autoClearSource(autoClear),
                  }
                )
              : t(
                  'Clear idle sessions after {{value0}} ({{value1}}). A provider idle window below overrides the global duration.',
                  {
                    value0: formatDuration(autoClear.idleMs) || t('the provider default'),
                    value1: autoClearSource(autoClear),
                  }
                )
          }
          checked={autoClear.enabled !== false}
          disabled={busy}
          onChange={(enabled) => void run('setAutoClear', [{ enabled }])}
        />
        {providerDefaults.map((entry) => (
          <AutoSaveRow
            key={String(entry.provider)}
            title={
              entry.provider && entry.provider !== 'default'
                ? resolveProviderDisplayName(String(entry.provider), providerNames)
                : t('Default')
            }
            name="duration"
            // 'unlimited' is the typed token the runtime parses (never auto-clear).
            value={entry.unlimited === true ? AUTO_CLEAR_UNLIMITED_INPUT : durationTextInput(entry.idleMs)}
            placeholder={
              entry.builtInUnlimited === true ? AUTO_CLEAR_UNLIMITED_INPUT : durationTextInput(entry.builtInMs)
            }
            required
            disabled={busy}
            onSave={(duration) =>
              void run('setAutoClear', [{ provider: entry.provider, duration }], `autoclear-${entry.provider}`)
            }
            actions={
              <>
                {entry.unlimited !== true && (
                  <ActionButton
                    disabled={busy}
                    onClick={() =>
                      void run(
                        'setAutoClear',
                        [{ provider: entry.provider, unlimited: true }],
                        `autoclear-unlimited-${entry.provider}`
                      )
                    }
                  >
                    {t('Unlimited')}
                  </ActionButton>
                )}
                {Boolean(entry.custom) && (
                  <ActionButton
                    disabled={busy}
                    onClick={() =>
                      void run(
                        'setAutoClear',
                        [{ provider: entry.provider, resetProvider: true }],
                        `autoclear-reset-${entry.provider}`
                      )
                    }
                  >
                    {t('Reset')}
                  </ActionButton>
                )}
              </>
            }
          />
        ))}
      </Group>
    </>
  );
}

// Desktop-local power setting (main-process powerSaveBlocker): rides the
// readSettings/updateSetting lane, not an engine capability, so it loads its
// own state. Hidden when the hosting shell exposes no settings surface.
function DesktopPowerGroup() {
  const api = (window as unknown as { mixdogDesktop?: Partial<DesktopApi> }).mixdogDesktop;
  const cached = getCachedDesktopStatus(api, 'settings');
  const [keepAwake, setKeepAwake] = useState<boolean | null>(() => (cached ? cached.keepAwake !== false : null));
  const [runInBackground, setRunInBackground] = useState(() => cached?.runInBackground !== false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: api is the window bridge read per render; it is kept as the re-read trigger.
  useEffect(() => {
    let live = true;
    const read = () =>
      void readDesktopStatus(api, 'settings')
        ?.then((settings) => {
          if (!live) return;
          setKeepAwake(settings.keepAwake !== false);
          setRunInBackground(settings.runInBackground !== false);
        })
        .catch(() => {});
    read();
    const unsubscribe = subscribeSetupChanges(read);
    return () => {
      live = false;
      unsubscribe();
    };
  }, [api]);
  if (keepAwake === null || !api?.updateSetting) return null;
  return (
    <Group
      title={t('Power')}
      description={t('Keep the computer awake while agents are working, so long runs never stall mid-turn.')}
    >
      <ToggleRow
        title={t('Keep system awake while working')}
        checked={keepAwake}
        onChange={(enabled) => {
          setKeepAwake(enabled);
          void api
            .updateSetting?.('keepAwake', enabled)
            .then((saved) => storeDesktopStatus(api, 'settings', saved))
            .catch(() => {});
        }}
      />
      <SelectRow
        title={t('When closing the window')}
        value={runInBackground ? 'tray' : 'quit'}
        options={[
          { value: 'tray', label: t('Hide to tray') },
          { value: 'quit', label: t('Quit completely') },
        ]}
        onChange={(value) => {
          const enabled = value === 'tray';
          setRunInBackground(enabled);
          void api
            .updateSetting?.('runInBackground', enabled)
            .then((saved) => storeDesktopStatus(api, 'settings', saved))
            .catch(() => {});
        }}
      />
    </Group>
  );
}

function SystemPanel(context: PanelContext) {
  return (
    <>
      <PhoneUpdatePanel />
      {/* The updater is this PC's: a server window has no update entry. */}
      {!isSshConnectionWindow() && <UpdatePanel {...context} />}
      <DesktopPowerGroup />
      <Group title={t('Diagnostics')}>
        <ResourceRow
          title={t('Runtime, providers and installation')}
          actions={<ActionButton onClick={requestOpenDoctor}>{t('Run diagnostics')}</ActionButton>}
        />
      </Group>
    </>
  );
}

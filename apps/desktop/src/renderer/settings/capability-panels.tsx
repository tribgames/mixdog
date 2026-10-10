import { useEffect, useState } from 'react';
import { ErrorNotice } from '../ErrorNotice';

import type { DesktopApi } from '../../shared/contract';
import { requestOpenDoctor } from '../command-surface-doctor-event';
import { t } from '../i18n';
import { providerDisplayName } from '../provider-display';
import { record } from '../record-utils';
import { isRemoteHostRenderer } from '../remote-ui-projection';
import { subscribeSetupChanges } from '../setup-change-refresh';
import {
  setToolActivityExpansion,
  useStoredToolActivityExpansion,
  type ToolActivityExpansion,
} from '../tool-activity-expansion';
import { AboutPanel } from './about-panel';
import { BuiltInFeaturesPanel } from './built-in-features-panel';
import { ConnectionPanel } from './connection-panel';
import { DeveloperPanel } from './developer-panel';
import { GeneralPanel } from './general-panel';

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
import { McpPanel, PluginExtensionsPanel, SkillExtensionsPanel } from './extension-panels';
import { ProvidersPanel } from './provider-panel';

export { OAuthControl } from './provider-panel';

export function CategoryPanel({ category, context }: { category: CapabilityCategory; context: PanelContext }) {
  if (category === 'builtins') return <BuiltInFeaturesPanel {...context} />;
  if (category === 'output-style') return <OutputStylePanel {...context} />;
  if (category === 'providers') return <ProvidersPanel {...context} />;
  if (category === 'git') return <BuiltInFeaturesPanel {...context} initialFeature="git" />;
  if (category === 'mcp') return <McpPanel {...context} />;
  if (category === 'plugins') return <PluginExtensionsPanel {...context} />;
  if (category === 'skills') return <SkillExtensionsPanel {...context} />;
  if (category === 'context') return <ContextPanel {...context} />;
  if (category === 'system') return <SystemPanel {...context} />;
  if (category === 'shortcuts') return <ShortcutsPanel />;
  if (category === 'connection') return <ConnectionPanel api={context.api} />;
  if (category === 'developer') return <DeveloperPanel {...context} />;
  if (category === 'about') return <AboutPanel />;
  return <GeneralPanel {...context} />;
}

// Keybind reference (read-only). Bindings live in App.tsx's
// global keydown handler and the composer key map; keep this list in sync.
const SHORTCUT_GROUPS: ReadonlyArray<readonly [string, ReadonlyArray<readonly [string, string]>]> = [
  [
    'Project',
    [
      ['Ctrl+N', 'New task'],
      ['Ctrl+P', 'Quick Open'],
      ['Ctrl+Shift+P / Ctrl+K / Ctrl+/', 'Command Palette'],
      ['Ctrl+F', 'Search sessions (no tab open)'],
      ['Ctrl+W', 'Close tab'],
      ['Ctrl+Tab / Ctrl+Shift+Tab', 'Next / previous tab'],
      ['Ctrl+Shift+] / Ctrl+Shift+[', 'Next / previous tab'],
      ['Ctrl+1–8 / Ctrl+9', 'Go to tab / last tab'],
      ['Ctrl+[ / Ctrl+]', 'Go back / forward'],
      ['Ctrl+← / →', 'Switch tab / pane'],
      ['Ctrl+↑ / ↓', 'Focus pane above / below'],
      ['Ctrl+B', 'Toggle right utility panel'],
      ['Ctrl+Shift+B', 'Toggle left side bar'],
      ['Ctrl+` / Ctrl+T', 'Toggle terminal panel'],
      ['Ctrl+,', 'Open settings'],
      ['Esc', 'Close menus and popovers'],
    ],
  ],
  [
    'Editor',
    [
      ['F2', 'Rename symbol'],
      ['Ctrl+.', 'Quick Fix'],
      ['Shift+Alt+F', 'Format document'],
      ['F12 / Shift+F12', 'Go to definition / references'],
    ],
  ],
  [
    'Composer',
    [
      ['Enter', 'Send message'],
      ['Shift+Enter / Ctrl+Enter', 'Insert new line'],
      ['Ctrl+J', 'Insert new line'],
      ['Ctrl+U', 'Delete to line start'],
      ['↑ / ↓', 'Prompt history (empty draft)'],
      ['/', 'Command palette'],
      ['@', 'File and context mentions'],
    ],
  ],
  [
    'Conversation',
    [
      ['PageUp / PageDown', 'Scroll conversation'],
      ['Home / End', 'First / latest message'],
      ['Ctrl+O', 'Expand or collapse all tool activity'],
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
              <div className="settings-shortcut-row" key={keys}>
                <span>{t(action)}</span>
                <kbd>{keys}</kbd>
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
  onChoose,
}: {
  title: string;
  values: RecordValue[];
  active: string;
  pending: string;
  emptyText: string;
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
              description={String(entry.description || entry.source || '')}
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
      ) : (
        <ListEmpty text={emptyText} />
      )}
    </Group>
  );
}

function OutputStylePanel({ data, pending, run }: PanelContext) {
  const output = record(data.outputStyles);
  const failure = sectionError(data, 'outputStyles');
  return (
    <>
      {failure ? (
        <ErrorNotice error={failure} role="status" />
      ) : (
        <ChoicePanel
          title=""
          values={rows(output, 'styles')}
          active={String(record(output.current).id || output.configured || 'default')}
          pending={pending}
          emptyText={
            sectionLoaded(data, 'outputStyles') ? t('No output styles available.') : t('Loading output styles…')
          }
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
  // Over remote access the updater is the host computer's, not this device's.
  // A host without the updater methods reports 'disabled': keep the old wording.
  const onHost = isRemoteHostRenderer() && updaterState.status !== 'disabled';
  return (
    <Group title={onHost ? t('Update (host computer)') : t('Update')}>
      <ResourceRow
        title={t('Current version')}
        description={onHost ? t('Installed Mixdog Desktop version on the host computer.') : t('Installed Mixdog Desktop version.')}
        meta={String(update.currentVersion || t('unknown'))}
      />
      <ResourceRow
        title={onHost ? t('Latest version (host computer)') : t('Latest version')}
        meta={version || t('unknown')}
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
      <ResourceRow
        title={onHost ? t('Install update on host computer') : t('Install update')}
        actions={
          <ActionButton disabled={busy || updaterState.status !== 'ready'} onClick={() => void installDesktopUpdate()}>
            {installLabel}
          </ActionButton>
        }
      />
    </Group>
  );
}

// Context management (user decision): ONE page owns how a session's context
// evolves — auto-compact, idle auto-clear, and the memory that carries over.
function ContextPanel({ data, pending, run }: PanelContext) {
  const autoClear = record(data.autoClear);
  const compaction = record(data.compaction);
  const providerDefaults = rows(autoClear.providerDefaults);
  const busy = Boolean(pending);
  return (
    <Group title={t('Session lifecycle')}>
      <ToggleRow
        title={t('Auto-compact')}
        description={t('Compact automatically as the active context reaches its limit.')}
        checked={compaction.auto !== false}
        disabled={busy}
        onChange={(enabled) => void run('setCompactionSettings', [{ auto: enabled }])}
      />
      <ToggleRow
        title={t('Auto-clear')}
        description={t(
          'Clear idle sessions after {{value0}} ({{value1}}). A provider idle window below overrides the global duration.',
          {
            value0: formatDuration(autoClear.idleMs) || t('the provider default'),
            value1: autoClear.providerCustom
              ? t('{{value0}} override', { value0: String(autoClear.provider) })
              : autoClear.custom
                ? t('global duration')
                : t('{{value0}} default', { value0: String(autoClear.provider || 'default') }),
          }
        )}
        checked={autoClear.enabled !== false}
        disabled={busy}
        onChange={(enabled) => void run('setAutoClear', [{ enabled }])}
      />
      {providerDefaults.map((entry) => (
        <AutoSaveRow
          key={String(entry.provider)}
          title={t('{{value0}} idle window', { value0: providerDisplayName(String(entry.provider || 'default')) })}
          name="duration"
          value={durationTextInput(entry.idleMs)}
          placeholder={durationTextInput(entry.builtInMs)}
          required
          disabled={busy}
          onSave={(duration) =>
            void run('setAutoClear', [{ provider: entry.provider, duration }], `autoclear-${entry.provider}`)
          }
          actions={
            Boolean(entry.custom) && (
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
            )
          }
        />
      ))}
    </Group>
  );
}

// Desktop-local power setting (main-process powerSaveBlocker): rides the
// readSettings/updateSetting lane, not an engine capability, so it loads its
// own state. Hidden when the hosting shell exposes no settings surface.
function DesktopPowerGroup() {
  const api = (window as unknown as { mixdogDesktop?: Partial<DesktopApi> }).mixdogDesktop;
  const [keepAwake, setKeepAwake] = useState<boolean | null>(null);
  const [runInBackground, setRunInBackground] = useState(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: api is the window bridge read per render; it is kept as the re-read trigger.
  useEffect(() => {
    let live = true;
    const read = () =>
      void api
        ?.readSettings?.()
        .then((settings) => {
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
          void api.updateSetting?.('keepAwake', enabled).catch(() => {});
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
          void api.updateSetting?.('runInBackground', enabled).catch(() => {});
        }}
      />
    </Group>
  );
}

function SystemPanel(context: PanelContext) {
  return (
    <>
      <UpdatePanel {...context} />
      <DesktopPowerGroup />
      <Group title={t('Doctor')}>
        <ResourceRow
          title={t('Diagnostics')}
          description={t('Check the runtime, providers, integrations, and local installation.')}
          actions={<ActionButton onClick={requestOpenDoctor}>{t('Run doctor')}</ActionButton>}
        />
      </Group>
    </>
  );
}

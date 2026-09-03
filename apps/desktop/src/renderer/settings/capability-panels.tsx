import { useEffect, useState } from 'react';

import type {
  DesktopApi,
} from '../../shared/contract';
import {
  t,
} from '../i18n';
import { providerDisplayName } from '../provider-display';
import { record } from '../record-utils';
import { AboutPanel } from './about-panel';
import { BuiltInFeaturesPanel } from './built-in-features-panel';
import { ConnectionPanel } from './connection-panel';
import { GeneralPanel } from './general-panel';
import { GitPanel } from './git-panel';

import { ActionButton, AutoSaveRow, Group, ListEmpty, ResourceRow, ToggleRow } from "./capability-controls";
import { durationTextInput, formatDuration, label, rows, sectionError, sectionLoaded, type CapabilityCategory, type PanelContext, type RecordValue } from "./capability-data";
import { McpPanel, PluginExtensionsPanel, SkillExtensionsPanel } from './extension-panels';
import { ProvidersPanel } from './provider-panel';

export { OAuthControl } from './provider-panel';

export function CategoryPanel({ category, context }: {
  category: CapabilityCategory;
  context: PanelContext;
}) {
  if (category === 'builtins') return <BuiltInFeaturesPanel {...context} />;
  if (category === 'output-style') return <OutputStylePanel {...context} />;
  if (category === 'providers') return <ProvidersPanel {...context} />;
  if (category === 'git') return <GitPanel />;
  if (category === 'mcp') return <McpPanel {...context} />;
  if (category === 'plugins') return <PluginExtensionsPanel {...context} />;
  if (category === 'skills') return <SkillExtensionsPanel {...context} />;
  if (category === 'context') return <ContextPanel {...context} />;
  if (category === 'system') return <SystemPanel {...context} />;
  if (category === 'shortcuts') return <ShortcutsPanel />;
  if (category === 'connection') return <ConnectionPanel api={context.api} />;
  if (category === 'about') return <AboutPanel />;
  return <GeneralPanel {...context} />;
}

// Keybind reference (read-only). Bindings live in App.tsx's
// global keydown handler and the composer key map; keep this list in sync.
const SHORTCUT_GROUPS: ReadonlyArray<readonly [string, ReadonlyArray<readonly [string, string]>]> = [
  ['Project', [
    ['Ctrl+N', 'New task'],
    ['Ctrl+P', 'Quick Open'],
    ['Ctrl+Shift+P', 'Command Palette'],
    ['Ctrl+W', 'Close tab'],
    ['Ctrl+Tab / Ctrl+Shift+Tab', 'Next / previous tab'],
    ['Ctrl+← / →', 'Switch tab / pane'],
    ['Ctrl+↑ / ↓', 'Focus pane above / below'],
    ['Ctrl+B', 'Toggle left side bar'],
    ['Ctrl+Alt+B', 'Toggle right utility panel'],
    ['Ctrl+` / Ctrl+T', 'Toggle terminal panel'],
    ['Ctrl+,', 'Open settings'],
    ['Esc', 'Close menus and popovers'],
  ]],
  ['Editor', [
    ['F2', 'Rename symbol'],
    ['Ctrl+.', 'Quick Fix'],
    ['Shift+Alt+F', 'Format document'],
    ['F12 / Shift+F12', 'Go to definition / references'],
  ]],
  ['Composer', [
    ['Enter', 'Send message'],
    ['Shift+Enter / Ctrl+Enter', 'Insert new line'],
    ['Ctrl+J', 'Insert new line'],
    ['Ctrl+U', 'Delete to line start'],
    ['↑ / ↓', 'Prompt history (empty draft)'],
    ['/', 'Command palette'],
    ['@', 'File and context mentions'],
  ]],
  ['Conversation', [
    ['PageUp / PageDown', 'Scroll conversation'],
    ['Home / End', 'First / latest message'],
  ]],
];

function ShortcutsPanel() {
  return <>
    {SHORTCUT_GROUPS.map(([title, rows]) => <Group key={title} title={title}>
      <div className="settings-shortcut-list">
        {rows.map(([keys, label]) => <div className="settings-shortcut-row" key={keys}>
          <span>{t(label)}</span>
          <kbd>{keys}</kbd>
        </div>)}
      </div>
    </Group>)}
  </>;
}

function ChoicePanel({ title, values, active, pending, emptyText, onChoose }: {
  title: string; values: RecordValue[]; active: string; pending: string; emptyText?: string; onChoose(id: string): void;
}) {
  return <Group title={title}>{values.length ? values.map((entry) => {
    const id = String(entry.id);
    return <ResourceRow key={id} title={label(entry)} description={String(entry.description || entry.source || '')}
      selected={id === active || entry.active === true}
      actions={id !== active && !entry.active && <ActionButton disabled={Boolean(pending)} onClick={() => onChoose(id)}>Choose</ActionButton>} />;
  }) : <ListEmpty text={emptyText || `No ${title.toLowerCase()} available.`} />}</Group>;
}

function OutputStylePanel({ data, pending, run }: PanelContext) {
  const output = record(data.outputStyles);
  const failure = sectionError(data, 'outputStyles');
  return <ChoicePanel title="" values={rows(output, 'styles')}
    active={String(record(output.current).id || output.configured || 'default')} pending={pending}
    emptyText={sectionLoaded(data, 'outputStyles')
      ? 'No output styles available.'
      : (failure ? `Output styles unavailable: ${failure}` : 'Loading output styles…')}
    onChoose={(id) => void run('setOutputStyle', [id])} />;
}

function UpdatePanel({
  data,
  pending,
  run,
  updaterState,
  checkDesktopUpdate,
  installDesktopUpdate,
}: PanelContext) {
  const update = record(data.update);
  const version = 'version' in updaterState
    ? updaterState.version
    : String(update.latestVersion || '');
  const busy = Boolean(pending)
    || updaterState.status === 'checking'
    || updaterState.status === 'downloading'
    || updaterState.status === 'installing';
  const installLabel = updaterState.status === 'ready'
    ? t('Update to v{{version}}', { version: updaterState.version })
    : updaterState.status === 'installing'
      ? t('Installing v{{version}}…', { version: updaterState.version })
      : updaterState.status === 'downloading'
        ? t('Downloading v{{version}}…', { version: updaterState.version })
        : updaterState.status === 'checking'
          ? 'Checking for update…'
          : updaterState.status === 'up-to-date'
            ? 'Up to date'
            : updaterState.status === 'error'
              ? 'Update unavailable'
              : 'Check for update';
  return <Group title="Update">
    <ResourceRow title="Current version" description="Installed Mixdog Desktop version."
      meta={String(update.currentVersion || t('unknown'))} />
    <ResourceRow title="Latest version" meta={version || t('unknown')}
      actions={<ActionButton disabled={busy} onClick={() => void checkDesktopUpdate()}>Check now</ActionButton>} />
    <ToggleRow title="Auto-update" checked={update.autoUpdate === true}
      disabled={busy} onChange={(enabled) => void run('setAutoUpdate', [enabled])} />
    <ResourceRow title="Install update" actions={<ActionButton
      disabled={busy || updaterState.status !== 'ready'}
      onClick={() => void installDesktopUpdate()}>{installLabel}</ActionButton>} />
  </Group>;
}

// Context management (user decision): ONE page owns how a session's context
// evolves — auto-compact, idle auto-clear, and the memory that carries over.
function ContextPanel({ data, pending, run }: PanelContext) {
  const autoClear = record(data.autoClear);
  const compaction = record(data.compaction);
  const providerDefaults = rows(autoClear.providerDefaults);
  const busy = Boolean(pending);
  return <>
    <Group title="Session lifecycle">
      <ToggleRow title="Auto-compact" description="Compact automatically as the active context reaches its limit."
        checked={compaction.auto !== false} disabled={busy} onChange={(enabled) => void run('setCompactionSettings', [{ auto: enabled }])} />
      <ToggleRow title="Auto-clear" description={`Clear idle sessions after ${formatDuration(autoClear.idleMs) || 'the provider default'}.`}
        checked={autoClear.enabled !== false} disabled={busy} onChange={(enabled) => void run('setAutoClear', [{ enabled }])} />
      {providerDefaults.map((entry) => <AutoSaveRow key={String(entry.provider)}
        title={`${providerDisplayName(String(entry.provider || 'default'))} idle window`}
        name="duration" value={durationTextInput(entry.idleMs)} placeholder={durationTextInput(entry.builtInMs)}
        required disabled={busy}
        onSave={(duration) => void run('setAutoClear', [{ provider: entry.provider, duration }], `autoclear-${entry.provider}`)}
        actions={Boolean(entry.custom) && <ActionButton disabled={busy} onClick={() => void run('setAutoClear', [
          { provider: entry.provider, resetProvider: true },
        ], `autoclear-reset-${entry.provider}`)}>Reset</ActionButton>} />)}
    </Group>
  </>;
}

function SystemPanel(context: PanelContext) {
  return SystemPanelBody(context);
}

// Desktop-local power setting (main-process powerSaveBlocker): rides the
// readSettings/updateSetting lane, not an engine capability, so it loads its
// own state. Hidden when the hosting shell exposes no settings surface.
function DesktopPowerGroup() {
  const api = (window as unknown as { mixdogDesktop?: Partial<DesktopApi> }).mixdogDesktop;
  const [keepAwake, setKeepAwake] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void api?.readSettings?.().then((settings) => {
      if (live) setKeepAwake(settings.keepAwake !== false);
    }).catch(() => {});
    return () => { live = false; };
  }, [api]);
  if (keepAwake === null || !api?.updateSetting) return null;
  return <Group title="Power"
    description="Keep the computer awake while agents are working, so long runs never stall mid-turn.">
    <ToggleRow title="Keep system awake while working" checked={keepAwake}
      onChange={(enabled) => {
        setKeepAwake(enabled);
        void api.updateSetting?.('keepAwake', enabled).catch(() => {});
      }} />
  </Group>;
}

function SystemPanelBody(context: PanelContext) {
  const { pending, run } = context;
  const busy = Boolean(pending);
  return <>
    {/* The remote runtime toggle moved to the session header (user decision):
        a persistent on/off button next to the context indicator. */}
    <UpdatePanel {...context} />
    <DesktopPowerGroup />
    <Group title="Doctor">
      <ResourceRow title="Diagnostics" description="Check the runtime, providers, integrations, and local installation."
        actions={<ActionButton disabled={busy} onClick={() => void run('runDoctor')}>Run doctor</ActionButton>} />
    </Group>
  </>;
}

// Schedules and webhook endpoints both moved to dedicated main-pane pages
// (sidebar → Schedules / Webhooks); the Channels settings page is retired.

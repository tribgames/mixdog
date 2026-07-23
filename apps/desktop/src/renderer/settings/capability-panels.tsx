import React, { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Trash2,
  X,
} from 'lucide-react';

import type {
  DesktopApi,
  DesktopCapability,
  DesktopCapabilityReadRequest,
  DesktopReadCapability,
  DesktopModelOption,
  DesktopModelSelection,
  DesktopRemoteAccessInfo,
  EngineSnapshot,
} from '../../shared/contract';
import type { SettingsCategory } from './settings-items';
import {
  desktopThemePreferenceForTheme,
  getDesktopThemePreference,
  setDesktopThemePreference,
  type DesktopThemePreference,
} from '../desktop-theme';
import { OpenSelect } from '../OpenSelect';
import { filterConfiguredModels, ModelPicker } from '../ModelPicker';
import { modelDisplayName, modelOptionLabel, normalizeModelOptions, providerDisplayName } from '../provider-display';

import { type RecordValue, type CapabilityApi, type CapabilitySettingsProps, type PanelContext, type SettingsConfirmation, type CachedCapabilitySettings, SECTION_READS, getCachedCapabilitySettings, preloadCapabilitySettings, record, rows, bool, label, providerLabel, count, formatDuration, durationTextInput } from "./capability-data";
import { Group, ToggleRow, SelectRow, QuietSelectRow, routeOption, preferredEffort, routeOptionLabel, RouteEditor, FormRow, AutoSaveRow, ActionButton, SettingsConfirmDialog, settingsStatus, type SettingsStatusTone, ResourceRow, MetricGrid, ContextStatusView, UsageDashboard, Empty, ListEmpty } from "./capability-controls";

export function CategoryPanel({ category, context }: {
  category: SettingsCategory;
  context: PanelContext;
}) {
  if (category === 'output-style') return <OutputStylePanel {...context} />;
  if (category === 'models') return <ModelsPanel {...context} />;
  if (category === 'workflows') return <AgentsPanel {...context} />;
  if (category === 'providers') return <ProvidersPanel {...context} />;
  if (category === 'channels') return <ChannelsPanel {...context} />;
  if (category === 'mcp') return <McpPanel {...context} />;
  if (category === 'plugins') return <PluginsPanel {...context} />;
  if (category === 'hooks') return <HooksPanel {...context} />;
  if (category === 'skills') return <SkillsPanel {...context} />;
  if (category === 'memory') return <MemoryPanel {...context} />;
  if (category === 'system') return <SystemPanel {...context} />;
  if (category === 'shortcuts') return <ShortcutsPanel />;
  if (category === 'connection') return <ConnectionPanel />;
  return <GeneralPanel {...context} />;
}

// Keybind reference (read-only). Bindings live in App.tsx's
// global keydown handler and the composer key map; keep this list in sync.
const SHORTCUT_GROUPS: ReadonlyArray<readonly [string, ReadonlyArray<readonly [string, string]>]> = [
  ['Workspace', [
    ['Ctrl+N', 'New task'],
    ['Ctrl+Q', 'Close tab'],
    ['Ctrl+Tab / Ctrl+Shift+Tab', 'Next / previous tab'],
    ['Ctrl+← / →', 'Switch tab'],
    ['Ctrl+B', 'Toggle sidebar'],
  ['Ctrl+Shift+B', 'Toggle utility panel'],
    ['Ctrl+,', 'Open settings'],
    ['Esc', 'Close menus and popovers'],
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
];

function ShortcutsPanel() {
  return <>
    {SHORTCUT_GROUPS.map(([title, rows]) => <Group key={title} title={title}>
      <div className="settings-shortcut-list">
        {rows.map(([keys, label]) => <div className="settings-shortcut-row" key={keys}>
          <span>{label}</span>
          <kbd>{keys}</kbd>
        </div>)}
      </div>
    </Group>)}
  </>;
}

// Settings → Connection: pairing card for the phone remote (ChatGPT-desktop
// 연결 page grammar). Data + pre-rendered QR SVGs come from the main process;
// the remote shim omits the API, so a phone session shows the fallback note.
function ConnectionPanel() {
  const [info, setInfo] = useState<DesktopRemoteAccessInfo | null | undefined>(undefined);
  const [tab, setTab] = useState<'browser' | 'android'>('browser');
  useEffect(() => {
    let live = true;
    const host = (window as unknown as { mixdogDesktop?: DesktopApi }).mixdogDesktop;
    if (!host?.getRemoteAccessInfo) {
      setInfo(null);
      return () => { live = false; };
    }
    void host.getRemoteAccessInfo()
      .then((value) => { if (live) setInfo(value ?? null); })
      .catch(() => { if (live) setInfo(null); });
    return () => { live = false; };
  }, []);
  if (info === undefined) {
    return <Group title="Phone remote"><p className="settings-connection-note">Loading…</p></Group>;
  }
  if (info === null) {
    // Remote surface (phone/browser): the desktop API is absent by design —
    // report where this device is connected instead of desktop-only pairing.
    const remoteServer = (window as unknown as { mixdogRemoteServer?: string }).mixdogRemoteServer;
    if (remoteServer) {
      return <Group title="Phone remote">
        <p className="settings-connection-note">
          This device is paired and connected through <code>{remoteServer}</code>.
          Pairing QR codes for other devices live in the desktop app under
          Settings → Connection.
        </p>
      </Group>;
    }
    return <Group title="Phone remote">
      <p className="settings-connection-note">
        Remote access is unavailable in this session. On the desktop it is on by
        default; restart without MIXDOG_REMOTE_BRIDGE=0 to enable pairing.
      </p>
    </Group>;
  }
  // Relay-only pairing (user decision: Anywhere only, no LAN fallback) — the
  // LAN bridge stays a transport detail and never surfaces here.
  const browserQrSvg = info.relayBrowserQrSvg;
  const appQrSvg = info.relayAppQrSvg;
  if (!browserQrSvg || !appQrSvg) {
    return <Group title="Phone remote">
      <p className="settings-connection-note">
        Connecting to the Mixdog relay… reopen this page in a moment. If this
        persists, check this PC&apos;s internet connection.
      </p>
    </Group>;
  }
  return <Group title="Phone remote"
    description="Works on any network. Scan with the phone camera.">
    <nav className="settings-connection-tabs" aria-label="Platform">
      {([['browser', 'Browser'], ['android', 'Android']] as const)
        .map(([id, name]) => <button key={id} type="button"
          className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{name}</button>)}
    </nav>
    {tab === 'browser' && <div className="settings-connection-grid">
      <figure className="settings-connection-card">
        <div aria-hidden="true" dangerouslySetInnerHTML={{ __html: browserQrSvg }} />
        <figcaption><b>Open the web app</b><small>Works on iPhone and Android — nothing to install</small></figcaption>
      </figure>
    </div>}
    {tab === 'android' && <div className="settings-connection-grid">
      {info.apkQrSvg && <figure className="settings-connection-card">
        <div aria-hidden="true" dangerouslySetInnerHTML={{ __html: info.apkQrSvg }} />
        <figcaption><b>1 · Install</b><small>Downloads the Android app (APK)</small></figcaption>
      </figure>}
      <figure className="settings-connection-card">
        <div aria-hidden="true" dangerouslySetInnerHTML={{ __html: appQrSvg }} />
        <figcaption><b>2 · Pair</b><small>Connects the installed app to this PC</small></figcaption>
      </figure>
    </div>}
  </Group>;
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
  return <ChoicePanel title="" values={rows(output, 'styles')}
    active={String(record(output.current).id || output.configured || 'default')} pending={pending}
    emptyText="No output styles available." onChoose={(id) => void run('setOutputStyle', [id])} />;
}

function UpdatePanel({ data, pending, run }: PanelContext) {
  const update = record(data.update);
  const status = record(data.updateStatus);
  const busy = Boolean(pending);
  return <Group title="Update">
    <ResourceRow title="Current version" description={status.phase === 'installed'
      ? `v${status.version || update.latestVersion} installed — restart mixdog to apply.`
      : 'Installed mixdog version.'} meta={String(update.currentVersion || 'unknown')} />
    <ResourceRow title="Latest version" meta={String(update.latestVersion || 'unknown')}
      actions={<ActionButton disabled={busy} onClick={() => void run('checkForUpdate', [{ force: true }])}>Check now</ActionButton>} />
    <ToggleRow title="Auto-update" checked={update.autoUpdate === true}
      disabled={busy} onChange={(enabled) => void run('setAutoUpdate', [enabled])} />
    <ResourceRow title="Install update" actions={<ActionButton disabled={busy} onClick={() => void run('runUpdateNow')}>
      {status.phase === 'installed' ? `v${status.version || update.latestVersion} installed — restart to apply`
        : update.updateAvailable ? `Update to v${update.latestVersion || 'latest'}` : 'Update now'}</ActionButton>} />
  </Group>;
}

function ThemeChoices({ data, pending }: Pick<PanelContext, 'data' | 'pending'>) {
  const backendTheme = String(data.theme || 'basic');
  const [preference, setPreference] = useState<DesktopThemePreference>(() =>
    getDesktopThemePreference() || desktopThemePreferenceForTheme(backendTheme));
  useEffect(() => {
    setPreference(getDesktopThemePreference() || desktopThemePreferenceForTheme(backendTheme));
  }, [backendTheme]);
  // Desktop-local theme (user decision): the toggle persists to desktop
  // storage only and never writes the engine/TUI theme.
  const choose = (next: string) => {
    const selected = next as DesktopThemePreference;
    setPreference(selected);
    setDesktopThemePreference(selected);
  };
  return <Group title="Theme">
    <SelectRow title="Theme" value={preference} disabled={Boolean(pending)}
      options={[
        { value: 'system', label: 'System' },
        { value: 'white', label: 'White' },
        { value: 'dark', label: 'Dark' },
      ]}
      onChange={choose} />
  </Group>;
}

function GeneralPanel({ data, pending, run }: PanelContext) {
  const profile = record(data.profile);
  const autoClear = record(data.autoClear);
  const compaction = record(data.compaction);
  const providerDefaults = rows(autoClear.providerDefaults);
  const languageOptions = rows(profile.languages).map((entry) => ({ value: String(entry.id || entry.value || 'system'), label: label(entry) }));
  const busy = Boolean(pending);
  return <>
    <Group title="Profile">
      <AutoSaveRow title="Title" name="title" value={String(profile.title || '')}
        placeholder="Your name or role" disabled={busy}
        onSave={(title) => void run('setProfile', [{ title }])} />
      <SelectRow title="Language" value={String(profile.language || 'system')} disabled={busy}
        options={languageOptions} onChange={(language) => void run('setProfile', [{ language }])} />
    </Group>
        <ThemeChoices data={data} pending={pending} />
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

function ModelsPanel({ data, snapshot: liveSnapshot, pending, run, route, setFast, openCategory }: PanelContext) {
  const models = filterConfiguredModels(
    normalizeModelOptions(Array.isArray(data.models) ? data.models as DesktopModelOption[] : []),
    data.providerSetup,
  );
  const snapshot = Object.keys(record(liveSnapshot)).length
    ? record(liveSnapshot)
    : record(data.snapshot as EngineSnapshot);
  const currentKey = `${snapshot.provider || ''}:${snapshot.model || ''}`;
  const selected = models.find((model) => `${model.provider}:${model.model}` === currentKey);
  const mainFastCapable = snapshot.fastCapable === true || selected?.fastCapable === true;
  const searchRoute = record(data.searchRoute);
  const searchModels = filterConfiguredModels(
    normalizeModelOptions(rows(data.searchModels).map(routeOption)),
    data.providerSetup,
  );
  const busy = Boolean(pending);
  return <>
    <Group title="Main route">
      <div className="mixdog-settings__row settings-route-row">
        <div className="mixdog-settings__copy"><span className="mixdog-settings__row-title">Model</span></div>
        <div className="settings-row-control"><ModelPicker models={models}
          provider={String(snapshot.provider || '')} model={String(snapshot.model || '')}
          triggerLabel={selected
            ? modelDisplayName(selected.model, selected.provider, selected.display)
            : snapshot.model ? modelDisplayName(String(snapshot.model), String(snapshot.provider || '')) : 'Select model…'}
          ariaLabel="Model" triggerClassName="model-trigger settings-model-trigger"
          disabled={busy} onSelect={(model) => route(model)}
          onOpenProviders={() => openCategory?.('providers')} /></div>
      </div>
      <QuietSelectRow title="Effort" kind="effort" value={String(snapshot.effort || 'auto')}
        disabled={busy} options={(selected?.effortOptions || [{ value: 'auto', label: 'Auto' }]).map((entry) => ({ value: entry.value, label: entry.label }))}
        onChange={(value) => void run('setEffort', [value])} />
      <QuietSelectRow title="Fast mode" kind="fast"
        value={snapshot.fast === true ? 'on' : 'off'} disabled={busy || !mainFastCapable}
        options={[{ value: 'on', label: 'Fast On' }, { value: 'off', label: 'Fast Off' }]}
        onChange={(value) => void setFast(value === 'on')} />
    </Group>
    <Group title="Search route">
      <RouteEditor title="Web-search model"
        route={searchRoute} models={searchModels} disabled={busy}
        onChange={(selection) => run('setSearchRoute', [selection])}
        onOpenProviders={() => openCategory?.('providers')} />
    </Group>
  </>;
}

function AgentsPanel({ data, pending, run, openCategory }: PanelContext) {
  const agents = rows(data.agents);
  const workflows = rows(data.workflows);
  const models = filterConfiguredModels(
    normalizeModelOptions(Array.isArray(data.models) ? data.models as DesktopModelOption[] : []),
    data.providerSetup,
  );
  const busy = Boolean(pending);
  return <>
    <Group title="Workflow packs">{workflows.length ? workflows.map((workflow) => <ResourceRow key={String(workflow.id)}
      title={label(workflow)} description={String(workflow.description || '')} selected={workflow.active === true}
      actions={!workflow.active && <ActionButton disabled={busy} onClick={() => void run('setWorkflow', [workflow.id])}>Activate</ActionButton>} />)
      : <ListEmpty text="No workflows found." />}</Group>
    <Group title="Agent routes">{agents.length ? agents.map((agent) => {
      const route = record(agent.route);
      return <ResourceRow key={String(agent.id)} className="settings-agent-route" title={label(agent)}
        description={String(agent.description || record(agent.definition).description || '')}
        actions={<RouteEditor compact title={`${label(agent)} route`}
          route={route} models={models} disabled={busy}
          onChange={(selection) => run('setAgentRoute', [agent.id, selection], `agent-${agent.id}`)}
          onOpenProviders={() => openCategory?.('providers')} />} />;
    }) : <ListEmpty text="No agent routes found." />}</Group>
  </>;
}

function ProvidersPanel({ data, pending, run, confirm }: PanelContext) {
  const setup = record(data.providerSetup);
  const apiProviders = rows(setup.api);
  const oauthProviders = rows(setup.oauth);
  const localProviders = rows(setup.local);
  const busy = Boolean(pending);
  return <>
    <Group title="OAuth providers">{oauthProviders.length ? oauthProviders.map((provider) => <ResourceRow key={String(provider.id)} title={providerLabel(provider)}
      description={String(provider.detail || '')}
      status={provider.authenticated ? 'Connected' : String(provider.status || 'Not connected')}
      actions={<><OAuthControl provider={provider} disabled={busy} run={run} />
        {provider.authenticated && <ActionButton danger disabled={busy} onClick={() => {
          confirm({ title: 'Forget provider authentication?', description: `Remove the saved authentication for ${providerLabel(provider)}.`,
            confirmLabel: 'Forget', danger: true, onConfirm: () => void run('forgetProviderAuth', [provider.id]) });
        }}>Forget</ActionButton>}</>} />) : <ListEmpty text="No OAuth providers available." />}</Group>
    <Group title="API-key providers">{apiProviders.length ? apiProviders.map((provider) => <ResourceRow key={String(provider.id)} title={providerLabel(provider)}
      description={String(provider.detail || provider.envName || '')}
      status={provider.authenticated ? 'Connected' : String(provider.status || 'Not connected')}
      actions={<>{String(provider.id) === 'opencode-go' && <ActionButton disabled={busy}
        onClick={() => void run('loginOpenCodeGoUsage')}>Usage sign-in</ActionButton>}
        {!provider.authenticated && <form className="settings-provider-secret" onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const secret = new FormData(form).get('secret');
          form.reset();
          void run('saveProviderApiKey', [provider.id, secret], `provider-key-${String(provider.id)}`);
        }}>
          <input name="secret" type="password" autoComplete="off" placeholder="API key"
            aria-label={`${providerLabel(provider)} API key`} required />
          <button disabled={busy}>Save</button>
        </form>}
        {Boolean(provider.stored || (!provider.env && provider.authenticated)) &&
          <ActionButton danger disabled={busy} onClick={() => {
        confirm({ title: 'Forget provider authentication?', description: `Remove the saved authentication for ${providerLabel(provider)}.`,
          confirmLabel: 'Forget', danger: true, onConfirm: () => void run('forgetProviderAuth', [provider.id]) });
      }}>Forget</ActionButton>}</>} />) : <ListEmpty text="No API-key providers available." />}</Group>
    <Group title="Local providers">{localProviders.length ? localProviders.map((provider) => <React.Fragment key={String(provider.id)}>
      <ResourceRow title={providerLabel(provider)} description={String(provider.baseURL || provider.detail || '')}
        status={String(provider.status || (provider.detected ? 'Detected' : 'Off'))}
        actions={<ActionButton disabled={busy} onClick={() => void run('setLocalProvider', [provider.id, {
          enabled: provider.enabled !== true, baseURL: provider.baseURL,
        }])}>{provider.enabled ? 'Disable' : 'Enable'}</ActionButton>} />
      <FormRow title={`${providerLabel(provider)} endpoint`} description="Update the OpenAI-compatible base URL."
        onSubmit={(form) => void run('setLocalProvider', [provider.id, {
          enabled: provider.enabled === true, baseURL: form.get('baseURL'),
        }], `local-${provider.id}`)}>
        <input name="baseURL" type="url" defaultValue={String(provider.baseURL || provider.defaultURL || '')}
          aria-label={`${providerLabel(provider)} endpoint`}
          placeholder={String(provider.defaultURL || 'http://127.0.0.1:11434/v1')} required />
        <button disabled={busy}>Save</button>
      </FormRow>
    </React.Fragment>) : <ListEmpty text="No local providers available." />}</Group>
  </>;
}

export function OAuthControl({ provider, disabled, run, onComplete }: {
  provider: RecordValue;
  disabled: boolean;
  run: PanelContext['run'];
  onComplete?: () => void;
}) {
  const [flow, setFlow] = useState<RecordValue | null>(null);
  const [error, setError] = useState('');
  const providerId = String(provider.id || '');
  const refresh = async () => {
    if (!flow?.flowId) return;
    const next = await run<RecordValue>('getOAuthProviderLoginStatus', [flow.flowId], `oauth-status-${providerId}`, false);
    if (next) setFlow(record(next));
  };
  const start = async () => {
    setError('');
    const next = await run<RecordValue>('beginOAuthProviderLogin', [providerId], `oauth-begin-${providerId}`, false);
    if (next) setFlow(record(next));
  };
  const close = () => {
    const completed = flow?.state === 'complete';
    setFlow(null);
    if (completed) void run('getProviderSetup', [], `oauth-refresh-${providerId}`, true).then(() => onComplete?.());
  };
  return <>
    <ActionButton disabled={disabled} onClick={() => void start()}>{provider.authenticated ? 'Reconnect' : 'Connect'}</ActionButton>
    {flow && <div className="settings-oauth-layer" onMouseDown={(event) => {
      if (event.target === event.currentTarget) close();
    }}><section className="settings-oauth-dialog" role="dialog" aria-modal="true" data-settings-nested-dialog
      aria-label={`${providerLabel(provider)} OAuth login`}>
      <header><div><b>{providerLabel(provider)} OAuth</b><small>Complete the browser login or paste the returned code.</small></div>
        <button type="button" aria-label="Close OAuth login" autoFocus onClick={close}>×</button></header>
      <ResourceRow title="Status" description={String(flow.error || '')} status={String(flow.state || 'pending')} />
      {Boolean(flow.manualUrl || flow.url) && <label className="settings-oauth-url">Manual login URL
        <textarea readOnly value={String(flow.manualUrl || flow.url)} /></label>}
      {Boolean(flow.manualCodeSupported) && flow.state !== 'complete' && <form className="settings-oauth-code" onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const code = new FormData(form).get('code');
        form.reset();
        void run<RecordValue>('completeOAuthProviderLogin', [flow.flowId, code], `oauth-complete-${providerId}`, false)
          .then((next) => { if (next) setFlow(record(next)); })
          .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
      }}><input name="code" placeholder="Authorization code or redirect URL" required /><button disabled={disabled}>Complete</button></form>}
      {error && <p className="settings-field-error">{error}</p>}
      <footer><ActionButton disabled={disabled} onClick={() => void refresh()}>Check status</ActionButton>
        {flow.state !== 'complete' && <ActionButton danger disabled={disabled} onClick={() => {
          void run<RecordValue>('cancelOAuthProviderLogin', [flow.flowId], `oauth-cancel-${providerId}`, false)
            .then((next) => { if (next) setFlow(record(next)); });
        }}>Cancel login</ActionButton>}
        <ActionButton onClick={close}>Close</ActionButton></footer>
    </section></div>}
  </>;
}

function McpPanel({ data, pending, run }: PanelContext) {
  const status = record(data.mcp);
  const servers = rows(status, 'servers');
  const busy = Boolean(pending);
  return <>
    <Group title="Servers"
      description={`${status.connectedCount || 0} connected · ${status.failedCount || 0} failed`}>
      {servers.length ? servers.map((server) => <ResourceRow key={String(server.name)} title={String(server.name)}
        description={`${server.transport || 'transport unknown'}${server.error ? ` · ${server.error}` : ''}`}
        meta={`${server.toolCount || 0} tools`}
        status={String(server.status || 'unknown')}
        actions={<ActionButton disabled={busy} onClick={() => void run('setMcpServerEnabled', [server.name, server.enabled === false])}>
          {server.enabled === false ? 'Enable' : 'Disable'}
        </ActionButton>} />) : <ListEmpty text="No MCP servers configured." />}
    </Group>
  </>;
}

function SkillsPanel({ data, pending, run }: PanelContext) {
  const status = record(data.skills);
  const skills = rows(status, 'skills');
  const disabled = new Set((Array.isArray(record(data.disabledSkills).disabled) ? record(data.disabledSkills).disabled as unknown[] : []).map(String));
  const busy = Boolean(pending);
  const toggle = (name: string) => {
    const next = new Set(disabled);
    if (next.has(name)) next.delete(name); else next.add(name);
    void run('setDisabledSkills', [[...next]]);
  };
  return <>
    <Group>{skills.length ? skills.map((skill) => <ResourceRow key={String(skill.name)} title={String(skill.name)}
      description={String(skill.description || skill.filePath || '')} meta={String(skill.source || 'skill')}
      status={disabled.has(String(skill.name)) ? 'Disabled' : 'Enabled'}
      actions={<ActionButton disabled={busy} onClick={() => toggle(String(skill.name))}>{disabled.has(String(skill.name)) ? 'Enable' : 'Disable'}</ActionButton>} />)
        : <ListEmpty text="No skills found." />}
    </Group>
  </>;
}

function PluginsPanel({ data, pending, run, confirm }: PanelContext) {
  const status = record(data.plugins);
  const plugins = rows(status, 'plugins');
  const busy = Boolean(pending);
  return <>
    <Group title="Installed">{plugins.length ? plugins.map((plugin) => <ResourceRow key={String(plugin.id || plugin.name)} title={label(plugin)}
      description={String(plugin.description || plugin.root || '')} meta={`${plugin.version || 'unversioned'} · ${plugin.skillCount || 0} skills`}
      actions={<><ActionButton disabled={busy} onClick={() => void run('updatePlugin', [plugin])}>
        {plugin.sourceType === 'local' ? 'Update metadata' : 'Update plugin'}</ActionButton>
        {plugin.mcpScript && <ActionButton disabled={busy}
          onClick={() => void run('enablePluginMcp', [plugin])}>{plugin.mcpEnabled ? 'Reconfigure MCP' : 'Enable MCP'}</ActionButton>}
        {Boolean(plugin.root) && <ActionButton disabled={busy} onClick={() => {
          void navigator.clipboard?.writeText(String(plugin.root));
        }}>Copy root</ActionButton>}
        {Boolean(plugin.mcpServerName) && <ActionButton disabled={busy} onClick={() => {
          void navigator.clipboard?.writeText(String(plugin.mcpServerName));
        }}>Copy MCP name</ActionButton>}
        <ActionButton danger disabled={busy} onClick={() => {
          confirm({ title: 'Remove plugin?', description: `${label(plugin)} will be removed from Mixdog.`,
            confirmLabel: 'Remove', danger: true, onConfirm: () => void run('removePlugin', [plugin]) });
        }}><Trash2 size={13} /></ActionButton></>} />) : <ListEmpty text="No plugins installed." />}
    </Group>
    <Group title="Install plugin" description="Local path, Git URL, or supported registry source.">
      <FormRow title="Plugin source"
      onSubmit={(form) => void run('addPlugin', [form.get('source')])}>
      <input name="source" placeholder="https://github.com/org/plugin or C:\path" required /><button disabled={busy}>Install</button>
      </FormRow>
    </Group>
  </>;
}

function HooksPanel({ data, pending, run }: PanelContext) {
  const status = record(data.hooks);
  const rules = rows(status, 'rules');
  const busy = Boolean(pending);
  return <>
    <Group title="Rules"
      description={`${status.ruleCount || rules.length} rules · ${status.configMode || 'standalone'}`}>
      {rules.length ? rules.map((rule, index) => <ResourceRow key={String(rule.index ?? index)} title={`${rule.tool || '*'} → ${rule.action || 'ask'}`}
        description={String(rule.match || rule.reason || '')} status={rule.enabled === false ? 'Disabled' : 'Enabled'}
        actions={<ActionButton disabled={busy} onClick={() => void run('setHookRuleEnabled', [Number(rule.index ?? index), rule.enabled === false])}>
          {rule.enabled === false ? 'Enable' : 'Disable'}
        </ActionButton>} />) : <ListEmpty text="No hook rules configured." />}
    </Group>
  </>;
}

function MemoryPanel({ data, pending, run, confirm }: PanelContext) {
  const memory = record(data.memory);
  const busy = Boolean(pending);
  return <>
    <Group><ToggleRow title="Memory enabled" description="Enable memory recap and curated core memories."
      checked={memory.enabled !== false} disabled={busy} onChange={(enabled) => void run('setMemoryEnabled', [enabled])} /></Group>
    <section className="settings-group core-memory-section">
      <header><h3>Core memories</h3><p>User-curated memories shared across Mixdog sessions.</p></header>
      <CoreMemoryManager initialValue={data.coreMemory} pending={pending} run={run} confirm={confirm} />
    </section>
  </>;
}

type CoreMemoryEntry = {
  id: number;
  projectId: string | null;
  element: string;
  summary: string;
  singleSentence: boolean;
};

function parseCoreMemoryEntries(value: unknown): CoreMemoryEntry[] {
  let projectId: string | null = null;
  const entries: CoreMemoryEntry[] = [];
  for (const line of String(value || '').split('\n').map((entry) => entry.trim()).filter(Boolean)) {
    if (line.endsWith(':') && !line.includes('id=')) {
      const scope = line.slice(0, -1);
      projectId = scope === 'COMMON' ? null : scope;
      continue;
    }
    const match = line.match(/^id=(\d+)\s+(.+?)(?:\s+—\s+(.+))?$/);
    if (!match) continue;
    const element = match[2];
    const rawSummary = match[3] || '';
    entries.push({
      id: Number(match[1]),
      projectId,
      element,
      summary: rawSummary || element,
      singleSentence: element === rawSummary,
    });
  }
  return entries.sort((left, right) => right.id - left.id);
}

function memoryResultError(value: unknown): string {
  const text = String(value || '').trim();
  return /^(?:core (?:add|edit|delete|promote|dismiss)(?::| failed)|core:.*(?:not initialized|failed|error)|(?:error|failed)\b)/i.test(text)
    ? text
    : '';
}

function CoreMemoryManager({ initialValue, pending, run, confirm }: {
  initialValue: unknown;
  pending: string;
  run: PanelContext['run'];
  confirm: PanelContext['confirm'];
}) {
  const [entries, setEntries] = useState<CoreMemoryEntry[]>(() => parseCoreMemoryEntries(initialValue));
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<number | null>(null);
  const loaded = useRef(false);
  const refresh = async () => {
    const result = await run<unknown>('memoryControl', [
      { action: 'core', op: 'list', project_id: '*' }, { silent: true },
    ], 'core-memory-list', false);
    if (result !== undefined) setEntries(parseCoreMemoryEntries(result));
  };
  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    if (initialValue === undefined) void refresh();
  }, []);
  useEffect(() => {
    if (initialValue !== undefined) setEntries(parseCoreMemoryEntries(initialValue));
  }, [initialValue]);
  const mutate = async (input: RecordValue) => {
    setError('');
    const result = await run<unknown>('memoryControl', [input, { silent: true }], `core-${input.op}`, false);
    const failure = memoryResultError(result);
    if (failure) {
      setError(failure);
      return false;
    }
    if (result !== undefined) await refresh();
    return result !== undefined;
  };
  return <div className="core-memory-manager">
    <section className="core-memory-add-card">
      <header><b>Add memory</b><small>Save a durable fact or preference for future sessions.</small></header>
      <form className="core-memory-add" onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const sentence = String(new FormData(form).get('sentence') || '').trim();
        if (!sentence) return;
        void mutate({ action: 'core', op: 'add', project_id: 'common', element: sentence, summary: sentence })
          .then((ok) => { if (ok) form.reset(); });
      }}><input name="sentence" aria-label="Memory to add" placeholder="What should Mixdog remember?" maxLength={2000} required />
        <button disabled={Boolean(pending)}>Add memory</button></form>
    </section>
    {entries.length ? <div className="core-memory-list">
      {entries.map((entry) => editing === entry.id ? <form className="core-memory-edit" key={entry.id} onSubmit={(event) => {
        event.preventDefault();
        const summary = String(new FormData(event.currentTarget).get('summary') || '').trim();
        if (!summary) return;
        const payload: RecordValue = { action: 'core', op: 'edit', id: entry.id, project_id: entry.projectId, summary };
        if (entry.singleSentence) payload.element = summary;
        void mutate(payload).then((ok) => { if (ok) setEditing(null); });
      }}><input name="summary" aria-label="Memory text" defaultValue={entry.summary} maxLength={2000} required autoFocus />
        <span className="core-memory-scope">{entry.projectId || 'Common'}</span>
        <div className="core-memory-actions"><button disabled={Boolean(pending)}>Save</button>
          <button type="button" onClick={() => setEditing(null)}>Cancel</button></div></form>
        : <div className="core-memory-row" key={entry.id}><div className="core-memory-copy"><b>{entry.summary}</b></div>
          <span className="core-memory-scope">{entry.projectId || 'Common'}</span>
          <div className="core-memory-actions"><button disabled={Boolean(pending)} onClick={() => setEditing(entry.id)}>Edit</button>
          <button className="danger" disabled={Boolean(pending)} onClick={() => {
            confirm({ title: 'Delete memory?', description: `Memory #${entry.id} will be removed permanently.`,
              confirmLabel: 'Delete', danger: true,
              onConfirm: () => void mutate({ action: 'core', op: 'delete', id: entry.id, project_id: entry.projectId }) });
          }}>Delete</button></div></div>)}
    </div> : <div className="core-memory-list core-memory-list--empty"><Empty text="No core memories yet." /></div>}
    {error && <p className="settings-field-error">{error}</p>}
  </div>;
}

function ChannelsPanel({ data, snapshot, pending, run, notice }: PanelContext) {
  const channels = record(data.channels);
  const setup = record(data.channelSetup);
  const worker = record(data.channelWorker);
  const channel = record(setup.channel);
  const webhook = record(setup.webhook);
  const voice = record(data.voice);
  const progress = record(record(snapshot).progressHint);
  const voiceComponents = record(voice.components);
  const busy = Boolean(pending);
  const persistedBackend = String(setup.backend || 'discord');
  const [backend, setBackendChoice] = useState(persistedBackend);
  const optimisticBackend = useRef<string | null>(null);
  useEffect(() => {
    if (optimisticBackend.current && optimisticBackend.current !== persistedBackend) return;
    optimisticBackend.current = null;
    setBackendChoice(persistedBackend);
  }, [persistedBackend]);
  return <>
    <Group title="Channel service">
      {/* Messaging-only toggle: schedules/webhooks run sessions through the
          automation runtime and no longer depend on this switch. */}
      <ToggleRow title="Channels enabled" description={channels.enabled === false
        ? 'Discord and Telegram messaging is disabled. Schedules and webhooks keep running.'
        : 'Discord and Telegram messaging is enabled.'}
        checked={channels.enabled !== false} disabled={busy}
        onChange={(enabled) => void run('setChannelsEnabled', [enabled])} />
      <SelectRow title="Channel" description="Primary outbound channel backend." value={backend} disabled={busy}
        options={[{ value: 'discord', label: 'Discord' }, { value: 'telegram', label: 'Telegram' }]}
        onChange={(value) => {
          optimisticBackend.current = value;
          setBackendChoice(value);
          void run('setBackend', [value], 'channel-backend', false).then((result) => {
            if (result === undefined) {
              optimisticBackend.current = null;
              setBackendChoice(persistedBackend);
              return;
            }
            const channelLabel = value === 'telegram' ? 'Telegram' : 'Discord';
            notice(data.remote === true || worker.running
              ? `Channel set to ${channelLabel}. Restart remote to apply.`
              : `Channel set to ${channelLabel}.`);
          });
        }} />
      <ResourceRow title="Voice transcription"
        description={progress.text ? String(progress.text) : voice.installed
          ? 'Managed Whisper and ffmpeg runtime is ready for incoming channel voice messages.'
          : `Runtime components · Whisper ${voiceComponents.whisper ? 'ready' : 'missing'} · model ${voiceComponents.model ? 'ready' : 'missing'} · ffmpeg ${voiceComponents.ffmpeg ? 'ready' : 'missing'}`}
        status={voice.enabled ? 'On' : progress.text || voice.busy ? 'Installing…' : 'Off'}
        actions={<ActionButton disabled={busy || voice.busy === true}
          onClick={() => void run('toggleVoice', [], 'voice-toggle')}>
          {voice.enabled ? 'Disable voice' : voice.installed ? 'Enable voice' : 'Install & enable'}
        </ActionButton>} />
    </Group>
    <Group title="Discord">
      <SecretForm title="Discord bot token" status={record(setup.discord)} disabled={busy}
        onSave={(secret) => void run('saveDiscordToken', [secret])} />
      <AutoSaveRow title="Main channel" name="discordChannelId"
        value={String(channel.discordChannelId || (setup.backend !== 'telegram' ? channel.channelId || '' : ''))}
        placeholder="Discord channel ID" required disabled={busy}
        onSave={(channelId) => void run('setChannel', [{ backend: 'discord', channelId }])} />
    </Group>
    <Group title="Telegram">
      <SecretForm title="Telegram bot token" status={record(setup.telegram)} disabled={busy}
        onSave={(secret) => void run('saveTelegramToken', [secret])} />
      <AutoSaveRow title="Main chat" name="telegramChatId"
        value={String(channel.telegramChatId || (setup.backend === 'telegram' ? channel.channelId || '' : ''))}
        placeholder="Telegram chat ID" required disabled={busy}
        onSave={(channelId) => void run('setChannel', [{ backend: 'telegram', channelId }])} />
    </Group>
    <Group title="Webhook ingress">
      {/* Relay tunnel replaced ngrok: the public URL is issued automatically —
          endpoint management lives on the main-pane Webhooks page. */}
      <ResourceRow title="Public webhook URL"
        description={webhook.publicUrl
          ? String(webhook.publicUrl)
          : 'Issued automatically by the Mixdog relay once the channel runtime connects.'}
        status={webhook.publicUrl ? 'Active' : 'Waiting'} />
    </Group>
  </>;
}

function SystemPanel(context: PanelContext) {
  const { data, pending, run } = context;
  const worker = record(data.channelWorker);
  const busy = Boolean(pending);
  return <>
    <Group>
      <ToggleRow title="Remote runtime" description={worker.running
        ? `Channel runtime running · PID ${worker.pid || '?'}`
        : 'Channel runtime stopped.'}
        checked={data.remote === true} disabled={busy} onChange={() => void run('toggleRemote')} />
    </Group>
    <UpdatePanel {...context} />
    <Group title="Doctor">
      <ResourceRow title="Diagnostics" description="Check the runtime, providers, integrations, and local installation."
        actions={<ActionButton disabled={busy} onClick={() => void run('runDoctor')}>Run doctor</ActionButton>} />
    </Group>
  </>;
}

function SecretForm({ title, status, disabled, onSave }: {
  title: string; status: RecordValue; disabled: boolean; onSave(secret: string): void;
}) {
  const saved = status.stored === true || status.authenticated === true || String(status.status || '').toLowerCase() === 'set';
  const visibleStatus = status.problem ? String(status.status || 'Invalid') : saved ? 'Saved' : undefined;
  return <FormRow title={title} status={visibleStatus}
    description={String(status.problem || status.status || 'Not configured')} resetOnSubmit
    onSubmit={(form) => onSave(String(form.get('secret') || ''))}>
    <input name="secret" type="password" autoComplete="off" aria-label={title}
      placeholder={saved ? '••••••••  Saved' : 'Secret'} required disabled={disabled} />
    <button disabled={disabled}>{saved ? 'Replace' : 'Save'}</button>
  </FormRow>;
}

// Schedules and webhook endpoints both moved to dedicated main-pane pages
// (sidebar → Schedules / Webhooks); settings keeps channel wiring only.

function DiagnosticsPanel({ data, pending, run, confirm }: PanelContext) {
  const update = record(data.update);
  const status = record(data.updateStatus);
  const busy = Boolean(pending);
  return <>
    <Group title="Updates">
      <ToggleRow title="Automatic updates" description={`Current ${update.currentVersion || 'unknown'}${update.latestVersion ? ` · latest ${update.latestVersion}` : ''}`}
        checked={update.autoUpdate === true} disabled={busy} onChange={(enabled) => void run('setAutoUpdate', [enabled])} />
      <div className="settings-button-row"><ActionButton disabled={busy} onClick={() => void run('checkForUpdate', [{ force: true }])}>Check now</ActionButton>
        {Boolean(update.updateAvailable) && <ActionButton disabled={busy} onClick={() => {
          confirm({ title: 'Install available update?', description: 'Mixdog may need to restart after the update is installed.',
            confirmLabel: 'Install update', onConfirm: () => void run('runUpdateNow') });
        }}>Install update</ActionButton>}</div>
      {Boolean(status.phase) && <ResourceRow title="Update process" description={String(status.message || status.detail || '')}
        status={String(status.phase)} />}
    </Group>
    <Group title="Doctor"><ActionButton disabled={busy} onClick={() => void run('runDoctor')}>Run full diagnostics</ActionButton></Group>
    <Group title="Context status"><ContextStatusView value={data.context} /></Group>
    <Group title="Provider usage"><UsageDashboard value={data.usage} /></Group>
  </>;
}

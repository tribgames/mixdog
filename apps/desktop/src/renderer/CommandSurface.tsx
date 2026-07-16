import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { RefreshCw, Trash2, X } from 'lucide-react';
import type { DesktopApi, DesktopCapability, DesktopModelOption } from '../shared/contract';
import type { CommandSurface as CommandSurfaceName } from './slash-commands';

type Row = Record<string, unknown>;
type SurfaceApi = Pick<DesktopApi, 'invokeCapability'> &
  Partial<Pick<DesktopApi, 'listProviderModels'>>;

function record(value: unknown): Row {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
}
function rows(value: unknown, key: string): Row[] {
  const source = record(value);
  return Array.isArray(source[key]) ? (source[key] as unknown[]).map(record) : [];
}
function pretty(value: unknown) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

const LOADERS: Record<CommandSurfaceName, DesktopCapability[]> = {
  agents: ['listAgents'],
  memory: ['getMemorySettings', 'memoryControl'],
  schedules: ['getChannelSetup', 'isRemoteEnabled'],
  webhooks: ['getChannelSetup', 'isRemoteEnabled'],
  channels: ['getChannelSettings', 'getChannelSetup', 'getChannelWorkerStatus', 'isRemoteEnabled', 'getVoiceStatus'],
  context: ['contextStatus'],
  usage: ['getUsageDashboard'],
  doctor: ['runDoctor'],
  effort: [],
};

export function CommandSurface({ surface, api = window.mixdogDesktop, onClose, onOpen }: {
  surface: CommandSurfaceName;
  api?: SurfaceApi;
  onClose(): void;
  onOpen(surface: CommandSurfaceName): void;
}) {
  const dialog = useRef<HTMLElement>(null);
  const [data, setData] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setError('');
    try {
      const capabilities = LOADERS[surface];
      const [values, models] = await Promise.all([
        Promise.all(capabilities.map((capability) => {
          const args = capability === 'memoryControl'
            ? [{ action: 'core', op: 'list', project_id: '*' }, { silent: true }]
            : capability === 'getUsageDashboard' && refresh ? [{ refresh: true }] : [];
          return api.invokeCapability({ capability, args }).then((result) => result.value);
        })),
        surface === 'agents'
          ? api.listProviderModels?.({ quick: false, ...(refresh ? { force: true } : {}) }) ?? []
          : Promise.resolve([]),
      ]);
      setData({
        ...Object.fromEntries(capabilities.map((capability, index) => [capability, values[index]])),
        models,
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [api, surface]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const prior = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
    };
    document.addEventListener('keydown', keydown, true);
    return () => { document.removeEventListener('keydown', keydown, true); prior?.focus(); };
  }, [onClose]);
  const run = async (capability: DesktopCapability, args: unknown[] = []) => {
    if (pending) return undefined;
    setPending(capability);
    setError('');
    try {
      const result = await api.invokeCapability({ capability, args });
      await load();
      return result.value;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return undefined;
    } finally { setPending(''); }
  };
  const title = ({
    agents: 'Agents', memory: 'Memory', schedules: 'Schedules', webhooks: 'Webhooks',
    channels: 'Channels', context: 'Context', usage: 'Provider usage',
    doctor: 'Doctor', effort: 'Reasoning effort',
  })[surface];
  return createPortal(<div className="mixdog-settings-layer">
    <section ref={dialog} className="mixdog-settings command-surface" role="dialog" aria-modal="true"
      aria-labelledby="command-surface-title" tabIndex={-1}>
      <div className="mixdog-settings__panel">
        <header className="mixdog-settings__header"><h1 id="command-surface-title">{title}</h1>
          <button className="mixdog-settings__close" onClick={onClose} aria-label={`Close ${title}`}><X size={16} /></button>
        </header>
        <div className="mixdog-settings__body">
          <div className="settings-section-heading"><div><h2>/{surface}</h2>
            <p>A dedicated command surface backed by the active Mixdog session.</p></div>
            {surface !== 'doctor' && <button className="settings-refresh" disabled={Boolean(pending)}
              onClick={() => void load(true)}><RefreshCw size={14} /> Refresh</button>}
          </div>
          {loading ? <p className="settings-loading" role="status">Loading…</p>
            : <SurfaceBody surface={surface} data={data} pending={pending} run={run} onOpen={onOpen} />}
          {error && <p className="mixdog-settings__error" role="alert">{error}</p>}
        </div>
      </div>
    </section>
  </div>, document.body);
}

function SurfaceBody({ surface, data, pending, run, onOpen }: {
  surface: CommandSurfaceName;
  data: Record<string, unknown>;
  pending: string;
  run(capability: DesktopCapability, args?: unknown[]): Promise<unknown>;
  onOpen(surface: CommandSurfaceName): void;
}) {
  const busy = Boolean(pending);
  if (surface === 'agents') {
    const agents = Array.isArray(data.listAgents) ? data.listAgents as Row[] : [];
    const models = Array.isArray(data.models) ? data.models as DesktopModelOption[] : [];
    return <Group title="Available workflow agents">{agents.map((agent) =>
      <Resource key={String(agent.id)} title={String(agent.label || agent.id)}
        detail={String(agent.description || record(agent.definition).description || '')}
        actions={<select aria-label={`${String(agent.label || agent.id)} model`}
          disabled={busy} value={routeKey(record(agent.route))}
          onChange={(event) => {
            const model = models.find((entry) => `${entry.provider}:${entry.model}` === event.currentTarget.value);
            if (model) void run('setAgentRoute', [agent.id, { provider: model.provider, model: model.model }]);
          }}>
          {!models.some((model) => `${model.provider}:${model.model}` === routeKey(record(agent.route))) &&
            <option value={routeKey(record(agent.route))}>{routeLabel(record(agent.route))}</option>}
          {models.map((model) => <option key={`${model.provider}:${model.model}`}
            value={`${model.provider}:${model.model}`}>{model.display || model.model} · {model.provider}</option>)}
        </select>} />)}
      {!agents.length && <p>No agents found.</p>}</Group>;
  }
  if (surface === 'memory') return <MemoryBody data={data} busy={busy} run={run} />;
  if (surface === 'context' || surface === 'usage' || surface === 'doctor') {
    const value = data[LOADERS[surface][0]];
    return <Group title={surface === 'doctor' ? 'Diagnostic result' : 'Current status'}>
      <pre className="tool-detail">{pretty(value) || 'No data available.'}</pre>
      {surface === 'doctor' && <button disabled={busy} onClick={() => void run('runDoctor')}>Run diagnostics again</button>}
    </Group>;
  }
  if (surface === 'effort') {
    return <Group title="Set reasoning effort"><form onSubmit={(event) => {
      event.preventDefault();
      const value = String(new FormData(event.currentTarget).get('effort') || '').trim();
      if (value) void run('setEffort', [value]);
    }}><input name="effort" placeholder="auto, low, medium, high, xhigh…" required />
      <button disabled={busy}>Apply</button></form></Group>;
  }
  if (surface === 'channels') return <ChannelsBody data={data} busy={busy} run={run} onOpen={onOpen} />;
  return <AutomationBody kind={surface} data={data} busy={busy} run={run} />;
}

function MemoryBody({ data, busy, run }: { data: Record<string, unknown>; busy: boolean; run: SurfaceRun }) {
  const enabled = record(data.getMemorySettings).enabled !== false;
  const entries = parseMemories(data.memoryControl);
  const [editing, setEditing] = useState<number | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);
  const mutate = (input: Row) => run('memoryControl', [input, { silent: true }]);
  return <><Group title="Memory runtime"><label><input type="checkbox" checked={enabled} disabled={busy}
    onChange={() => void run('setMemoryEnabled', [!enabled])} /> Background memory</label></Group>
    <Group title="Core memories"><form onSubmit={(event) => {
      event.preventDefault(); const form = event.currentTarget;
      const sentence = String(new FormData(form).get('sentence') || '').trim();
      if (sentence) void mutate({ action: 'core', op: 'add', project_id: 'common', element: sentence, summary: sentence })
        .then(() => form.reset());
    }}><input name="sentence" placeholder="Add a memory" required /><button disabled={busy}>Add</button></form>
      {entries.map((entry) => editing === entry.id
        ? <form key={entry.id} onSubmit={(event) => {
          event.preventDefault();
          const summary = String(new FormData(event.currentTarget).get('summary') || '').trim();
          if (!summary) return;
          const input: Row = { action: 'core', op: 'edit', id: entry.id, project_id: entry.projectId, summary };
          if (entry.singleSentence) input.element = summary;
          void mutate(input).then(() => setEditing(null));
        }}><input name="summary" defaultValue={entry.summary} autoFocus required />
          <button disabled={busy}>Save</button><button type="button" onClick={() => setEditing(null)}>Cancel</button></form>
        : <Resource key={String(entry.id)} title={`#${entry.id} ${entry.summary}`}
          detail={String(entry.projectId || 'Common')} actions={confirming === entry.id
            ? <><span>Delete this memory?</span><button disabled={busy} onClick={() => setConfirming(null)}>Cancel</button>
              <button className="danger" disabled={busy} onClick={() => void mutate({
                action: 'core', op: 'delete', id: entry.id, project_id: entry.projectId,
              }).then(() => setConfirming(null))}><Trash2 size={13} /> Confirm delete</button></>
            : <><button disabled={busy} onClick={() => setEditing(entry.id)}>Edit</button>
              <button className="danger" disabled={busy} onClick={() => setConfirming(entry.id)}>
                <Trash2 size={13} /> Delete</button></>} />)}</Group></>;
}

type SurfaceRun = (capability: DesktopCapability, args?: unknown[]) => Promise<unknown>;
function ChannelsBody({ data, busy, run, onOpen }: {
  data: Record<string, unknown>; busy: boolean; run: SurfaceRun; onOpen(surface: CommandSurfaceName): void;
}) {
  const setup = record(data.getChannelSetup);
  const channel = record(setup.channel);
  const channelSettings = record(data.getChannelSettings);
  const voice = record(data.getVoiceStatus);
  return <><Group title="Runtime"><Resource title={data.isRemoteEnabled ? 'Remote enabled' : 'Remote disabled'}
    detail={pretty(data.getChannelWorkerStatus)} actions={<button disabled={busy}
      onClick={() => void run(data.isRemoteEnabled ? 'toggleRemote' : 'claimRemote')}>
      {data.isRemoteEnabled ? 'Stop remote' : 'Claim remote'}</button>} />
    <label><input type="checkbox" checked={channelSettings.enabled !== false} disabled={busy}
      onChange={() => void run('setChannelsEnabled', [channelSettings.enabled === false])} /> Channels enabled</label>
    <label><input type="checkbox" checked={voice.enabled === true} disabled={busy || voice.busy === true}
      onChange={() => void run('toggleVoice')} /> Voice transcription</label>
    <label>Backend <select defaultValue={String(setup.backend || 'discord')} disabled={busy}
      onChange={(event) => void run('setBackend', [event.currentTarget.value])}>
      <option value="discord">Discord</option><option value="telegram">Telegram</option></select></label></Group>
    <Group title="Channel target"><form onSubmit={(event) => {
      event.preventDefault(); const form = new FormData(event.currentTarget);
      void run('setChannel', [{ backend: form.get('backend'), channelId: form.get('channelId') }]);
    }}><select name="backend" defaultValue={String(setup.backend || 'discord')}><option value="discord">Discord</option>
      <option value="telegram">Telegram</option></select>
      <input name="channelId" defaultValue={String(channel.channelId || '')} placeholder="Channel / chat ID" required />
      <button disabled={busy}>Save</button></form></Group>
    <Group title="Authentication">{([
      ['Discord bot token', 'saveDiscordToken'],
      ['Telegram bot token', 'saveTelegramToken'],
      ['Webhook / ngrok auth token', 'saveWebhookAuthtoken'],
    ] as const).map(([label, capability]) => <form key={capability} onSubmit={(event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const secret = String(new FormData(form).get('secret') || '');
      if (secret) void run(capability, [secret]).then(() => form.reset());
    }}><label>{label}<input name="secret" type="password" autoComplete="off" required /></label>
      <button disabled={busy}>Save</button></form>)}</Group>
    <Group title="Webhook ingress"><form onSubmit={(event) => {
      event.preventDefault();
      const domain = new FormData(event.currentTarget).get('domain');
      void run('setWebhookConfig', [{ ngrokDomain: domain }]);
    }}><input name="domain" defaultValue={String(record(setup.webhook).ngrokDomain || '')}
      placeholder="ngrok domain" required /><button disabled={busy}>Save</button></form></Group>
    <Group title="Automation"><button onClick={() => onOpen('schedules')}>Manage schedules</button>
      <button onClick={() => onOpen('webhooks')}>Manage webhooks</button></Group></>;
}

function AutomationBody({ kind, data, busy, run }: {
  kind: 'schedules' | 'webhooks'; data: Record<string, unknown>; busy: boolean; run: SurfaceRun;
}) {
  const list = rows(data.getChannelSetup, kind);
  const toggle = kind === 'schedules' ? 'setScheduleEnabled' : 'setWebhookEnabled';
  const remoteEnabled = data.isRemoteEnabled === true;
  return <Group title={kind === 'schedules' ? 'Scheduled prompts' : 'Inbound webhook endpoints'}>
    {list.map((item) => <Resource key={String(item.name)} title={String(item.name)}
      detail={`${pretty(item)}${remoteEnabled ? '' : '\nChannel off'}`} actions={<><button disabled={busy || !remoteEnabled}
        onClick={() => void run(toggle, [item.name, item.enabled === false])}>
        {item.enabled === false ? 'Enable' : 'Disable'}</button></>} />)}
    {!list.length && <p>No {kind} configured.</p>}
  </Group>;
}

function routeKey(route: Row) {
  return `${String(route.provider || '')}:${String(route.model || '')}`;
}
function routeLabel(route: Row) {
  return route.model ? `${String(route.model)} · ${String(route.provider || 'default')}` : 'Select model…';
}

function parseMemories(value: unknown): Array<{
  id: number; summary: string; projectId: string | null; singleSentence: boolean;
}> {
  let projectId: string | null = null;
  return String(value || '').split('\n').flatMap((line) => {
    const text = line.trim();
    if (text.endsWith(':') && !text.includes('id=')) { projectId = text === 'COMMON:' ? null : text.slice(0, -1); return []; }
    const match = text.match(/^id=(\d+)\s+(.+?)(?:\s+—\s+(.+))?$/);
    return match ? [{
      id: Number(match[1]),
      summary: match[3] || match[2],
      projectId,
      singleSentence: match[2] === (match[3] || ''),
    }] : [];
  });
}
function Group({ title, children }: React.PropsWithChildren<{ title: string }>) {
  return <section className="settings-group"><header><h3>{title}</h3></header><div className="settings-group-body">{children}</div></section>;
}
function Resource({ title, detail, actions }: { title: string; detail?: string; actions?: React.ReactNode }) {
  return <div className="settings-resource"><div><b>{title}</b>{detail && <p>{detail}</p>}</div>
    {actions && <div className="settings-resource-actions">{actions}</div>}</div>;
}

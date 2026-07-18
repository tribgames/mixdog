import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Trash2, X } from 'lucide-react';
import type { DesktopApi, DesktopCapability, DesktopModelOption } from '../shared/contract';
import type { CommandSurface as CommandSurfaceName } from './slash-commands';
import { OpenSelect } from './OpenSelect';
import { modelOptionLabel } from './provider-display';
import { acquireModalLayer } from './modal-layer';

type Row = Record<string, unknown>;
type SurfaceApi = Pick<DesktopApi, 'invokeCapability'> &
  Partial<Pick<DesktopApi, 'listProviderModels' | 'getSnapshot'>>;

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

function preferredEffort(model: DesktopModelOption | undefined): string | undefined {
  if (!model?.effortOptions.length) return undefined;
  if (model.savedEffort && model.effortOptions.some((entry) => entry.value === model.savedEffort)) {
    return model.savedEffort;
  }
  for (const value of ['high', 'medium', 'low', 'none', 'xhigh', 'max', 'ultra']) {
    if (model.effortOptions.some((entry) => entry.value === value)) return value;
  }
  return model.effortOptions[0]?.value;
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
  const surfaceLayer = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const loadSequence = useRef(0);
  const loadingSurface = useRef<CommandSurfaceName | null>(null);
  const [data, setData] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    if (loadingSurface.current === surface) return;
    const request = ++loadSequence.current;
    loadingSurface.current = surface;
    setLoading(true);
    setError('');
    try {
      const capabilities = LOADERS[surface];
      const [values, models, snapshot] = await Promise.all([
        Promise.all(capabilities.map((capability) => {
          const args = capability === 'memoryControl'
            ? [{ action: 'core', op: 'list', project_id: '*' }, { silent: true }]
            : [];
          return api.invokeCapability({ capability, args }).then((result) => result.value);
        })),
        surface === 'agents'
          ? api.listProviderModels?.({ quick: false }) ?? []
          : Promise.resolve([]),
        surface === 'effort' || surface === 'context'
          ? api.getSnapshot?.() ?? null
          : Promise.resolve(null),
      ]);
      if (loadSequence.current === request) {
        setData({
          ...Object.fromEntries(capabilities.map((capability, index) => [capability, values[index]])),
          models,
          snapshot,
        });
      }
    } catch (reason) {
      if (loadSequence.current === request) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (loadSequence.current === request) setLoading(false);
      if (loadingSurface.current === surface) loadingSurface.current = null;
    }
  }, [api, surface]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const prior = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const shell = document.querySelector<HTMLElement>('.app-shell');
    const isolatedElements = Array.from(shell?.children || [])
      .filter((element): element is HTMLElement =>
        element instanceof HTMLElement && !element.matches('.oc-toast-region'));
    const layer = acquireModalLayer(isolatedElements);
    layer.attachSurface(surfaceLayer.current);
    dialog.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (!layer.isTop()) return;
      if (event.key === 'Escape') {
        // OpenSelect menus are portaled to document.body and own the first Escape.
        if (document.querySelector('.oc-menu[role="listbox"]')) return;
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const openMenu = document.querySelector<HTMLElement>('.oc-menu[role="listbox"]');
      if (openMenu?.contains(document.activeElement)) return;
      const focusable = Array.from(dialog.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), ' +
        'select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) || []).filter((element) => element.getClientRects().length > 0);
      if (!focusable.length) {
        event.preventDefault();
        dialog.current?.focus();
        return;
      }
      const current = focusable.indexOf(document.activeElement as HTMLElement);
      const next = event.shiftKey
        ? (current <= 0 ? focusable.length - 1 : current - 1)
        : (current < 0 || current === focusable.length - 1 ? 0 : current + 1);
      event.preventDefault();
      focusable[next]?.focus();
    };
    document.addEventListener('keydown', keydown, true);
    return () => {
      document.removeEventListener('keydown', keydown, true);
      layer.release();
      prior?.focus();
    };
  }, []);
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
  return createPortal(<div ref={surfaceLayer} className="mixdog-settings-layer" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <section ref={dialog} className="mixdog-settings command-surface" data-surface={surface}
      role="dialog" aria-modal="true"
      aria-labelledby="command-surface-title" aria-describedby="command-surface-description" tabIndex={-1}
      aria-busy={loading || Boolean(pending)}>
      <div className="mixdog-settings__panel">
        <header className="mixdog-settings__header"><h1 id="command-surface-title">{title}</h1>
          <div className="command-surface-header-actions">
            <button className="mixdog-settings__close" onClick={onClose} aria-label={`Close ${title}`}><X size={16} /></button>
          </div>
        </header>
        <div className="mixdog-settings__body">
          {surface === 'context'
            ? <p id="command-surface-description" className="sr-only">Context details for the active Mixdog session.</p>
            : <div className="settings-section-heading"><div><h2>/{surface}</h2>
              <p id="command-surface-description">Manage {title.toLowerCase()} for the active Mixdog session.</p></div>
            </div>}
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
    return <Group title="Available workflow agents">{agents.map((agent) => {
      const route = record(agent.route);
      const selected = models.find((model) => `${model.provider}:${model.model}` === routeKey(route));
      const effort = selected?.effortOptions.some((entry) => entry.value === route.effort)
        ? String(route.effort)
        : preferredEffort(selected);
      const fast = selected?.fastCapable
        ? (typeof route.fast === 'boolean' ? route.fast === true
          : (typeof selected.savedFast === 'boolean' ? selected.savedFast : selected.fastPreferred))
        : false;
      const selectionFor = (
        model: DesktopModelOption,
        patch: { effort?: string; fast?: boolean } = {},
      ) => {
        const sameModel = model === selected;
        const nextEffort = patch.effort ?? (sameModel ? effort : preferredEffort(model));
        const nextFast = patch.fast ?? (sameModel ? fast
          : (typeof model.savedFast === 'boolean' ? model.savedFast : model.fastPreferred));
        return {
          provider: model.provider,
          model: model.model,
          ...(nextEffort ? { effort: nextEffort } : {}),
          ...(model.fastCapable ? { fast: nextFast === true } : {}),
        };
      };
      return <Resource key={String(agent.id)} title={String(agent.label || agent.id)}
        detail={String(agent.description || record(agent.definition).description || '')}
        actions={<div className="settings-route-controls">
          <OpenSelect className="settings-select" ariaLabel={`${String(agent.label || agent.id)} model`}
            disabled={busy} value={routeKey(route)}
            options={[
              ...(!selected ? [{ value: routeKey(route), label: routeLabel(route) }] : []),
              ...models.map((model) => ({
                value: `${model.provider}:${model.model}`,
                label: modelOptionLabel(model),
              })),
            ]}
            onChange={(value) => {
              const model = models.find((entry) => `${entry.provider}:${entry.model}` === value);
              if (model) void run('setAgentRoute', [agent.id, selectionFor(model)]);
            }} />
          {selected?.effortOptions.length ? <OpenSelect className="settings-select settings-select--effort"
            ariaLabel={`${String(agent.label || agent.id)} effort`} disabled={busy} value={effort}
            options={selected.effortOptions}
            onChange={(value) => void run('setAgentRoute', [agent.id, selectionFor(selected, { effort: value })])} /> : null}
          {selected?.fastCapable ? <label className="settings-route-fast"><input type="checkbox"
            checked={fast} disabled={busy}
            onChange={(event) => void run('setAgentRoute', [
              agent.id, selectionFor(selected, { fast: event.currentTarget.checked }),
            ])} /> Fast</label> : null}
        </div>} />;
    })}
      {!agents.length && <p>No agents found.</p>}</Group>;
  }
  if (surface === 'memory') return <MemoryBody data={data} busy={busy} run={run} />;
  if (surface === 'context') {
    return <ContextBody status={data.contextStatus} snapshot={data.snapshot} />;
  }
  if (surface === 'usage' || surface === 'doctor') {
    const value = data[LOADERS[surface][0]];
    return <Group title={surface === 'doctor' ? 'Diagnostic result' : 'Current status'}>
      <pre className="tool-detail">{pretty(value) || 'No data available.'}</pre>
      {surface === 'doctor' && <button disabled={busy} onClick={() => void run('runDoctor')}>Run diagnostics again</button>}
    </Group>;
  }
  if (surface === 'effort') {
    const snapshot = record(data.snapshot);
    const options = Array.isArray(snapshot.effortOptions)
      ? (snapshot.effortOptions as unknown[]).map(record).flatMap((entry) => {
        const value = String(entry.value || '');
        return value ? [{ value, label: String(entry.label || value) }] : [];
      })
      : [];
    if (!options.length) return <Group title="Set reasoning effort">
      <p>The current model has no effort levels.</p>
    </Group>;
    return <Group title="Set reasoning effort"><form className="command-surface-form" onSubmit={(event) => {
      event.preventDefault();
      const value = String(new FormData(event.currentTarget).get('effort') || '').trim();
      if (value) void run('setEffort', [value]);
    }}><OpenSelect className="settings-select" name="effort" ariaLabel="Reasoning effort"
      defaultValue={String(snapshot.effort || options[0]?.value || '')} options={options} />
      <button disabled={busy}>Apply</button></form></Group>;
  }
  if (surface === 'channels') return <ChannelsBody data={data} busy={busy} run={run} onOpen={onOpen} />;
  return <AutomationBody kind={surface} data={data} busy={busy} run={run} />;
}

function finite(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function formattedNumber(value: unknown): string {
  return Math.round(finite(value)).toLocaleString();
}

function compactTokens(value: unknown): string {
  const number = finite(value);
  if (number <= 0) return '0';
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(number >= 10_000_000 ? 0 : 1)}m`;
  if (number >= 10_000) return `${Math.round(number / 1_000)}k`;
  if (number >= 1_000) return `${(number / 1_000).toFixed(1)}k`;
  return `${Math.round(number)}`;
}

function contextPercent(value: unknown, total: unknown): number | null {
  const denominator = finite(total);
  if (!denominator) return null;
  return Math.max(0, Math.min(100, (finite(value) / denominator) * 100));
}

function contextPercentLabel(value: unknown, total: unknown): string {
  const percent = contextPercent(value, total);
  if (percent === null) return finite(value) === 0 ? '0%' : 'N/A';
  return `${percent > 0 && percent < 1 ? percent.toFixed(1) : Math.floor(percent)}%`;
}

function tokenBuckets(source: Row, names: string[]): number {
  return names.reduce((sum, name) => sum + finite(record(source[name]).tokens), 0);
}

function metric(parts: Array<string | null | undefined | false>): string {
  return parts.filter(Boolean).join(' · ');
}

export function ContextBody({ status, snapshot }: { status: unknown; snapshot: unknown }) {
  const context = record(status);
  const state = record(snapshot);
  const usage = record(context.usage);
  const messages = record(context.messages);
  const semantic = record(messages.semantic);
  const request = record(context.request);
  const schema = record(request.toolSchemaBreakdown);
  const compaction = record(context.compaction);
  const used = finite(context.usedTokens ?? context.currentEstimatedTokens);
  const windowTokens = finite(context.contextWindow ?? state.contextWindow ?? context.rawContextWindow);
  const rawWindowTokens = finite(context.rawContextWindow ?? state.rawContextWindow ?? windowTokens);
  const freeTokens = windowTokens ? Math.max(0, windowTokens - used) : finite(context.freeTokens);
  const usedPercent = contextPercent(used, windowTokens) || 0;
  const cachedRead = finite(usage.lastCachedReadTokens);
  const cacheWrite = finite(usage.lastCacheWriteTokens);
  const rawInput = finite(usage.lastInputTokens);
  const freshInput = finite(usage.lastUncachedInputTokens ?? Math.max(rawInput - cachedRead - cacheWrite, 0));
  const cacheDenominator = finite(usage.lastContextTokens) || cachedRead + freshInput + cacheWrite;
  const cacheHitRate = cacheDenominator > 0 ? `${Math.round((cachedRead / cacheDenominator) * 100)}%` : 'N/A';
  const compactRunning = compaction.inProgress === true || compaction.lastStage === 'compacting';
  const compactState = compactRunning ? 'Compacting conversation'
    : compaction.lastStage === 'interrupted' ? 'Compact interrupted'
      : compaction.lastStage === 'auto_clear_failed' ? 'Auto-clear skipped'
        : compaction.lastStage === 'auto_clear' || compaction.lastClearAt ? 'Auto-clear complete'
          : compaction.lastChanged ? 'Compact complete' : 'Compact checked';
  const sourceLine = metric([
    `effective ${compactTokens(windowTokens)}`,
    rawWindowTokens && rawWindowTokens !== windowTokens ? `raw ${compactTokens(rawWindowTokens)}` : '',
  ]);
  const compactionLine = metric([
    compaction.lastStage && compaction.lastStage !== 'pending' ? String(compaction.lastStage) : '',
    compactState,
    compaction.compactType || compaction.type ? `type ${String(compaction.compactType || compaction.type)}` : '',
    compaction.triggerTokens ? `trigger ${compactTokens(compaction.triggerTokens)}` : '',
    compaction.boundaryTokens ? `boundary ${compactTokens(compaction.boundaryTokens)}` : '',
  ]);
  const apiLine = metric([
    `last ctx ${compactTokens(usage.lastContextTokens)}`,
    `uncached/out ${compactTokens(freshInput)}/${compactTokens(usage.lastOutputTokens)}`,
    rawInput && rawInput !== freshInput ? `raw in ${compactTokens(rawInput)}` : '',
    cacheWrite ? `write ${compactTokens(cacheWrite)}` : '',
    `cache ${cacheHitRate}`,
  ]);
  const categories = [
    { key: 'messages', label: 'Messages', tokens: tokenBuckets(semantic, ['chat', 'assistant']) },
    { key: 'tools', label: 'Tools', tokens: tokenBuckets(schema, ['code', 'web', 'mutation', 'channels', 'setup', 'other', 'control', 'agents', 'session']) },
    { key: 'mcp', label: 'MCP', tokens: tokenBuckets(schema, ['mcp']) },
    { key: 'skills', label: 'Skills', tokens: tokenBuckets(schema, ['skills']) },
    { key: 'memory', label: 'Memory', tokens: tokenBuckets(semantic, ['memory']) + tokenBuckets(schema, ['memory']) },
    { key: 'session', label: 'Session', tokens: tokenBuckets(semantic, ['workspace', 'environment', 'other']) },
    { key: 'workflow', label: 'Workflow', tokens: tokenBuckets(semantic, ['workflow']) },
    { key: 'system', label: 'System', tokens: tokenBuckets(semantic, ['system']) },
    { key: 'tool-io', label: 'Tool I/O', tokens: tokenBuckets(semantic, ['toolResults']) },
  ];
  const categorizedTokens = categories.reduce((sum, category) => sum + category.tokens, 0);
  const requestOverheadTokens = Math.max(0, used - categorizedTokens);
  if (requestOverheadTokens > 0) {
    categories.push({ key: 'request', label: 'Overhead', tokens: requestOverheadTokens });
  }

  return <div className="context-view">
    <section className="context-usage-overview" aria-label="Context usage">
      <div className="context-usage-heading">
        <strong>{contextPercentLabel(used, windowTokens)} used</strong>
        <span>{compactTokens(used)} / {compactTokens(windowTokens)} · {compactTokens(freeTokens)} free</span>
      </div>
      <div className="context-main-bar" role="img"
        aria-label={`${contextPercentLabel(used, windowTokens)} context used`}>
        <span style={{ width: `${usedPercent}%` }} />
      </div>
    </section>
    <section className="context-runtime-lines" aria-label="Context details">
      {[['Source', sourceLine], ['Compaction', compactionLine], ['API/cache', apiLine]].map(([label, value]) =>
        <div key={label}><span>{label}</span><strong>{value}</strong></div>)}
    </section>
    <section className="context-mix" aria-labelledby="context-mix-title">
      <h3 id="context-mix-title">Context mix</h3>
      <div className="context-mix-grid">
        {categories.map((category) => {
          const percent = contextPercent(category.tokens, windowTokens) || 0;
          return <div className="context-mix-row" key={category.key}>
            <span>{category.label}</span>
            <small>{contextPercentLabel(category.tokens, windowTokens)}</small>
            <i><b style={{ width: `${percent}%` }} /></i>
            <strong>{compactTokens(category.tokens)}</strong>
          </div>;
        })}
      </div>
    </section>
  </div>;
}

function MemoryBody({ data, busy, run }: { data: Record<string, unknown>; busy: boolean; run: SurfaceRun }) {
  const enabled = record(data.getMemorySettings).enabled !== false;
  const entries = parseMemories(data.memoryControl);
  const [editing, setEditing] = useState<number | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);
  const mutate = (input: Row) => run('memoryControl', [input, { silent: true }]);
  return <><Group title="Memory runtime"><label><input type="checkbox" checked={enabled} disabled={busy}
    onChange={() => void run('setMemoryEnabled', [!enabled])} /> Memory · background cycles</label></Group>
    <Group title="Core memories"><form className="command-surface-form" onSubmit={(event) => {
      event.preventDefault(); const form = event.currentTarget;
      const sentence = String(new FormData(form).get('sentence') || '').trim();
      if (sentence) void mutate({ action: 'core', op: 'add', project_id: 'common', element: sentence, summary: sentence })
        .then(() => form.reset());
    }}><input name="sentence" placeholder="Add a memory" required /><button disabled={busy}>Add</button></form>
      {entries.map((entry) => editing === entry.id
        ? <form className="command-surface-form" key={entry.id} onSubmit={(event) => {
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
    <label className="command-surface-select-row">Backend <OpenSelect className="settings-select"
      ariaLabel="Channel backend" value={String(setup.backend || 'discord')} disabled={busy}
      options={[{ value: 'discord', label: 'Discord' }, { value: 'telegram', label: 'Telegram' }]}
      onChange={(value) => void run('setBackend', [value])} /></label></Group>
    <Group title="Channel target"><form className="command-surface-form" onSubmit={(event) => {
      event.preventDefault(); const form = new FormData(event.currentTarget);
      void run('setChannel', [{ backend: form.get('backend'), channelId: form.get('channelId') }]);
    }}><OpenSelect className="settings-select" name="backend" ariaLabel="Target backend"
      defaultValue={String(setup.backend || 'discord')}
      options={[{ value: 'discord', label: 'Discord' }, { value: 'telegram', label: 'Telegram' }]} />
      <input name="channelId" defaultValue={String(channel.channelId || '')} placeholder="Channel / chat ID" required />
      <button disabled={busy}>Save</button></form></Group>
    <Group title="Authentication">{([
      ['Discord bot token', 'saveDiscordToken'],
      ['Telegram bot token', 'saveTelegramToken'],
      ['Webhook / ngrok auth token', 'saveWebhookAuthtoken'],
    ] as const).map(([label, capability]) => <form className="command-surface-form" key={capability} onSubmit={(event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const secret = String(new FormData(form).get('secret') || '');
      if (secret) void run(capability, [secret]).then(() => form.reset());
    }}><label>{label}<input name="secret" type="password" autoComplete="off" required /></label>
      <button disabled={busy}>Save</button></form>)}</Group>
    <Group title="Webhook ingress"><form className="command-surface-form" onSubmit={(event) => {
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
  }).sort((left, right) => right.id - left.id);
}
function Group({ title, children }: React.PropsWithChildren<{ title: string }>) {
  return <section className="settings-group"><header><h3>{title}</h3></header><div className="settings-group-body">{children}</div></section>;
}
function Resource({ title, detail, actions }: { title: string; detail?: string; actions?: React.ReactNode }) {
  return <div className="settings-resource"><div><b>{title}</b>{detail && <p>{detail}</p>}</div>
    {actions && <div className="settings-resource-actions">{actions}</div>}</div>;
}

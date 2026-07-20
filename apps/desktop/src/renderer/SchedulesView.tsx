import React, { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { AlarmClock, Plus, Search, X } from 'lucide-react';

import type { DesktopApi, DesktopCapability, DesktopModelOption, DesktopProjectSummary } from '../shared/contract';
import { OpenSelect } from './OpenSelect';
import { ModelPicker } from './ModelPicker';
import { modelDisplayName } from './provider-display';

type RecordValue = Record<string, unknown>;
export type SchedulesApi = Partial<Pick<DesktopApi, 'invokeCapability' | 'listProviderModels' | 'listProjects'>>;

type FrequencyKind = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'once';

const FREQUENCY_OPTIONS: Array<{ value: FrequencyKind; label: string }> = [
  { value: 'hourly', label: 'Hourly' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekdays', label: 'Weekdays' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'once', label: 'One-shot' },
];

const WEEKDAY_OPTIONS = [
  { value: '1', label: 'Monday' },
  { value: '2', label: 'Tuesday' },
  { value: '3', label: 'Wednesday' },
  { value: '4', label: 'Thursday' },
  { value: '5', label: 'Friday' },
  { value: '6', label: 'Saturday' },
  { value: '0', label: 'Sunday' },
];

function record(value: unknown): RecordValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
}

function rows(value: unknown): RecordValue[] {
  return Array.isArray(value) ? value.map(record) : [];
}

// Announce that background sessions may have changed (App refreshes Recent).
// window.Event keeps the constructor tied to the ACTIVE window realm, so the
// jsdom test harness accepts it too; failures stay best-effort.
function notifySessionsRefresh(): void {
  try {
    window.dispatchEvent(new window.Event('mixdog:sessions-refresh'));
  } catch {
    // Sidebar refresh is a convenience; the 15s poll remains authoritative.
  }
}

interface ScheduleDraft {
  name: string;
  description: string;
  frequency: FrequencyKind;
  minute: string;
  clock: string;
  weekday: string;
  at: string;
  cwd: string;
  channel: string;
  model: string;
  instructions: string;
  enabled: boolean;
}

function datetimeLocalValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Recognize the cron shapes the frequency dropdown can produce so existing
// schedules prefill the same controls; anything else falls back to Daily.
function frequencyFromCron(cron: string): {
  kind: FrequencyKind; minute: string; clock: string; weekday: string; matched: boolean;
} {
  const fallback = { kind: 'daily' as FrequencyKind, minute: '0', clock: '09:00', weekday: '1', matched: false };
  const parts = String(cron || '').trim().split(/\s+/);
  if (parts.length !== 5) return fallback;
  const [minute, hour, dom, month, dow] = parts;
  const numeric = (value: string) => /^\d{1,2}$/.test(value);
  if (numeric(minute) && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return { ...fallback, kind: 'hourly', minute, matched: true };
  }
  if (numeric(minute) && numeric(hour) && dom === '*' && month === '*') {
    const clock = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
    if (dow === '*') return { ...fallback, kind: 'daily', clock, matched: true };
    if (dow === '1-5') return { ...fallback, kind: 'weekdays', clock, matched: true };
    if (/^[0-6]$/.test(dow)) return { ...fallback, kind: 'weekly', clock, weekday: dow, matched: true };
  }
  return fallback;
}

// Human schedule line for list rows (Codex-style "Weekdays at 08:00").
function describeSchedule(schedule: RecordValue): string {
  if (schedule.whenAt) {
    const at = new Date(String(schedule.whenAt));
    return Number.isNaN(at.getTime())
      ? 'One-shot'
      : `Once at ${at.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
  }
  const cron = String(schedule.whenCron || '');
  const parsed = frequencyFromCron(cron);
  if (!parsed.matched) return cron || String(schedule.time || '');
  if (parsed.kind === 'hourly') return `Hourly at :${parsed.minute.padStart(2, '0')}`;
  if (parsed.kind === 'weekdays') return `Weekdays at ${parsed.clock}`;
  if (parsed.kind === 'weekly') {
    const day = WEEKDAY_OPTIONS.find((option) => option.value === parsed.weekday)?.label || 'Weekly';
    return `${day}s at ${parsed.clock}`;
  }
  return `Daily at ${parsed.clock}`;
}

// Sub-line: schedule first, then model, project, and paused state.
function scheduleMeta(schedule: RecordValue): string {
  const parts = [describeSchedule(schedule)];
  const ref = parseModelRef(String(schedule.model || ''));
  if (ref.route) {
    const slash = ref.route.indexOf('/');
    parts.push(slash > 0 ? modelDisplayName(ref.route.slice(slash + 1), ref.route.slice(0, slash)) : ref.route);
  }
  const cwd = String(schedule.cwd || '');
  if (cwd) parts.push(cwd.split(/[\\/]/).filter(Boolean).pop() || cwd);
  if (schedule.enabled === false) parts.push('paused');
  return parts.filter(Boolean).join(' · ');
}

// Map the engine's schedule display shape (channel-admin scheduleToDisplay)
// onto editable form state; `defaultChannel` seeds the channel target with the
// configured main channel/chat ID.
function scheduleDraft(schedule: RecordValue | undefined, defaultChannel: string): ScheduleDraft {
  const source = record(schedule);
  const parsedAt = source.whenAt ? new Date(String(source.whenAt)) : null;
  const cron = String(source.whenCron || '');
  const parsed = frequencyFromCron(cron);
  return {
    name: String(source.name || ''),
    description: String(source.description || ''),
    frequency: source.whenAt && !cron ? 'once' : (cron ? parsed.kind : 'daily'),
    minute: parsed.minute,
    clock: parsed.clock,
    weekday: parsed.weekday,
    at: parsedAt && !Number.isNaN(parsedAt.getTime()) ? datetimeLocalValue(parsedAt) : '',
    cwd: String(source.cwd || ''),
    channel: String(source.channel || defaultChannel || ''),
    model: String(source.model || ''),
    instructions: String(source.instructions || ''),
    enabled: source.enabled !== false,
  };
}

// schedule.model wire format: "provider/model[@effort][+fast]" — the same
// string the scheduler parses back into a dispatch route.
function parseModelRef(ref: string): { route: string; effort: string; fast: boolean } {
  let route = String(ref || '');
  let fast = false;
  if (route.endsWith('+fast')) {
    fast = true;
    route = route.slice(0, -5);
  }
  let effort = '';
  const slash = route.indexOf('/');
  if (slash > 0) {
    const at = route.lastIndexOf('@');
    if (at > slash) {
      effort = route.slice(at + 1);
      route = route.slice(0, at);
    }
  }
  return { route, effort, fast };
}

function preferredEffort(option?: DesktopModelOption): string {
  if (!option?.effortOptions.length) return '';
  if (option.savedEffort && option.effortOptions.some((entry) => entry.value === option.savedEffort)) {
    return option.savedEffort;
  }
  for (const value of ['high', 'medium', 'low', 'none', 'xhigh', 'max', 'ultra']) {
    if (option.effortOptions.some((entry) => entry.value === value)) return value;
  }
  return option.effortOptions[0]?.value || '';
}

function ScheduleEditor({ draft, editing, busy, models, projects, error = '', onCancel, onSave }: {
  draft: ScheduleDraft;
  editing: boolean;
  busy: boolean;
  models: DesktopModelOption[];
  projects: DesktopProjectSummary[];
  error?: string;
  onCancel(): void;
  onSave(entry: RecordValue): void;
}) {
  const [frequency, setFrequency] = useState<FrequencyKind>(draft.frequency);
  const [weekday, setWeekday] = useState(draft.weekday);
  const initialModel = parseModelRef(draft.model);
  const [model, setModel] = useState(initialModel.route);
  const [effort, setEffort] = useState(initialModel.effort);
  const [fast, setFast] = useState(initialModel.fast);
  const [cwd, setCwd] = useState(draft.cwd);
  const [formError, setFormError] = useState('');
  const slash = model.indexOf('/');
  const modelProvider = slash > 0 ? model.slice(0, slash) : '';
  const modelId = slash > 0 ? model.slice(slash + 1) : '';
  const modelLabel = model ? (slash > 0 ? modelDisplayName(modelId, modelProvider) : model) : 'Model';
  const selected = models.find((option) => option.provider === modelProvider && option.model === modelId);
  const effortValue = selected?.effortOptions.some((entry) => entry.value === effort)
    ? effort
    : preferredEffort(selected);
  const projectOptions = [
    { value: '', label: 'No project' },
    ...projects.map((project) => ({
      value: project.path,
      label: project.alias?.trim() || project.name?.trim() || project.path,
    })),
  ];
  if (cwd && !projectOptions.some((option) => option.value === cwd)) {
    projectOptions.push({ value: cwd, label: cwd });
  }
  return <div className="schedules-dialog-layer"
    onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}
    onKeyDown={(event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }
    }}>
    <section className="schedules-dialog" role="dialog" aria-modal="true" aria-labelledby="schedules-dialog-title">
      <header>
        <h2 id="schedules-dialog-title">{editing ? 'Edit scheduled task' : 'Create scheduled task'}</h2>
        <button type="button" aria-label="Close schedule editor" onClick={onCancel}><X size={15} aria-hidden="true" /></button>
      </header>
      <form onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const text = (name: string) => String(data.get(name) || '').trim();
        if (!model) {
          setFormError('Choose a model for this schedule.');
          return;
        }
        const buildCron = () => {
          if (frequency === 'hourly') {
            const minute = Math.min(59, Math.max(0, Number(text('schedule-minute') || '0') || 0));
            return `${minute} * * * *`;
          }
          const [hour = '9', minute = '0'] = text('schedule-clock').split(':');
          const base = `${Number(minute)} ${Number(hour)}`;
          if (frequency === 'weekdays') return `${base} * * 1-5`;
          if (frequency === 'weekly') return `${base} * * ${weekday}`;
          return `${base} * * *`;
        };
        setFormError('');
        const effortSuffix = selected && effortValue ? `@${effortValue}` : '';
        const fastSuffix = selected?.fastCapable && fast ? '+fast' : '';
        onSave({
          name: editing ? draft.name : text('schedule-name'),
          description: draft.description,
          ...(frequency === 'once'
            ? { at: text('schedule-at') }
            : { time: buildCron() }),
          channel: draft.channel || 'main',
          model: `${model}${effortSuffix}${fastSuffix}`,
          ...(cwd ? { cwd } : {}),
          instructions: text('schedule-instructions'),
          enabled: draft.enabled,
          ...(editing ? { overwrite: true } : {}),
        });
      }}>
        <label className="schedules-field">Name
          <input name="schedule-name" defaultValue={draft.name} placeholder="daily-briefing" required autoFocus
            disabled={busy || editing} maxLength={64} />
        </label>
        <div className="schedules-composer">
          <textarea name="schedule-instructions" defaultValue={draft.instructions} required disabled={busy}
            placeholder="What should Mixdog do when this schedule fires?" aria-label="Schedule instructions" />
          <div className="schedules-composer-row">
            <OpenSelect ariaLabel="Schedule project" value={cwd} disabled={busy}
              options={projectOptions} onChange={setCwd} />
            <div className="schedules-composer-route">
            <ModelPicker models={models} provider={modelProvider} model={modelId}
              triggerLabel={modelLabel} ariaLabel="Schedule model"
              triggerClassName="model-trigger schedules-model-trigger" disabled={busy}
              onSelect={(option) => {
                setModel(`${option.provider}/${option.model}`);
                setEffort(preferredEffort(option));
                setFast(option.fastCapable ? option.fastPreferred : false);
                setFormError('');
              }} />
            {selected && selected.effortOptions.length > 0 && <OpenSelect ariaLabel="Schedule reasoning effort"
              value={effortValue} disabled={busy} options={selected.effortOptions} onChange={setEffort} />}
            {selected?.fastCapable && <OpenSelect ariaLabel="Schedule fast mode"
              value={fast ? 'on' : 'off'} disabled={busy}
              options={[{ value: 'on', label: 'Fast On' }, { value: 'off', label: 'Fast Off' }]}
              onChange={(value) => setFast(value === 'on')} />}
            </div>
          </div>
        </div>
        <div className="schedules-field">
          <span>Frequency</span>
          <div className="schedules-frequency">
            <OpenSelect ariaLabel="Schedule frequency" value={frequency} disabled={busy}
              options={FREQUENCY_OPTIONS}
              onChange={(value) => setFrequency((FREQUENCY_OPTIONS.some((option) => option.value === value)
                ? value : 'daily') as FrequencyKind)} />
            {frequency === 'hourly' && <input name="schedule-minute" type="number" min={0} max={59}
              defaultValue={draft.minute} required disabled={busy} aria-label="Minute of each hour" />}
            {(frequency === 'daily' || frequency === 'weekdays') && <input name="schedule-clock" type="time"
              defaultValue={draft.clock} required disabled={busy} aria-label="Time of day" />}
            {frequency === 'weekly' && <>
              <OpenSelect ariaLabel="Weekday" value={weekday} disabled={busy}
                options={WEEKDAY_OPTIONS} onChange={setWeekday} />
              <input name="schedule-clock" type="time" defaultValue={draft.clock} required disabled={busy}
                aria-label="Time of day" />
            </>}
            {frequency === 'once' && <input name="schedule-at" type="datetime-local" defaultValue={draft.at}
              required disabled={busy} aria-label="Run at" />}
          </div>
        </div>
        <footer>
          {(formError || error) && <p className="schedules-form-error" role="alert">{formError || error}</p>}
          <button type="button" disabled={busy} onClick={onCancel}>Cancel</button>
          <button type="submit" disabled={busy}>Save</button>
        </footer>
      </form>
    </section>
  </div>;
}

// Scheduled-tasks page (sidebar -> Schedules): a Claude-style main-pane list
// with search, active/paused filters, and a popup schedule editor.
export function SchedulesPane({ api = window.mixdogDesktop, active = true }: {
  api?: SchedulesApi;
  active?: boolean;
}) {
  const [setup, setSetup] = useState<RecordValue>({});
  const [remote, setRemote] = useState(false);
  const [models, setModels] = useState<DesktopModelOption[]>([]);
  const [projects, setProjects] = useState<DesktopProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'active' | 'paused'>('all');
  const [editor, setEditor] = useState<{ name: string; draft: ScheduleDraft } | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState('');
  const [runningName, setRunningName] = useState('');
  const [notice, setNotice] = useState('');
  const loadSequence = useRef(0);

  const load = useCallback(async () => {
    if (!api?.invokeCapability) {
      setLoading(false);
      return;
    }
    const sequence = ++loadSequence.current;
    try {
      const [setupResult, remoteResult, modelRows, projectRows] = await Promise.all([
        api.invokeCapability({ capability: 'getChannelSetup', args: [] }),
        api.invokeCapability({ capability: 'isRemoteEnabled', args: [] }),
        api.listProviderModels ? api.listProviderModels({ quick: true }).catch(() => []) : Promise.resolve([]),
        api.listProjects ? api.listProjects().catch(() => []) : Promise.resolve([]),
      ]);
      if (sequence !== loadSequence.current) return;
      setSetup(record(setupResult?.value));
      setRemote(remoteResult?.value === true);
      setModels(Array.isArray(modelRows) ? modelRows : []);
      setProjects(Array.isArray(projectRows) ? projectRows : []);
      setError('');
    } catch (reason) {
      if (sequence !== loadSequence.current) return;
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [api]);
  useEffect(() => {
    if (active) void load();
    return () => { loadSequence.current += 1; };
  }, [active, load]);

  const busy = Boolean(pending) || loading;
  const run = async (capability: DesktopCapability, args: unknown[] = []): Promise<unknown> => {
    if (!api?.invokeCapability || pending) return undefined;
    setPending(capability);
    setError('');
    try {
      const result = await api.invokeCapability({ capability, args });
      await load();
      notifySessionsRefresh();
      return result?.value ?? true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return undefined;
    } finally {
      setPending('');
    }
  };

  const schedules = rows(setup.schedules);
  const runNow = async (name: string) => {
    if (!api?.invokeCapability || runningName) return;
    setRunningName(name);
    setNotice('');
    setError('');
    try {
      await api.invokeCapability({ capability: 'runScheduleNow', args: [name] });
      setNotice(`"${name}" ran — the session is in Recent.`);
      void load();
      notifySessionsRefresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRunningName('');
    }
  };
  const text = query.trim().toLowerCase();
  const visible = schedules.filter((schedule) => {
    const enabled = schedule.enabled !== false;
    if (filter === 'active' && !enabled) return false;
    if (filter === 'paused' && enabled) return false;
    if (!text) return true;
    return [schedule.name, schedule.description, schedule.time, schedule.model, schedule.channel]
      .map((value) => String(value || '').toLowerCase()).join(' ').includes(text);
  });
  const channelEntry = record(setup.channel);
  const mainChannelId = String(channelEntry.channelId || channelEntry.discordChannelId || channelEntry.telegramChatId || '');
  const saveSchedule = async (entry: RecordValue) => {
    const result = await run('saveSchedule', [entry]);
    if (result !== undefined) setEditor(null);
  };

  return <div className="schedules-pane" style={active ? undefined : { display: 'none' }}>
    <div className="schedules-page">
      <header className="schedules-page-header">
        <div>
          <h1>Scheduled tasks</h1>
          <p>Run prompts on a schedule through the channel runtime.</p>
        </div>
        <button type="button" className="settings-action schedules-new" disabled={busy}
          onClick={() => {
            setError('');
            setEditor({ name: '', draft: scheduleDraft(undefined, mainChannelId) });
          }}>
          <Plus size={14} aria-hidden="true" />New schedule</button>
      </header>
      <div className="schedules-search">
        <Search size={14} aria-hidden="true" />
        <input aria-label="Search schedules" placeholder="Search schedules…" value={query}
          onChange={(event) => setQuery(event.currentTarget.value)} />
      </div>
      <div className="schedules-filters" aria-label="Schedule filter">
        {([['all', 'All'], ['active', 'Active'], ['paused', 'Paused']] as const).map(([value, label]) =>
          <button key={value} type="button" className={filter === value ? 'active' : ''}
            aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}
      </div>
      {editor && <ScheduleEditor key={editor.name || '(new)'} draft={editor.draft} editing={Boolean(editor.name)}
        busy={busy} models={models} projects={projects} error={error}
        onCancel={() => {
          setError('');
          setEditor(null);
        }} onSave={(entry) => void saveSchedule(entry)} />}
      {/* No loading flash: the list area stays empty until the first snapshot
          lands, so the empty-state icon never pops in and out on entry. */}
      {loading ? null
        : visible.length ? <div className="schedules-list">{visible.map((schedule) => {
          const name = String(schedule.name);
          const enabled = schedule.enabled !== false;
          return <div key={name} className="schedules-row">
            <span className={`schedules-row-dot ${enabled ? 'on' : ''}`} aria-hidden="true" />
            <div className="schedules-row-copy">
              <b>{name}</b>
              <small>{scheduleMeta(schedule)}</small>
            </div>
            <div className="schedules-row-actions">
              <button type="button" className="settings-action" disabled={busy || Boolean(runningName)}
                onClick={() => void runNow(name)}>{runningName === name ? 'Running…' : 'Run now'}</button>
              <button type="button" className="settings-action" disabled={busy || !remote}
                onClick={() => void run('setScheduleEnabled', [name, !enabled])}>{enabled ? 'Pause' : 'Resume'}</button>
              <button type="button" className="settings-action" disabled={busy}
                onClick={() => {
                  setConfirmingDelete('');
                  setError('');
                  setEditor({ name, draft: scheduleDraft(schedule, mainChannelId) });
                }}>Edit</button>
              <button type="button" className="settings-action danger" disabled={busy}
                onClick={() => {
                  if (confirmingDelete !== name) {
                    setConfirmingDelete(name);
                    return;
                  }
                  setConfirmingDelete('');
                  void run('deleteSchedule', [name]);
                }}>{confirmingDelete === name ? 'Confirm delete' : 'Delete'}</button>
            </div>
          </div>;
        })}</div>
        : <div className="schedules-empty">
          <AlarmClock size={40} strokeWidth={1.5} aria-hidden="true" />
          <p>{schedules.length ? 'No schedules match the current filter.' : 'No scheduled tasks yet.'}</p>
        </div>}
      {error && !editor && <p className="mixdog-settings__error" role="alert">{error}</p>}
      {notice && !editor && <p className="schedules-notice" role="status">{notice}</p>}
    </div>
  </div>;
}

import { AlarmClock, ChevronRight, Plus, Search, X } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';

import type { DesktopApi, DesktopModelOption, DesktopProjectSummary } from '../shared/contract';
import type { RecordValue } from './desktop-types';
import { t, uiFormatLocale } from './i18n';
import { InitialSurface } from './InitialSurface';
import { filterConfiguredModels } from './model-catalog';
import { ModelRouteEditor } from './ModelRouteEditor';
import { parseModelRef, preferredModelEffort, preferredModelParameters } from './model-route-utils';
import { showDesktopToast } from './notifications';
import { OpenSelect } from './OpenSelect';
import { ProgressSpinner } from './ProgressSpinner';
import { record, rows } from './record-utils';
import { SidebarResourceTitle } from './sidebar-resource-row';
import {
  AutomationAttachButton,
  AutomationAttachmentChips,
  attachmentsFromRecords,
  type AutomationAttachment,
} from './automation-attachments';
import { ModelRouteLabel, normalizeModelOptions } from './provider-display';
import {
  automationFastSuffix,
  automationProjectOptions,
  automationRouteSummary,
  automationWorkflowOptions,
  splitModelRoute,
} from './automation-editor-support';
import { SidebarPanelAction } from './session-sidebar-sections';
import { EditorDialogFooter, SidebarDialogLayer } from './sidebar-dialog';
import { useSidebarPanelDismiss } from './sidebar-panel-surface';
import { useSidebarReferences, type SidebarReferenceKey } from './sidebar-reference-cache';
import { usePersistedListOrder } from './use-persisted-list-order';
import { useSidebarCapabilityRunner } from './use-sidebar-capability-runner';
import { CompactSwitch } from './settings/capability-controls';

type SchedulesApi = Partial<Pick<DesktopApi, 'invokeCapability' | 'listProviderModels' | 'listProjects'>>;

type FrequencyKind = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'once';

const frequencyOptions = (): Array<{ value: FrequencyKind; label: string }> => [
  { value: 'hourly', label: t('Hourly') },
  { value: 'daily', label: t('Daily') },
  { value: 'weekdays', label: t('Weekdays') },
  { value: 'weekly', label: t('Weekly') },
  { value: 'once', label: t('One-shot') },
];

const weekdayOptions = () => [
  { value: '1', label: t('Monday') },
  { value: '2', label: t('Tuesday') },
  { value: '3', label: t('Wednesday') },
  { value: '4', label: t('Thursday') },
  { value: '5', label: t('Friday') },
  { value: '6', label: t('Saturday') },
  { value: '0', label: t('Sunday') },
];

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
  workflow: string;
  attachments: AutomationAttachment[];
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
  kind: FrequencyKind;
  minute: string;
  clock: string;
  weekday: string;
  matched: boolean;
} {
  const fallback = { kind: 'daily' as FrequencyKind, minute: '0', clock: '09:00', weekday: '1', matched: false };
  const parts = String(cron || '')
    .trim()
    .split(/\s+/);
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

// The cron expression for a repeating frequency, read from the editor's
// minute/clock fields — the inverse of frequencyFromCron above.
function scheduleCron(frequency: FrequencyKind, field: (name: string) => string, weekday: string): string {
  if (frequency === 'hourly') {
    const minute = Math.min(59, Math.max(0, Number(field('schedule-minute') || '0') || 0));
    return `${minute} * * * *`;
  }
  const [hour = '9', minute = '0'] = field('schedule-clock').split(':');
  const base = `${Number(minute)} ${Number(hour)}`;
  if (frequency === 'weekdays') return `${base} * * 1-5`;
  if (frequency === 'weekly') return `${base} * * ${weekday}`;
  return `${base} * * *`;
}

// Human schedule line for list rows (e.g. "Weekdays at 08:00").
function describeSchedule(schedule: RecordValue): string {
  if (schedule.whenAt) {
    const at = new Date(String(schedule.whenAt));
    return Number.isNaN(at.getTime())
      ? t('One-shot')
      : t('Once at {{time}}', {
          time: at.toLocaleString(uiFormatLocale(), {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          }),
        });
  }
  const cron = String(schedule.whenCron || '');
  const parsed = frequencyFromCron(cron);
  if (!parsed.matched) return cron || String(schedule.time || '');
  if (parsed.kind === 'hourly') return t('Hourly at :{{minute}}', { minute: parsed.minute.padStart(2, '0') });
  if (parsed.kind === 'weekdays') return t('Weekdays at {{time}}', { time: parsed.clock });
  if (parsed.kind === 'weekly') {
    const day = weekdayOptions().find((option) => option.value === parsed.weekday)?.label || t('Weekly');
    return t('Every {{day}} at {{time}}', { day, time: parsed.clock });
  }
  return t('Daily at {{time}}', { time: parsed.clock });
}

// Sub-line: schedule first, then model, project, and paused state.
function scheduleMeta(schedule: RecordValue) {
  const scheduleLabel = describeSchedule(schedule);
  const route = automationRouteSummary(String(schedule.model || ''));
  const cwd = String(schedule.cwd || '');
  const cwdLabel = cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() || cwd : '';
  return (
    <>
      {scheduleLabel}
      {route && (
        <>
          {' '}
          · <ModelRouteLabel model={route.model} effort={route.effort} fast={route.fast} />
        </>
      )}
      {cwdLabel && <> · {cwdLabel}</>}
    </>
  );
}

// Map the engine's schedule display shape (channel-admin scheduleToDisplay)
// onto editable form state. Results always deliver to the app session; the
// messaging-channel delivery target is retired.
function scheduleDraft(schedule: RecordValue | undefined): ScheduleDraft {
  const source = record(schedule);
  const parsedAt = source.whenAt ? new Date(String(source.whenAt)) : null;
  const cron = String(source.whenCron || '');
  const parsed = frequencyFromCron(cron);
  let frequency: FrequencyKind = parsed.kind;
  if (!cron) frequency = source.whenAt ? 'once' : 'daily';
  return {
    name: String(source.name || ''),
    description: String(source.description || ''),
    frequency,
    minute: parsed.minute,
    clock: parsed.clock,
    weekday: parsed.weekday,
    at: parsedAt && !Number.isNaN(parsedAt.getTime()) ? datetimeLocalValue(parsedAt) : '',
    cwd: String(source.cwd || ''),
    // New-task parity: an automation always carries a workflow; legacy rows
    // without one edit as the Default pack.
    workflow: String(source.workflow || 'default'),
    attachments: attachmentsFromRecords(source.attachments),
    model: String(source.model || ''),
    instructions: String(source.instructions || ''),
    enabled: source.enabled !== false,
  };
}

function ScheduleEditor({
  draft,
  editing,
  busy,
  running = false,
  models,
  projects,
  workflows,
  error = '',
  onCancel,
  onSave,
  onToggle,
  onRun,
  onDelete,
}: {
  draft: ScheduleDraft;
  editing: boolean;
  busy: boolean;
  running?: boolean;
  models: DesktopModelOption[];
  projects: DesktopProjectSummary[];
  workflows: Array<{ value: string; label: string }>;
  error?: string;
  onCancel(): void;
  onSave(entry: RecordValue): void;
  onToggle?(enabled: boolean): void;
  onRun?(): void;
  onDelete?(): void;
}) {
  const [frequency, setFrequency] = useState<FrequencyKind>(draft.frequency);
  const [weekday, setWeekday] = useState(draft.weekday);
  const initialModel = parseModelRef(draft.model);
  const [model, setModel] = useState(initialModel.route);
  const [effort, setEffort] = useState(initialModel.effort);
  const [fast, setFast] = useState(initialModel.fast);
  const [modelParameters, setModelParameters] = useState(initialModel.modelParameters);
  const [cwd, setCwd] = useState(draft.cwd);
  const [workflow, setWorkflow] = useState(draft.workflow);
  const [attachments, setAttachments] = useState<AutomationAttachment[]>(draft.attachments);
  const [enabled, setEnabled] = useState(draft.enabled);
  const [formError, setFormError] = useState('');
  const { provider: modelProvider, id: modelId } = splitModelRoute(model);
  const selected = models.find((option) => option.provider === modelProvider && option.model === modelId);
  const effortValue = selected?.effortOptions.some((entry) => entry.value === effort)
    ? effort
    : preferredModelEffort(selected) || '';
  const selectedModelParameters = preferredModelParameters(selected, modelParameters);
  const projectOptions = automationProjectOptions(projects, cwd);
  return (
    <SidebarDialogLayer onClose={onCancel}>
      <section
        className="schedules-dialog schedules-editor-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="schedules-dialog-title"
      >
        <header>
          <h2 id="schedules-dialog-title">{editing ? t('Edit scheduled task') : t('Create scheduled task')}</h2>
          <div className="schedules-dialog-header-actions">
            <CompactSwitch
              label={t('Enabled')}
              checked={enabled}
              disabled={busy}
              onChange={(next) => {
                setEnabled(next);
                if (editing) onToggle?.(next);
              }}
            />
            <button type="button" aria-label={t('Close schedule editor')} onClick={onCancel}>
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        </header>
        <form
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            const text = (name: string) => String(data.get(name) || '').trim();
            if (!model) {
              setFormError(t('Choose a model for this schedule.'));
              return;
            }
            setFormError('');
            const effortSuffix = selected && effortValue ? `@${effortValue}` : '';
            const fastSuffix = automationFastSuffix(selected, effortValue, selectedModelParameters, fast);
            const parameterSuffix = Object.keys(selectedModelParameters).length
              ? `?${new URLSearchParams(selectedModelParameters).toString()}`
              : '';
            onSave({
              name: editing ? draft.name : text('schedule-name'),
              description: draft.description,
              ...(frequency === 'once'
                ? { at: text('schedule-at') }
                : { time: scheduleCron(frequency, text, weekday) }),
              model: `${model}${effortSuffix}${fastSuffix}${parameterSuffix}`,
              ...(cwd ? { cwd } : {}),
              ...(workflow ? { workflow } : {}),
              ...(attachments.length ? { attachments } : {}),
              instructions: text('schedule-instructions'),
              enabled,
              ...(editing ? { overwrite: true } : {}),
            });
          }}
        >
          <label className="schedules-field">
            <span>{t('Name')}</span>
            <small>{t('Shown in schedule lists and notifications.')}</small>
            <input
              name="schedule-name"
              defaultValue={draft.name}
              placeholder="daily-briefing"
              required
              autoFocus
              disabled={busy || editing}
              maxLength={64}
            />
          </label>
          {/* Field order (user decision): composer right under Name, then
            Project → Delivery → Frequency as labeled fields. */}
          <div className="schedules-composer">
            <textarea
              name="schedule-instructions"
              defaultValue={draft.instructions}
              required
              disabled={busy}
              placeholder={t('What should Mixdog do when this schedule fires?')}
              aria-label={t('Schedule instructions')}
            />
            <AutomationAttachmentChips attachments={attachments} disabled={busy} onChange={setAttachments} />
            <div className="composer-footer schedules-composer-footer">
              <AutomationAttachButton
                attachments={attachments}
                disabled={busy}
                ariaLabel={t('Attach files to this schedule')}
                onChange={setAttachments}
                onError={setFormError}
              />
              <ModelRouteEditor
                models={models}
                disabled={busy}
                ariaLabel={t('Schedule model')}
                value={{
                  provider: modelProvider,
                  model: modelId,
                  ...(effortValue ? { effort: effortValue } : {}),
                  fast,
                  modelParameters: selectedModelParameters,
                }}
                onChange={(selection) => {
                  setModel(`${selection.provider}/${selection.model}`);
                  setEffort(String(selection.effort || ''));
                  setFast(selection.fast === true);
                  setModelParameters(selection.modelParameters || {});
                  setFormError('');
                }}
              />
              {/* Same flat, right-aligned workflow control as the chat
                composer (effort-control/workflow-control skin) — including its
                rule: a single pack is not a choice, so the control is omitted
                and the draft keeps the workflow it already carries. */}
              {workflows.length > 1 && (
                <div className="effort-control workflow-control">
                  <OpenSelect
                    variant="route"
                    ariaLabel={t('Schedule workflow')}
                    value={workflow}
                    disabled={busy}
                    options={workflows}
                    onChange={setWorkflow}
                  />
                </div>
              )}
            </div>
          </div>
          <div className="schedules-field">
            <span>{t('Project')}</span>
            <small>{t('Project used for each run.')}</small>
            <div className="schedules-frequency">
              <OpenSelect
                ariaLabel={t('Schedule project')}
                value={cwd || '__none__'}
                disabled={busy}
                options={projectOptions}
                onChange={(next) => setCwd(next === '__none__' ? '' : next)}
              />
            </div>
          </div>
          <div className="schedules-field">
            <span>{t('Frequency')}</span>
            <small>{t('How often this schedule runs.')}</small>
            <div className="schedules-frequency">
              <OpenSelect
                ariaLabel={t('Schedule frequency')}
                value={frequency}
                disabled={busy}
                options={frequencyOptions()}
                onChange={(value) =>
                  setFrequency(
                    (frequencyOptions().some((option) => option.value === value) ? value : 'daily') as FrequencyKind
                  )
                }
              />
              {frequency === 'hourly' && (
                <input
                  name="schedule-minute"
                  type="number"
                  min={0}
                  max={59}
                  defaultValue={draft.minute}
                  required
                  disabled={busy}
                  aria-label={t('Minute of each hour')}
                />
              )}
              {(frequency === 'daily' || frequency === 'weekdays') && (
                <input
                  name="schedule-clock"
                  type="time"
                  defaultValue={draft.clock}
                  required
                  disabled={busy}
                  aria-label={t('Time of day')}
                />
              )}
              {frequency === 'weekly' && (
                <>
                  <OpenSelect
                    ariaLabel={t('Weekday')}
                    value={weekday}
                    disabled={busy}
                    options={weekdayOptions()}
                    onChange={setWeekday}
                  />
                  <input
                    name="schedule-clock"
                    type="time"
                    defaultValue={draft.clock}
                    required
                    disabled={busy}
                    aria-label={t('Time of day')}
                  />
                </>
              )}
              {frequency === 'once' && (
                <input
                  name="schedule-at"
                  type="datetime-local"
                  defaultValue={draft.at}
                  required
                  disabled={busy}
                  aria-label={t('Run at')}
                />
              )}
            </div>
          </div>
          <EditorDialogFooter
            error={formError || error}
            busy={busy}
            onCancel={onCancel}
            onDelete={editing ? onDelete : undefined}
          >
            {editing && onRun && (
              <button type="button" disabled={busy || running} onClick={onRun}>
                {running ? t('Running…') : t('Run now')}
              </button>
            )}
          </EditorDialogFooter>
        </form>
      </section>
    </SidebarDialogLayer>
  );
}

// Shared, process-wide reference keys. channelSetup is first: it carries the
// schedule rows, so it alone decides whether this panel has anything to paint.
const SCHEDULE_REFERENCE_KEYS = [
  'channelSetup',
  'quickProviderModels',
  'providerSetup',
  'projects',
  'workflows',
] as const satisfies readonly SidebarReferenceKey[];

// Scheduled-tasks panel (rail -> Schedules): a compact searchable list in the
// session-panel area, plus a popup editor.
export function SchedulesPane({
  api = window.mixdogDesktop,
  active = true,
  runningNames,
}: {
  api?: SchedulesApi;
  active?: boolean;
  runningNames?: ReadonlySet<string>;
}) {
  // Seeded synchronously from the shared cache: a warm boot paints rows on the
  // first render instead of showing a loading cover, and re-entry revalidates
  // silently underneath the rows that are already there.
  const { values, loading, completeMutation } = useSidebarReferences(api, SCHEDULE_REFERENCE_KEYS, active);
  const setup = values.channelSetup;
  // Same configured-provider semantics as the Workflows panel: a disconnected
  // provider's models never reach the picker.
  const models = useMemo(
    () => filterConfiguredModels(normalizeModelOptions(values.quickProviderModels), values.providerSetup),
    [values.quickProviderModels, values.providerSetup]
  );
  const projects = values.projects;
  const workflows = useMemo(() => automationWorkflowOptions(values.workflows), [values.workflows]);
  // Host-scoped completion invalidates the keys a capability made untrue and
  // reads through once, unless the app already rebound hosts.
  const { pending, error, setError, run } = useSidebarCapabilityRunner({
    api,
    completeMutation,
    toastScope: 'schedule',
    onSuccess: notifySessionsRefresh,
  });
  const [query, setQuery] = useState('');
  const [editor, setEditor] = useState<{ name: string; draft: ScheduleDraft } | null>(null);
  const [runningName, setRunningName] = useState('');
  // The editor portals to document.body, so the sidebar's inert/aria-hidden
  // does not reach it: a collapsed sidebar — or another destination taking the
  // panel area — must close it explicitly. Search/filter state is untouched.
  useSidebarPanelDismiss(active, () => {
    setEditor(null);
  });
  const busy = Boolean(pending) || loading;

  const schedules = rows(setup.schedules);
  const scheduleOrder = usePersistedListOrder(
    'mixdog.sidebar-order.schedules.v1',
    schedules.map((schedule) => String(schedule.name))
  );
  const orderedSchedules = scheduleOrder.orderedIds
    .map((name) => schedules.find((schedule) => String(schedule.name) === name))
    .filter((schedule): schedule is RecordValue => Boolean(schedule));
  const runNow = async (name: string) => {
    if (!api?.invokeCapability || runningName) return;
    setRunningName(name);
    setError('');
    try {
      await api.invokeCapability({ capability: 'runScheduleNow', args: [name] });
      showDesktopToast(t('"{{name}}" ran — see Automations in the sidebar.', { name }), 'success');
      void completeMutation('runScheduleNow');
      notifySessionsRefresh();
    } catch (reason) {
      showDesktopToast(reason instanceof Error ? reason.message : String(reason), 'error', {
        scope: `schedule:run:${name}`,
      });
    } finally {
      setRunningName('');
    }
  };
  const text = query.trim().toLowerCase();
  const visible = orderedSchedules.filter((schedule) => {
    if (!text) return true;
    return [schedule.name, schedule.description, schedule.time, schedule.model]
      .map((value) => String(value || '').toLowerCase())
      .join(' ')
      .includes(text);
  });
  const saveSchedule = async (entry: RecordValue) => {
    const result = await run('saveSchedule', [entry]);
    if (result !== undefined) setEditor(null);
  };

  return (
    <div
      className="schedules-pane stable-surface-preserved stable-takeover-surface"
      data-surface-active={active ? 'true' : 'false'}
      inert={active ? undefined : true}
      aria-hidden={active ? undefined : true}
    >
      <div className="schedules-page">
        {/* Title and primary action live in the sidebar panel header. */}
        <SidebarPanelAction
          active={active}
          label={t('New schedule')}
          icon={Plus}
          className="schedules-add"
          disabled={busy}
          onClick={() => {
            setError('');
            setEditor({ name: '', draft: scheduleDraft(undefined) });
          }}
        />
        <div className="schedules-search">
          <Search size={14} aria-hidden="true" />
          <input
            aria-label={t('Search schedules')}
            placeholder={t('Search schedules…')}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </div>
        {active && editor && (
          <ScheduleEditor
            key={editor.name || '(new)'}
            draft={editor.draft}
            editing={Boolean(editor.name)}
            busy={busy}
            running={runningName === editor.name}
            models={models}
            projects={projects}
            workflows={workflows}
            error={error}
            onCancel={() => {
              setError('');
              setEditor(null);
            }}
            onRun={editor.name ? () => void runNow(editor.name) : undefined}
            onDelete={
              editor.name
                ? () => {
                    const name = editor.name;
                    setEditor(null);
                    void run('deleteSchedule', [name], 'toast');
                  }
                : undefined
            }
            onSave={(entry) => void saveSchedule(entry)}
            onToggle={(enabled) => void run('setScheduleEnabled', [editor.name, enabled], 'toast')}
          />
        )}
        {/* Reserve the first-read list, without claiming it is empty. Cached
          rows stay visible while their background refresh runs. */}
        {loading && <InitialSurface />}
        {!loading && visible.length > 0 && (
          <div className="schedules-list">
            {visible.map((schedule) => {
              const name = String(schedule.name);
              const enabled = schedule.enabled !== false;
              const running = runningNames?.has(name) === true;
              return (
                <button
                  type="button"
                  key={name}
                  className="schedules-row utilities-row sidebar-resource-row"
                  data-enabled={enabled ? 'true' : 'false'}
                  disabled={busy}
                  onClick={() => {
                    setError('');
                    setEditor({ name, draft: scheduleDraft(schedule) });
                  }}
                  {...scheduleOrder.getReorderProps(name)}
                >
                  <span className="sidebar-resource-icon" aria-hidden="true">
                    {running ? (
                      <ProgressSpinner size={12} className="schedules-row-spinner" />
                    ) : (
                      <AlarmClock size={16} />
                    )}
                  </span>
                  <span className="schedules-row-copy utilities-row-copy">
                    <SidebarResourceTitle
                      label={name}
                      tag={!enabled ? { label: t('Disabled'), tone: 'muted' } : null}
                    />
                    <small>{scheduleMeta(schedule)}</small>
                  </span>
                  <ChevronRight className="utilities-row-chevron" size={16} aria-hidden="true" />
                </button>
              );
            })}
          </div>
        )}
        {!loading && visible.length === 0 && (
          <div className="schedules-empty">
            <AlarmClock size={40} aria-hidden="true" />
            <p>{schedules.length ? t('No schedules match the current filter.') : t('No scheduled tasks yet.')}</p>
          </div>
        )}
      </div>
    </div>
  );
}

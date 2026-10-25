import { Plus, Search, X } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import type { DesktopApi, DesktopProjectSummary } from '../shared/contract';
import type { RecordValue } from './desktop-types';
import { t, uiFormatLocale } from './i18n';
import { InitialSurface } from './InitialSurface';
import {
  AutomationAgentPicker,
  RoutineNeedsBot,
  RoutineSortChips,
  RoutineSideGroups,
  automationAgentOf,
  automationRunFields,
  routinePausedText,
  useAutomationAgents,
} from './automation-agent-picker';
import { showDesktopToast } from './notifications';
import { scheduleErrorText } from './schedule-error-text';
import { OpenSelect } from './OpenSelect';
import { timeFormatOptions } from './time-format-preference';
import { record, rows } from './record-utils';
import { RoutineItem, relativeTime } from './routine-list-item';
import {
  type Cadence,
  type FrequencyKind,
  SCHEDULE_SORTS,
  type ScheduleSort,
  frequencyFromCron,
  routinePaused,
  scheduleCadence,
  scheduleGroups,
  useSortChoice,
} from './routine-sideview-model';
import { routineRows } from './routines-model';
import { useNewScheduleRequest } from './routine-editor-request';
import { RoomMemberFace } from './agent-room-parts';
import './routines.css';
import {
  AutomationAttachButton,
  AutomationAttachmentChips,
  attachmentsFromRecords,
  type AutomationAttachment,
} from './automation-attachments';
import { automationDraftCwd, automationProjectOptions } from './automation-editor-support';
import { SidebarPanelAction } from './session-sidebar-sections';
import { EditorDialogFooter, SidebarDialogLayer } from './sidebar-dialog';
import { useSidebarPanelDismiss } from './sidebar-panel-surface';
import { useSidebarReferences, type SidebarReferenceKey } from './sidebar-reference-cache';
import { useSidebarCapabilityRunner } from './use-sidebar-capability-runner';
import { CompactSwitch } from './settings/capability-controls';

type SchedulesApi = Partial<Pick<DesktopApi, 'invokeCapability' | 'listProjects'>>;

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
  /** The saved one-shot instant, whole (the `at` field shows it to the minute). */
  whenAt: string;
  cwd: string;
  attachments: AutomationAttachment[];
  /** The bot it belongs to: each run is a turn in that bot's chat. */
  agent: string;
  instructions: string;
  enabled: boolean;
}

function datetimeLocalValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
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
export function describeSchedule(schedule: RecordValue): string {
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
            ...timeFormatOptions(),
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

const scheduleSortOptions = (): Array<{ value: ScheduleSort; label: string }> => [
  { value: 'next', label: t('Next run') },
  { value: 'cadence', label: t('Cadence') },
  { value: 'bot', label: t('By bot') },
];

/** A 주기 group's title. */
function cadenceLabel(cadence: Cadence): string {
  if (cadence === 'custom') return t('Other');
  return frequencyOptions().find((option) => option.value === cadence)?.label ?? cadence;
}

/** When in its cadence a schedule runs (its group names the cadence). */
function cadenceTime(schedule: RecordValue): string {
  const cadence = scheduleCadence(schedule);
  if (cadence === 'once' || cadence === 'custom') return describeSchedule(schedule);
  const parsed = frequencyFromCron(String(schedule.whenCron || ''));
  if (cadence === 'hourly') return `:${parsed.minute.padStart(2, '0')}`;
  if (cadence === 'weekly') {
    const day = weekdayOptions().find((option) => option.value === parsed.weekday)?.label ?? '';
    return `${day} ${parsed.clock}`;
  }
  return parsed.clock;
}

// Map the engine's schedule display shape (channel-admin scheduleToDisplay)
// onto editable form state. Results always deliver to the app session; the
// messaging-channel delivery target is retired.
function scheduleDraft(schedule: RecordValue | undefined, defaultAgent: string): ScheduleDraft {
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
    whenAt: parsedAt && !Number.isNaN(parsedAt.getTime()) ? parsedAt.toISOString() : '',
    cwd: automationDraftCwd(source.cwd),
    attachments: attachmentsFromRecords(source.attachments),
    agent: automationAgentOf(schedule, defaultAgent),
    instructions: String(source.instructions || ''),
    enabled: source.enabled !== false,
  };
}

function ScheduleEditor({
  api,
  draft,
  editing,
  busy,
  running = false,
  projects,
  error = '',
  onCancel,
  onSave,
  onToggle,
  onRun,
  onDelete,
}: {
  api: SchedulesApi | undefined;
  draft: ScheduleDraft;
  editing: boolean;
  busy: boolean;
  running?: boolean;
  projects: DesktopProjectSummary[];
  error?: string;
  onCancel(): void;
  onSave(entry: RecordValue): void;
  onToggle?(enabled: boolean): void;
  onRun?(): void;
  onDelete?(): void;
}) {
  const [frequency, setFrequency] = useState<FrequencyKind>(draft.frequency);
  const [weekday, setWeekday] = useState(draft.weekday);
  const [agent, setAgent] = useState(draft.agent);
  const [cwd, setCwd] = useState(draft.cwd);
  const [attachments, setAttachments] = useState<AutomationAttachment[]>(draft.attachments);
  const [enabled, setEnabled] = useState(draft.enabled);
  const [formError, setFormError] = useState('');
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
            // An untouched run time keeps the saved instant to the millisecond,
            // so the save does not read as a new time (which re-arms a
            // finished one-shot).
            const at = text('schedule-at');
            setFormError('');
            onSave({
              name: editing ? draft.name : text('schedule-name'),
              ...(editing && text('schedule-name') !== draft.name ? { newName: text('schedule-name') } : {}),
              description: draft.description,
              ...(frequency === 'once'
                ? { at: draft.whenAt && at === draft.at ? draft.whenAt : at }
                : { time: scheduleCron(frequency, text, weekday) }),
              ...automationRunFields(agent),
              ...(cwd ? { cwd } : {}),
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
              // biome-ignore lint/a11y/noAutofocus: the schedule name field is the first input of a freshly opened editor form
              autoFocus
              disabled={busy}
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
              <AutomationAgentPicker
                api={api}
                value={agent}
                disabled={busy}
                ariaLabel={t('Schedule bot')}
                onChange={(next) => {
                  setAgent(next);
                  setFormError('');
                }}
              />
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
          <div className="schedules-field">
            <small>
              {t(
                "Saving lets this schedule's runs act without asking, within the bot's permissions. Payments and permanent deletes are never done in runs."
              )}
            </small>
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
const SCHEDULE_REFERENCE_KEYS = ['channelSetup', 'projects'] as const satisfies readonly SidebarReferenceKey[];

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
  // Routines are bot-based: with no bot at all, none can be made.
  const bots = useAutomationAgents(api, active);
  const noBot = bots.ready && bots.members.length === 0;
  const defaultAgent = bots.members[0]?.id ?? '';
  const projects = values.projects;
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
  // A bot room's "루틴 만들기": the new-schedule editor with that bot preselected.
  useNewScheduleRequest(active, (agentId) => {
    setError('');
    setEditor({ name: '', draft: scheduleDraft(undefined, agentId) });
  });
  const [runningName, setRunningName] = useState('');
  // The editor portals to document.body, so the sidebar's inert/aria-hidden
  // does not reach it: a collapsed sidebar — or another destination taking the
  // panel area — must close it explicitly. Search state is untouched.
  useSidebarPanelDismiss(active, () => {
    setEditor(null);
  });
  const busy = Boolean(pending) || loading;

  const schedules = rows(setup.schedules);
  const [sort, setSort] = useSortChoice<ScheduleSort>('mixdog.sidebar-sort.schedules.v1', SCHEDULE_SORTS, 'next');
  const runNow = async (name: string) => {
    if (!api?.invokeCapability || runningName) return;
    setRunningName(name);
    setError('');
    try {
      await api.invokeCapability({ capability: 'runScheduleNow', args: [name] });
      showDesktopToast(t('"{{name}}" finished. Its result is in the bot\'s chat.', { name }), 'success');
      void completeMutation('runScheduleNow');
      notifySessionsRefresh();
    } catch (reason) {
      showDesktopToast(scheduleErrorText(reason), 'error', {
        scope: `schedule:run:${name}`,
      });
    } finally {
      setRunningName('');
    }
  };
  const text = query.trim().toLowerCase();
  const visible = schedules.filter((schedule) => {
    if (!text) return true;
    return [schedule.name, schedule.description, schedule.time, bots.label(automationAgentOf(schedule)).name]
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
        {/* Title and primary action live in the sidebar panel header; with no
          bot there is nothing to add yet. */}
        {!noBot && (
          <SidebarPanelAction
            active={active}
            label={t('New schedule')}
            icon={Plus}
            className="schedules-add"
            disabled={busy}
            onClick={() => {
              setError('');
              setEditor({ name: '', draft: scheduleDraft(undefined, defaultAgent) });
            }}
          />
        )}
        <div className="schedules-search">
          <Search size={14} aria-hidden="true" />
          <input
            aria-label={t('Search schedules')}
            placeholder={t('Search schedules…')}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </div>
        {active && editor && noBot && (
          <SidebarDialogLayer onClose={() => setEditor(null)}>
            <section className="schedules-dialog" role="dialog" aria-modal="true" aria-label={t('New schedule')}>
              <RoutineNeedsBot />
            </section>
          </SidebarDialogLayer>
        )}
        {active && editor && !noBot && (
          <ScheduleEditor
            api={api}
            key={editor.name || '(new)'}
            draft={editor.draft}
            editing={Boolean(editor.name)}
            busy={busy}
            running={runningName === editor.name}
            projects={projects}
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
        {!loading && !noBot && schedules.length > 0 && (
          <RoutineSortChips value={sort} options={scheduleSortOptions()} onChange={setSort} />
        )}
        {!loading && noBot && <RoutineNeedsBot />}
        {!loading && visible.length > 0 && (
          <RoutineSideGroups
            groups={scheduleGroups(
              visible,
              sort,
              bots.members.map((member) => member.id)
            )}
            title={(group) => cadenceLabel(String(group.key).replace('cadence:', '') as Cadence)}
            bot={bots.label}
          >
            {(schedule) => {
              const name = String(schedule.name);
              const owner = automationAgentOf(schedule);
              const bot = bots.label(owner);
              // routineRows keeps the routine tab's state (last run, auto-pause).
              const row = routineRows([schedule], owner)[0];
              const paused = routinePausedText(schedule, row.pausedAfter);
              const when =
                sort === 'bot'
                  ? [describeSchedule(schedule), paused || (row.nextAt !== null ? relativeTime(row.nextAt) : '')]
                  : sort === 'cadence'
                    ? [bot.name, cadenceTime(schedule), paused]
                    : [
                        bot.name,
                        paused || (row.nextAt !== null ? relativeTime(row.nextAt) : describeSchedule(schedule)),
                      ];
              return (
                <RoutineItem
                  key={name}
                  name={name}
                  enabled={row.enabled}
                  held={routinePaused(schedule)}
                  last={row.last}
                  detail={when.filter(Boolean).join(' · ')}
                  health={row}
                  leading={
                    sort === 'bot' ? undefined : <RoomMemberFace member={bot} className="automation-agent-face" />
                  }
                  running={runningNames?.has(name) === true || runningName === name}
                  busy={busy}
                  onOpen={() => {
                    setError('');
                    setEditor({ name, draft: scheduleDraft(schedule, defaultAgent) });
                  }}
                  onToggle={(enabled) => void run('setScheduleEnabled', [name, enabled], 'toast')}
                  onRun={() => void runNow(name)}
                  onRetryDelivery={() => void run('retryRoutineDelivery', ['schedule', name], 'toast')}
                  onDelete={() => void run('deleteSchedule', [name], 'toast')}
                />
              );
            }}
          </RoutineSideGroups>
        )}
        {!loading && !noBot && visible.length === 0 && (
          <div className="utility-dock-empty">
            <p>{t('No schedules.')}</p>
          </div>
        )}
      </div>
    </div>
  );
}

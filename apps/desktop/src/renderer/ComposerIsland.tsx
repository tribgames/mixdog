import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { liveAgentRows } from './agent-activity-model';
import { ComposerIslandContext, type ComposerIslandTab } from './composer-island-state';
import { desktopHeaderSnapshotsEqual } from './desktop-snapshot-store';
import { EMPTY_SNAPSHOT, type Snapshot } from './desktop-types';
import { t } from './i18n';
import { MxIcon } from './MxIcon';
import { defaultSessionLaneStore, useSessionLane } from './session-lane-store';
import { formatElapsed } from './text-format';
import { timeMs } from './transcript-primitives';
import { quotaRemainingLabel, quotaResetLabel } from './quota-continue';
import { useClock } from './use-clock';

/** A short notice the island shows in place of its pill, then returns. */
export type ComposerIslandFlash = { key: string; text: string };

/** The selected route differs from the route this chat runs on. */
export type ComposerIslandModelMismatch = {
  /** The chat's own model, display name. */
  sessionModel: string;
  /** The model picked in the composer, display name. */
  selectedModel: string;
  onRevert(): void;
  onContinue(): void;
};

/** The provider's quota ran out and stopped the latest turn. */
export type ComposerIslandQuota = {
  /** Provider display name. */
  provider: string;
  /** Epoch ms the quota resets; null when unknown. */
  resetAt: number | null;
  /** Leave the session stopped for this turn. */
  onDismiss(): void;
  /** Open the model picker to continue in another model. */
  onContinue(): void;
  /** Arm the auto-resume at the reset time; given only when the user's
   *  auto-resume setting is off and the reset time is known. */
  onSchedule?(): void;
};

/** A quota-stopped turn that resumes by itself at the reset time. */
export type ComposerIslandQuotaResume = {
  /** Model the turn resumes in, display name. */
  model: string;
  /** Epoch ms of the resume. */
  resetAt: number;
  /** Drop the reservation; the session stays stopped. */
  onCancel(): void;
  /** Open the model picker to continue in another model instead. */
  onContinue(): void;
};

const FLASH_MS = 2_500;

/** A segment's words, plus the icon and bare count the narrow island shows
 *  instead (the count is painted from the attribute so it never joins the
 *  text content). */
export function IslandSegLabel({ text, count, icon }: { text: string; count: number; icon: string }) {
  return (
    <>
      <MxIcon name={icon} size={14} className="composer-island-seg-icon" aria-hidden="true" />
      <span className="composer-island-seg-word">{text}</span>
      <span className="composer-island-seg-num" data-count={count} aria-hidden="true" />
    </>
  );
}

/** Running work: one slowly pulsing dot (still under reduced motion). */
function JobsPulse() {
  return <span className="composer-island-pulse" aria-hidden="true" />;
}

type JobKind = 'shell' | 'agent';
type JobRow = {
  key: string;
  kind: JobKind;
  /** Agent role (or the shell command). */
  label: string;
  /** Agent tag; '' for shell jobs and untagged agents. */
  sub: string;
  startedAt: number;
  /** An agent that is queued or waiting rather than working. */
  idle: boolean;
  /** Not started yet; an idle row that is not queued is a running agent waiting. */
  queued?: boolean;
  /** Blocked on the user's approval: neither working nor idle. */
  needsUser?: boolean;
  /** The agent's own session: '' when it has none to open. */
  sessionId?: string;
};

/** Rows that need the user lead, then working ones, then queued/waiting. */
function jobRowRank(row: JobRow): number {
  if (row.needsUser) return 0;
  return row.idle ? 2 : 1;
}

/** Shell jobs newest first, then agents that need the user, work or wait (in
 *  that order). Idle and finished agents are not background work. */
function backgroundJobRows(snapshot: Snapshot): JobRow[] {
  const shell = (snapshot.shellJobs?.jobs ?? [])
    .map((job, index) => ({
      key: `shell:${String(job.taskId || job.task_id || index)}`,
      kind: 'shell' as const,
      label: String(job.command || '').trim(),
      sub: '',
      startedAt: timeMs(job.startedAt),
      idle: false,
    }))
    .sort((a, b) => b.startedAt - a.startedAt);
  const agents = liveAgentRows(snapshot)
    .filter((agent) => agent.queued || ['running', 'needs-user', 'waiting', 'cancel-unconfirmed'].includes(agent.state))
    .map((agent) => ({
      key: `agent:${agent.key}`,
      kind: 'agent' as const,
      label: agent.role,
      sub: agent.tag && agent.tag !== agent.role ? agent.tag : '',
      startedAt: agent.turnStartedAt || agent.startedAt,
      idle: agent.queued || agent.state === 'waiting',
      queued: agent.queued,
      needsUser: agent.state === 'needs-user',
      sessionId: agent.sessionId,
    }))
    .sort((a, b) => jobRowRank(a) - jobRowRank(b));
  return [...shell, ...agents];
}

/** Shows `flash` once per key for FLASH_MS. */
function useIslandFlash(flash: ComposerIslandFlash | null): ComposerIslandFlash | null {
  const [visible, setVisible] = useState<ComposerIslandFlash | null>(null);
  const shownKey = useRef('');
  useEffect(() => {
    if (!flash || flash.key === shownKey.current) return;
    shownKey.current = flash.key;
    setVisible(flash);
  }, [flash]);
  useEffect(() => {
    if (!visible) return undefined;
    const timer = window.setTimeout(() => setVisible(null), FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [visible]);
  return visible;
}

/** An agent blocked on the user is marked for attention and never pulses;
 *  running agents pulse; a set that is only queued or waiting rests grey. */
function AgentMark({ working, needsUser = false }: { working: boolean; needsUser?: boolean }) {
  if (needsUser) return <MxIcon name="warning" size={14} className="composer-island-attention" aria-hidden="true" />;
  return working ? <JobsPulse /> : <span className="composer-island-dot composer-island-dot-idle" aria-hidden="true" />;
}

function rowSubLabel(row: JobRow, clock: number): string {
  if (row.needsUser) return t('Waiting for approval');
  if (row.idle) return t(row.queued ? 'Queued' : 'Waiting for tasks');
  return row.startedAt > 0 ? formatElapsed(clock - row.startedAt) : '';
}

function JobsPanel({
  rows,
  tab,
  onTab,
  onClose,
  onOpenRow,
}: {
  rows: JobRow[];
  tab: JobKind;
  onTab(tab: JobKind): void;
  onClose(): void;
  /** Present only where agent sessions can be opened. */
  onOpenRow?(row: JobRow): void;
}) {
  const clock = useClock(true);
  const agents = rows.filter((row) => row.kind === 'agent');
  const shells = rows.filter((row) => row.kind === 'shell');
  // The requested tab may have emptied while open: show the one that has rows.
  const other: JobKind = tab === 'agent' ? 'shell' : 'agent';
  const shown: JobKind = (tab === 'agent' ? agents : shells).length > 0 ? tab : other;
  const tabs: Array<[JobKind, JobRow[], string]> = [
    ['agent', agents, t('Agent {{agent}}', { agent: agents.length })],
    ['shell', shells, t('Shell {{shell}}', { shell: shells.length })],
  ];
  return (
    <section className="composer-island-panel" aria-label={t('Background tasks')}>
      <div className="composer-island-phead">
        {tabs.map(([kind, list, label]) =>
          list.length > 0 ? (
            <button
              key={kind}
              type="button"
              className="composer-island-tab"
              data-active={shown === kind ? 'true' : 'false'}
              aria-pressed={shown === kind}
              onClick={() => onTab(kind)}
            >
              {kind === 'agent' ? (
                <AgentMark
                  working={list.some((row) => !row.idle && !row.needsUser)}
                  needsUser={list.some((row) => row.needsUser)}
                />
              ) : (
                <JobsPulse />
              )}
              {label}
            </button>
          ) : null
        )}
        <button
          type="button"
          className="composer-island-close"
          aria-label={t('Close')}
          title={t('Close')}
          onClick={onClose}
        >
          <MxIcon name="close-small" size={16} />
        </button>
      </div>
      <ul className="composer-island-pbody composer-island-jobs">
        {(shown === 'agent' ? agents : shells).map((row) => {
          const openable = Boolean(onOpenRow) && row.kind === 'agent' && Boolean(row.sessionId);
          const sub = rowSubLabel(row, clock);
          const content = (
            <>
              {row.kind === 'agent' ? (
                <AgentMark working={!row.idle && !row.needsUser} needsUser={row.needsUser} />
              ) : (
                <JobsPulse />
              )}
              <span className="composer-island-row-main">
                {row.kind === 'shell' ? (
                  <code>{row.label}</code>
                ) : (
                  <>
                    {row.label}
                    {row.sub ? <span className="composer-island-row-tag">{row.sub}</span> : null}
                  </>
                )}
              </span>
              {/* Time spent waiting on the user is not work: no running timer. */}
              {sub ? <span className="composer-island-row-sub">{sub}</span> : null}
            </>
          );
          return (
            <li key={row.key} className="composer-island-row" data-openable={openable ? 'true' : undefined}>
              {openable ? (
                <button
                  type="button"
                  className="composer-island-row-open"
                  aria-label={[t('Open {{agent}}', { agent: [row.label, row.sub].filter(Boolean).join(' · ') }), sub]
                    .filter(Boolean)
                    .join(', ')}
                  onClick={() => onOpenRow?.(row)}
                >
                  {content}
                </button>
              ) : (
                content
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function ModelPanel({ mismatch }: { mismatch: ComposerIslandModelMismatch }) {
  return (
    <section className="composer-island-panel composer-island-model" aria-label={t('Model mismatch')}>
      <div className="composer-island-pbody">
        <p className="composer-island-ptitle">
          {t('This chat continues in {{model}}', { model: mismatch.sessionModel })}
        </p>
        <p className="composer-island-pnote">
          {t(
            '{{model}} is used for new chats or when you continue this chat in it. The conversation and its Goal carry over.',
            { model: mismatch.selectedModel }
          )}
        </p>
        <div className="composer-island-pfoot">
          <button type="button" className="composer-island-button" onClick={mismatch.onRevert}>
            {t('Revert')}
          </button>
          <button
            type="button"
            className="composer-island-button composer-island-button-primary"
            onClick={mismatch.onContinue}
          >
            {t('Continue in {{model}}', { model: mismatch.selectedModel })}
          </button>
        </div>
      </div>
    </section>
  );
}

function QuotaPanelFrame({
  label,
  icon,
  title,
  note,
  children,
}: {
  label: string;
  icon: 'warning' | 'clock';
  title: string;
  note: string;
  children: ReactNode;
}) {
  return (
    <section className="composer-island-panel composer-island-quota" aria-label={label}>
      <div className="composer-island-pbody">
        <p className="composer-island-ptitle">
          <MxIcon name={icon} size={16} />
          {title}
        </p>
        <p className="composer-island-pnote">{note}</p>
        <div className="composer-island-pfoot">{children}</div>
      </div>
    </section>
  );
}

function ContinueButton({ onClick }: { onClick(): void }) {
  return (
    <button type="button" className="composer-island-button composer-island-button-primary" onClick={onClick}>
      {t('Continue in another model')}
    </button>
  );
}

function QuotaPanel({ quota }: { quota: ComposerIslandQuota }) {
  return (
    <QuotaPanelFrame
      label={t('Usage limit reached')}
      icon="warning"
      title={t('{{provider}} usage limit reached', { provider: quota.provider })}
      note={
        quota.resetAt === null
          ? t('No reset time is available. Continuing in another model carries on this chat as it is.')
          : t('Resets at {{time}}. Continuing in another model carries on this chat as it is.', {
              time: quotaResetLabel(quota.resetAt),
            })
      }
    >
      <button type="button" className="composer-island-button" onClick={quota.onDismiss}>
        {t('Keep stopped')}
      </button>
      {quota.onSchedule && quota.resetAt !== null ? (
        <button type="button" className="composer-island-button" onClick={quota.onSchedule}>
          {t('Auto-resume at {{time}}', { time: quotaResetLabel(quota.resetAt) })}
        </button>
      ) : null}
      <ContinueButton onClick={quota.onContinue} />
    </QuotaPanelFrame>
  );
}

/** Remaining time, refreshed once a minute. */
function ResumeRemaining({ resetAt }: { resetAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [resetAt]);
  return <>{quotaRemainingLabel(resetAt, now)}</>;
}

function ResumePanel({ resume }: { resume: ComposerIslandQuotaResume }) {
  const time = quotaResetLabel(resume.resetAt);
  return (
    <QuotaPanelFrame
      label={t('Waiting to resume')}
      icon="clock"
      title={t('Resumes automatically at {{time}} in {{model}}', { time, model: resume.model })}
      note={t('{{remaining}} left. The reservation is kept even if you close and reopen the app.', {
        remaining: quotaRemainingLabel(resume.resetAt),
      })}
    >
      <button type="button" className="composer-island-button" onClick={resume.onCancel}>
        {t('Cancel resume')}
      </button>
      <ContinueButton onClick={resume.onContinue} />
    </QuotaPanelFrame>
  );
}

/**
 * The single island above a session's composer. Its slot always reserves the
 * pill's height, so the island appearing, expanding (upward, over the
 * transcript), growing into the approval card or flashing a notice never
 * moves the transcript.
 */
export function ComposerIsland({
  sessionId,
  goal,
  files,
  approval,
  flash,
  modelMismatch,
  quotaExhausted,
  quotaResume,
  onOpenAgentSession,
}: {
  /** The pane's session ('' while hidden): background jobs read its lane. */
  sessionId: string;
  /** Opens an agent's session (same action as the Agents pane rows). */
  onOpenAgentSession?(sessionId: string, title: string, ownerSessionId: string): void;
  goal?: ReactNode;
  /** The changed-files segment: opens the side dock, or where the surface has
   *  none, expands into the turn's file list like the Goal tab. */
  files?: ReactNode;
  /** The live tool approval card: the island grows into it. */
  approval?: ReactNode;
  flash?: ComposerIslandFlash | null;
  modelMismatch?: ComposerIslandModelMismatch | null;
  /** Shown as the island's panel and takes precedence over the model mismatch. */
  quotaExhausted?: ComposerIslandQuota | null;
  /** A waiting auto-resume: a pill segment that expands, replacing the quota panel. */
  quotaResume?: ComposerIslandQuotaResume | null;
}) {
  const lane = useSessionLane(sessionId, defaultSessionLaneStore, desktopHeaderSnapshotsEqual, Boolean(sessionId));
  const snapshot = lane ?? EMPTY_SNAPSHOT;
  const jobRows = useMemo(() => backgroundJobRows(snapshot), [snapshot]);
  const agentRows = jobRows.filter((row) => row.kind === 'agent');
  const agentNeedsUser = agentRows.filter((row) => row.needsUser).length;
  const agentWorking = agentRows.filter((row) => !row.idle && !row.needsUser).length;
  const agentWaiting = agentRows.filter((row) => row.idle).length;
  const shellRows = jobRows.filter((row) => row.kind === 'shell');
  const shellCount = Math.max(Number(snapshot.shellJobs?.count) || 0, shellRows.length);
  const running = agentRows.length + shellCount;
  const agentStates = [
    agentNeedsUser > 0 ? t('Needs you {{needs}}', { needs: agentNeedsUser }) : '',
    agentWorking > 0 ? t('Jobs: Running {{running}}', { running: agentWorking }) : '',
    agentWaiting > 0 ? t('Waiting {{waiting}}', { waiting: agentWaiting }) : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const [jobsTab, setJobsTab] = useState<JobKind>('agent');
  const [expanded, setExpanded] = useState<ComposerIslandTab>('');
  const toggleJobs = (kind: JobKind) => {
    const open = expanded === 'jobs' && jobsTab === kind;
    setJobsTab(kind);
    setExpanded(open ? '' : 'jobs');
  };
  const islandRef = useRef<HTMLDivElement | null>(null);
  // Finished background work announces nothing: a flash per job would make
  // the island pop in and out.
  const visibleFlash = useIslandFlash(flash ?? null);

  // A tab whose content went away closes; a new session starts collapsed.
  useEffect(() => {
    if ((expanded === 'jobs' && running === 0) || (expanded === 'model' && !modelMismatch)) setExpanded('');
    if (expanded === 'resume' && !quotaResume) setExpanded('');
  }, [expanded, modelMismatch, quotaResume, running]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId is the reset trigger
  useEffect(() => {
    setExpanded('');
  }, [sessionId]);
  // Outside press or Escape collapses the island's own tabs. The Goal tab
  // owns its dismissal (it also guards its edit dialog).
  useEffect(() => {
    if (expanded !== 'jobs' && expanded !== 'model' && expanded !== 'resume') return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const island = islandRef.current;
      if (island && event.target instanceof Node && island.contains(event.target)) return;
      setExpanded('');
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded('');
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [expanded]);

  let mode = 'pill';
  if (approval) mode = 'approval';
  else if (visibleFlash) mode = 'flash';
  else if (quotaExhausted || expanded) mode = 'panel';
  const resumePanel = mode === 'panel' && expanded === 'resume' && Boolean(quotaResume);
  const quotaPanel = mode === 'panel' && Boolean(quotaExhausted) && !quotaResume;
  const ownPanel = quotaPanel || resumePanel || (mode === 'panel' && (expanded === 'jobs' || expanded === 'model'));
  const context = useMemo(() => ({ expanded, setExpanded }), [expanded]);

  return (
    <ComposerIslandContext.Provider value={context}>
      <div className="composer-island-slot" data-mode={mode}>
        <div className="composer-island-stage">
          <div ref={islandRef} className="composer-island" data-mode={mode} data-expanded={expanded || undefined}>
            {approval ? <div className="composer-island-approval">{approval}</div> : null}
            {mode === 'flash' && visibleFlash ? (
              <div className="composer-island-flash" role="status" key={visibleFlash.key}>
                <MxIcon name="check" size={16} />
                <span>{visibleFlash.text}</span>
              </div>
            ) : null}
            <div className="composer-island-pill" hidden={mode === 'approval' || mode === 'flash' || ownPanel}>
              {quotaResume ? (
                <button
                  type="button"
                  className="composer-island-seg composer-island-seg-warning"
                  aria-expanded={expanded === 'resume'}
                  onClick={() => setExpanded(expanded === 'resume' ? '' : 'resume')}
                >
                  <MxIcon name="clock" size={16} />
                  <span className="composer-island-seg-text">
                    {t('Resumes in {{model}} at {{time}}', {
                      model: quotaResume.model,
                      time: quotaResetLabel(quotaResume.resetAt),
                    })}
                  </span>
                  <span className="composer-island-seg-sub">
                    <ResumeRemaining resetAt={quotaResume.resetAt} />
                  </span>
                </button>
              ) : null}
              {modelMismatch ? (
                <button
                  type="button"
                  className="composer-island-seg composer-island-seg-model"
                  aria-expanded={expanded === 'model'}
                  title={t('Continuing in {{model}}', { model: modelMismatch.sessionModel })}
                  onClick={() => setExpanded(expanded === 'model' ? '' : 'model')}
                >
                  <span className="composer-island-dot" aria-hidden="true" />
                  <span className="composer-island-seg-text">
                    {t('Continuing in {{model}}', { model: modelMismatch.sessionModel })}
                  </span>
                </button>
              ) : null}
              {goal}
              {agentRows.length > 0 ? (
                <button
                  type="button"
                  className="composer-island-seg composer-island-seg-agents"
                  aria-expanded={expanded === 'jobs' && jobsTab === 'agent'}
                  title={`${t('Agent {{agent}}', { agent: agentRows.length })} · ${agentStates}`}
                  onClick={() => toggleJobs('agent')}
                >
                  <AgentMark working={agentWorking > 0} needsUser={agentNeedsUser > 0} />
                  <IslandSegLabel
                    text={t('Agent {{agent}}', { agent: agentRows.length })}
                    count={agentRows.length}
                    icon="agent"
                  />
                  <span className="composer-island-seg-meta">{agentStates}</span>
                </button>
              ) : null}
              {shellCount > 0 ? (
                <button
                  type="button"
                  className="composer-island-seg composer-island-seg-shell"
                  aria-expanded={expanded === 'jobs' && jobsTab === 'shell'}
                  title={t('Shell {{shell}}', { shell: shellCount })}
                  onClick={() => toggleJobs('shell')}
                >
                  <JobsPulse />
                  <IslandSegLabel text={t('Shell')} count={shellCount} icon="terminal" />
                  {shellRows[0]?.label ? (
                    <span className="composer-island-seg-meta">
                      <span className="composer-island-seg-cmd">{shellRows[0].label}</span>
                      {shellCount > 1 ? ` +${shellCount - 1}` : ''}
                    </span>
                  ) : null}
                </button>
              ) : null}
              {files}
            </div>
            {quotaPanel && quotaExhausted ? <QuotaPanel quota={quotaExhausted} /> : null}
            {resumePanel && quotaResume ? <ResumePanel resume={quotaResume} /> : null}
            {ownPanel && !quotaPanel && expanded === 'jobs' ? (
              <JobsPanel
                rows={jobRows}
                tab={jobsTab}
                onTab={setJobsTab}
                onClose={() => setExpanded('')}
                onOpenRow={
                  onOpenAgentSession
                    ? (row) => {
                        if (!row.sessionId) return;
                        onOpenAgentSession(row.sessionId, [row.label, row.sub].filter(Boolean).join(' · '), sessionId);
                        setExpanded('');
                      }
                    : undefined
                }
              />
            ) : null}
            {ownPanel && !quotaPanel && expanded === 'model' && modelMismatch ? (
              <ModelPanel mismatch={modelMismatch} />
            ) : null}
          </div>
        </div>
      </div>
    </ComposerIslandContext.Provider>
  );
}

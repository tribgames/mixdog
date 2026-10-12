import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { dismissShellJobs, useDismissedShellJobs } from './background-jobs-dismissed-store';
import type { DesktopAgentPoolRow } from '../shared/contract';
import { agentElapsedText, agentUsageMeta } from './agent-row-meta';
import { AgentProviderMark, AgentRouteSummary } from './agent-row-parts';
import { backgroundJobRows, type JobKind, type JobRow } from './background-jobs-model';
import { ShellJobContent, ShellRowButton, useShellStops } from './shell-job-controls';
import { ComposerIslandContext, type ComposerIslandTab } from './composer-island-state';
import { desktopHeaderSnapshotsEqual } from './desktop-snapshot-store';
import { EMPTY_SNAPSHOT } from './desktop-types';
import { t } from './i18n';
import { MxIcon } from './MxIcon';
import { defaultSessionLaneStore, useSessionLane } from './session-lane-store';
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

/** An agent row in the Agents pane's grammar, plus tokens and tool calls. */
function AgentJobContent({ row, elapsed }: { row: JobRow; elapsed: string }) {
  const agent = row.pool as DesktopAgentPoolRow;
  return (
    <>
      <AgentProviderMark agent={agent} />
      <span className="schedules-row-copy">
        <span className="agent-pool-heading">
          <b className="agent-pool-name">{[row.label, row.sub].filter(Boolean).join(' · ')}</b>
        </span>
        <AgentRouteSummary agent={agent} meta={agentUsageMeta(agent)} />
      </span>
      <span className="agent-activity-status">
        {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: aria-label on <time> gives the elapsed duration an explicit accessible name */}
        <time
          className="agent-activity-elapsed"
          aria-label={elapsed}
          title={row.state === 'cancel-unconfirmed' ? t('Cancel unconfirmed') : undefined}
          data-state={row.state}
        >
          {elapsed}
        </time>
      </span>
    </>
  );
}

function JobsPanel({
  sessionId,
  rows,
  tab,
  onTab,
  onClose,
  onOpenRow,
  onDismiss,
}: {
  sessionId: string;
  rows: JobRow[];
  tab: JobKind;
  onTab(tab: JobKind): void;
  onClose(): void;
  /** Hides a finished shell row for good. */
  onDismiss(row: JobRow): void;
  /** Present only where agent sessions can be opened. */
  onOpenRow?(row: JobRow): void;
}) {
  const clock = useClock(true);
  const { stopOf, stop } = useShellStops(sessionId);
  const agents = rows.filter((row) => row.kind === 'agent');
  const shells = rows.filter((row) => row.kind === 'shell');
  // The requested tab may have emptied while open: show the one that has rows.
  const other: JobKind = tab === 'agent' ? 'shell' : 'agent';
  const requestedRows = tab === 'agent' ? agents : shells;
  const shown: JobKind = requestedRows.length > 0 ? tab : other;
  const runningShells = shells.filter((row) => !row.finished).length;
  const tabs: Array<[JobKind, JobRow[], string]> = [
    ['agent', agents, t('Agent {{agent}}', { agent: agents.length })],
    [
      'shell',
      shells,
      runningShells > 0
        ? t('Shell {{shell}}', { shell: runningShells })
        : t('Island: {{count}} finished shells', { count: shells.length }),
    ],
  ];
  return (
    <section className="composer-island-panel" aria-label={t('Background tasks')}>
      <div className="composer-island-phead">
        {tabs.map(
          ([kind, list, label]) =>
            list.length > 0 && (
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
                ) : runningShells > 0 ? (
                  <JobsPulse />
                ) : (
                  <span className="composer-island-dot composer-island-dot-idle" aria-hidden="true" />
                )}
                {label}
              </button>
            )
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
          const elapsed = row.pool ? agentElapsedText(row.state ?? 'unknown', row.pool, clock) : '';
          const content =
            row.kind === 'agent' && row.pool ? (
              <AgentJobContent row={row} elapsed={elapsed} />
            ) : (
              <ShellJobContent row={row} clock={clock} stop={stopOf(row)} />
            );
          return (
            <li
              key={row.key}
              className="composer-island-row"
              data-openable={openable ? 'true' : undefined}
              data-finished={row.finished ? 'true' : undefined}
            >
              {openable ? (
                <button
                  type="button"
                  className="composer-island-row-open"
                  aria-label={[t('Open {{agent}}', { agent: [row.label, row.sub].filter(Boolean).join(' · ') }), elapsed]
                    .filter(Boolean)
                    .join(', ')}
                  onClick={() => onOpenRow?.(row)}
                >
                  {content}
                </button>
              ) : (
                content
              )}
              {row.kind === 'shell' ? (
                <ShellRowButton row={row} stop={stopOf(row)} onStop={stop} onDismiss={onDismiss} />
              ) : null}
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
  const dismissedShells = useDismissedShellJobs(sessionId);
  const jobRows = useMemo(() => backgroundJobRows(snapshot, dismissedShells), [snapshot, dismissedShells]);
  const agentRows = jobRows.filter((row) => row.kind === 'agent');
  const agentNeedsUser = agentRows.filter((row) => row.needsUser).length;
  const agentWorking = agentRows.filter((row) => !row.idle && !row.needsUser).length;
  const agentWaiting = agentRows.filter((row) => row.idle).length;
  const shellRows = jobRows.filter((row) => row.kind === 'shell' && !row.finished);
  const finishedShellCount = jobRows.filter((row) => row.kind === 'shell' && row.finished).length;
  const shellCount = Math.max(Number(snapshot.shellJobs?.count) || 0, shellRows.length);
  // Finished shells keep the jobs panel open-able until dismissed.
  const running = agentRows.length + shellCount + finishedShellCount;
  const agentStates = [
    agentNeedsUser > 0 ? t('Needs you {{needs}}', { needs: agentNeedsUser }) : '',
    agentWaiting > 0 ? t('Island: {{waiting}} waiting', { waiting: agentWaiting }) : '',
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
              {quotaResume && (
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
              )}
              {modelMismatch && (
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
              )}
              {goal}
              {agentRows.length > 0 && (
                <button
                  type="button"
                  className="composer-island-seg composer-island-seg-agents"
                  aria-expanded={expanded === 'jobs' && jobsTab === 'agent'}
                  title={`${t('Agent {{agent}}', { agent: agentRows.length })} · ${agentStates}`}
                  onClick={() => toggleJobs('agent')}
                >
                  <IslandSegLabel
                    text={t('Island: {{count}} agents', { count: agentRows.length })}
                    count={agentRows.length}
                    icon="agent"
                  />
                  {agentNeedsUser === 0 ? <AgentMark working={agentWorking > 0} /> : null}
                  {(agentNeedsUser > 0 || agentWaiting > 0) && (
                    <span className="composer-island-seg-states">
                      {agentNeedsUser > 0 ? (
                        <span className="composer-island-seg-state">
                          <MxIcon name="warning" size={14} className="composer-island-attention" aria-hidden="true" />
                          <span className="composer-island-seg-word">
                            {t('Needs you {{needs}}', { needs: agentNeedsUser })}
                          </span>
                          <span className="composer-island-seg-num" data-count={agentNeedsUser} aria-hidden="true" />
                        </span>
                      ) : null}
                      {agentWaiting > 0 ? (
                        <span className="composer-island-seg-state" data-kind="waiting">
                          <span className="composer-island-dot composer-island-dot-idle" aria-hidden="true" />
                          <span className="composer-island-seg-word">
                            {t('Island: {{waiting}} waiting', { waiting: agentWaiting })}
                          </span>
                          <span className="composer-island-seg-num" data-count={agentWaiting} aria-hidden="true" />
                        </span>
                      ) : null}
                    </span>
                  )}
                </button>
              )}
              {shellCount > 0 || finishedShellCount > 0 ? (
                <button
                  type="button"
                  className="composer-island-seg composer-island-seg-shell"
                  data-finished={shellCount === 0 ? 'true' : undefined}
                  aria-expanded={expanded === 'jobs' && jobsTab === 'shell'}
                  title={
                    shellCount > 0
                      ? t('Shell {{shell}}', { shell: shellCount })
                      : t('Island: {{count}} finished shells', { count: finishedShellCount })
                  }
                  onClick={() => toggleJobs('shell')}
                >
                  <IslandSegLabel
                    text={
                      shellCount > 0
                        ? t('Island: {{count}} shells', { count: shellCount })
                        : t('Island: {{count}} finished shells', { count: finishedShellCount })
                    }
                    count={shellCount > 0 ? shellCount : finishedShellCount}
                    icon="shell-prompt"
                  />
                  {shellCount > 0 ? (
                    <JobsPulse />
                  ) : (
                    <span className="composer-island-dot composer-island-dot-idle" aria-hidden="true" />
                  )}
                </button>
              ) : null}
              {files}
            </div>
            {quotaPanel && quotaExhausted ? <QuotaPanel quota={quotaExhausted} /> : null}
            {resumePanel && quotaResume ? <ResumePanel resume={quotaResume} /> : null}
            {ownPanel && !quotaPanel && expanded === 'jobs' && (
              <JobsPanel
                sessionId={sessionId}
                rows={jobRows}
                tab={jobsTab}
                onTab={setJobsTab}
                onClose={() => setExpanded('')}
                onDismiss={(row) => dismissShellJobs(sessionId, [row.key])}
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
            )}
            {ownPanel && !quotaPanel && expanded === 'model' && modelMismatch ? (
              <ModelPanel mismatch={modelMismatch} />
            ) : null}
          </div>
        </div>
      </div>
    </ComposerIslandContext.Provider>
  );
}

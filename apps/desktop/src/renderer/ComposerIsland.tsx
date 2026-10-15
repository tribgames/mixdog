import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from 'react';
import { dismissShellJobs, useDismissedShellJobs } from './background-jobs-dismissed-store';
import { AgentPoolRow } from './AgentActivityPane';
import {
  AGENT_POOL_RECONCILE_MS,
  agentPoolStore,
  islandAgentRows,
  poolRowKey,
  refreshAgentPool,
  startAgentPool,
  type IslandAgentRow,
} from './agent-activity-model';
import { backgroundJobRows, type JobKind, type JobRow, type ShellStopState } from './background-jobs-model';
import { ShellJobContent, ShellRowButton, useShellStops } from './shell-job-controls';
import { ComposerIslandContext, type ComposerIslandTab } from './composer-island-state';
import { desktopHeaderSnapshotsEqual } from './desktop-snapshot-store';
import { EMPTY_SNAPSHOT } from './desktop-types';
import { t } from './i18n';
import { subscribeSharedPoll } from './shared-pool-poll';
import { MxIcon } from './MxIcon';
import { defaultSessionLaneStore, useSessionLane } from './session-lane-store';
import { quotaRemainingLabel, quotaResetLabel } from './quota-continue';
import { useClock } from './use-clock';

/** A short notice the island shows in place of its pill, then returns. */
export type ComposerIslandFlash = { key: string; text: string };

/** A quota-stopped turn that resumes by itself at the reset time. */
export type ComposerIslandQuotaResume = {
  /** Model the turn resumes in, display name. */
  model: string;
  /** Epoch ms of the resume. */
  resetAt: number;
  /** Drop the reservation; the session stays stopped. */
  onCancel(): void;
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

/** Swaps segment words for bare counts only when the full labels overflow the
 *  island's room: the pill is measured at its full-label width before paint,
 *  whenever the room or the pill's content changes. */
function useIslandFit(islandRef: RefObject<HTMLDivElement | null>, pillRef: RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    const island = islandRef.current;
    const pill = pillRef.current;
    const stage = island?.parentElement;
    if (!island || !pill || !stage) return undefined;
    const fit = () => {
      island.removeAttribute('data-compact');
      island.setAttribute('data-measuring', '');
      const needed = pill.offsetWidth;
      island.removeAttribute('data-measuring');
      island.toggleAttribute('data-compact', needed > stage.clientWidth);
    };
    fit();
    const resize = new ResizeObserver(fit);
    resize.observe(stage);
    const mutation = new MutationObserver(fit);
    mutation.observe(pill, {
      subtree: true,
      childList: true,
      characterData: true,
      attributeFilter: ['hidden'],
    });
    return () => {
      resize.disconnect();
      mutation.disconnect();
    };
  }, [islandRef, pillRef]);
}

/** How long an emptied island keeps its slot before the slot eases shut:
 *  content returning within it (one segment handing over to the next) moves
 *  nothing. */
export const ISLAND_COLLAPSE_GRACE_MS = 500;
/** What the island carries; the stylesheet's empty-island rule tests the same. */
const ISLAND_CONTENT =
  '.composer-island-seg, .session-goal-island, .composer-island-approval, .composer-island-flash, .composer-island-quota, .turn-review-bar';

type SlotPresence = 'open' | 'grace' | 'closing' | 'closed';
/** The slot's eased height; the stylesheet rounds it to whole pixels. */
const SLOT_HEIGHT = '--island-slot-height';

/**
 * Owns the slot's explicit height and data-presence. Content opens the slot
 * at once to the stage's real height; a change while open eases there
 * (data-motion carries the CSS transition, which reverses mid-flight on its
 * own). The last content leaving holds the slot for ISLAND_COLLAPSE_GRACE_MS,
 * then eases it to 0. Mount (a session switch remounts the island) and
 * reduced motion apply every change instantly; reduced motion turning on
 * mid-motion lands the slot at its target at once. The island's entry fade
 * (data-entry) is enabled only by content arriving, or the island changing
 * shape, after the first frame: a mounted island draws at its final state.
 * Content changes are read in the mutation microtask, before the frame's
 * layout, so the transcript's viewport observer sees the new dock in the same
 * frame. Segments render from their own state, so the island's DOM, not its
 * props, is watched.
 */
function useIslandSlotPresence(slotRef: RefObject<HTMLDivElement | null>, islandRef: RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    const slot = slotRef.current;
    const island = islandRef.current;
    const stage = island?.parentElement;
    if (!slot || !island || !stage) return undefined;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let armed = false;
    let grace = 0;
    let height = -1;
    let carried = false;
    let shape: string | null = null;
    const presence = (value: SlotPresence) => slot.setAttribute('data-presence', value);
    // An unchanged target starts no transition: it leaves any motion running.
    const resize = (target: number, animate: boolean) => {
      if (target === height) return;
      height = target;
      if (animate) slot.setAttribute('data-motion', '');
      else slot.removeAttribute('data-motion');
      slot.style.setProperty(SLOT_HEIGHT, `${target}px`);
    };
    // The stage's own height, unshrunk by the slot (mid-motion or squeezed).
    const natural = () => {
      slot.setAttribute('data-measuring', '');
      const value = stage.offsetHeight;
      slot.removeAttribute('data-measuring');
      return value;
    };
    const cancelGrace = () => {
      window.clearTimeout(grace);
      grace = 0;
    };
    // The height motion is over (it ran out, or reduced motion cut it short).
    const endMotion = () => {
      slot.removeAttribute('data-motion');
      if (slot.getAttribute('data-presence') === 'closing') presence('closed');
    };
    const collapse = (animate: boolean) => {
      if (animate && height > 0) {
        presence('closing');
        resize(0, true);
      } else {
        resize(0, false);
        presence('closed');
      }
    };
    const sync = () => {
      const animate = armed && !reducedMotion.matches;
      const content = Boolean(island.querySelector(ISLAND_CONTENT));
      const mode = island.getAttribute('data-mode');
      // Set in the same microtask as the change, so the style pass that
      // shows the new content starts its fade; once set it stays.
      if (armed && content && (!carried || mode !== shape)) slot.setAttribute('data-entry', '');
      carried = content;
      shape = mode;
      if (content) {
        cancelGrace();
        // Shown first: a closed slot has no box to measure.
        presence('open');
        resize(natural(), animate);
        return;
      }
      if (!armed) {
        cancelGrace();
        collapse(false);
        return;
      }
      if (slot.getAttribute('data-presence') !== 'open') return;
      presence('grace');
      grace = window.setTimeout(() => {
        grace = 0;
        collapse(!reducedMotion.matches);
      }, ISLAND_COLLAPSE_GRACE_MS);
    };
    const onTransitionEnd = (event: TransitionEvent) => {
      if (event.target === slot && event.propertyName === SLOT_HEIGHT) endMotion();
    };
    // Dropping data-motion removes the transition, so the browser cancels it
    // and the slot takes its target height in the next style pass.
    const onMotionPreference = () => {
      if (reducedMotion.matches && slot.hasAttribute('data-motion')) endMotion();
    };
    sync();
    // The first painted frame shows the true state; changes after it animate.
    const frame = window.requestAnimationFrame(() => {
      armed = true;
    });
    const mutation = new MutationObserver(sync);
    mutation.observe(island, { subtree: true, childList: true, characterData: true, attributes: true });
    // Size changes without a DOM change (wrapping, the pane's height bound).
    const resizeObserver = new ResizeObserver(sync);
    resizeObserver.observe(island);
    for (const child of island.children) resizeObserver.observe(child);
    const children = new MutationObserver(() => {
      for (const child of island.children) resizeObserver.observe(child);
    });
    children.observe(island, { childList: true });
    slot.addEventListener('transitionend', onTransitionEnd);
    reducedMotion.addEventListener('change', onMotionPreference);
    return () => {
      window.cancelAnimationFrame(frame);
      cancelGrace();
      mutation.disconnect();
      children.disconnect();
      resizeObserver.disconnect();
      slot.removeEventListener('transitionend', onTransitionEnd);
      reducedMotion.removeEventListener('change', onMotionPreference);
    };
  }, [slotRef, islandRef]);
}

/** An agent blocked on the user is marked for attention and never pulses;
 *  running agents pulse; a set that is only queued or waiting rests grey. */
function AgentMark({ working, needsUser = false }: { working: boolean; needsUser?: boolean }) {
  if (needsUser) return <MxIcon name="warning" size={14} className="composer-island-attention" aria-hidden="true" />;
  return working ? <JobsPulse /> : <span className="composer-island-dot composer-island-dot-idle" aria-hidden="true" />;
}

/** The jobs panel tab's leading mark: agent activity, a live pulse while a
 *  shell runs, or an idle dot when only finished shells remain. */
function jobsTabMark(kind: JobKind, agents: IslandAgentRow[], runningShells: number): ReactNode {
  if (kind === 'agent') {
    return (
      <AgentMark
        working={agents.some(({ state }) => state === 'running' || state === 'cancel-unconfirmed')}
        needsUser={agents.some(({ state }) => state === 'needs-user')}
      />
    );
  }
  if (runningShells > 0) return <JobsPulse />;
  return <span className="composer-island-dot composer-island-dot-idle" aria-hidden="true" />;
}

function ShellJobItem({
  row,
  clock,
  stop,
  onStop,
  onDismiss,
}: {
  row: JobRow;
  clock: number;
  stop: ShellStopState;
  onStop(row: JobRow): void;
  onDismiss(row: JobRow): void;
}) {
  return (
    <li className="composer-island-row" data-finished={row.finished ? 'true' : undefined}>
      <ShellJobContent row={row} clock={clock} stop={stop} />
      <ShellRowButton row={row} stop={stop} onStop={onStop} onDismiss={onDismiss} />
    </li>
  );
}

function JobsPanel({
  sessionId,
  agents,
  shells,
  tab,
  onTab,
  onClose,
  onOpenSession,
  onDismiss,
}: {
  sessionId: string;
  agents: IslandAgentRow[];
  shells: JobRow[];
  tab: JobKind;
  onTab(tab: JobKind): void;
  onClose(): void;
  /** Hides a finished shell row for good. */
  onDismiss(row: JobRow): void;
  onOpenSession?(sessionId: string, title: string, ownerSessionId: string): void;
}) {
  const clock = useClock(true);
  const { stopOf, stop } = useShellStops(sessionId);
  // The requested tab may have emptied while open: show the one that has rows.
  const other: JobKind = tab === 'agent' ? 'shell' : 'agent';
  const requestedCount = tab === 'agent' ? agents.length : shells.length;
  const shown: JobKind = requestedCount > 0 ? tab : other;
  const runningShells = shells.filter((row) => !row.finished).length;
  // A kind with no rows has no tab at all.
  const tabs: Array<[JobKind, string]> = [];
  if (agents.length > 0) tabs.push(['agent', t('Agent {{agent}}', { agent: agents.length })]);
  if (shells.length > 0) {
    tabs.push([
      'shell',
      runningShells > 0
        ? t('Shell {{shell}}', { shell: runningShells })
        : t('Island: {{count}} finished shells', { count: shells.length }),
    ]);
  }
  return (
    <section className="composer-island-panel" aria-label={t('Background tasks')}>
      <div className="composer-island-phead">
        {tabs.map(([kind, label]) => (
          <button
            key={kind}
            type="button"
            className="composer-island-tab"
            data-active={shown === kind ? 'true' : 'false'}
            aria-pressed={shown === kind}
            onClick={() => onTab(kind)}
          >
            {jobsTabMark(kind, agents, runningShells)}
            {label}
          </button>
        ))}
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
      {shown === 'agent' ? (
        // The Agents window's own tree and row component.
        <div className="composer-island-pbody composer-island-jobs composer-island-agents schedules-list" role="tree">
          {agents.map(({ node, state, waitingForTasks }, index) => (
            <AgentPoolRow
              key={poolRowKey(node.agent, index)}
              agent={node.agent}
              clock={clock}
              stateOverride={state}
              waitingForTasks={waitingForTasks}
              depth={node.depth}
              parentSessionId={node.parentSessionId}
              posInSet={index + 1}
              setSize={agents.length}
              ownerSessionId={sessionId}
              onOpenSession={onOpenSession}
            />
          ))}
        </div>
      ) : (
        <ul className="composer-island-pbody composer-island-jobs">
          {shells.map((row) => (
            <ShellJobItem
              key={row.key}
              row={row}
              clock={clock}
              stop={stopOf(row)}
              onStop={stop}
              onDismiss={onDismiss}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/** The session's live agent rows; polls the shared pool only while any exist. */
function useIslandAgentRows(sessionId: string): IslandAgentRow[] {
  const poolStore = useMemo(() => agentPoolStore(window.mixdogDesktop), []);
  const pool = useSyncExternalStore(poolStore.subscribe, poolStore.getSnapshot, poolStore.getSnapshot);
  const agentRows = useMemo(() => islandAgentRows(pool, sessionId), [pool, sessionId]);
  const hasAgents = agentRows.length > 0;
  useEffect(() => {
    startAgentPool(poolStore);
    if (!hasAgents) return undefined;
    return subscribeSharedPoll(poolStore, () => void refreshAgentPool(poolStore), AGENT_POOL_RECONCILE_MS);
  }, [hasAgents, poolStore]);
  return agentRows;
}

/** The pill's agents segment: the count, the working mark, and what needs the
 *  user or waits. */
function AgentsSegment({
  agents,
  expanded,
  onClick,
}: {
  agents: IslandAgentRow[];
  expanded: boolean;
  onClick(): void;
}) {
  const needsUser = agents.filter(({ state }) => state === 'needs-user').length;
  const working = agents.filter(({ state }) => state === 'running' || state === 'cancel-unconfirmed').length;
  const waiting = agents.filter(({ state }) => state === 'queued' || state === 'waiting').length;
  const title = [
    t('Agent {{agent}}', { agent: agents.length }),
    needsUser > 0 ? t('Needs you {{needs}}', { needs: needsUser }) : '',
    waiting > 0 ? t('Island: {{waiting}} waiting', { waiting }) : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <button
      type="button"
      className="composer-island-seg composer-island-seg-agents"
      aria-expanded={expanded}
      title={title}
      onClick={onClick}
    >
      <IslandSegLabel
        text={t('Island: {{count}} agents', { count: agents.length })}
        count={agents.length}
        icon="agent"
      />
      {needsUser === 0 ? <AgentMark working={working > 0} /> : null}
      {(needsUser > 0 || waiting > 0) && (
        <span className="composer-island-seg-states">
          {needsUser > 0 ? (
            <span className="composer-island-seg-state">
              <MxIcon name="warning" size={14} className="composer-island-attention" aria-hidden="true" />
              <span className="composer-island-seg-word">{t('Needs you {{needs}}', { needs: needsUser })}</span>
              <span className="composer-island-seg-num" data-count={needsUser} aria-hidden="true" />
            </span>
          ) : null}
          {waiting > 0 ? (
            <span className="composer-island-seg-state" data-kind="waiting">
              <span className="composer-island-dot composer-island-dot-idle" aria-hidden="true" />
              <span className="composer-island-seg-word">{t('Island: {{waiting}} waiting', { waiting })}</span>
              <span className="composer-island-seg-num" data-count={waiting} aria-hidden="true" />
            </span>
          ) : null}
        </span>
      )}
    </button>
  );
}

/** The pill's shell segment counts running shells; with none left it shows the
 *  finished ones (muted) so they can still be opened and dismissed. */
function ShellsSegment({
  runningCount,
  finishedCount,
  expanded,
  onClick,
}: {
  runningCount: number;
  finishedCount: number;
  expanded: boolean;
  onClick(): void;
}) {
  const live = runningCount > 0;
  const count = live ? runningCount : finishedCount;
  if (count === 0) return null;
  const finishedText = t('Island: {{count}} finished shells', { count: finishedCount });
  return (
    <button
      type="button"
      className="composer-island-seg composer-island-seg-shell"
      data-finished={live ? undefined : 'true'}
      aria-expanded={expanded}
      title={live ? t('Shell {{shell}}', { shell: runningCount }) : finishedText}
      onClick={onClick}
    >
      <IslandSegLabel
        text={live ? t('Island: {{count}} shells', { count: runningCount }) : finishedText}
        count={count}
        icon="shell-prompt"
      />
      {live ? <JobsPulse /> : <span className="composer-island-dot composer-island-dot-idle" aria-hidden="true" />}
    </button>
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

/** Time left until `resetAt`, refreshed once a minute; '' without a reset. */
export function useQuotaRemaining(resetAt: number | null): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (resetAt === null) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [resetAt]);
  return resetAt === null ? '' : quotaRemainingLabel(resetAt, now);
}

function ResumeRemaining({ resetAt }: { resetAt: number }) {
  return <>{useQuotaRemaining(resetAt)}</>;
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
    </QuotaPanelFrame>
  );
}

/**
 * The single island above a session's composer. Its slot takes the island's
 * real height in the dock while it carries something and eases between
 * heights (see useIslandSlotPresence); the transcript viewport above resizes
 * with it and the end pin keeps a following tail in place on every frame.
 */
export function ComposerIsland({
  sessionId,
  goal,
  files,
  approval,
  flash,
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
  /** A waiting auto-resume: a pill segment that expands into its panel. */
  quotaResume?: ComposerIslandQuotaResume | null;
}) {
  const lane = useSessionLane(sessionId, defaultSessionLaneStore, desktopHeaderSnapshotsEqual, Boolean(sessionId));
  const snapshot = lane ?? EMPTY_SNAPSHOT;
  const dismissedShells = useDismissedShellJobs(sessionId);
  const jobRows = useMemo(() => backgroundJobRows(snapshot, dismissedShells), [snapshot, dismissedShells]);
  const agentRows = useIslandAgentRows(sessionId);
  const shellRows = jobRows.filter((row) => !row.finished);
  const finishedShellCount = jobRows.filter((row) => row.finished).length;
  const shellCount = Math.max(Number(snapshot.shellJobs?.count) || 0, shellRows.length);
  // Finished shells keep the jobs panel open-able until dismissed.
  const running = agentRows.length + shellCount + finishedShellCount;
  const [jobsTab, setJobsTab] = useState<JobKind>('agent');
  const [expanded, setExpanded] = useState<ComposerIslandTab>('');
  const toggleJobs = (kind: JobKind) => {
    const open = expanded === 'jobs' && jobsTab === kind;
    setJobsTab(kind);
    setExpanded(open ? '' : 'jobs');
  };
  const islandRef = useRef<HTMLDivElement | null>(null);
  const pillRef = useRef<HTMLDivElement | null>(null);
  const slotRef = useRef<HTMLDivElement | null>(null);
  useIslandFit(islandRef, pillRef);
  useIslandSlotPresence(slotRef, islandRef);
  // Finished background work announces nothing: a flash per job would make
  // the island pop in and out.
  const visibleFlash = useIslandFlash(flash ?? null);

  // A tab whose content went away closes; a new session starts collapsed.
  useEffect(() => {
    if (expanded === 'jobs' && running === 0) setExpanded('');
    if (expanded === 'resume' && !quotaResume) setExpanded('');
  }, [expanded, quotaResume, running]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId is the reset trigger
  useEffect(() => {
    setExpanded('');
  }, [sessionId]);
  // Outside press or Escape collapses the island's own tabs. The Goal tab
  // owns its dismissal (it also guards its edit dialog).
  useEffect(() => {
    if (expanded !== 'jobs' && expanded !== 'resume') return undefined;
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
  else if (expanded) mode = 'panel';
  const resumePanel = mode === 'panel' && expanded === 'resume' && Boolean(quotaResume);
  const ownPanel = resumePanel || (mode === 'panel' && expanded === 'jobs');
  const context = useMemo(() => ({ expanded, setExpanded }), [expanded]);

  return (
    <ComposerIslandContext.Provider value={context}>
      <div ref={slotRef} className="composer-island-slot" data-mode={mode}>
        <div className="composer-island-stage">
          <div ref={islandRef} className="composer-island" data-mode={mode} data-expanded={expanded || undefined}>
            {approval ? <div className="composer-island-approval">{approval}</div> : null}
            {mode === 'flash' && visibleFlash ? (
              <div className="composer-island-flash" role="status" key={visibleFlash.key}>
                <MxIcon name="check" size={16} />
                <span>{visibleFlash.text}</span>
              </div>
            ) : null}
            <div
              ref={pillRef}
              className="composer-island-pill"
              hidden={mode === 'approval' || mode === 'flash' || ownPanel}
            >
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
              {goal}
              {agentRows.length > 0 && (
                <AgentsSegment
                  agents={agentRows}
                  expanded={expanded === 'jobs' && jobsTab === 'agent'}
                  onClick={() => toggleJobs('agent')}
                />
              )}
              <ShellsSegment
                runningCount={shellCount}
                finishedCount={finishedShellCount}
                expanded={expanded === 'jobs' && jobsTab === 'shell'}
                onClick={() => toggleJobs('shell')}
              />
              {files}
            </div>
            {resumePanel && quotaResume ? <ResumePanel resume={quotaResume} /> : null}
            {ownPanel && expanded === 'jobs' && (
              <JobsPanel
                sessionId={sessionId}
                agents={agentRows}
                shells={jobRows}
                tab={jobsTab}
                onTab={setJobsTab}
                onClose={() => setExpanded('')}
                onDismiss={(row) => dismissShellJobs(sessionId, [row.key])}
                onOpenSession={
                  onOpenAgentSession
                    ? (agentSessionId, title, owner) => {
                        onOpenAgentSession(agentSessionId, title, owner);
                        setExpanded('');
                      }
                    : undefined
                }
              />
            )}
          </div>
        </div>
      </div>
    </ComposerIslandContext.Provider>
  );
}

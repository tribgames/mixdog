import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type ReactNode,
  type RefObject,
} from 'react';
import { dismissShellJobs, useDismissedShellJobs } from './background-jobs-dismissed-store';
import { AgentPoolRow } from './AgentActivityPane';
import {
  clearableAgentNode,
  dismissFinishedAgentRows,
  hostAgentListing,
  hostDismissListing,
  useVisibleAgentPool,
} from './agent-dismiss';
import type { DesktopAgentActivityState } from '../shared/agent-activity';
import type { DesktopAgentPoolRow } from '../shared/contract';
import {
  agentPoolStore,
  islandAgentRows,
  poolRowKey,
  startAgentPool,
  type IslandAgentRow,
} from './agent-activity-model';
import {
  backgroundJobRows,
  listedShellKeys,
  EMPTY_SHELL_ROW_RETENTION,
  expiredShellRows,
  retainVanishedShellRows,
  type JobKind,
  type JobRow,
  type ShellStopState,
} from './background-jobs-model';
import {
  type IslandUsageSummary,
  islandUsageCue,
  islandUsageSummary,
  useIslandSessionUsage,
} from './island-session-usage';
import { CircleDollarSign } from 'lucide-react';
import {
  cacheHitReadoutItem,
  FittedReadout,
  formatCompactTokens,
  formatHitPercent,
  readoutVariants,
  tokensReadoutItem,
} from './composer-usage-readout';
import { statsCount } from './usage-stats-model';
import { usageMoney } from './usage-format';
import { ShellJobContent, ShellRowButton, useShellStops } from './shell-job-controls';
import { ComposerIslandContext, type ComposerIslandTab, type IslandSegmentReserves } from './composer-island-state';
import { rememberedSegmentAdvances, useIslandFit, useIslandSlotPresence } from './composer-island-layout';
import { desktopHeaderSnapshotsEqual, paneHeaderView } from './desktop-snapshot-store';
import { EMPTY_SNAPSHOT } from './desktop-types';
import { t } from './i18n';
import { IslandPanelFoot, TidyButton } from './IslandPanelFoot';
import { MxIcon } from './MxIcon';
import { defaultSessionLaneStore, useSessionLane } from './session-lane-store';
import { quotaRemainingLabel, quotaResetLabel } from './quota-continue';
import { useClock } from './use-clock';
import { useSurfaceActive } from './surface-activity';

/** A short notice the island shows in place of its pill, then returns.
 *  `icon`: the glyph before the text (default the check). */
export type ComposerIslandFlash = { key: string; text: string; icon?: 'check' | 'close-small' | 'clock' };

/** A quota-stopped turn that resumes by itself at the reset time. */
export type ComposerIslandQuotaResume = {
  /** Model the turn resumes in, display name. */
  model: string;
  /** Epoch ms of the resume. */
  resetAt: number;
  /** Drop the reservation; the session stays stopped. */
  onCancel(): void;
};

export { ISLAND_COLLAPSE_GRACE_MS, rememberedSegmentAdvances, rememberedSlotHeight } from './composer-island-layout';

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
  return <StateMark working={working} />;
}

/** Fixed-size mark slot: pulse and idle dot swap inside it without moving the pill. */
function StateMark({ working }: { working: boolean }) {
  return (
    <span className="composer-island-mark-slot" aria-hidden="true">
      {working ? <JobsPulse /> : <span className="composer-island-dot composer-island-dot-idle" />}
    </span>
  );
}

/** A jobs panel title's leading mark: agent activity, a live pulse while a
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
  return <StateMark working={runningShells > 0} />;
}

function ShellJobItem({
  row,
  clock,
  stop,
  releasing,
  onStop,
  onDismiss,
}: {
  row: JobRow;
  clock: number;
  stop: ShellStopState;
  releasing: boolean;
  onStop: ComponentProps<typeof ShellRowButton>['onStop'];
  onDismiss(row: JobRow): void;
}) {
  return (
    <li className="composer-island-row" data-finished={row.finished ? 'true' : undefined}>
      <ShellJobContent row={row} clock={clock} stop={stop} releasing={releasing} />
      <ShellRowButton row={row} stop={stop} releasing={releasing} onStop={onStop} onDismiss={onDismiss} />
    </li>
  );
}

/** A jobs panel's header: its own title chip, optional state counts beside
 *  it, and the close button. Actions live in the footer (IslandPanelFoot). */
function JobsPanelHead({
  mark,
  title,
  meta,
  onClose,
}: {
  mark: ReactNode;
  title: string;
  meta?: ReactNode;
  onClose(): void;
}) {
  return (
    <div className="composer-island-phead">
      <span className="composer-island-tab" data-active="true">
        {mark}
        {title}
      </span>
      {meta ? <span className="composer-island-phead-meta">{meta}</span> : null}
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
  );
}

/** The listed agents tallied by state, read by both the pill segment and the
 *  panel head. An agent waiting on its own tasks is still at work (its
 *  timer runs), so it counts as running; `waiting` is queued only; `idle` rests. */
function islandAgentCounts(agents: readonly IslandAgentRow[]) {
  const count = (...states: DesktopAgentActivityState[]) => agents.filter(({ state }) => states.includes(state)).length;
  return {
    running: count('running', 'waiting', 'cancel-unconfirmed'),
    needsUser: count('needs-user'),
    failed: count('failed'),
    waiting: count('queued'),
    idle: count('idle'),
  };
}

/** How many listed agents run, need the user, failed or wait: beside the title. */
function AgentsStateCounts({ agents }: { agents: IslandAgentRow[] }) {
  const { running, needsUser, failed, waiting: queued, idle } = islandAgentCounts(agents);
  const waiting = queued + idle;
  return (
    <>
      <span>
        {t('Island: Running')} <b>{statsCount(running)}</b>
      </span>
      {needsUser > 0 ? <span>{t('Needs you {{needs}}', { needs: needsUser })}</span> : null}
      {failed > 0 ? <span className="composer-island-failed">{t('{{failed}} failed', { failed })}</span> : null}
      {waiting > 0 ? <span>{t('Island: {{waiting}} waiting', { waiting })}</span> : null}
    </>
  );
}

/** Shown for a figure the ledger has not answered yet or cannot attribute
 *  exactly: never an invented zero. */
const SUMMARY_UNKNOWN = '-';
/** Narrowing drops the cache hit first, as the composer's readout does, then
 *  the cost (which that line lacks); the token total stays longest. */
const SUMMARY_KEEP_ORDER = ['total', 'cost', 'hit'];
const SUMMARY_DISPLAY_ORDER = ['total', 'hit', 'cost'];

function AgentsSummary({ usage }: { usage: IslandUsageSummary }) {
  const { totalTokens, leadTokens, agentTokens, cacheHitRate, costUsd } = usage;
  const splitKnown = totalTokens !== null && leadTokens !== null && agentTokens !== null;
  const split = `(${t('Lead {{lead}} · Agents {{agents}}', {
    lead: splitKnown ? formatCompactTokens(leadTokens) : SUMMARY_UNKNOWN,
    agents: splitKnown ? formatCompactTokens(agentTokens) : SUMMARY_UNKNOWN,
  })})`;
  const total = tokensReadoutItem(totalTokens === null ? SUMMARY_UNKNOWN : formatCompactTokens(totalTokens));
  const cost = t('Island: {{cost}} est. cost', { cost: costUsd === null ? SUMMARY_UNKNOWN : usageMoney(costUsd) });
  const parts = {
    total: { ...total, label: `${total.label} ${split}`, word: `${total.word} ${split}` },
    hit: cacheHitReadoutItem(cacheHitRate === null ? SUMMARY_UNKNOWN : formatHitPercent(cacheHitRate)),
    cost: {
      icon: CircleDollarSign,
      text: costUsd === null ? SUMMARY_UNKNOWN : usageMoney(costUsd),
      label: cost,
      word: cost,
    },
  };
  const [detailed, ...icons] = readoutVariants(parts, SUMMARY_KEEP_ORDER, SUMMARY_DISPLAY_ORDER);
  // The composer's own wording (`11.6B tokens · Cache hit 92.0% · $6,216.60`) for a footer too narrow for the split.
  const [worded] = readoutVariants(
    { ...parts, total: { ...parts.total, word: total.word }, cost: { ...parts.cost, word: parts.cost.text } },
    SUMMARY_KEEP_ORDER,
    SUMMARY_DISPLAY_ORDER
  );
  return (
    <FittedReadout
      variants={[detailed, worded, ...icons]}
      title={t('Session usage')}
      className="composer-island-summary"
    />
  );
}

function AgentsPanel({
  sessionId,
  agents,
  shellKeys,
  usage,
  onClose,
  onOpenSession,
}: {
  sessionId: string;
  agents: IslandAgentRow[];
  shellKeys: ReadonlySet<string> | null;
  usage: IslandUsageSummary;
  onClose(): void;
  onOpenSession?(sessionId: string, title: string, ownerSessionId: string): void;
}) {
  const clock = useClock(true);
  // The listed rows are already the tree flattened: each is judged on its own node.
  const clearable = agents.filter(({ node }) => clearableAgentNode(node)).map(({ node }) => node.agent);
  return (
    <section className="composer-island-panel" aria-label={t('Agents')}>
      <JobsPanelHead
        mark={jobsTabMark('agent', agents, 0)}
        title={t('Agent {{agent}}', { agent: agents.length })}
        meta={<AgentsStateCounts agents={agents} />}
        onClose={onClose}
      />
      {/* The Agents window's own tree and row component; each row's own
          ledger total sits at its right edge. */}
      <div className="composer-island-pbody composer-island-jobs composer-island-agents schedules-list" role="tree">
        {agents.map(({ node, state, waitingForTasks }, index) => {
          const tokens = usage.agentRowTokens.get(node.sessionId);
          return (
            <div
              key={poolRowKey(node.agent, index)}
              className="composer-island-agent-item"
              role="none"
              data-tokens={tokens === undefined ? undefined : 'true'}
            >
              <AgentPoolRow
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
              {tokens === undefined ? null : (
                <span className="composer-island-agent-tokens" aria-hidden="true">
                  {formatCompactTokens(tokens)}
                </span>
              )}
            </div>
          );
        })}
      </div>
      <IslandPanelFoot
        end={
          <TidyButton
            className="composer-island-button"
            kind="clear-finished"
            label={t('Clean up')}
            description={t('Clear finished')}
            named
            disabled={clearable.length === 0}
            onClick={() => dismissFinishedAgentRows(clearable, hostAgentListing(), { sessionId, keys: shellKeys })}
          />
        }
      >
        <AgentsSummary usage={usage} />
      </IslandPanelFoot>
    </section>
  );
}

function ShellsPanel({
  sessionId,
  shells,
  onClose,
  onDismiss,
  onDismissAll,
}: {
  sessionId: string;
  shells: JobRow[];
  onClose(): void;
  /** Hides a finished shell row for good. */
  onDismiss(row: JobRow): void;
  /** Hides every listed finished shell row for good. */
  onDismissAll(rows: JobRow[]): void;
}) {
  const clock = useClock(true);
  const { stopOf, releasingOf, stop } = useShellStops(sessionId);
  const runningShells = shells.filter((row) => !row.finished).length;
  const finished = shells.filter((row) => row.finished);
  return (
    <section className="composer-island-panel" aria-label={t('Background tasks')}>
      <JobsPanelHead
        mark={jobsTabMark('shell', [], runningShells)}
        title={runningShells > 0 ? t('Shell {{shell}}', { shell: runningShells }) : t('Shell')}
        meta={finished.length > 0 ? <span>{t('Island: Ended {{count}}', { count: finished.length })}</span> : undefined}
        onClose={onClose}
      />
      <ul className="composer-island-pbody composer-island-jobs">
        {shells.map((row) => (
          <ShellJobItem
            key={row.key}
            row={row}
            clock={clock}
            stop={stopOf(row)}
            releasing={releasingOf(row)}
            onStop={stop}
            onDismiss={onDismiss}
          />
        ))}
      </ul>
      <IslandPanelFoot
        end={
          finished.length > 0 ? (
            <TidyButton
              className="composer-island-button"
              kind="close-all"
              label={t('Island: Close all')}
              description={t('Island: Close all')}
              onClick={() => onDismissAll(finished)}
            />
          ) : undefined
        }
      />
    </section>
  );
}

/** The session's shell rows with a job kept (as running) in the gap between
 *  the host dropping it from the running list and its finished record. */
function useShellRowsUntilFinished(sessionId: string, hostRows: JobRow[]): JobRow[] {
  const held = useRef({ sessionId, retention: EMPTY_SHELL_ROW_RETENTION });
  const [tick, setTick] = useState(0);
  // `tick` re-evaluates after the grace lapses.
  // biome-ignore lint/correctness/useExhaustiveDependencies: tick is the clock input
  const result = useMemo(() => {
    if (held.current.sessionId !== sessionId) held.current = { sessionId, retention: EMPTY_SHELL_ROW_RETENTION };
    const next = retainVanishedShellRows(held.current.retention, hostRows, Date.now());
    held.current.retention = next.retention;
    return next;
  }, [sessionId, hostRows, tick]);
  const { expiresAt } = result;
  useEffect(() => {
    if (!expiresAt) return undefined;
    const timer = setTimeout(() => setTick((value) => value + 1), Math.max(0, expiresAt - Date.now()) + 1);
    return () => clearTimeout(timer);
  }, [expiresAt]);
  return result.rows;
}

/** Dismisses each cleanly exited shell row SHELL_AUTO_DISMISS_MS after it
 *  finished (after it was first listed, when its finish time is unknown). */
function useAutoDismissShells(sessionId: string, rows: JobRow[], shellKeys: ReadonlySet<string> | null): void {
  const seen = useRef({ sessionId, at: new Map<string, number>() });
  const [tick, setTick] = useState(0);
  // `tick` re-evaluates once the next row's listing time is over.
  // biome-ignore lint/correctness/useExhaustiveDependencies: tick is the clock input
  useEffect(() => {
    if (!sessionId) return undefined;
    if (seen.current.sessionId !== sessionId) seen.current = { sessionId, at: new Map() };
    const now = Date.now();
    const at = seen.current.at;
    for (const row of rows) if (row.finished && !at.has(row.key)) at.set(row.key, now);
    const { keys, nextAt } = expiredShellRows(rows, now, (row) => at.get(row.key) ?? now);
    if (keys.length > 0) dismissShellJobs(sessionId, keys, hostDismissListing(sessionId, shellKeys));
    if (!nextAt) return undefined;
    const timer = setTimeout(() => setTick((value) => value + 1), Math.max(0, nextAt - now) + 1);
    return () => clearTimeout(timer);
  }, [sessionId, rows, shellKeys, tick]);
}

/** The session's agent rows, finished ones included; polls the shared pool
 *  only while any of them is active. */
function useIslandAgentRows(sessionId: string): {
  agentRows: IslandAgentRow[];
  poolRows: DesktopAgentPoolRow[] | null;
} {
  const poolStore = useMemo(() => agentPoolStore(window.mixdogDesktop), []);
  const poolRows = useSyncExternalStore(poolStore.subscribe, poolStore.getSnapshot, poolStore.getSnapshot);
  // Rows the user cleared ("Clear finished") are not listed.
  const pool = useVisibleAgentPool(poolRows);
  const agentRows = useMemo(() => islandAgentRows(pool, sessionId), [pool, sessionId]);
  useEffect(() => {
    startAgentPool(poolStore);
  }, [poolStore]);
  return { agentRows, poolRows };
}

function useIslandTabDismiss(
  expanded: ComposerIslandTab,
  setExpanded: (tab: ComposerIslandTab) => void,
  islandRef: RefObject<HTMLDivElement | null>
): void {
  const surfaceActive = useSurfaceActive();
  useEffect(() => {
    if (!surfaceActive || !['agents', 'shells', 'resume', 'branch', 'git'].includes(expanded)) return undefined;
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
  }, [expanded, surfaceActive, setExpanded, islandRef]);
}

/** How many turns of the session have settled (busy, then idle) since it was shown. */
function useSettledTurns(busy: boolean): number {
  const wasBusy = useRef(busy);
  const [settled, setSettled] = useState(0);
  useEffect(() => {
    if (wasBusy.current && !busy) setSettled((count) => count + 1);
    wasBusy.current = busy;
  }, [busy]);
  return settled;
}

function AgentsSegment({
  agents,
  expanded,
  onClick,
}: {
  agents: IslandAgentRow[];
  expanded: boolean;
  onClick(): void;
}) {
  const total = agents.length;
  const active = agents.filter((row) => !row.finished).length;
  const { running: working, waiting } = islandAgentCounts(agents);
  const title = [
    t('Agent {{agent}}', { agent: total }),
    active === 0 ? t('Done') : '',
    working > 0 ? `${t('Island: Running')} ${working}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <button
      type="button"
      className="composer-island-seg composer-island-seg-agents"
      data-finished={active === 0 ? 'true' : undefined}
      aria-expanded={expanded}
      title={title}
      onClick={onClick}
    >
      {active > 0 ? (
        <IslandSegLabel text={t('Island: {{count}} agents', { count: active })} count={active} icon="agent" />
      ) : (
        <>
          <MxIcon name="agent" size={14} className="composer-island-seg-icon" aria-hidden="true" />
          <span className="composer-island-seg-word">{t('Agent')}</span>
        </>
      )}
      <AgentMark working={working + waiting > 0} />
    </button>
  );
}

/** The pill's shell segment counts running shells only. With only finished
 *  shells left (not yet dismissed) it reads "Shell", muted and without a
 *  number; with none it is gone. */
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
  if (!live && finishedCount === 0) return null;
  return (
    <button
      type="button"
      className="composer-island-seg composer-island-seg-shell"
      data-finished={live ? undefined : 'true'}
      aria-expanded={expanded}
      title={live ? t('Shell {{shell}}', { shell: runningCount }) : t('Shell')}
      onClick={onClick}
    >
      {live ? (
        <IslandSegLabel
          text={t('Island: {{count}} shells', { count: runningCount })}
          count={runningCount}
          icon="shell-prompt"
        />
      ) : (
        <>
          <MxIcon name="shell-prompt" size={14} className="composer-island-seg-icon" aria-hidden="true" />
          <span className="composer-island-seg-word">{t('Shell')}</span>
        </>
      )}
      <StateMark working={live} />
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

interface ComposerIslandProps {
  /** The pane's session ('' while hidden): background jobs read its lane. */
  sessionId: string;
  /** The route address the island is mounted (keyed) for; its resting slot
   *  height is remembered per address. Defaults to `sessionId`. */
  routeSessionId?: string;
  /** Opens an agent's session (same action as the Agents pane rows). */
  onOpenAgentSession?(sessionId: string, title: string, ownerSessionId: string): void;
  goal?: ReactNode;
  /** The changed-files segment: opens the side dock, or where the surface has
   *  none, expands into the turn's file list like the Goal tab. */
  files?: ReactNode;
  /** The branch segment (BranchIslandSegment), first of the git group after
   *  the divider; `locked` while the session has work running (no branch or
   *  worktree switch). */
  branch?: (locked: boolean) => ReactNode;
  /** The git action (IslandGitSegment), last in the pill. */
  git?: ReactNode;
  /** A running turn or command, or queued composer input. */
  workBusy?: boolean;
  /** The live tool approval card: the island grows into it. */
  approval?: ReactNode;
  flash?: ComposerIslandFlash | null;
  /** A waiting auto-resume: a pill segment that expands into its panel. */
  quotaResume?: ComposerIslandQuotaResume | null;
  /** The height of the dock chrome this island replaces at mount (the draft's
   *  context bar on its first submit): an empty island holds it instead of
   *  closing in that frame. Read once, at mount. */
  heldHeight?: number;
  /** The resting slot height of the island this one replaces in the same
   *  dock (a session switch). A session with no remembered height reserves
   *  it like a revisit: a first entry otherwise dropped the outgoing pill in
   *  the switch commit and reopened it once its segments had read their
   *  state, moving the composer and the end-pinned transcript down and back
   *  up. Read once, at mount. */
  carriedHeight?: number;
  /** The late segments' advances of the island this one replaces in the same
   *  dock; reserved like carriedHeight for a session with none remembered.
   *  Read once, at mount. */
  carriedAdvances?: Partial<IslandSegmentReserves>;
}

/** The single island above a session's composer; memoised by sameIslandProps. */
export const ComposerIsland = memo(function ComposerIsland({
  sessionId,
  routeSessionId = sessionId,
  goal,
  files,
  branch,
  git,
  workBusy = false,
  approval,
  flash,
  quotaResume,
  heldHeight = 0,
  carriedHeight = 0,
  carriedAdvances,
  onOpenAgentSession,
}: ComposerIslandProps) {
  const lane = useSessionLane(sessionId, defaultSessionLaneStore, desktopHeaderSnapshotsEqual, Boolean(sessionId));
  const snapshot = lane ? paneHeaderView(lane) : EMPTY_SNAPSHOT;
  const dismissedShells = useDismissedShellJobs(sessionId);
  const hostJobRows = useMemo(() => backgroundJobRows(snapshot, dismissedShells), [snapshot, dismissedShells]);
  const jobRows = useShellRowsUntilFinished(sessionId, hostJobRows);
  const { agentRows, poolRows } = useIslandAgentRows(sessionId);
  const shellKeys = useMemo(
    () => listedShellKeys(lane, [...backgroundJobRows(snapshot), ...jobRows]),
    [lane, snapshot, jobRows]
  );
  useAutoDismissShells(sessionId, jobRows, shellKeys);
  const shellRows = jobRows.filter((row) => !row.finished);
  const finishedShellCount = jobRows.filter((row) => row.finished).length;
  const shellCount = Math.max(Number(snapshot.shellJobs?.count) || 0, shellRows.length);
  // Finished shells keep the shells panel open-able until dismissed.
  const shellTotal = shellCount + finishedShellCount;
  // No branch or worktree switch while anything of the session still works.
  const locked = workBusy || shellCount > 0 || agentRows.some((row) => !row.finished);
  const [expanded, setExpanded] = useState<ComposerIslandTab>('');
  const toggle = (tab: 'agents' | 'shells') => setExpanded(expanded === tab ? '' : tab);
  const agentSessionIds = useMemo(() => agentRows.map(({ node }) => node.sessionId).filter(Boolean), [agentRows]);
  const settledTurns = useSettledTurns(Boolean(snapshot.busy));
  const usageCue = islandUsageCue(poolRows, sessionId, settledTurns);
  const sessionUsage = useIslandSessionUsage(sessionId, agentSessionIds, expanded === 'agents', usageCue);
  const usageSummary = useMemo(
    () => islandUsageSummary(sessionUsage, agentSessionIds),
    [sessionUsage, agentSessionIds]
  );
  const islandRef = useRef<HTMLDivElement | null>(null);
  const pillRef = useRef<HTMLDivElement | null>(null);
  const slotRef = useRef<HTMLDivElement | null>(null);
  useIslandFit(islandRef, pillRef);
  const heldHeightRef = useRef(heldHeight);
  const carriedHeightRef = useRef(carriedHeight);
  const routeSessionIdRef = useRef(routeSessionId);
  routeSessionIdRef.current = routeSessionId;
  useIslandSlotPresence(slotRef, islandRef, heldHeightRef, routeSessionIdRef, carriedHeightRef);
  // Finished background work announces nothing: a flash per job would make
  // the island pop in and out.
  const visibleFlash = useIslandFlash(flash ?? null);

  // A tab whose content went away closes; a new session starts collapsed.
  useEffect(() => {
    if (expanded === 'agents' && agentRows.length === 0) setExpanded('');
    if (expanded === 'shells' && shellTotal === 0) setExpanded('');
    if (expanded === 'resume' && !quotaResume) setExpanded('');
  }, [expanded, quotaResume, agentRows.length, shellTotal]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId is the reset trigger
  useEffect(() => {
    setExpanded('');
  }, [sessionId]);
  useIslandTabDismiss(expanded, setExpanded, islandRef);

  let mode = 'pill';
  if (approval) mode = 'approval';
  else if (visibleFlash) mode = 'flash';
  else if (expanded) mode = 'panel';
  const resumePanel = mode === 'panel' && expanded === 'resume' && Boolean(quotaResume);
  const agentsPanel = mode === 'panel' && expanded === 'agents' && agentRows.length > 0;
  const shellsPanel = mode === 'panel' && expanded === 'shells' && shellTotal > 0;
  const ownPanel = resumePanel || agentsPanel || shellsPanel;
  const [reserves] = useState<IslandSegmentReserves>(() => {
    const known = rememberedSegmentAdvances(routeSessionId) ?? carriedAdvances;
    return { branch: known?.branch ?? 0, files: known?.files ?? 0, git: known?.git ?? 0 };
  });
  const context = useMemo(() => ({ expanded, setExpanded, reserves }), [expanded, reserves]);

  return (
    <ComposerIslandContext.Provider value={context}>
      <div ref={slotRef} className="composer-island-slot" data-mode={mode}>
        <div className="composer-island-stage">
          <div ref={islandRef} className="composer-island" data-mode={mode} data-expanded={expanded || undefined}>
            {approval ? <div className="composer-island-approval">{approval}</div> : null}
            {mode === 'flash' && visibleFlash ? (
              <div className="composer-island-flash" role="status" key={visibleFlash.key}>
                <MxIcon name={visibleFlash.icon ?? 'check'} size={16} />
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
                <AgentsSegment agents={agentRows} expanded={expanded === 'agents'} onClick={() => toggle('agents')} />
              )}
              <ShellsSegment
                runningCount={shellCount}
                finishedCount={finishedShellCount}
                expanded={expanded === 'shells'}
                onClick={() => toggle('shells')}
              />
              {/* Work (agents, shells) │ git (branch, files, git action); the
                  stylesheet shows the divider only between two groups. */}
              <span className="composer-island-divider" aria-hidden="true" />
              {branch?.(locked)}
              {files}
              {git}
            </div>
            {resumePanel && quotaResume ? <ResumePanel resume={quotaResume} /> : null}
            {shellsPanel && (
              <ShellsPanel
                sessionId={sessionId}
                shells={jobRows}
                onClose={() => setExpanded('')}
                onDismiss={(row) => dismissShellJobs(sessionId, [row.key], hostDismissListing(sessionId, shellKeys))}
                onDismissAll={(rows) =>
                  dismissShellJobs(
                    sessionId,
                    rows.map((row) => row.key),
                    hostDismissListing(sessionId, shellKeys)
                  )
                }
              />
            )}
            {agentsPanel && (
              <AgentsPanel
                sessionId={sessionId}
                agents={agentRows}
                shellKeys={shellKeys}
                usage={usageSummary}
                onClose={() => setExpanded('')}
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
}, sameIslandProps);

/** The island's props are equal when everything it renders from is: the
 *  mount-only reserves (heldHeight, carriedHeight, carriedAdvances) are read
 *  once, at mount, so a later change of them renders nothing. */
function sameIslandProps(previous: ComposerIslandProps, next: ComposerIslandProps): boolean {
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]) as Set<keyof ComposerIslandProps>;
  for (const key of keys) {
    if (key === 'heldHeight' || key === 'carriedHeight' || key === 'carriedAdvances') continue;
    if (!Object.is(previous[key], next[key])) return false;
  }
  return true;
}

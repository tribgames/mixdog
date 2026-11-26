import { ChevronDown, ChevronRight } from 'lucide-react';
import {
  Fragment,
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
import { AgentIslandRow } from './AgentIslandRow';
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
  agentPlace,
  agentPoolStore,
  agentRoleLabel,
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
  shellFinishedLabel,
  type JobKind,
  type JobRow,
  type ShellStopState,
} from './background-jobs-model';
import { agentStateWords } from './agent-row-meta';
import { useSharedRouteText } from './agent-row-parts';
import { modelDisplayName } from './provider-display';
import {
  type IslandUsageSummary,
  islandUsageCue,
  islandUsageSummary,
  useIslandSessionUsage,
} from './island-session-usage';
import {
  cacheHitReadoutItem,
  costReadoutItem,
  FittedReadout,
  formatCompactTokens,
  formatHitPercent,
  type ReadoutItem,
  readoutVariants,
  tokensReadoutItem,
} from './composer-usage-readout';
import { hitRateNote, plainFloorNote } from './usage-stats-model';
import { useWholeRowList } from './whole-row-list';
import { usageMoney } from './usage-format';
import { ShellJobContent, ShellRowButton, useShellStops } from './shell-job-controls';
import { useMobileBack } from './mobile-back';
import { ComposerIslandContext, type ComposerIslandTab, type IslandSegmentReserves } from './composer-island-state';
import {
  rememberedSegmentAdvances,
  useIslandFit,
  useIslandGlide,
  useIslandSlotPresence,
} from './composer-island-layout';
import { desktopHeaderSnapshotsEqual, paneHeaderView } from './desktop-snapshot-store';
import { EMPTY_SNAPSHOT } from './desktop-types';
import { t } from './i18n';
import { IslandColumnSizer, IslandPanelFoot, IslandPanelHead, TidyButton } from './IslandPanelFoot';
import { formatWorkClock, formatWorkElapsed } from './transcript-primitives';
import { MxIcon } from './MxIcon';
import { defaultSessionLaneStore, useSessionLane } from './session-lane-store';
import { quotaRemainingLabel, quotaResetLabel } from './quota-continue';
import { useClock } from './use-clock';
import { useSurfaceActive } from './surface-activity';
import { releasePointerFocus, useSessionRailFolds } from './session-rail-folds';

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
export function jobsTabMark(kind: JobKind, agents: IslandAgentRow[], runningShells: number): ReactNode {
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

/** A panel title's figures, written as its island segment writes them after its label ("Agents 2 ●"): how many are
 *  in progress, then `mark`; with none in progress, neither. */
function HeadFigures({ count, mark }: { count: number; mark: ReactNode }) {
  if (count === 0) return null;
  return (
    <>
      <span className="composer-island-head-count">{count}</span>
      {mark}
    </>
  );
}

/** The agents' state mark for a head: while any is in progress, none otherwise. */
export function agentsHeadMark(agents: IslandAgentRow[]): ReactNode {
  return agentsInProgress(agents) > 0 ? jobsTabMark('agent', agents, 0) : null;
}

type AgentKindGroup = {
  /** The kind, provider and model together: one fold each. */
  key: string;
  kind: string;
  provider: string;
  model: string;
  rows: IslandAgentRow[];
};

/** The listed agents by kind (Worker, Reviewer, …) and the provider and model they run on, each group's rows in the
 *  list's order. The groups stand in the order their first agent appeared (started), so work starting or ending moves
 *  no group. */
function agentKindGroups(sessionId: string, agents: readonly IslandAgentRow[]): AgentKindGroup[] {
  const groups = new Map<string, AgentKindGroup & { first: number }>();
  // An agent keeps its place and its last known route through a restart: its kind keeps its key, its fold and its place.
  const routed = (row: IslandAgentRow) => {
    const { agent } = row.node;
    const { provider, model, at } = agentPlace(sessionId, agent);
    return { kind: agentRoleLabel(agent.agent || agent.tag), provider, model, appeared: at };
  };
  // An agent whose route is not known yet stands with the first of its kind whose route is.
  const known = new Map<string, { provider: string; model: string }>();
  for (const row of agents) {
    const { kind, provider, model } = routed(row);
    if ((provider || model) && !known.has(kind)) known.set(kind, { provider, model });
  }
  for (const row of agents) {
    const own = routed(row);
    const { kind, appeared } = own;
    const { provider, model } = own.provider || own.model ? own : (known.get(kind) ?? own);
    const key = [kind, provider, model].join('/');
    const group = groups.get(key);
    if (group) {
      group.rows.push(row);
      group.first = Math.min(group.first, appeared);
    } else {
      groups.set(key, { key, kind, provider, model, rows: [row], first: appeared });
    }
  }
  // Groups that started together, or with no start time, stand by name: the input's order follows activity.
  return [...groups.values()]
    .sort((a, b) => a.first - b.first || a.key.localeCompare(b.key))
    .map(({ first: _first, ...group }) => group);
}

/** The short model name a kind line adds where another listed group shares its kind and provider on another model
 *  ("Worker · Opus 5.5"): the model's display name less the brand word they all lead with. Keyed by group. */
function kindModelLabels(groups: readonly AgentKindGroup[]): Map<string, string> {
  const labels = new Map<string, string>();
  const named = new Map<string, AgentKindGroup[]>();
  for (const group of groups) {
    const same = `${group.kind}/${group.provider}`;
    named.set(same, [...(named.get(same) ?? []), group]);
  }
  for (const same of named.values()) {
    if (same.length < 2) continue;
    const names = same.map(({ model, provider }) => modelDisplayName(model, provider));
    const brand = names[0].split(' ')[0];
    const shared = names.every((name) => name.includes(' ') && name.split(' ')[0] === brand);
    for (const [index, group] of same.entries()) {
      labels.set(group.key, shared ? names[index].slice(brand.length + 1) : names[index]);
    }
  }
  return labels;
}

/** A kind's fold, one line, as To-do's "Remaining 6" line: the kind (and the short model where another listed kind
 *  shares its name and provider), the chevron, then at the line's end the mark and how many are in progress, as a
 *  section head reads, neither with none in progress. The route (model and effort) is the line's tooltip. */
function AgentKindFold({
  group,
  model,
  foldKey,
  open,
  onToggle,
}: {
  group: AgentKindGroup;
  /** The short model name, only where it tells two kinds of one name apart. */
  model: string;
  foldKey: string;
  open: boolean;
  onToggle(): void;
}) {
  const { kind, rows } = group;
  const route = useSharedRouteText(rows.map(({ node }) => node.agent)) || modelDisplayName(group.model, group.provider);
  const active = agentsInProgress(rows);
  const needs = rows.filter((row) => row.state === 'needs-user').length;
  const Chevron = open ? ChevronDown : ChevronRight;
  const label = t('{{kind}}: {{count}} agents, {{active}} not finished', {
    kind: model ? `${kind} · ${model}` : kind,
    count: rows.length,
    active,
  });
  return (
    <div className="composer-island-agent-group" role="none">
      <button
        type="button"
        className="composer-island-agent-fold"
        data-fold={foldKey}
        role="treeitem"
        aria-level={1}
        aria-expanded={open}
        // Folded, the head stands for its rows: one that waits on the user is named, as its mark shows.
        aria-label={!open && needs > 0 ? `${label}, ${t('Needs you {{needs}}', { needs })}` : label}
        title={route || undefined}
        onClick={(event) => {
          onToggle();
          releasePointerFocus(event);
        }}
      >
        <span className="composer-island-agent-fold-name">{kind}</span>
        {model && <span className="composer-island-agent-fold-model">{` · ${model}`}</span>}
        <Chevron size={12} className="composer-island-agent-fold-cv" aria-hidden="true" />
        {/* At the line's end, as a section head writes its own: the mark, then how many are in progress. */}
        {active > 0 && jobsTabMark('agent', rows, 0)}
        {active > 0 && <span className="composer-island-agent-fold-count">{active}</span>}
      </button>
    </div>
  );
}

/** An agents list (the island's Agents tab, the session panel's Agents
 *  section), built as the To-do list: one fold a kind and route
 *  (AgentKindFold), its agents one line each under it. A fold is remembered
 *  per session; a kind the user never folded or opened is open as
 *  `kindsOpen` says. `sizer` holds the state column's width. */
export function AgentGroupList({
  sessionId,
  agents,
  usage,
  clock,
  listRef,
  className,
  sizer,
  kindsOpen = true,
  onOpenSession,
}: {
  sessionId: string;
  agents: IslandAgentRow[];
  /** A kind's fold before the user sets it: open on the island, folded in the session panel. */
  kindsOpen?: boolean;
  usage: Pick<IslandUsageSummary, 'agentRowTokens' | 'agentRowFloors'>;
  clock: number;
  listRef?: RefObject<HTMLDivElement | null>;
  className: string;
  sizer: ReactNode;
  onOpenSession?(sessionId: string, title: string, ownerSessionId: string): void;
}) {
  const folds = useSessionRailFolds(sessionId);
  const groups = agentKindGroups(sessionId, agents);
  const models = kindModelLabels(groups);
  return (
    <div ref={listRef} className={className} role="tree" aria-label={t('Agents')}>
      {groups.map((group) => {
        const { rows } = group;
        const key = `agents:${group.key}`;
        const fallback =
          group.provider || group.model ? folds.groupOpen(`agents:${group.kind}//`, kindsOpen) : kindsOpen;
        const open = folds.groupOpen(key, fallback);
        return (
          <Fragment key={group.key}>
            <AgentKindFold
              group={group}
              model={models.get(group.key) ?? ''}
              foldKey={key}
              open={open}
              onToggle={() => folds.setGroups({ [key]: !open })}
            />
            {open &&
              rows.map(({ node, state, finished }, index) => (
                <div key={poolRowKey(node.agent, index)} className="composer-island-agent-item" role="none">
                  <AgentIslandRow
                    node={node}
                    state={state}
                    finished={finished}
                    clock={clock}
                    tokens={usage.agentRowTokens.get(node.sessionId)}
                    tokensFloor={usage.agentRowFloors.has(node.sessionId)}
                    posInSet={index + 1}
                    setSize={rows.length}
                    ownerSessionId={sessionId}
                    onOpenSession={onOpenSession}
                  />
                </div>
              ))}
          </Fragment>
        );
      })}
      {sizer}
    </div>
  );
}

export function ShellJobItem({
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
      {/* One grid cell for the row's one or two buttons. */}
      <span className="composer-island-row-actions">
        <ShellRowButton row={row} stop={stop} releasing={releasing} onStop={onStop} onDismiss={onDismiss} />
      </span>
    </li>
  );
}

/** The listed agents at work, read by the pill segment and the session
 *  panel's Agents section. An agent waiting on its own tasks is still at work
 *  (its timer runs), so it counts as running. */
export function islandAgentCounts(agents: readonly IslandAgentRow[]) {
  const count = (...states: DesktopAgentActivityState[]) => agents.filter(({ state }) => states.includes(state)).length;
  return {
    running: count('running', 'waiting', 'cancel-unconfirmed'),
  };
}

/** How many listed agents are in progress: not finished (at work, queued, blocked on the user, or not yet settled by
 *  the pool), the agents a head's mark stands for. The heads, the kind lines and the pill count these, not every agent
 *  listed. */
export function agentsInProgress(agents: readonly IslandAgentRow[]): number {
  return agents.filter((row) => !row.finished).length;
}

/** A clock under an hour and one under ten hours, at their widest digits. */
export const widestClocks = () => [formatWorkElapsed(3_599_000), formatWorkElapsed(35_999_000)];

/** An agent row's clock (minutes past a minute) under an hour and under ten hours, at their widest digits. */
export const widestAgentClocks = () => [formatWorkClock(3_599_000), formatWorkClock(35_999_000)];

/** Everything an agent row's state column can read (agentElapsedText). */
function agentStateLabels(): string[] {
  return [...widestAgentClocks(), ...agentStateWords()];
}

/** Every word a shell row's state column can read besides its clock (ShellJobContent): how it finished, or that
 *  its stop is not confirmed. */
export function shellStateWords(): string[] {
  const finished = [{ status: 'cancelled' as const }, { exitCode: 0 }, { exitCode: 1 }].map(shellFinishedLabel);
  return [...new Set([...finished, t('Termination unconfirmed')])];
}

/** Everything a shell row's state column can read (ShellJobContent). */
function shellStateLabels(): string[] {
  return [...widestClocks(), ...shellStateWords()];
}

/** Narrowing drops the cache hit first, as the composer's readout does, then
 *  the cost (which that line lacks); the token total stays longest. */
const SUMMARY_KEEP_ORDER = ['total', 'cost', 'hit'];
const SUMMARY_DISPLAY_ORDER = ['total', 'hit', 'cost'];

/** The agents' usage line: what every agent the Lead ran used together, in
 *  the composer readout's wording; the Lead's own is that readout. A figure
 *  the ledger has not answered or cannot attribute exactly is left out, never
 *  written as a placeholder or an invented zero; with none known there is no
 *  line. */
export function AgentsSummary({ usage }: { usage: IslandUsageSummary }) {
  const { agentTokens, cacheHitRate, costUsd, costFloor, agentsFloor } = usage;
  const noted = (item: ReadoutItem, note: string | null): ReadoutItem =>
    note ? { ...item, label: `${item.label}\n${note}` } : item;
  // The line's figures stand plain; that one is a floor is its tooltip's to say.
  const total = agentTokens === null ? null : tokensReadoutItem(formatCompactTokens(agentTokens));
  // The amount alone on the line, in every form; its tooltip names it.
  const costItem = costUsd === null ? null : costReadoutItem(usageMoney(costUsd));
  const parts = {
    total: total && noted(total, agentsFloor ? plainFloorNote() : null),
    hit:
      cacheHitRate === null
        ? null
        : noted(cacheHitReadoutItem(formatHitPercent(cacheHitRate)), agentsFloor ? hitRateNote() : null),
    cost: costItem && noted({ ...costItem, word: costItem.text }, costFloor ? plainFloorNote() : null),
  };
  const variants = readoutVariants(parts, SUMMARY_KEEP_ORDER, SUMMARY_DISPLAY_ORDER);
  if (variants.length === 0) return null;
  return <FittedReadout variants={variants} title={t('Agents usage')} className="composer-island-summary" />;
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
  const list = useRef<HTMLDivElement>(null);
  useWholeRowList(list);
  const clearable = clearableAgents(agents);
  return (
    <section className="composer-island-panel" aria-label={t('Agents')}>
      <IslandPanelHead
        chip={
          <>
            {t('Agents')}
            <HeadFigures count={agentsInProgress(agents)} mark={agentsHeadMark(agents)} />
          </>
        }
        onClose={onClose}
      />
      <AgentGroupList
        sessionId={sessionId}
        agents={agents}
        usage={usage}
        clock={clock}
        listRef={list}
        className="composer-island-pbody composer-island-jobs composer-island-agents schedules-list agent-pool-list"
        sizer={<IslandColumnSizer labels={agentStateLabels()} />}
        onOpenSession={onOpenSession}
      />
      <IslandPanelFoot
        end={
          <TidyButton
            className="composer-island-button"
            kind="clear-finished"
            label={t('Clean up')}
            description={t('Clear finished')}
            disabled={clearable.length === 0}
            onClick={() => clearFinishedAgents(sessionId, agents, shellKeys)}
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
  const list = useRef<HTMLUListElement>(null);
  useWholeRowList(list);
  const { stopOf, releasingOf, stop } = useShellStops(sessionId);
  const runningShells = shells.filter((row) => !row.finished).length;
  const finished = shells.filter((row) => row.finished);
  return (
    <section className="composer-island-panel" aria-label={t('Background tasks')}>
      <IslandPanelHead
        chip={
          <>
            {t('Shell')}
            <HeadFigures count={runningShells} mark={jobsTabMark('shell', [], runningShells)} />
          </>
        }
        onClose={onClose}
      />
      <ul ref={list} className="composer-island-pbody composer-island-jobs">
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
        <IslandColumnSizer element="li" labels={shellStateLabels()} />
      </ul>
      <IslandPanelFoot
        end={
          finished.length > 0 ? (
            <TidyButton
              className="composer-island-button"
              kind="close-all"
              label={t('Clean up')}
              description={t('Clear ended shells')}
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
  // The view keeps its identity through progress the rows do not show.
  const view = useSyncExternalStore(poolStore.subscribe, poolStore.getView, poolStore.getView);
  // The usage cue's ledger token is progress the view leaves out: it re-renders on its own.
  const readCue = () => islandUsageCue(poolStore.getSnapshot(), sessionId, 0);
  useSyncExternalStore(poolStore.subscribe, readCue, readCue);
  // Rows the user cleared ("Clear finished") are not listed.
  const agentRows = islandAgentRows(useVisibleAgentPool(view), sessionId);
  useEffect(() => {
    startAgentPool(poolStore);
  }, [poolStore]);
  return { agentRows, poolRows: poolStore.getSnapshot() };
}

const CLEARABLE_AGENTS = new WeakMap<readonly IslandAgentRow[], DesktopAgentPoolRow[]>();

/** The finished agents "Clean up" clears: the listed rows are already the
 *  tree flattened, so each is judged on its own node. */
export function clearableAgents(agents: readonly IslandAgentRow[]): DesktopAgentPoolRow[] {
  let clearable = CLEARABLE_AGENTS.get(agents);
  if (!clearable) {
    clearable = agents.filter(({ node }) => clearableAgentNode(node)).map(({ node }) => node.agent);
    CLEARABLE_AGENTS.set(agents, clearable);
  }
  return clearable;
}

export function clearFinishedAgents(
  sessionId: string,
  agents: readonly IslandAgentRow[],
  shellKeys: ReadonlySet<string> | null
): void {
  dismissFinishedAgentRows(clearableAgents(agents), hostAgentListing(), { sessionId, keys: shellKeys });
}

/** Hides finished shell rows for good. */
export function dismissShellRows(sessionId: string, rows: readonly JobRow[], shellKeys: ReadonlySet<string> | null) {
  dismissShellJobs(
    sessionId,
    rows.map((row) => row.key),
    hostDismissListing(sessionId, shellKeys)
  );
}

/** A session's background work as the island lists it: its lane's header
 *  view, the shell rows (finished ones until dismissed or auto-dismissed) and
 *  the agent rows. The island and the session panel both read it. */
export function useSessionJobs(sessionId: string) {
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
  const runningShells = jobRows.filter((row) => !row.finished).length;
  const finishedShellCount = jobRows.length - runningShells;
  return {
    snapshot,
    jobRows,
    agentRows,
    poolRows,
    shellKeys,
    finishedShellCount,
    shellCount: Math.max(Number(snapshot.shellJobs?.count) || 0, runningShells),
  };
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

/** The agents list's usage (its footer line and each row's total), read while
 *  the list is shown: the island's panel and the session panel's category. */
export function useAgentsUsage({
  sessionId,
  agentRows,
  poolRows,
  busy,
  open,
}: {
  sessionId: string;
  agentRows: readonly IslandAgentRow[];
  poolRows: Parameters<typeof islandUsageCue>[0];
  busy: boolean;
  open: boolean;
}): IslandUsageSummary {
  const agentSessionIds = useMemo(() => agentRows.map(({ node }) => node.sessionId).filter(Boolean), [agentRows]);
  const settledTurns = useSettledTurns(busy);
  const usageCue = islandUsageCue(poolRows, sessionId, settledTurns);
  const sessionUsage = useIslandSessionUsage(sessionId, agentSessionIds, open, usageCue);
  return useMemo(() => islandUsageSummary(sessionUsage, agentSessionIds), [sessionUsage, agentSessionIds]);
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
  const { running: working } = islandAgentCounts(agents);
  const active = agentsInProgress(agents);
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
      {/* The panel's own mark, so one state reads the same in the pill and the panel. */}
      {jobsTabMark('agent', agents, 0)}
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
      </div>
      <IslandPanelFoot className="composer-island-pfoot" end={children} />
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

/** The time alone is what a narrow island keeps of the sentence (useIslandFit);
 *  its name keeps the whole of it, whatever the width shows. */
function ResumeSegment({
  resume,
  expanded,
  onClick,
}: {
  resume: ComposerIslandQuotaResume;
  expanded: boolean;
  onClick(): void;
}) {
  const time = quotaResetLabel(resume.resetAt);
  const text = t('Resumes in {{model}} at {{time}}', { model: resume.model, time });
  const remaining = useQuotaRemaining(resume.resetAt);
  return (
    <button
      type="button"
      className="composer-island-seg composer-island-seg-warning composer-island-seg-resume"
      aria-expanded={expanded}
      aria-label={remaining ? `${text}, ${remaining}` : text}
      title={text}
      onClick={onClick}
    >
      <MxIcon name="clock" size={16} />
      <span className="composer-island-seg-text">{text}</span>
      <span className="composer-island-seg-time">{time}</span>
      <span className="composer-island-seg-sub">{remaining}</span>
    </button>
  );
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
  const { snapshot, jobRows, agentRows, poolRows, shellKeys, finishedShellCount, shellCount } =
    useSessionJobs(sessionId);
  // Finished shells keep the shells panel open-able until dismissed.
  const shellTotal = shellCount + finishedShellCount;
  // No branch or worktree switch while anything of the session still works.
  const locked = workBusy || shellCount > 0 || agentRows.some((row) => !row.finished);
  const [expanded, setExpanded] = useState<ComposerIslandTab>('');
  const toggle = (tab: 'agents' | 'shells') => setExpanded(expanded === tab ? '' : tab);
  const usageSummary = useAgentsUsage({
    sessionId,
    agentRows,
    poolRows,
    busy: Boolean(snapshot.busy),
    open: expanded === 'agents',
  });
  const islandRef = useRef<HTMLDivElement | null>(null);
  const pillRef = useRef<HTMLDivElement | null>(null);
  const slotRef = useRef<HTMLDivElement | null>(null);
  useIslandFit(islandRef, pillRef);
  useIslandGlide(islandRef, pillRef, useSurfaceActive());
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
  useMobileBack(ownPanel, () => setExpanded(''));
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
                <ResumeSegment
                  resume={quotaResume}
                  expanded={expanded === 'resume'}
                  onClick={() => setExpanded(expanded === 'resume' ? '' : 'resume')}
                />
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
                onDismiss={(row) => dismissShellRows(sessionId, [row], shellKeys)}
                onDismissAll={(rows) => dismissShellRows(sessionId, rows, shellKeys)}
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

// The session panel's Agents and Shells categories: the island's own rows,
// handlers (useSessionJobs) and footer line, in the panel's sheets.
import { ChevronDown, ChevronRight } from 'lucide-react';
import { type KeyboardEvent, useId, useLayoutEffect, useMemo, useRef } from 'react';
import { agentRoleLabel, poolRowKey, type IslandAgentRow } from './agent-activity-model';
import { AgentRouteLabel, type AgentRouteView, agentRouteView, useAgentRouteAuto } from './agent-row-parts';
import { useModelCatalogRevision } from './auto-effort-store';
import type { JobRow } from './background-jobs-model';
import {
  clearableAgents,
  clearFinishedAgents,
  dismissShellRows,
  ShellJobItem,
  shellStateLabels,
  useAgentsUsage,
} from './ComposerIsland';
import { t } from './i18n';
import { IslandColumnSizer } from './IslandPanelFoot';
import { RailAgentRow, RailFinishedAgent } from './session-rail-agent-rows';
import type { useSessionRailFolds } from './session-rail-folds';
import { RailSection } from './session-rail-parts';
import { useShellStops } from './shell-job-controls';
import { useClock } from './use-clock';

type Folds = ReturnType<typeof useSessionRailFolds>;

/** The agents by where they stand, as the island's model has them; each keeps
 *  its place. `working` is what is listed above the fold: those at work
 *  (waiting on the user or on their own tasks, or of unknown outcome), then the
 *  queued. An agent of unknown outcome is in none of the counts by state. */
export function railAgentGroups(agents: readonly IslandAgentRow[]) {
  const unfinished = agents.filter((row) => !row.finished);
  const atWork = unfinished.filter((row) => row.state !== 'queued');
  const waiting = unfinished.filter((row) => row.state === 'queued');
  return {
    working: [...atWork, ...waiting],
    running: atWork.filter((row) => row.state !== 'unknown'),
    waiting,
    finished: agents.filter((row) => row.finished),
  };
}

type RailAgentFold = { key: string; role: string; view: AgentRouteView | null; rows: IslandAgentRow[] };

/** The agents by their group's heading (role, then the model line as the row
 *  shows it), in the order each heading first appears. */
export function railAgentFolds(agents: readonly IslandAgentRow[], autoOn: boolean): RailAgentFold[] {
  const folds = new Map<string, RailAgentFold>();
  for (const row of agents) {
    const { agent } = row.node;
    const role = agentRoleLabel(agent.agent || agent.tag);
    const view = agentRouteView(agent, autoOn);
    const key = `agents:group:${role}|${view ? Object.values(view).join('|') : ''}`;
    const fold = folds.get(key);
    if (fold) fold.rows.push(row);
    else folds.set(key, { key, role, view, rows: [row] });
  }
  return [...folds.values()];
}

/** An agent's name under its group: its tag, the group saying the role. */
const nameInRole = (row: IslandAgentRow, role: string) => String(row.node.agent.tag || '').trim() || role;

/** What the card lists: every agent, or the agents of one state. */
type AgentFilter = 'all' | 'running' | 'waiting' | 'finished';
const AGENT_FILTER_KEY = 'agents:filter';
const AGENT_FILTERS: { filter: AgentFilter; wording: string }[] = [
  { filter: 'all', wording: 'All {{count}}' },
  { filter: 'running', wording: 'Running {{count}}' },
  { filter: 'waiting', wording: 'Waiting {{count}}' },
  { filter: 'finished', wording: 'Finished {{count}}' },
];

/** The agents a filter lists; an agent of unknown outcome is listed under All only. */
function filteredAgents(agents: readonly IslandAgentRow[], filter: AgentFilter): readonly IslandAgentRow[] {
  return filter === 'all' ? agents : railAgentGroups(agents)[filter];
}

/** A count's wording with the word muted and the number in the text's ink. */
function CountWording({ wording, count }: { wording: string; count: number }) {
  const [before, after = ''] = t(wording, { count: COUNT_SLOT }).split(COUNT_SLOT);
  return (
    <>
      {before}
      <b>{count}</b>
      {after}
    </>
  );
}
const COUNT_SLOT = '\uE000';

/** The state line under the head: All, then each state that has agents, as
 *  tabs; the one picked filters the card's list. */
function AgentFilterTabs({
  counts,
  selected,
  panelId,
  onSelect,
}: {
  counts: Record<AgentFilter, number>;
  selected: AgentFilter;
  panelId: string;
  onSelect(filter: AgentFilter): void;
}) {
  const shown = AGENT_FILTERS.filter(({ filter }) => filter === 'all' || counts[filter] > 0);
  const list = useRef<HTMLDivElement>(null);
  // The tabs scroll sideways when wider than the card: the picked one is brought into view, inside the line alone.
  useLayoutEffect(() => {
    const line = list.current;
    const tab = line?.querySelector<HTMLElement>(`[data-filter="${selected}"]`);
    if (!line || !tab) return;
    const pad = Number.parseFloat(getComputedStyle(line).paddingLeft) || 0;
    const box = line.getBoundingClientRect();
    const at = tab.getBoundingClientRect();
    if (at.left < box.left + pad) line.scrollLeft -= box.left + pad - at.left;
    else if (at.right > box.right - pad) line.scrollLeft += at.right - (box.right - pad);
  }, [selected]);
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const at = shown.findIndex(({ filter }) => filter === selected);
    const next =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? (at + 1) % shown.length
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? (at - 1 + shown.length) % shown.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? shown.length - 1
              : -1;
    if (next < 0) return;
    event.preventDefault();
    onSelect(shown[next].filter);
    list.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus({ preventScroll: true });
  };
  return (
    <div ref={list} className="session-rail-pills" role="tablist" aria-label={t('Agents')}>
      {shown.map(({ filter, wording }) => (
        <button
          key={filter}
          type="button"
          className="session-rail-pill"
          role="tab"
          id={`${panelId}-${filter}`}
          aria-selected={filter === selected}
          aria-controls={panelId}
          tabIndex={filter === selected ? 0 : -1}
          data-filter={filter}
          onClick={() => onSelect(filter)}
          onKeyDown={onKeyDown}
        >
          <CountWording wording={wording} count={counts[filter]} />
        </button>
      ))}
    </div>
  );
}

/** A group's label: its role in small capitals, its model as the island's row names it, then how many it shows. */
function AgentGroupLabel({ fold, count }: { fold: RailAgentFold; count: number }) {
  return (
    <div className="session-rail-agent-group">
      <span className="session-rail-caps">{fold.role}</span>
      {fold.view && <AgentRouteLabel view={fold.view} title={String(fold.rows[0].node.agent.model || '')} />}
      <span className="session-rail-ct">{count}</span>
    </div>
  );
}

/** The Agents category: a group for each role and model ("WORKER Claude Opus
 *  5.5 Medium") with its working agents, each named by its tag, and its
 *  finished ones folded into one line; the state tabs under the head filter it. */
export function AgentsSection({
  sessionId,
  agents,
  poolRows,
  busy,
  shellKeys,
  open,
  onToggle,
  folds,
  onOpenSession,
}: {
  sessionId: string;
  agents: IslandAgentRow[];
  folds: Folds;
  poolRows: Parameters<typeof useAgentsUsage>[0]['poolRows'];
  /** The session's turn runs: a settled turn asks for the usage again. */
  busy: boolean;
  shellKeys: ReadonlySet<string> | null;
  open: boolean;
  onToggle(): void;
  onOpenSession?(sessionId: string, title: string, ownerSessionId: string): void;
}) {
  const shown = open && agents.length > 0;
  const usage = useAgentsUsage({ sessionId, agentRows: agents, poolRows, busy, open: shown });
  const routed = useMemo(() => agents.map((row) => row.node.agent), [agents]);
  const catalog = useModelCatalogRevision();
  const autoOn = useAgentRouteAuto(routed, catalog);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the route views read the catalog `catalog` counts.
  const groups = useMemo(() => railAgentFolds(agents, autoOn), [agents, autoOn, catalog]);
  const counts = useMemo(() => {
    const { running, waiting, finished } = railAgentGroups(agents);
    return { all: agents.length, running: running.length, waiting: waiting.length, finished: finished.length };
  }, [agents]);
  const picked = folds.choice(AGENT_FILTER_KEY, 'all') as AgentFilter;
  // A state with no agents shows All; the session's pick stands for when the state has agents again.
  const filter: AgentFilter = Object.hasOwn(counts, picked) && counts[picked] > 0 ? picked : 'all';
  const { setChoice } = folds;
  const panelId = useId();
  if (agents.length === 0) return null;
  return (
    <RailSection
      category="agents"
      title={t('Agents')}
      count={agents.length}
      open={open}
      onToggle={onToggle}
      top={
        <AgentFilterTabs
          counts={counts}
          selected={filter}
          panelId={panelId}
          onSelect={(next) => setChoice(AGENT_FILTER_KEY, next)}
        />
      }
      scroll
      tidy={{
        kind: 'clear-finished',
        description: t('Clear finished'),
        disabled: clearableAgents(agents).length === 0,
        onClick: () => clearFinishedAgents(sessionId, agents, shellKeys),
      }}
    >
      <div id={panelId} role="tabpanel" aria-labelledby={`${panelId}-${filter}`}>
      {groups.map((group) => {
        const listed = filteredAgents(group.rows, filter);
        if (listed.length === 0) return null;
        // Under a state, its agents alone: the finished ones as their own lines, with no fold above them.
        const working = filter === 'finished' ? [] : filter === 'all' ? railAgentGroups(group.rows).working : listed;
        const done = filter === 'finished' ? listed : filter === 'all' ? railAgentGroups(group.rows).finished : [];
        const doneKey = `${group.key}|finished`;
        const folded = filter === 'all' && done.length > 0;
        const doneShown = !folded || folds.groupOpen(doneKey, working.length === 0 && done.length <= 4);
        const setSize = working.length + (folded ? 1 : done.length);
        const rowProps = (row: IslandAgentRow) => ({
          row,
          name: nameInRole(row, group.role),
          tokens: usage.agentRowTokens.get(row.node.sessionId),
          tokensFloor: usage.agentRowFloors.has(row.node.sessionId),
          ownerSessionId: sessionId,
          onOpenSession,
        });
        return (
          <div key={group.key} className="session-rail-group" data-group={group.key}>
            <AgentGroupLabel fold={group} count={listed.length} />
            <div
              className="composer-island-jobs session-rail-agents"
              role="tree"
              aria-label={`${group.role} ${listed.length}`}
            >
                {working.map((row, index) => (
                  <RailAgentRow
                    key={poolRowKey(row.node.agent, index)}
                    {...rowProps(row)}
                    posInSet={index + 1}
                    setSize={setSize}
                  />
                ))}
                {folded && (
                  <button
                    type="button"
                    className="session-rail-agent-fold"
                    role="treeitem"
                    aria-level={1}
                    aria-posinset={setSize}
                    aria-setsize={setSize}
                    aria-expanded={doneShown}
                    data-fold={doneKey}
                    onClick={() => folds.setGroups({ [doneKey]: !doneShown })}
                  >
                    <span>{t('Finished {{count}}', { count: done.length })}</span>
                    {doneShown ? (
                      <ChevronDown size={10} className="session-rail-cv" aria-hidden="true" />
                    ) : (
                      <ChevronRight size={10} className="session-rail-cv" aria-hidden="true" />
                    )}
                  </button>
                )}
                {folded && doneShown && (
                  <div role="group">
                    {done.map((row, index) => (
                      <RailFinishedAgent
                        key={poolRowKey(row.node.agent, index)}
                        {...rowProps(row)}
                        depth={1}
                        posInSet={index + 1}
                        setSize={done.length}
                      />
                    ))}
                  </div>
                )}
                {!folded &&
                  done.map((row, index) => (
                    <RailFinishedAgent
                      key={poolRowKey(row.node.agent, index)}
                      {...rowProps(row)}
                      depth={0}
                      posInSet={index + 1}
                      setSize={setSize}
                    />
                  ))}
            </div>
          </div>
        );
      })}
      </div>
    </RailSection>
  );
}

export function ShellsSection({
  sessionId,
  shells,
  shellKeys,
  open,
  onToggle,
}: {
  sessionId: string;
  shells: JobRow[];
  shellKeys: ReadonlySet<string> | null;
  open: boolean;
  onToggle(): void;
}) {
  const clock = useClock(open && shells.length > 0);
  const { stopOf, releasingOf, stop } = useShellStops(sessionId);
  if (shells.length === 0) return null;
  const running = shells.filter((row) => !row.finished).length;
  const finished = shells.filter((row) => row.finished);
  return (
    <RailSection
      category="shells"
      title={t('Shell')}
      count={shells.length}
      meta={
        <span>
          {[
            running ? t('Running {{count}}', { count: running }) : '',
            finished.length ? t('Ended {{count}}', { count: finished.length }) : '',
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
      }
      open={open}
      onToggle={onToggle}
      scroll
      tidy={{
        kind: 'close-all',
        description: t('Clear ended shells'),
        disabled: finished.length === 0,
        onClick: () => dismissShellRows(sessionId, finished, shellKeys),
      }}
    >
      <ul className="composer-island-jobs">
        {shells.map((row) => (
          <ShellJobItem
            key={row.key}
            row={row}
            clock={clock}
            stop={stopOf(row)}
            releasing={releasingOf(row)}
            onStop={stop}
            onDismiss={(dismissed) => dismissShellRows(sessionId, [dismissed], shellKeys)}
          />
        ))}
        <IslandColumnSizer element="li" labels={shellStateLabels()} />
      </ul>
    </RailSection>
  );
}

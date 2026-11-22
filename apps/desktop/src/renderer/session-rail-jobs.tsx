// The session panel's Agents and Shells categories: the island's own rows,
// handlers (useSessionJobs) and footer line, in the panel's sheets.
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useMemo } from 'react';
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
import { RailFold, RailSection } from './session-rail-parts';
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

/** A state count of the line under the head: the word muted, the number in the text's ink. */
function StateCount({ wording, count }: { wording: string; count: number }) {
  const [before, after = ''] = t(wording, { count: COUNT_SLOT }).split(COUNT_SLOT);
  return (
    <span>
      {before}
      <b>{count}</b>
      {after}
    </span>
  );
}
const COUNT_SLOT = '\uE000';

/** The card's counts by state, on a line of their own under the head. */
function AgentStateCounts({ agents }: { agents: readonly IslandAgentRow[] }) {
  const { running, waiting, finished } = railAgentGroups(agents);
  return (
    <div className="session-rail-meta">
      {running.length > 0 && <StateCount wording="Running {{count}}" count={running.length} />}
      {waiting.length > 0 && <StateCount wording="Waiting {{count}}" count={waiting.length} />}
      {finished.length > 0 && <StateCount wording="Finished {{count}}" count={finished.length} />}
    </div>
  );
}

/** A group's name: its role, then its model as the island's row names it. */
function AgentGroupName({ fold }: { fold: RailAgentFold }) {
  return (
    <>
      {fold.role}
      {fold.view && <AgentRouteLabel view={fold.view} title={String(fold.rows[0].node.agent.model || '')} />}
    </>
  );
}

/** The Agents category: a fold for each role and model ("Worker · Claude Opus
 *  5.5 Medium") with its working agents, each named by its tag, and its
 *  finished ones folded into one line; the counts by state under the head. */
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
  if (agents.length === 0) return null;
  return (
    <RailSection
      category="agents"
      title={t('Agents')}
      count={agents.length}
      open={open}
      onToggle={onToggle}
      top={<AgentStateCounts agents={agents} />}
      scroll
      tidy={{
        kind: 'clear-finished',
        description: t('Clear finished'),
        disabled: clearableAgents(agents).length === 0,
        onClick: () => clearFinishedAgents(sessionId, agents, shellKeys),
      }}
    >
      {groups.map((group) => {
        const shown = folds.groupOpen(group.key, true);
        const { working, finished: done } = railAgentGroups(group.rows);
        const doneKey = `${group.key}|finished`;
        const doneShown = folds.groupOpen(doneKey, working.length === 0 && done.length <= 4);
        const setSize = working.length + (done.length > 0 ? 1 : 0);
        const rowProps = (row: IslandAgentRow) => ({
          row,
          name: nameInRole(row, group.role),
          tokens: usage.agentRowTokens.get(row.node.sessionId),
          ownerSessionId: sessionId,
          onOpenSession,
        });
        return (
          <div key={group.key} className="session-rail-group" data-group={group.key}>
            <RailFold
              id={group.key}
              name={<AgentGroupName fold={group} />}
              count={group.rows.length}
              open={shown}
              onToggle={() => folds.setGroups({ [group.key]: !shown })}
            />
            {shown && (
              <div
                className="composer-island-jobs session-rail-agents"
                role="tree"
                aria-label={`${group.role} ${group.rows.length}`}
              >
                {working.map((row, index) => (
                  <RailAgentRow
                    key={poolRowKey(row.node.agent, index)}
                    {...rowProps(row)}
                    posInSet={index + 1}
                    setSize={setSize}
                  />
                ))}
                {done.length > 0 && (
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
                {done.length > 0 && doneShown && (
                  <div role="group">
                    {done.map((row, index) => (
                      <RailFinishedAgent
                        key={poolRowKey(row.node.agent, index)}
                        {...rowProps(row)}
                        posInSet={index + 1}
                        setSize={done.length}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
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

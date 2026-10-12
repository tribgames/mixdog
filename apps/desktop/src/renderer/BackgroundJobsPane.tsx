import { SquareTerminal } from 'lucide-react';
import { useMemo } from 'react';
import { AgentPoolRow } from './AgentActivityPane';
import { backgroundJobRows, type JobKind, type JobRow } from './background-jobs-model';
import { requestBackgroundJobsTab, useBackgroundJobsTab } from './background-jobs-tab-store';
import { desktopHeaderSnapshotsEqual } from './desktop-snapshot-store';
import { EMPTY_SNAPSHOT } from './desktop-types';
import { t } from './i18n';
import { DockHeaderRow } from './pane-dock-chrome';
import { defaultSessionLaneStore, useSessionLane } from './session-lane-store';
import { formatWorkElapsed } from './transcript-primitives';
import { useClock } from './use-clock';

/** A shell job in the agents list's row grammar: icon, command, elapsed. */
function ShellJobRow({ row, clock }: { row: JobRow; clock: number }) {
  const elapsed = row.startedAt > 0 ? formatWorkElapsed(clock - row.startedAt) || '0s' : '0s';
  return (
    <div className="schedules-row workflows-agent-summary-row agent-pool-row" role="treeitem" aria-label={row.label}>
      <span className="sidebar-resource-icon" aria-hidden="true">
        <SquareTerminal size={16} />
      </span>
      <span className="schedules-row-copy">
        <span className="agent-pool-heading">
          <b className="agent-pool-name" title={row.label}>
            {row.label}
          </b>
        </span>
      </span>
      <span className="agent-activity-status">
        {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: aria-label on <time> gives the elapsed duration an explicit accessible name */}
        <time className="agent-activity-elapsed" aria-label={elapsed} data-state="running">
          {elapsed}
        </time>
      </span>
    </div>
  );
}

/** The side dock's background-jobs view: the composer island's agents and
 *  shells as a list, painted with the Agents sidebar's own row. */
export function BackgroundJobsPane({
  sessionId,
  active,
  onClose,
  onOpenAgentSession,
}: {
  sessionId: string;
  active: boolean;
  onClose?(): void;
  /** Opens an agent's session (same action as the Agents sidebar rows). */
  onOpenAgentSession?(sessionId: string, title: string, ownerSessionId: string): void;
}) {
  const lane = useSessionLane(sessionId, defaultSessionLaneStore, desktopHeaderSnapshotsEqual, Boolean(sessionId));
  const snapshot = lane ?? EMPTY_SNAPSHOT;
  const rows = useMemo(() => backgroundJobRows(snapshot), [snapshot]);
  const clock = useClock(active);
  const requested = useBackgroundJobsTab(sessionId);
  const agents = rows.filter((row) => row.kind === 'agent');
  const shells = rows.filter((row) => row.kind === 'shell');
  // The requested list may have emptied while open: show the one that has rows.
  const other: JobKind = requested === 'agent' ? 'shell' : 'agent';
  const shown: JobKind = (requested === 'agent' ? agents : shells).length > 0 ? requested : other;
  const shownRows = shown === 'agent' ? agents : shells;
  const tabs: Array<[JobKind, number, string]> = [
    ['agent', agents.length, t('Agent {{agent}}', { agent: agents.length })],
    ['shell', shells.length, t('Shell {{shell}}', { shell: shells.length })],
  ];
  const left = (
    <span className="session-diff-summary">
      {tabs.map(
        ([kind, count, label]) =>
          count > 0 && (
            <button
              key={kind}
              type="button"
              className="composer-island-tab"
              data-active={shown === kind ? 'true' : 'false'}
              aria-pressed={shown === kind}
              onClick={() => requestBackgroundJobsTab(sessionId, kind)}
            >
              {label}
            </button>
          )
      )}
      {rows.length === 0 && <span className="session-diff-count">{t('Background tasks')}</span>}
    </span>
  );
  return (
    <section className="session-diff-pane background-jobs-pane" aria-label={t('Background tasks')}>
      <DockHeaderRow className="session-diff-header" ariaLabel={t('Background tasks')} onClose={onClose} left={left} />
      {shownRows.length === 0 ? (
        <p className="utility-dock-empty">{t('No background tasks.')}</p>
      ) : (
        // The Agents sidebar's row styles hang off `.utility-dock
        // .agent-activity-page`: wearing the same two classes keeps these rows
        // pixel-identical to it.
        <div className="utility-dock background-jobs-dock">
          <div className="agent-activity-page">
            <div className="schedules-list" role="tree" aria-label={t('Background tasks')}>
              {shownRows.map((row) =>
                row.kind === 'agent' && row.pool ? (
                  <AgentPoolRow
                    key={row.key}
                    agent={row.pool}
                    clock={clock}
                    stateOverride={row.state}
                    ownerSessionId={sessionId}
                    onOpenSession={onOpenAgentSession}
                  />
                ) : (
                  <ShellJobRow key={row.key} row={row} clock={clock} />
                )
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

import { useCallback, useState } from 'react';
import {
  cwdFolderName,
  shellFinishedLabel,
  shellRowAction,
  type JobRow,
  type ShellStopState,
} from './background-jobs-model';
import { t } from './i18n';
import { MxIcon } from './MxIcon';
import { formatWorkElapsed } from './transcript-primitives';

/** Stop requests per shell row. A row stays "stopping" until the shell-jobs
 *  status lists it as finished (the row then reads Stopped and Dismiss), or
 *  until the request fails, which keeps it running and offers a retry. */
export function useShellStops(sessionId: string) {
  const [stops, setStops] = useState<Record<string, ShellStopState>>({});
  const stopOf = (row: JobRow): ShellStopState => (row.finished ? undefined : stops[row.key]);
  const stop = useCallback(
    async (row: JobRow) => {
      if (!row.taskId) return;
      setStops((current) => ({ ...current, [row.key]: 'stopping' }));
      let stopped = false;
      try {
        stopped = (await window.mixdogDesktop.stopShellJob?.(sessionId, row.taskId))?.stopped === true;
      } catch {
        stopped = false;
      }
      if (!stopped) setStops((current) => ({ ...current, [row.key]: 'failed' }));
    },
    [sessionId]
  );
  return { stopOf, stop };
}

/** A shell row's icon, command, folder (or stop error) and time/status. */
export function ShellJobContent({ row, clock, stop }: { row: JobRow; clock: number; stop: ShellStopState }) {
  const folder = cwdFolderName(row.cwd);
  const elapsed = row.startedAt > 0 ? formatWorkElapsed(clock - row.startedAt) || '0s' : '0s';
  return (
    <>
      <span className="sidebar-resource-icon" aria-hidden="true">
        <MxIcon name="shell-prompt" size={16} />
      </span>
      <span className="schedules-row-copy">
        <span className="agent-pool-heading">
          <b className="agent-pool-name composer-island-shell-command" title={row.label}>
            {row.label}
          </b>
        </span>
        {stop === 'failed' ? (
          <small className="composer-island-row-error" role="alert">
            {t("Island: Couldn't stop")}
          </small>
        ) : folder ? (
          <small title={row.cwd}>{folder}</small>
        ) : null}
      </span>
      <span className="agent-activity-status">
        {row.finished ? (
          <span className="agent-activity-elapsed" data-state="finished">
            {shellFinishedLabel(row)}
          </span>
        ) : (
          // biome-ignore lint/a11y/useAriaPropsSupportedByRole: aria-label on <time> gives the elapsed duration an explicit accessible name
          <time className="agent-activity-elapsed" aria-label={elapsed} data-state="running">
            {elapsed}
          </time>
        )}
      </span>
    </>
  );
}

/** The shell row's trailing button: Stop, Stopping…, Retry, or Dismiss. */
export function ShellRowButton({
  row,
  stop,
  onStop,
  onDismiss,
}: {
  row: JobRow;
  stop: ShellStopState;
  onStop(row: JobRow): void;
  onDismiss(row: JobRow): void;
}) {
  const action = shellRowAction(row, stop);
  const label = {
    stop: t('Stop'),
    stopping: t('Island: Stopping…'),
    retry: t('Retry'),
    dismiss: t('Dismiss'),
  }[action];
  return (
    <button
      type="button"
      className="composer-island-button composer-island-row-dismiss"
      aria-label={action === 'stopping' ? undefined : `${label}: ${row.label}`}
      disabled={action === 'stopping'}
      onClick={() => (action === 'dismiss' ? onDismiss(row) : onStop(row))}
    >
      {label}
    </button>
  );
}

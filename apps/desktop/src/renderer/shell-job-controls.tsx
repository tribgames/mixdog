import { type ReactNode, useCallback, useState } from 'react';
import {
  cwdFolderName,
  shellFinishedLabel,
  shellFinishedOk,
  shellRowAction,
  type JobRow,
  type ShellStopState,
} from './background-jobs-model';
import { confirmText } from './confirm-text';
import { confirmAction } from './app-confirm';
import { t } from './i18n';
import { MxIcon } from './MxIcon';
import { formatWorkElapsed } from './transcript-primitives';

type ShellRequest = { kind: 'stop' | 'release'; state: NonNullable<ShellStopState> };

/** Stop requests per shell row. A row stays "stopping" until the shell-jobs
 *  status lists it as finished (the row then reads Stopped and Dismiss), or
 *  until the request fails, which keeps it running and offers a retry. A row
 *  whose termination is unconfirmed is released instead — only after the
 *  user confirms that its processes may still be running. */
export function useShellStops(sessionId: string) {
  const [stops, setStops] = useState<Record<string, ShellRequest>>({});
  // A pending or failed *stop* is moot once the host reports the row's
  // termination unconfirmed; only a release request keeps that row busy.
  const stopOf = (row: JobRow): ShellStopState => {
    const request = stops[row.key];
    if (row.finished || !request) return undefined;
    if (request.kind === 'stop' && row.terminationUnconfirmed) return undefined;
    return request.state;
  };
  const stop = useCallback(
    async (row: JobRow) => {
      if (!row.taskId) return;
      if (
        row.terminationUnconfirmed &&
        !(await confirmAction(
          t(
            'Release {{command}} anyway? Its processes may still be running; the folder will no longer be protected from them.',
            { command: confirmText(row.label) }
          ),
          { danger: true, confirmLabel: t('Release anyway') }
        ))
      )
        return;
      const kind: ShellRequest['kind'] = row.terminationUnconfirmed ? 'release' : 'stop';
      setStops((current) => ({ ...current, [row.key]: { kind, state: 'stopping' } }));
      let done = false;
      try {
        done =
          kind === 'release'
            ? (await window.mixdogDesktop.releaseShellJob?.(sessionId, row.taskId))?.released === true
            : (await window.mixdogDesktop.stopShellJob?.(sessionId, row.taskId))?.stopped === true;
      } catch {
        done = false;
      }
      if (!done) setStops((current) => ({ ...current, [row.key]: { kind, state: 'failed' } }));
    },
    [sessionId]
  );
  return { stopOf, stop };
}

/** A finished shell's status mark: done (exit 0), cancelled (stopped) or failed. */
function finishedState(row: JobRow): 'done' | 'cancelled' | 'failed' {
  if (row.status === 'cancelled') return 'cancelled';
  return shellFinishedOk(row) ? 'done' : 'failed';
}

/** A shell row's icon, command, folder · elapsed (or stop error) and status. */
export function ShellJobContent({ row, clock, stop }: { row: JobRow; clock: number; stop: ShellStopState }) {
  const folder = cwdFolderName(row.cwd);
  const elapsed = row.startedAt > 0 ? formatWorkElapsed(clock - row.startedAt) || '0s' : '0s';
  let detail: ReactNode = null;
  if (stop === 'failed') {
    detail = (
      <small className="composer-island-row-error" role="alert">
        {row.terminationUnconfirmed ? t("Couldn't release") : t("Island: Couldn't stop")}
      </small>
    );
  } else if (!row.finished) {
    detail = (
      <small title={row.cwd || undefined}>
        {folder ? `${folder} · ` : ''}
        <time className="composer-island-row-elapsed">{elapsed}</time>
      </small>
    );
  } else if (folder) {
    detail = <small title={row.cwd}>{folder}</small>;
  }
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
        {detail}
      </span>
      <span className="agent-activity-status">
        {row.finished ? (
          <span className="agent-activity-elapsed" data-state={finishedState(row)}>
            {shellFinishedLabel(row)}
          </span>
        ) : row.terminationUnconfirmed ? (
          <span
            className="agent-activity-elapsed"
            data-state="unconfirmed"
            title={t('The kill was sent, but not every process is confirmed gone; the folder stays locked.')}
          >
            {t('Termination unconfirmed')}
          </span>
        ) : (
          <span className="agent-activity-elapsed" data-state="running">
            {t('Island: Running')}
          </span>
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
    stopping: row.terminationUnconfirmed ? t('Releasing…') : t('Island: Stopping…'),
    retry: t('Retry'),
    dismiss: t('Dismiss'),
    release: t('Release anyway'),
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

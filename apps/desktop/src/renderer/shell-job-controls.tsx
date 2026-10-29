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

type ShellKind = 'stop' | 'release';
// `held`: the stop was asked of a row already reported unconfirmed (it ends
// the survivors), so it stays visible instead of turning into a release.
type ShellRequest = { kind: ShellKind; state: NonNullable<ShellStopState>; held?: boolean };

/** Stop requests per shell row. A row stays "stopping" until the shell-jobs
 *  status lists it as finished (the row then reads Stopped and Dismiss), or
 *  until the request fails, which keeps it running and offers a retry. A row
 *  whose termination is unconfirmed offers both Stop (ends its surviving
 *  processes) and Release anyway — released only after the user confirms that
 *  its processes may still be running. */
export function useShellStops(sessionId: string) {
  const [stops, setStops] = useState<Record<string, ShellRequest>>({});
  // A pending or failed *stop* is moot once the host reports the row's
  // termination unconfirmed; only a release request, or a stop asked of an
  // already unconfirmed row, keeps that row busy.
  const stopOf = (row: JobRow): ShellStopState => {
    const request = stops[row.key];
    if (row.finished || !request) return undefined;
    if (request.kind === 'stop' && row.terminationUnconfirmed && !request.held) return undefined;
    return request.state;
  };
  // A held row whose release (not a stop) is in flight or failed.
  const releasingOf = (row: JobRow): boolean => row.terminationUnconfirmed === true && stops[row.key]?.kind !== 'stop';
  const stop = useCallback(
    async (row: JobRow, requested?: ShellKind) => {
      if (!row.taskId) return;
      const kind: ShellKind = requested ?? (row.terminationUnconfirmed ? 'release' : 'stop');
      if (
        kind === 'release' &&
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
      const held = kind === 'stop' && row.terminationUnconfirmed === true;
      setStops((current) => ({ ...current, [row.key]: { kind, state: 'stopping', held } }));
      let done = false;
      let unconfirmed = false;
      try {
        if (kind === 'release') {
          done = (await window.mixdogDesktop.releaseShellJob?.(sessionId, row.taskId))?.released === true;
        } else {
          const result = await window.mixdogDesktop.stopShellJob?.(sessionId, row.taskId);
          done = result?.stopped === true;
          unconfirmed = result?.unconfirmed === true;
        }
      } catch {
        done = false;
      }
      // A stop of a held row that is not confirmed fails visibly, so Release
      // anyway stays reachable.
      if (unconfirmed && !held)
        setStops((current) => ({ ...current, [row.key]: { kind, state: 'unconfirmed', held } }));
      else if (!done) setStops((current) => ({ ...current, [row.key]: { kind, state: 'failed', held } }));
    },
    [sessionId]
  );
  return { stopOf, releasingOf, stop };
}

/** A finished shell's status mark: done (exit 0), cancelled (stopped) or failed. */
function finishedState(row: JobRow): 'done' | 'cancelled' | 'failed' {
  if (row.status === 'cancelled') return 'cancelled';
  return shellFinishedOk(row) ? 'done' : 'failed';
}

/** A shell row's icon, command, folder · elapsed (or stop error) and status. */
export function ShellJobContent({
  row,
  clock,
  stop,
  releasing = row.terminationUnconfirmed === true,
}: {
  row: JobRow;
  clock: number;
  stop: ShellStopState;
  releasing?: boolean;
}) {
  const folder = cwdFolderName(row.cwd);
  const elapsed = row.startedAt > 0 ? formatWorkElapsed(clock - row.startedAt) || '0s' : '0s';
  let detail: ReactNode = null;
  if (stop === 'failed') {
    detail = (
      <small className="composer-island-row-error" role="alert">
        {releasing ? t("Couldn't release") : t("Island: Couldn't stop")}
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
        ) : row.terminationUnconfirmed || stop === 'unconfirmed' ? (
          <span
            className="agent-activity-elapsed"
            data-state="unconfirmed"
            title={t('The kill was sent, but not every process is confirmed gone; the folder stays locked.')}
          >
            {t('Termination unconfirmed')}
          </span>
        ) : (
          <time className="agent-activity-elapsed" data-state="running" title={t('Island: Running')}>
            {elapsed}
          </time>
        )}
      </span>
    </>
  );
}

/** The shell row's trailing buttons: Stop, Stopping…, Retry, or Dismiss. A
 *  held row (termination unconfirmed) offers Release anyway and Stop (which
 *  ends its surviving processes); after a failed stop, Retry in place of Stop. */
export function ShellRowButton({
  row,
  stop,
  releasing = row.terminationUnconfirmed === true,
  onStop,
  onDismiss,
}: {
  row: JobRow;
  stop: ShellStopState;
  releasing?: boolean;
  onStop(row: JobRow, kind?: ShellKind): void;
  onDismiss(row: JobRow): void;
}) {
  const action = shellRowAction(row, stop);
  const label = {
    stop: t('Stop'),
    stopping: releasing ? t('Releasing…') : t('Island: Stopping…'),
    retry: t('Retry'),
    dismiss: t('Dismiss'),
    release: t('Release anyway'),
  }[action];
  const held = row.terminationUnconfirmed === true;
  const button = (text: string, onClick: () => void, disabled = false) => (
    <button
      key={text}
      type="button"
      className="composer-island-button composer-island-row-dismiss"
      aria-label={disabled ? undefined : `${text}: ${row.label}`}
      disabled={disabled}
      onClick={onClick}
    >
      {text}
    </button>
  );
  if (action === 'release') {
    return (
      <>
        {button(label, () => onStop(row, 'release'))}
        {button(t('Stop'), () => onStop(row, 'stop'))}
      </>
    );
  }
  if (action === 'retry' && held && !releasing) {
    return (
      <>
        {button(t('Release anyway'), () => onStop(row, 'release'))}
        {button(label, () => onStop(row, 'stop'))}
      </>
    );
  }
  const heldKind: ShellKind = releasing ? 'release' : 'stop';
  return button(
    label,
    () => (action === 'dismiss' ? onDismiss(row) : onStop(row, held ? heldKind : undefined)),
    action === 'stopping'
  );
}

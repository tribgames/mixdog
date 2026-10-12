import { ArrowUpRight, ChevronDown, ChevronLeft, ChevronUp, RefreshCw, Undo2 } from 'lucide-react';
import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { SESSION_DIFF_STYLE_KEY, type Snapshot } from './desktop-types';
import { diffModeActions, useDiffViewState, type DiffViewState } from './diff-header-controls';
import { DockHeaderRow } from './pane-dock-chrome';
import { t } from './i18n';
import { ErrorNotice } from './ErrorNotice';
import { InitialSurface } from './InitialSurface';
import { FileDiffBody } from './inline-diff';
import { buildSessionDiffRows, type SessionDiffRow } from './session-diff-model';
import { useSessionDiffRefresh } from './use-session-diff-refresh';
import { defaultSessionLaneStore, useSessionLane } from './session-lane-store';

function activityKey(snapshot: Snapshot | null): string {
  const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
  const last = items.at(-1);
  return [
    items.length,
    String(last?.id || ''),
    String(last?.completedAt || last?.completedCount || ''),
    snapshot?.busy ? '1' : '0',
    snapshot?.commandBusy ? '1' : '0',
  ].join(':');
}

function sessionDiffSnapshotsEqual(left: Snapshot, right: Snapshot): boolean {
  return activityKey(left) === activityKey(right);
}

/** Every state renders inside the same flex-column frame, so an empty, loading
 *  or failed pane centres its message on both axes exactly like the other
 *  dock panes. */
function SessionDiffFrame({
  children,
  onKeyDown,
}: {
  children: ReactNode;
  onKeyDown?(event: KeyboardEvent<HTMLElement>): void;
}) {
  return (
    <section className="session-diff-pane" aria-label={t('Session diff')} onKeyDown={onKeyDown}>
      {children}
    </section>
  );
}

function pathDirectory(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash >= 0 ? path.slice(0, slash) : '';
}

function pathName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function DiffStats({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="diff-stats">
      <i>+{additions}</i>
      <em>
        {'\u2212'}
        {deletions}
      </em>
    </span>
  );
}

/** The changed-file list: choosing a row drills into that file's diff. */
export function SessionDiffFiles({
  rows,
  onSelect,
}: {
  rows: readonly SessionDiffRow[];
  onSelect(path: string): void;
}) {
  return (
    <ul className="session-diff-files">
      {rows.map((row) => {
        const directory = pathDirectory(row.path);
        return (
          <li key={row.path} className="changes-file">
            <div className="changes-file-row">
              <button type="button" className="changes-file-main" title={row.path} onClick={() => onSelect(row.path)}>
                <span className="session-diff-status" data-status={row.status}>
                  {row.status}
                </span>
                <b>{pathName(row.path)}</b>
                {directory && <span className="changes-file-dir">{directory}</span>}
                <span className="changes-file-stats">
                  <i>+{row.additions}</i>
                  <em>
                    {'\u2212'}
                    {row.deletions}
                  </em>
                </span>
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function SessionDiffPane({
  sessionId,
  active,
  onOpenFile,
  headerControlsExternal,
  viewState,
  onClose,
}: {
  sessionId: string;
  active: boolean;
  /** Closes the host dock; the close button is absent without it. */
  onClose?(): void;
  /** Opens a changed file through the editor's open-file route. */
  onOpenFile?(rel: string): void;
  /** The host mounts `DiffHeaderControls` itself: hide the in-pane header. */
  headerControlsExternal?: boolean;
  /** The host's Unified/Split + filter state (the pane keeps its own otherwise). */
  viewState?: DiffViewState;
}) {
  const ownViewState = useDiffViewState(SESSION_DIFF_STYLE_KEY);
  const { viewMode, onViewModeChange } = viewState ?? ownViewState;
  const lane = useSessionLane(sessionId, defaultSessionLaneStore, sessionDiffSnapshotsEqual, active);
  const revision = activityKey(lane);
  const busy = Boolean(lane?.busy || lane?.commandBusy);
  // A revisited session paints its cached rows instantly while the refresh
  // below revalidates behind them.
  const { result, loading, error, refresh } = useSessionDiffRefresh({
    sessionId,
    active,
    revision,
    busy,
  });
  const rows = useMemo(() => buildSessionDiffRows(result), [result]);
  const additions = rows.reduce((total, row) => total + row.additions, 0);
  const deletions = rows.reduce((total, row) => total + row.deletions, 0);

  // Drill-down: ‹ (or Escape) swaps a file's diff to the list and choosing a
  // file swaps back. The two are never on screen together.
  // `null` = not chosen yet: several changed files open on the list, a single
  // one opens straight on its diff.
  const [listChoice, setListChoice] = useState<boolean | null>(null);
  const listOpen = listChoice ?? rows.length > 1;
  // Latch the choice when the first files arrive: a later file-count change
  // (1→2, 2→1) must not flip a view the user is already looking at.
  useEffect(() => {
    if (listChoice === null && rows.length > 0) setListChoice(rows.length > 1);
  }, [listChoice, rows.length]);
  const [selectedPath, setSelectedPath] = useState('');
  const [revertError, setRevertError] = useState('');
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId is the trigger; a session switch resets the drill-down.
  useEffect(() => {
    setListChoice(null);
    setSelectedPath('');
    setRevertError('');
  }, [sessionId]);
  const foundIndex = rows.findIndex((row) => row.path === selectedPath);
  const index = foundIndex >= 0 ? foundIndex : 0;
  const current: SessionDiffRow | undefined = rows[index];
  const inDiff = Boolean(current) && !listOpen;
  const go = (next: number) => {
    const row = rows[next];
    if (row) setSelectedPath(row.path);
  };
  // The session diff spans turns and has no revert contract: only the latest
  // turn's files can be restored, and only against that turn's checkpoint,
  // exactly like TurnReview. While a turn runs nothing is revertable.
  const [turnReview, setTurnReview] = useState<{ checkpointId: string; paths: ReadonlySet<string> } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision re-reads the turn review after each activity change
  useEffect(() => {
    setTurnReview(null);
    if (!active || !sessionId || busy) return;
    let stale = false;
    void window.mixdogDesktop
      .invokeCapability?.({ capability: 'getTurnReviewDiff', args: [{ summary: true }], sessionId })
      .then((reply) => {
        const value = reply?.value as { checkpointId?: unknown; files?: unknown } | null | undefined;
        const files = Array.isArray(value?.files) ? (value.files as Array<{ path?: unknown }>) : [];
        const checkpointId = typeof value?.checkpointId === 'string' ? value.checkpointId : '';
        if (stale || !checkpointId) return;
        setTurnReview({ checkpointId, paths: new Set(files.map((file) => String(file?.path ?? ''))) });
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [active, sessionId, busy, revision]);
  const canRevert = Boolean(current && !busy && turnReview?.paths.has(current.path));
  const revertCurrent = () => {
    if (!current || !turnReview || !canRevert) return;
    if (
      !window.confirm(t('Revert {{file}} to the start of the turn? This discards its changes.', { file: current.path }))
    )
      return;
    setRevertError('');
    void window.mixdogDesktop
      .invokeCapability?.({
        capability: 'revertTurnReviewFile',
        args: [current.path, turnReview.checkpointId],
        sessionId,
      })
      .then(() => refresh(true))
      .catch((reason: unknown) => setRevertError(reason instanceof Error ? reason.message : String(reason)));
  };

  // The ONE header row renders in every state (no session, loading, error,
  // unsupported, empty, files) so close/expand are always reachable.
  const showCount = Boolean(sessionId) && !error && result?.supported !== false && Boolean(result);
  const left =
    inDiff && current ? (
      <span className="session-diff-summary session-diff-file-head">
        <button
          type="button"
          className="session-diff-back"
          aria-label={t('Back to changed files')}
          data-tooltip={t('Back to changed files')}
          onClick={() => setListChoice(true)}
        >
          <ChevronLeft size={15} aria-hidden="true" />
        </button>
        <span className="session-diff-status" data-status={current.status}>
          {current.status}
        </span>
        <b className="session-diff-path" title={current.path}>
          {pathName(current.path)}
        </b>
        <DiffStats additions={current.additions} deletions={current.deletions} />
      </span>
    ) : (
      <span className="session-diff-summary">
        {showCount && (
          <span className="session-diff-count">
            {rows.length === 1 ? t('1 file changed') : t('{{count}} files changed', { count: rows.length })}
          </span>
        )}
        {showCount && (additions > 0 || deletions > 0) && (
          <span className="diff-stats">
            {additions > 0 && <i>+{additions}</i>}
            {deletions > 0 && (
              <em>
                {'\u2212'}
                {deletions}
              </em>
            )}
          </span>
        )}
      </span>
    );
  const header = !headerControlsExternal && (
    <DockHeaderRow
      className="session-diff-header"
      ariaLabel={t('Changes')}
      onClose={onClose}
      left={left}
      actions={[
        ...(inDiff && current
          ? [
              {
                id: 'revert',
                label: t('Revert {{file}}', { file: current.path }),
                icon: Undo2,
                inline: true,
                disabled: !canRevert,
                onSelect: revertCurrent,
              },
              {
                id: 'previous-file',
                label: t('Previous file'),
                icon: ChevronUp,
                disabled: index <= 0,
                onSelect: () => go(index - 1),
              },
              {
                id: 'next-file',
                label: t('Next file'),
                icon: ChevronDown,
                disabled: index >= rows.length - 1,
                onSelect: () => go(index + 1),
              },
              ...(onOpenFile
                ? [
                    {
                      id: 'open-file',
                      label: t('Open file {{file}}', { file: current.path }),
                      icon: ArrowUpRight,
                      onSelect: () => onOpenFile(current.path),
                    },
                  ]
                : []),
            ]
          : []),
        {
          id: 'refresh',
          label: t('Refresh'),
          icon: RefreshCw,
          disabled: !sessionId || loading,
          onSelect: () => void refresh(true),
        },
        ...diffModeActions(viewMode, onViewModeChange),
      ]}
    />
  );

  if (!sessionId) {
    return (
      <SessionDiffFrame>
        {header}
        <p className="utility-dock-empty">{t('Open a session to view its diff.')}</p>
      </SessionDiffFrame>
    );
  }
  if (loading && !result) {
    return (
      <SessionDiffFrame>
        {header}
        <InitialSurface />
      </SessionDiffFrame>
    );
  }
  if (error) {
    return (
      <SessionDiffFrame>
        {header}
        <ErrorNotice error={error} onRetry={() => void refresh(true)} />
      </SessionDiffFrame>
    );
  }
  if (result?.supported === false) {
    return (
      <SessionDiffFrame>
        {header}
        <p className="utility-dock-empty">{t('Session diff is unavailable.')}</p>
      </SessionDiffFrame>
    );
  }
  return (
    <SessionDiffFrame
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !inDiff || event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        setListChoice(true);
      }}
    >
      {header}
      {result?.patchTruncated && <p className="session-diff-notice">{t('The session diff was truncated.')}</p>}
      {revertError && <p className="session-diff-notice">{revertError}</p>}
      {rows.length === 0 ? (
        <p className="utility-dock-empty">{t('No changes from this session.')}</p>
      ) : inDiff && current ? (
        <div className="session-diff-body">
          <FileDiffBody key={current.path} patch={current.parts.map((part) => part.patch).join('\n')} mode={viewMode} />
        </div>
      ) : (
        <SessionDiffFiles
          rows={rows}
          onSelect={(path) => {
            setSelectedPath(path);
            setListChoice(false);
          }}
        />
      )}
    </SessionDiffFrame>
  );
}

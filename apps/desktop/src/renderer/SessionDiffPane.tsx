import { RefreshCw } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { type DiffStyle, SESSION_DIFF_STYLE_KEY, type Snapshot } from './desktop-types';
import { diffModeActions, useDiffViewState, type DiffViewState } from './diff-header-controls';
import { DockHeaderRow } from './pane-dock-chrome';
import { t } from './i18n';
import { ErrorNotice } from './ErrorNotice';
import { InitialSurface } from './InitialSurface';
import { ChangeFileRow, FileDiffBody } from './inline-diff';
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
 *  dock panes (user: 비어있을때 문구는 상하정렬). */
function SessionDiffFrame({ children }: { children: ReactNode }) {
  return (
    <section className="session-diff-pane" aria-label={t('Session diff')}>
      {children}
    </section>
  );
}

/** More files than this and the list says they start collapsed. */
export const LARGE_DIFF_FILE_COUNT = 20;

/** The expandable file list: each row opens its diff inline below it. */
export function SessionDiffFiles({
  rows,
  mode,
  onOpenFile,
}: {
  rows: readonly SessionDiffRow[];
  mode: DiffStyle;
  onOpenFile?(rel: string): void;
}) {
  const [openPaths, setOpenPaths] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (path: string) =>
    setOpenPaths((current) => {
      const next = new Set(current);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  return (
    <ul className="session-diff-files">
      {rows.map((row) => {
        const open = openPaths.has(row.path);
        return (
          <ChangeFileRow
            key={row.path}
            path={row.path}
            additions={row.additions}
            deletions={row.deletions}
            open={open}
            onToggle={() => toggle(row.path)}
            onOpenFile={onOpenFile && (() => onOpenFile(row.path))}
          >
            {open && <FileDiffBody patch={row.parts.map((part) => part.patch).join('\n')} mode={mode} />}
          </ChangeFileRow>
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

  // The ONE header row renders in every state (no session, loading, error,
  // unsupported, empty, files) so close/expand are always reachable.
  const showCount = Boolean(sessionId) && !error && result?.supported !== false && Boolean(result);
  const header = !headerControlsExternal && (
    <DockHeaderRow
      className="session-diff-header"
      ariaLabel={t('Changes')}
      onClose={onClose}
      left={
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
      }
      actions={[
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
    <SessionDiffFrame>
      {header}
      {result?.patchTruncated && <p className="session-diff-notice">{t('The session diff was truncated.')}</p>}
      {rows.length > LARGE_DIFF_FILE_COUNT && (
        <p className="session-diff-notice" data-kind="collapsed">
          {t('Files are collapsed. Select a file to expand its diff.')}
        </p>
      )}
      {rows.length === 0 ? (
        <p className="utility-dock-empty">{t('No changes from this session.')}</p>
      ) : (
        <SessionDiffFiles rows={rows} mode={viewMode} onOpenFile={onOpenFile} />
      )}
    </SessionDiffFrame>
  );
}

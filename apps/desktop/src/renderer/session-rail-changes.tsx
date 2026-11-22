// The session panel's Changes category: the island's Changes source (the
// files segment's own view) and the actions of its files menu and Git tab.
import { type RefObject, useMemo, useRef, useState } from 'react';
import { useIslandGitStatus } from './IslandGitSegment';
import { t } from './i18n';
import { type IslandGitAction, useIslandGitRequest } from './island-git-request';
import { showDesktopToast } from './notifications';
import { requestOpenDockTab } from './open-dock-tab-event';
import type { DockAction } from './pane-dock-chrome';
import {
  DEFAULT_SESSION_CHANGES_SOURCE,
  SESSION_CHANGES_SOURCES,
  type SessionChangesSource,
  sessionChangesSourceLabel,
  setSessionChangesSource,
  useSessionChangesSource,
} from './session-changes-store';
import { RailList, RailSection } from './session-rail-parts';
import type { TurnReviewSegmentView } from './TurnReview';
import { clearSessionChangeHistory, DeleteHistoryDialog, runningTurnNotice } from './turn-review-files-menu';
import type { TurnReviewFileEntry } from './turn-review-model';
import { errorMessageText } from './ErrorNotice';

export const RAIL_FILE_ROWS = 5;

/** Most changed first; files without line counts keep their order after them. */
export function railChangedFiles(files: ReadonlyMap<string, TurnReviewFileEntry>): [string, TurnReviewFileEntry][] {
  const weight = ([, entry]: [string, TurnReviewFileEntry]) => (entry.additions || 0) + (entry.deletions || 0);
  return [...files.entries()].sort((a, b) => weight(b) - weight(a));
}

/** The "…" menu: the source as radio items, then the files menu's and Git tab's actions. */
export function railChangesMenu({
  source,
  gitReady,
  onSource,
  onViewChanges,
  onGit,
  onSourceControl,
  onDeleteHistory,
}: {
  source: SessionChangesSource;
  gitReady: boolean;
  onSource(source: SessionChangesSource): void;
  onViewChanges?: () => void;
  onGit(action: IslandGitAction): void;
  onSourceControl(): void;
  onDeleteHistory(): void;
}): DockAction[] {
  return [
    ...SESSION_CHANGES_SOURCES.map((value) => ({
      id: `source:${value}`,
      label: sessionChangesSourceLabel(value),
      checked: value === source,
      // The conversation's own sources stand apart from Git's.
      separatorBefore: value === 'branch',
      onSelect: () => onSource(value),
    })),
    {
      id: 'view-changes',
      label: t('Island: View changes'),
      separatorBefore: true,
      disabled: !onViewChanges,
      onSelect: () => onViewChanges?.(),
    },
    { id: 'commit', label: t('Commit'), disabled: !gitReady, onSelect: () => onGit('commit') },
    { id: 'commit-push', label: t('Commit · push'), disabled: !gitReady, onSelect: () => onGit('commit-push') },
    { id: 'pr', label: t('Create PR'), disabled: !gitReady, onSelect: () => onGit('pr') },
    { id: 'source-control', label: t('Island: Source Control'), onSelect: onSourceControl },
    {
      id: 'delete-history',
      label: t('Delete history'),
      separatorBefore: true,
      danger: true,
      onSelect: onDeleteHistory,
    },
  ];
}

function FileRow({ path, entry, onOpen }: { path: string; entry: TurnReviewFileEntry; onOpen?: () => void }) {
  const cut = path.lastIndexOf('/');
  const dir = cut >= 0 ? path.slice(0, cut + 1) : '';
  const name = path.slice(cut + 1);
  return (
    <button type="button" className="session-rail-row" title={path} disabled={!onOpen} onClick={onOpen}>
      {dir && <span className="session-rail-cut session-rail-muted session-rail-dir">{dir}</span>}
      <span className="session-rail-cut session-rail-name">{name}</span>
      <span className="session-rail-grow" />
      {entry.lineStats && (
        <span className="session-rail-num">
          {entry.additions > 0 && <span className="session-rail-add">+{entry.additions}</span>}
          {entry.additions > 0 && entry.deletions > 0 && ' '}
          {entry.deletions > 0 && <span className="session-rail-del">−{entry.deletions}</span>}
        </span>
      )}
    </button>
  );
}

export function ChangesSection({
  view,
  cwd,
  open,
  onToggle,
  onOpenChanges,
  onOpenChangeFile,
}: {
  view: TurnReviewSegmentView;
  /** The session's checkout, for the Git actions. */
  cwd: string;
  open: boolean;
  onToggle(): void;
  onOpenChanges?: () => void;
  onOpenChangeFile?: (path: string) => void;
}) {
  const source = useSessionChangesSource();
  const git = useIslandGitRequest({ sessionId: view.sessionId ?? '', cwd });
  const [confirming, setConfirming] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  // Delete history's dialog hands focus back to the "…" that opened it.
  const menuTrigger = useMemo<RefObject<HTMLElement | null>>(
    () => ({
      get current() {
        return root.current?.querySelector<HTMLElement>('.session-rail-hd .dock-header-more') ?? null;
      },
    }),
    []
  );
  const nonDefault = source !== DEFAULT_SESSION_CHANGES_SOURCE;
  // With nothing changed the island's Git button still stays for commits not
  // yet pushed; the panel keeps the category, and its Git actions, for them.
  const status = useIslandGitStatus(git.ready && view.fileCount === 0 ? cwd : '');
  const ahead = status?.repository ? status.ahead : 0;
  // An empty default source has nothing to show; another source stays so its picker can switch back.
  if (view.fileCount === 0 && !nonDefault && ahead <= 0) return null;
  const files = railChangedFiles(view.files);
  const { additions, deletions, hasLineStats } = view.headlineStats;
  const deleteHistory = async () => {
    try {
      await clearSessionChangeHistory(view.sessionId);
    } catch (reason) {
      showDesktopToast(errorMessageText(reason), 'error');
    }
  };
  return (
    <div ref={root} className="session-rail-sec-host">
      <RailSection
        category="changes"
        title={t('Changes')}
        open={open}
        onToggle={onToggle}
        summary={
          <>
            {nonDefault && (
              <>
                <span>{sessionChangesSourceLabel(source)}</span>
                <span aria-hidden="true">·</span>
              </>
            )}
            <span>{t('{{count}} files', { count: view.fileCount })}</span>
            {hasLineStats && <span className="session-rail-add">+{additions}</span>}
            {hasLineStats && <span className="session-rail-del">−{deletions}</span>}
            {ahead > 0 && <span title={t('{{count}} commits not pushed', { count: ahead })}>↑{ahead}</span>}
          </>
        }
        menu={railChangesMenu({
          source,
          gitReady: git.ready,
          onSource: setSessionChangesSource,
          onViewChanges: onOpenChanges,
          onGit: git.request,
          onSourceControl: () => requestOpenDockTab('source-control'),
          onDeleteHistory: () => {
            // The runtime refuses while a turn runs: say so instead of asking.
            if (view.busy) showDesktopToast(runningTurnNotice().message, 'info');
            else setConfirming(true);
          },
        })}
      >
        {files.length === 0 ? (
          <p className="session-rail-note session-rail-muted">{view.emptyText}</p>
        ) : (
          <RailList
            budget={RAIL_FILE_ROWS}
            rows={files.map(([path, entry]) => (
              <FileRow
                key={path}
                path={path}
                entry={entry}
                onOpen={onOpenChangeFile ? () => onOpenChangeFile(path) : undefined}
              />
            ))}
          />
        )}
      </RailSection>
      {confirming && (
        <DeleteHistoryDialog
          turns={view.historyTurns}
          returnFocus={menuTrigger}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            void deleteHistory();
          }}
        />
      )}
    </div>
  );
}

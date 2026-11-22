// The session panel's Changes category (the island's Changes source: the
// files segment's own view) and its Git category (the island's Git tab).
import { File, Play } from 'lucide-react';
import { GIT_ROWS, useIslandGitStatus } from './IslandGitSegment';
import { t } from './i18n';
import { useIslandGitRequest } from './island-git-request';
import type { DockAction } from './pane-dock-chrome';
import {
  DEFAULT_SESSION_CHANGES_SOURCE,
  SESSION_CHANGES_SOURCES,
  type SessionChangesSource,
  sessionChangesSourceLabel,
  setSessionChangesSource,
  useSessionChangesSource,
} from './session-changes-store';
import { RailSection } from './session-rail-parts';
import type { TurnReviewSegmentView } from './TurnReview';
import type { TurnReviewFileEntry } from './turn-review-model';

/** Most changed first; files without line counts keep their order after them. */
export function railChangedFiles(files: ReadonlyMap<string, TurnReviewFileEntry>): [string, TurnReviewFileEntry][] {
  const weight = ([, entry]: [string, TurnReviewFileEntry]) => (entry.additions || 0) + (entry.deletions || 0);
  return [...files.entries()].sort((a, b) => weight(b) - weight(a));
}

/** The "…" menu: which changes the category lists, as radio items. */
export function railChangesMenu(
  source: SessionChangesSource,
  onSource: (source: SessionChangesSource) => void
): DockAction[] {
  return SESSION_CHANGES_SOURCES.map((value) => ({
    id: `source:${value}`,
    label: sessionChangesSourceLabel(value),
    checked: value === source,
    // The conversation's own sources stand apart from Git's.
    separatorBefore: value === 'branch',
    onSelect: () => onSource(value),
  }));
}

function FileRow({ path, entry, onOpen }: { path: string; entry: TurnReviewFileEntry; onOpen?: () => void }) {
  const cut = path.lastIndexOf('/');
  const dir = cut >= 0 ? path.slice(0, cut + 1) : '';
  const name = path.slice(cut + 1);
  return (
    <button type="button" className="session-rail-row" title={path} disabled={!onOpen} onClick={onOpen}>
      <File size={14} className="session-rail-ic" aria-hidden="true" />
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
  /** The session's checkout: its commits not yet pushed keep the category. */
  cwd: string;
  open: boolean;
  onToggle(): void;
  onOpenChanges?: () => void;
  onOpenChangeFile?: (path: string) => void;
}) {
  const source = useSessionChangesSource();
  const nonDefault = source !== DEFAULT_SESSION_CHANGES_SOURCE;
  const empty = view.fileCount === 0 && !nonDefault;
  const status = useIslandGitStatus(empty ? cwd : '');
  // An empty default source has nothing to show unless the branch is ahead (its picker then
  // reaches the branch's files); another source stays so its picker can switch back.
  if (empty && !(status?.repository && status.ahead > 0)) return null;
  const files = railChangedFiles(view.files);
  const { additions, deletions, hasLineStats } = view.headlineStats;
  return (
    <RailSection
      category="changes"
      title={t('Changes')}
      count={view.fileCount}
      meta={
        <>
          {nonDefault && <span className="session-rail-cut">{sessionChangesSourceLabel(source)}</span>}
          {hasLineStats && <span className="session-rail-add">+{additions}</span>}
          {hasLineStats && <span className="session-rail-del">−{deletions}</span>}
        </>
      }
      open={open}
      onToggle={onToggle}
      scroll
      menu={railChangesMenu(source, setSessionChangesSource)}
      foot={
        onOpenChanges && (
          <span className="session-rail-ft-end">
            <button type="button" className="composer-island-button" onClick={onOpenChanges}>
              {t('Island: View changes')}
            </button>
          </span>
        )
      }
    >
      {files.length === 0 ? (
        <p className="session-rail-note session-rail-muted">{view.emptyText}</p>
      ) : (
        files.map(([path, entry]) => (
          <FileRow
            key={path}
            path={path}
            entry={entry}
            onOpen={onOpenChangeFile ? () => onOpenChangeFile(path) : undefined}
          />
        ))
      )}
    </RailSection>
  );
}

/** The Git category: the island's Git tab, while there is something to commit or push. */
export function GitSection({
  sessionId,
  cwd,
  open,
  onToggle,
}: {
  sessionId: string;
  /** The session's checkout. */
  cwd: string;
  open: boolean;
  onToggle(): void;
}) {
  const { changes, ...git } = useIslandGitRequest({ sessionId, cwd });
  const listed = changes.summary.files.size + changes.untrackedOmitted;
  // A listed file already decides visibility; the open category and an empty list read the
  // working tree itself (the list follows the Changes source, which may show none of it).
  const status = useIslandGitStatus(git.ready && (open || !listed) ? cwd : '');
  const ahead = status?.repository ? status.ahead : 0;
  const files = listed || (status?.repository ? status.files.length : 0);
  if (!git.ready || (files <= 0 && ahead <= 0)) return null;
  return (
    <RailSection
      category="git"
      title={t('Git')}
      meta={
        <span className="session-rail-cut">
          {[status?.branch, t('Files {{count}}', { count: files })].filter(Boolean).join(' · ')}
        </span>
      }
      open={open}
      onToggle={onToggle}
    >
      <div className="composer-island-git-rows">
        {GIT_ROWS.map(({ action, label, icon: Icon }) => (
          <div key={action} className="composer-island-git-row" data-action={action}>
            <span className="composer-island-git-label">
              <Icon size={16} aria-hidden="true" />
              <span>{label()}</span>
            </span>
            <button
              type="button"
              className="composer-island-button composer-island-git-run"
              aria-label={`${t('Run')}: ${label()}`}
              onClick={() => git.request(action)}
            >
              <Play size={12} aria-hidden="true" />
              <span>{t('Run')}</span>
            </button>
          </div>
        ))}
      </div>
    </RailSection>
  );
}

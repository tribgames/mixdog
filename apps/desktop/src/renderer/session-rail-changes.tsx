// The session panel's Changes category (the island's Changes source: the
// files segment's own view) and its Git category (the island's Git tab).
import { Check, File, FileDiff, Play } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { textWidths } from './composer-usage-readout';
import { GIT_ROWS, useIslandGitStatus } from './IslandGitSegment';
import { t } from './i18n';
import { type IslandGitAction, useIslandGitRequest } from './island-git-request';
import {
  DEFAULT_SESSION_CHANGES_SOURCE,
  sessionChangesSourceLabel,
  useSessionChangesSource,
} from './session-changes-store';
import { releasePointerFocus } from './session-rail-folds';
import { RailSection } from './session-rail-parts';
import type { TurnReviewSegmentView } from './TurnReview';
import type { TurnReviewFileEntry } from './turn-review-model';

/** Deterministic path order so mid-turn line-count updates never reshuffle rows. */
export function railChangedFiles(files: ReadonlyMap<string, TurnReviewFileEntry>): [string, TurnReviewFileEntry][] {
  return [...files.entries()].sort(([a], [b]) => {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  });
}

const folderWidth = textWidths();

/** A file's folder and name. The name keeps its room; a folder too long for
 *  what is left gives up whole segments from its start ("…/"), so the nearest
 *  ones, which tell two files of one name apart, stay. */
function FilePath({ dir, name }: { dir: string; name: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(dir);
  // The path fills what its row leaves, whatever it shows: its width is the room, followed as the panel, a list's
  // gutter or the font changes it.
  useLayoutEffect(() => {
    const path = ref.current;
    const nameBox = path?.lastElementChild;
    if (!path || !nameBox || !dir) return undefined;
    const segments = dir.split('/').filter(Boolean);
    const forms = segments.map((_, drop) => (drop ? `…/${segments.slice(drop).join('/')}/` : dir));
    const fit = () => {
      const style = getComputedStyle(path);
      const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const room = path.clientWidth - nameBox.getBoundingClientRect().width;
      setShown(forms.find((form) => folderWidth(font, form) <= room) ?? '…/');
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(path);
    return () => observer.disconnect();
  }, [dir]);
  return (
    <span ref={ref} className="turn-review-files-path">
      {dir && <span className="turn-review-files-dir">{shown}</span>}
      <span className="turn-review-files-name">{name}</span>
    </span>
  );
}

function FileRow({ path, entry, onOpen }: { path: string; entry: TurnReviewFileEntry; onOpen?: () => void }) {
  const cut = path.lastIndexOf('/');
  const dir = cut >= 0 ? path.slice(0, cut + 1) : '';
  const name = path.slice(cut + 1);
  return (
    <button type="button" className="session-rail-row" title={path} disabled={!onOpen} onClick={onOpen}>
      <File size={14} strokeWidth={1.5} className="session-rail-ic session-rail-ic-file" aria-hidden />
      <FilePath dir={dir} name={name} />
      {entry.lineStats && (
        <span className="diff-stats">
          {entry.additions > 0 && <i>+{entry.additions}</i>}
          {entry.additions > 0 && entry.deletions > 0 && ' '}
          {entry.deletions > 0 && <em>−{entry.deletions}</em>}
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
  const fileRows = files.map(([path, entry]) => (
    <FileRow
      key={path}
      path={path}
      entry={entry}
      onOpen={onOpenChangeFile ? () => onOpenChangeFile(path) : undefined}
    />
  ));
  const { additions, deletions, hasLineStats } = view.headlineStats;
  return (
    <RailSection
      category="changes"
      title={t('Changes')}
      // The island's files head: how many files, then the lines added and removed.
      meta={
        <>
          {nonDefault && <span className="session-rail-cut">{sessionChangesSourceLabel(source)}</span>}
          <span>{t('Files {{count}}', { count: view.fileCount })}</span>
          {hasLineStats && <span className="session-rail-add">+{additions}</span>}
          {hasLineStats && <span className="session-rail-del">−{deletions}</span>}
        </>
      }
      open={open}
      onToggle={onToggle}
      scroll
      foot={
        onOpenChanges && (
          <span className="session-rail-ft-end">
            <button type="button" className="composer-island-button" onClick={onOpenChanges}>
              <FileDiff size={14} aria-hidden="true" />
              <span>{t('Island: View changes')}</span>
            </button>
          </span>
        )
      }
    >
      {files.length === 0 ? <p className="session-rail-note session-rail-muted">{view.emptyText}</p> : fileRows}
    </RailSection>
  );
}

const GIT_ACTION_KEY = 'mixdog.desktop.session-rail-git-action.v1';

/** The action picked last, in any panel; Commit until one is picked. */
function pickedGitAction(): IslandGitAction {
  try {
    const stored = window.localStorage.getItem(GIT_ACTION_KEY);
    const row = GIT_ROWS.find(({ action }) => action === stored);
    if (row) return row.action;
  } catch {
    // An unreadable pick is the default one.
  }
  return 'commit';
}

/** The Git category, while there is something to commit or push: the island's Git actions as one choice, and the
 *  Run that carries it out at the head's end. */
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
  const [picked, setPicked] = useState(pickedGitAction);
  if (!git.ready || (files <= 0 && ahead <= 0)) return null;
  const pick = (action: IslandGitAction) => {
    setPicked(action);
    try {
      window.localStorage.setItem(GIT_ACTION_KEY, action);
    } catch {
      // The pick holds for this panel.
    }
  };
  const pickedLabel = GIT_ROWS.find(({ action }) => action === picked)?.label() ?? '';
  return (
    <RailSection
      category="git"
      title={t('Git')}
      // The branch is Info's row: the closed head shows only the commits waiting to be pushed.
      summary={ahead > 0 ? <span className="session-rail-cut">{`↑${ahead}`}</span> : undefined}
      action={
        <button
          type="button"
          className="composer-island-button composer-island-git-run"
          onClick={() => git.request(picked)}
        >
          <Play size={12} aria-hidden="true" />
          <span>{pickedLabel}</span>
        </button>
      }
      open={open}
      onToggle={onToggle}
    >
      <div className="composer-island-git-rows" role="radiogroup" aria-label={t('Git')}>
        {GIT_ROWS.map(({ action, label, icon: Icon }) => (
          // biome-ignore lint/a11y/useSemanticElements: a row that is pressed, with its mark and its check
          <button
            key={action}
            type="button"
            role="radio"
            aria-checked={picked === action}
            className="composer-island-git-row"
            data-action={action}
            onClick={(event) => {
              pick(action);
              releasePointerFocus(event);
            }}
          >
            <span className="composer-island-git-label">
              <Icon size={16} aria-hidden="true" />
              <span>{label()}</span>
            </span>
            {picked === action && <Check size={14} className="session-rail-git-on" aria-hidden="true" />}
          </button>
        ))}
      </div>
    </RailSection>
  );
}

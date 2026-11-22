import { ChevronDown, FileDiff, MoreHorizontal } from 'lucide-react';
import { Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { confirmAction } from './app-confirm';
import { t, uiFormatLocale } from './i18n';
import { isSshConnectionWindow } from './desktop-connection';
import { downloadAndOpenServerFile, revealFileFromWindow } from './server-transfers';
import { useMobileBack } from './mobile-back';
import { useMobileRemoteSurface } from './mobile-surface';
import { DiffBoundary } from './transcript-diff';
import { REVIEW_DIFF_STYLE_KEY } from './desktop-types';
import { DiffView } from './lazy-widgets';
import { ProgressSpinner } from './ProgressSpinner';
import { parseUnifiedDiff } from './renderer-logic.mjs';
import { isRemoteHostRenderer } from './remote-ui-projection';
import { DownloadSessionContext, startProjectFileDownload } from './project-file-download';
import { copyTextToClipboard } from './text-format';
import { createGitRefreshScheduler, watchGitRefreshEvidence } from './git-refresh-scheduler';
import { describeSourceControlError, SourceControlErrorNotice } from './SourceControlErrorNotice';
import { emptyStateHost } from './empty-state-host';

interface GitPanelStatus {
  repository: boolean;
  branch: string;
  ahead: number;
  behind: number;
  upstream: boolean;
  files: Array<{
    path: string;
    index: string;
    worktree: string;
    untracked: boolean;
    additions: number;
    deletions: number;
  }>;
}

function pushLabel(upstream: boolean, ahead: number): string {
  if (!upstream) return t('Publish Branch');
  return `${t('Push')} ${ahead ? `↑${ahead}` : ''}`.trim();
}
export interface GitReviewFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  untracked: boolean;
}
interface GitReviewInfo {
  base: string;
  files: GitReviewFile[];
}
export function GitDiffBody({
  file,
  mode,
  hideHunkHeader,
}: {
  file: ReturnType<typeof parseUnifiedDiff>[number];
  mode?: 'unified' | 'split';
  hideHunkHeader?: boolean;
}) {
  const fallback = <pre className="diff-fallback">{file.patch}</pre>;
  // One data identity per parsed file: the diff library rebuilds and
  // re-highlights EVERY row whenever this object changes, so an inline
  // literal turned each re-render of the host (an `active` flip on the
  // pane dock, a refresh) into a full rebuild — measured at 140–230ms of
  // main-thread time landing on whatever keystroke came next.
  const data = useMemo(
    () => ({ oldFile: file.oldFile, newFile: file.newFile, hunks: [file.renderPatch || file.patch] }),
    [file]
  );
  if (!file.renderable) return fallback;
  return (
    <DiffBoundary fallback={fallback}>
      <Suspense
        fallback={
          <div className="diff-loading" role="status" aria-label={t('Rendering diff…')}>
            <ProgressSpinner size={24} className="desktop-loading-spinner" aria-hidden="true" />
          </div>
        }
      >
        <DiffView data={data} mode={mode} hideHunkHeader={hideHunkHeader} />
      </Suspense>
    </DiffBoundary>
  );
}
// Working-tree file diff (single file): the row already names the file, so
// the body renders hunks only.
// `hideHunkHeader`: the caller already renders the `@@ … @@` header itself
// (the Stage Hunk row), so the diff body must not repeat it.
export function GitFileDiff({
  patch,
  mode,
  hideHunkHeader,
}: {
  patch: string;
  mode?: 'unified' | 'split';
  hideHunkHeader?: boolean;
}) {
  const files = useMemo(() => {
    try {
      return parseUnifiedDiff(patch);
    } catch {
      return [];
    }
  }, [patch]);
  if (!files.length) return <pre className="diff-fallback">{patch}</pre>;
  return (
    <>
      {files.map((file) => (
        <GitDiffBody
          file={file}
          mode={mode}
          hideHunkHeader={hideHunkHeader}
          key={`${file.oldFile.fileName}\n${file.newFile.fileName}`}
        />
      ))}
    </>
  );
}

type DiffState = string | null | { error: string };

function ReviewNotice({ children }: { children: ReactNode }) {
  return (
    <div className="review-pane">
      <p className="review-empty mx-empty-state" ref={emptyStateHost}>
        {children}
      </p>
    </div>
  );
}

function ReviewFileSection({
  file,
  open,
  phone,
  menuOpen,
  patch,
  forced,
  diffStyle,
  onForce,
  onToggle,
  onMenu,
}: {
  file: GitReviewFile;
  open: boolean;
  phone: boolean;
  menuOpen: boolean;
  /** undefined / null: not read yet; a string is the patch; `{ error }` a failed read. */
  patch: DiffState | undefined;
  /** The user chose to render a diff past the size limit. */
  forced: boolean;
  diffStyle: 'unified' | 'split';
  onForce(): void;
  onToggle(path: string, trigger: HTMLElement): void;
  onMenu(file: GitReviewFile, x: number, y: number): void;
}) {
  const slash = file.path.lastIndexOf('/');
  const dir = slash >= 0 ? file.path.slice(0, slash + 1) : '';
  const name = slash >= 0 ? file.path.slice(slash + 1) : file.path;
  const added = file.untracked || file.status === 'A';
  const deleted = file.status === 'D';
  const tooLarge = file.additions + file.deletions > 500 && !forced;
  let fileBody: ReactNode;
  if (tooLarge) {
    fileBody = (
      <div className="review-large-diff">
        <b>{t('Large diff')}</b>
        <span>
          {t('{{count}} changed lines exceed the 500-line render limit.', {
            count: (file.additions + file.deletions).toLocaleString(uiFormatLocale()),
          })}
        </span>
        <button type="button" onClick={onForce}>
          {t('Render anyway')}
        </button>
      </div>
    );
  } else if (patch === undefined || patch === null) {
    fileBody = (
      <p className="review-empty mx-empty-state" ref={emptyStateHost}>
        {t('Loading diff…')}
      </p>
    );
  } else if (typeof patch === 'object') {
    fileBody = (
      <p className="review-empty mx-empty-state" ref={emptyStateHost}>
        {patch.error}
      </p>
    );
  } else if (patch) {
    fileBody = <GitFileDiff patch={patch} mode={diffStyle} />;
  } else {
    fileBody = (
      <p className="review-empty mx-empty-state" ref={emptyStateHost}>
        {t('No textual diff for this file.')}
      </p>
    );
  }
  return (
    <section className="review-file" data-open={open || undefined}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: context-menu shortcut on the header; the trigger button inside carries the keyboard interaction. */}
      <div
        className="review-file-header"
        onContextMenu={(event) => {
          event.preventDefault();
          onMenu(file, event.clientX, event.clientY);
        }}
      >
        <button
          type="button"
          className="review-file-trigger"
          aria-expanded={open}
          onClick={(event) => onToggle(file.path, event.currentTarget)}
        >
          <FileDiff size={14} aria-hidden="true" />
          <span className="review-file-name">
            {dir && <small>{dir}</small>}
            <b>{name}</b>
          </span>
          <span className="review-file-meta">
            {added && (
              <em className="review-change-label" data-type="added">
                {t('Added')}
              </em>
            )}
            {deleted && (
              <em className="review-change-label" data-type="removed">
                {t('Removed')}
              </em>
            )}
            {(file.additions > 0 || file.deletions > 0) && (
              <span className="diff-stats">
                {file.additions > 0 && <i>+{file.additions}</i>}
                {file.deletions > 0 && <em>-{file.deletions}</em>}
              </span>
            )}
          </span>
          <ChevronDown size={14} className="review-chevron" aria-hidden="true" />
        </button>
        {phone && (
          <button
            type="button"
            className="review-file-more"
            aria-label={t('More actions')}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              onMenu(file, box.left, box.bottom);
            }}
          >
            <MoreHorizontal size={16} aria-hidden="true" />
          </button>
        )}
      </div>
      {open && <div className="review-file-body">{fileBody}</div>}
    </section>
  );
}

type ReviewMenu = { x: number; y: number; file: GitReviewFile };

/** The diff layout the reader last chose, kept across sessions. */
function usePersistedDiffStyle() {
  const [diffStyle, setDiffStyle] = useState<'unified' | 'split'>(() => {
    try {
      return window.localStorage.getItem(REVIEW_DIFF_STYLE_KEY) === 'split' ? 'split' : 'unified';
    } catch {
      return 'unified';
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(REVIEW_DIFF_STYLE_KEY, diffStyle);
    } catch {
      /* persistence only */
    }
  }, [diffStyle]);
  return [diffStyle, setDiffStyle] as const;
}

/** An open file menu closes on an outside press or Escape. */
function useReviewMenuDismiss(open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return undefined;
    const onPress = (event: Event) => {
      if (event.target instanceof Element && event.target.closest('.review-context-menu')) return;
      close();
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('pointerdown', onPress, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPress, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, close]);
}

function ReviewFileMenu({
  menu,
  cwd,
  sessionId,
  onClose,
  onRevert,
}: {
  menu: ReviewMenu;
  cwd: string;
  sessionId: string;
  onClose(): void;
  onRevert(file: GitReviewFile): Promise<unknown> | undefined;
}) {
  return (
    <div className="review-context-menu" role="menu" style={{ left: menu.x, top: menu.y }}>
      {isRemoteHostRenderer() ? (
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            onClose();
            void startProjectFileDownload(sessionId, menu.file.path);
          }}
        >
          {t('Download / Share')}
        </button>
      ) : (
        <>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onClose();
              if (isSshConnectionWindow()) void downloadAndOpenServerFile(cwd, menu.file.path);
              else void window.mixdogDesktop.openFilePath?.(cwd, menu.file.path).catch(() => {});
            }}
          >
            {t('Open file')}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onClose();
              void revealFileFromWindow(cwd, menu.file.path).catch(() => {});
            }}
          >
            {t('Reveal in Explorer')}
          </button>
        </>
      )}
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onClose();
          const sep = cwd.includes('\\') ? '\\' : '/';
          void copyTextToClipboard(cwd.replace(/[\\/]+$/, '') + sep + menu.file.path.split('/').join(sep));
        }}
      >
        {t('Copy path')}
      </button>
      <button
        type="button"
        role="menuitem"
        data-danger
        onClick={() => {
          const target = menu.file;
          onClose();
          const warning = target.untracked
            ? t('Delete untracked file "{{file}}"? This cannot be undone.', { file: target.path })
            : t('Discard uncommitted changes to "{{file}}"? This cannot be undone.', { file: target.path });
          void confirmAction(warning, {
            danger: true,
            confirmLabel: target.untracked ? t('Delete file') : t('Revert changes'),
          }).then((approved) => {
            if (!approved) return;
            return onRevert(target);
          });
        }}
      >
        {menu.file.untracked ? t('Delete file') : t('Revert changes')}
      </button>
    </div>
  );
}
export function ReviewPane({ cwd }: { cwd: string | null }) {
  const sessionId = useContext(DownloadSessionContext);
  const [status, setStatus] = useState<GitPanelStatus | null>(null);
  const [review, setReview] = useState<GitReviewInfo | null>(null);
  const [readError, setReadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: cwd is the trigger; switching project clears the stale action error.
  useEffect(() => setActionError(''), [cwd]);
  // Single-open accordion: opening a file closes the rest
  // and snaps the opened card flush under the sticky header.
  const [openFile, setOpenFile] = useState('');
  // Right-click context menu: open / reveal / copy
  // path, plus a confirm-dialog revert.
  const [menu, setMenu] = useState<ReviewMenu | null>(null);
  useReviewMenuDismiss(Boolean(menu), () => setMenu(null));
  // ABB: hardware back closes the menu instead of leaving the PWA.
  useMobileBack(Boolean(menu), () => setMenu(null));
  // A phone has no right-click: each header carries a visible ⋯ that opens the
  // same menu under it, instead of hiding it behind a long-press.
  const phone = useMobileRemoteSurface();
  const openMenu = (file: GitReviewFile, x: number, y: number) =>
    setMenu({ x: Math.min(x, window.innerWidth - 208), y: Math.min(y, window.innerHeight - 168), file });
  const [forced, setForced] = useState<string[]>([]);
  // null = loading; a failed read keeps its message apart from patch text.
  const [diffs, setDiffs] = useState<Record<string, DiffState>>({});
  // No manual refresh control: Git evidence (file and git-dir events, focus)
  // owns freshness, so cached diffs self-invalidate when a file's stats change.
  const reviewRef = useRef<GitReviewInfo | null>(null);
  const [diffStyle, setDiffStyle] = usePersistedDiffStyle();
  const refresh = useCallback(async () => {
    if (!cwd) {
      setStatus(null);
      return;
    }
    if (!window.mixdogDesktop.gitStatus || !window.mixdogDesktop.gitReview) {
      setReadError(t('Review needs an app restart to finish updating.'));
      return;
    }
    try {
      const [next, nextReview] = await Promise.all([
        window.mixdogDesktop.gitStatus(cwd),
        window.mixdogDesktop.gitReview(cwd),
      ]);
      setStatus(next ?? null);
      setReview(nextReview ?? null);
      const prev = reviewRef.current;
      reviewRef.current = nextReview ?? null;
      if (prev && nextReview) {
        const signature = (file: GitReviewFile) => `${file.additions}:${file.deletions}`;
        const before = new Map(prev.files.map((file) => [file.path, signature(file)]));
        setDiffs((current) => {
          let dirty = false;
          const draft = { ...current };
          for (const file of nextReview.files) {
            if (draft[file.path] !== undefined && before.get(file.path) !== signature(file)) {
              delete draft[file.path];
              dirty = true;
            }
          }
          return dirty ? draft : current;
        });
      }
      setReadError('');
    } catch {
      setStatus(null);
      setReadError(t('Review is temporarily unavailable.'));
    }
  }, [cwd]);
  useEffect(() => {
    if (!cwd) return undefined;
    return watchGitRefreshEvidence(cwd, createGitRefreshScheduler(refresh));
  }, [cwd, refresh]);
  // Lazy diff loads for open files that are not cached yet.
  useEffect(() => {
    if (!cwd || !review) return;
    for (const file of review.files) {
      if (file.path !== openFile || diffs[file.path] !== undefined) continue;
      setDiffs((current) => ({ ...current, [file.path]: null }));
      void window.mixdogDesktop
        .gitReviewDiff?.(cwd, file.path, file.untracked)
        .then((patch) => setDiffs((current) => ({ ...current, [file.path]: patch || '' })))
        .catch((reason) =>
          setDiffs((current) => ({
            ...current,
            [file.path]: { error: describeSourceControlError(reason).summary },
          }))
        );
    }
  }, [cwd, review, openFile, diffs]);
  const act = async (action: () => Promise<unknown> | undefined) => {
    setBusy(true);
    setActionError('');
    try {
      await action();
      setDiffs({});
      await refresh();
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  if (!cwd) return <ReviewNotice>{t('Select a project to review changes.')}</ReviewNotice>;
  if (readError) return <ReviewNotice>{readError}</ReviewNotice>;
  if (!status) return <ReviewNotice>{t('Loading review…')}</ReviewNotice>;
  if (!status.repository) return <ReviewNotice>{t('Not a git repository.')}</ReviewNotice>;
  const changed = review?.files ?? [];
  const base = review?.base || 'HEAD';
  const totalAdditions = changed.reduce((sum, file) => sum + (file.additions || 0), 0);
  const totalDeletions = changed.reduce((sum, file) => sum + (file.deletions || 0), 0);
  const showPush = status.ahead > 0 || (!status.upstream && changed.length === 0);
  const toggleFile = (path: string, trigger: HTMLElement) => {
    const opening = openFile !== path;
    setOpenFile(opening ? path : '');
    if (!opening) return;
    // Snap the opened card flush under the sticky header.
    const pane = trigger.closest('.review-scroll');
    const section = trigger.closest('.review-file');
    if (!(pane instanceof HTMLElement) || !(section instanceof HTMLElement)) return;
    requestAnimationFrame(() => {
      pane.scrollTop += section.getBoundingClientRect().top - pane.getBoundingClientRect().top;
    });
  };
  return (
    <div className="review-pane">
      <header className="review-header">
        <div className="review-title">
          <h2>{t('Review')}</h2>
          <span className="review-branch">
            <b>{status.branch}</b>
            {base !== 'HEAD' ? ` → ${base}` : ''}
          </span>
          {(totalAdditions > 0 || totalDeletions > 0) && (
            <span className="diff-stats review-total">
              {totalAdditions > 0 && <i>+{totalAdditions}</i>}
              {totalDeletions > 0 && <em>-{totalDeletions}</em>}
            </span>
          )}
          {status.ahead > 0 && (
            <button
              type="button"
              className="dock-git-sync"
              disabled={busy}
              title={
                status.ahead === 1
                  ? t('Push {{count}} commit', { count: status.ahead })
                  : t('Push {{count}} commits', { count: status.ahead })
              }
              onClick={() => void act(() => window.mixdogDesktop.gitPush?.(cwd))}
            >
              ↑{status.ahead}
            </button>
          )}
        </div>
        <div className="review-actions">
          {changed.length > 0 && (
            <div className="review-style-toggle" role="radiogroup" aria-label={t('Diff style')}>
              <button type="button" aria-pressed={diffStyle === 'unified'} onClick={() => setDiffStyle('unified')}>
                {t('Unified')}
              </button>
              <button type="button" aria-pressed={diffStyle === 'split'} onClick={() => setDiffStyle('split')}>
                {t('Split')}
              </button>
            </div>
          )}
        </div>
      </header>
      {actionError && <SourceControlErrorNotice error={actionError} className="review-git-error" />}
      <div className="review-scroll">
        {changed.length === 0 && (
          <div className="review-empty-state mx-empty-state" ref={emptyStateHost}>
            <p className="review-empty">
              {base === 'HEAD' ? t('Working tree clean.') : t('No changes vs {{base}}.', { base })}
            </p>
            {showPush && (
              <button
                type="button"
                className="dock-git-clean-push"
                disabled={busy}
                onClick={() => void act(() => window.mixdogDesktop.gitPush?.(cwd))}
              >
                {pushLabel(status.upstream, status.ahead)}
              </button>
            )}
          </div>
        )}
        <div className="review-list">
          {changed.map((file) => (
            <ReviewFileSection
              key={file.path}
              file={file}
              open={openFile === file.path}
              phone={phone}
              menuOpen={menu?.file.path === file.path}
              patch={diffs[file.path]}
              forced={forced.includes(file.path)}
              diffStyle={diffStyle}
              onForce={() => setForced((current) => [...current, file.path])}
              onToggle={toggleFile}
              onMenu={openMenu}
            />
          ))}
        </div>
      </div>
      {menu && (
        <ReviewFileMenu
          menu={menu}
          cwd={cwd}
          sessionId={sessionId}
          onClose={() => setMenu(null)}
          onRevert={(target) => {
            if (openFile === target.path) setOpenFile('');
            return act(() => window.mixdogDesktop.gitRevert?.(cwd, target.path, target.untracked, 'all'));
          }}
        />
      )}
    </div>
  );
}

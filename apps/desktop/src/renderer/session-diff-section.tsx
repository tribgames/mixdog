import { ArrowUpRight, ChevronDown, Undo2 } from 'lucide-react';
import { memo, type RefObject, useMemo, useRef } from 'react';
import type { DiffViewState } from './diff-header-controls';
import { t } from './i18n';
import { FileDiffBody } from './inline-diff';
import { sessionDiffRowPlainText, sessionDiffRowTooLarge, type SessionDiffRow } from './session-diff-model';
import { SetiFileIcon } from './SetiFileIcon';
import { fileBaseName } from './text-format';
import { toolActivityCodeLanguage } from './transcript-tool-format';
import { middleTruncatedDirectory } from './turn-changes-model';

/** Added/removed counts; a zero half is left out, as in the turn card. */
export function DiffStats({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="diff-stats">
      {additions > 0 && <i>+{additions}</i>}
      {deletions > 0 && (
        <em>
          {'\u2212'}
          {deletions}
        </em>
      )}
    </span>
  );
}

/** A file's diff under its header: nothing while folded, a note when no diff
 *  was recorded, Codex's "too large" note with Open in editor past the
 *  per-file limits, otherwise the diff itself (plain text past 2,000 changed
 *  lines). A plain render helper (not a component), so the section's element
 *  tree stays as it was. */
function sectionBody(
  row: SessionDiffRow,
  mode: DiffViewState['viewMode'],
  collapsed: boolean,
  whole: boolean,
  onOpenFile: (() => void) | undefined
) {
  if (collapsed) return null;
  if (row.reason) return <p className="inline-diff-empty">{t('No diff was recorded for this file.')}</p>;
  if (sessionDiffRowTooLarge(row)) {
    return (
      <p className="inline-diff-empty session-diff-too-large">
        {t('This file is too large to display here.')}
        {onOpenFile && (
          <>
            {' · '}
            <button
              type="button"
              className="session-diff-open-in-editor"
              disabled={row.status === 'D'}
              onClick={onOpenFile}
            >
              {t('Open in editor')}
            </button>
          </>
        )}
      </p>
    );
  }
  if (row.patchPending) return <p className="inline-diff-empty">{t('Loading diff…')}</p>;
  const failed = row.patchFailed ? (
    <p className="inline-diff-empty">{t('Could not load this diff. Refresh to try again.')}</p>
  ) : null;
  // A newer read that failed keeps the last text readable, with the failure beside it.
  if (failed && row.parts.length === 0) return failed;
  return (
    <>
      {failed}
      <FileDiffBody
        patch={row.parts.map((part) => part.patch).join('\n')}
        mode={mode}
        language={sessionDiffRowPlainText(row) ? '' : toolActivityCodeLanguage(row.path)}
        whole={whole}
      />
    </>
  );
}

/** The file header's and one diff line's height in the dock (27-search-review.css). */
const SECTION_HEAD_PX = 34;
const DIFF_LINE_PX = 19;

/** An unfolded section's height before it first renders: its header plus one
 *  line per patch line (wrapping only adds). */
export function sessionDiffSectionEstimate(row: SessionDiffRow): number {
  let lines = 0;
  for (const part of row.parts) {
    for (let at = part.patch.indexOf('\n'); at !== -1; at = part.patch.indexOf('\n', at + 1)) lines += 1;
    if (part.patch) lines += 1;
  }
  return SECTION_HEAD_PX + Math.max(1, lines) * DIFF_LINE_PX;
}

/** An unfolded file whose body is still the one-line "Loading diff…" note: its
 *  section is about to grow to the whole diff and push every file below it. */
export function sessionDiffBodyPending(row: SessionDiffRow, collapsed: boolean): boolean {
  return !collapsed && !row.reason && !sessionDiffRowTooLarge(row) && row.patchPending === true;
}

/** One changed file: a sticky header (icon, muted middle-truncated directory,
 *  name that opens the file, the collapse chevron right after it, counts, open
 *  and undo) over its diff. Memoized on its row: a stack of hundreds of files
 *  redraws only the files whose row (or patch) moved. */
const SessionDiffSection = memo(function SessionDiffSection({
  row,
  mode,
  collapsed,
  onToggle: toggle,
  canRevert,
  onRevert: revert,
  onOpenFile,
  whole = false,
}: {
  row: SessionDiffRow;
  mode: DiffViewState['viewMode'];
  collapsed: boolean;
  onToggle(path: string): void;
  canRevert: boolean;
  onRevert(path: string): void;
  onOpenFile?(path: string): void;
  /** Draw every recorded line of the diff (the single-file view). */
  whole?: boolean;
}) {
  const onToggle = () => toggle(row.path);
  const onRevert = () => revert(row.path);
  // The off-screen placeholder height (content-visibility, see
  // 27-search-review.css) until the section has rendered once and remembers
  // its own: the header plus one diff line per patch line.
  const estimate = useMemo(() => sessionDiffSectionEstimate(row), [row]);
  // Outside the project only the name shows; the full path stays in the tooltip.
  const directory = row.outside ? '' : middleTruncatedDirectory(row.path);
  const deleted = row.status === 'D';
  const openLabel = deleted ? t('Deleted files cannot be opened') : t('Open file in tab');
  const toggleLabel = collapsed
    ? t('Expand {{label}}', { label: fileBaseName(row.path) })
    : t('Collapse {{label}}', { label: fileBaseName(row.path) });
  return (
    <section
      className="session-diff-section"
      data-session-diff-path={row.path}
      data-status={row.status}
      data-collapsed={collapsed ? 'true' : undefined}
      style={collapsed ? undefined : { containIntrinsicBlockSize: `auto ${estimate}px` }}
    >
      {/* A file's own tab names the file in its toolbar row instead. */}
      {!whole && (
        <header className="session-diff-section-head">
          {/* The whole row (icon, folder, name, chevron, counts) opens and
            closes the file's diff; only open and undo act on their own. */}
          <button
            type="button"
            className="session-diff-collapse session-diff-section-title"
            title={row.path}
            aria-label={toggleLabel}
            aria-expanded={!collapsed}
            onClick={onToggle}
          >
            <SetiFileIcon name={fileBaseName(row.path)} className="session-diff-row-icon" />
            {directory && <span className="session-diff-row-dir">{directory}/</span>}
            <span className="session-diff-row-name">{fileBaseName(row.path)}</span>
            <ChevronDown size={14} className="session-diff-collapse-chevron" aria-hidden="true" />
            <DiffStats additions={row.additions} deletions={row.deletions} />
          </button>
          <span className="session-diff-section-actions">
            {onOpenFile && (
              <button
                type="button"
                className="browser-pane-nav-button session-diff-open"
                aria-label={openLabel}
                data-tooltip={openLabel}
                disabled={deleted}
                onClick={() => onOpenFile(row.path)}
              >
                <ArrowUpRight size={14} aria-hidden="true" />
              </button>
            )}
            <button
              type="button"
              className="browser-pane-nav-button"
              aria-label={t('Revert {{file}}', { file: row.path })}
              data-tooltip={t('Revert {{file}}', { file: row.path })}
              disabled={!canRevert}
              onClick={onRevert}
            >
              <Undo2 size={14} aria-hidden="true" />
            </button>
          </span>
        </header>
      )}
      {sectionBody(row, mode, collapsed, whole, onOpenFile && (() => onOpenFile(row.path)))}
    </section>
  );
});

/** Every visible file is one section of a single scroll; the selected file
 *  tab draws its one file whole and never folded. */
export function SessionDiffStack({
  stackRef,
  rows,
  focusRow,
  mode,
  collapsed,
  onToggle,
  canRevertPath,
  onRevert,
  onOpenFile,
}: {
  stackRef: RefObject<HTMLDivElement | null>;
  rows: readonly SessionDiffRow[];
  focusRow: SessionDiffRow | null;
  mode: DiffViewState['viewMode'];
  /** Folded files (a capped set folds every file but the selected one). */
  collapsed: ReadonlySet<string>;
  onToggle(path: string): void;
  canRevertPath(path: string): boolean;
  onRevert(path: string): void;
  onOpenFile?(path: string): void;
}) {
  // The pane rebuilds its callbacks every render; the sections get stable
  // ones that call the latest, so an unchanged section skips its redraw.
  const latest = useRef({ onToggle, onRevert, onOpenFile });
  latest.current = { onToggle, onRevert, onOpenFile };
  const handlers = useMemo(
    () => ({
      toggle: (path: string) => latest.current.onToggle(path),
      revert: (path: string) => latest.current.onRevert(path),
      openFile: (path: string) => latest.current.onOpenFile?.(path),
    }),
    []
  );
  return (
    <div className="session-diff-stack" ref={stackRef}>
      {rows.map((row) => (
        <SessionDiffSection
          key={row.id}
          row={row}
          mode={mode}
          whole={row === focusRow}
          collapsed={row !== focusRow && collapsed.has(row.path)}
          onToggle={handlers.toggle}
          canRevert={canRevertPath(row.path)}
          onRevert={handlers.revert}
          onOpenFile={onOpenFile ? handlers.openFile : undefined}
        />
      ))}
    </div>
  );
}

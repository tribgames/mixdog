import { ArrowUpRight, ChevronDown, Undo2 } from 'lucide-react';
import type { RefObject } from 'react';
import type { DiffViewState } from './diff-header-controls';
import { t } from './i18n';
import { FileDiffBody } from './inline-diff';
import type { SessionDiffRow } from './session-diff-model';
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

/** A file's diff under its header: nothing while folded, a note when no
 *  diff was recorded, otherwise the diff itself. A plain render helper (not a
 *  component), so the section's element tree stays as it was. */
function sectionBody(row: SessionDiffRow, mode: DiffViewState['viewMode'], collapsed: boolean, whole: boolean) {
  if (collapsed) return null;
  if (row.reason) return <p className="inline-diff-empty">{t('No diff was recorded for this file.')}</p>;
  return (
    <FileDiffBody
      patch={row.parts.map((part) => part.patch).join('\n')}
      mode={mode}
      language={toolActivityCodeLanguage(row.path)}
      whole={whole}
    />
  );
}

/** One changed file: a sticky header (icon, muted middle-truncated directory,
 *  name that opens the file, the collapse chevron right after it, counts, open
 *  and undo) over its diff. */
function SessionDiffSection({
  row,
  mode,
  collapsed,
  onToggle,
  canRevert,
  onRevert,
  onOpenFile,
  whole = false,
}: {
  row: SessionDiffRow;
  mode: DiffViewState['viewMode'];
  collapsed: boolean;
  onToggle(): void;
  canRevert: boolean;
  onRevert(): void;
  onOpenFile?(path: string): void;
  /** Draw every recorded line of the diff (the single-file view). */
  whole?: boolean;
}) {
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
      {sectionBody(row, mode, collapsed, whole)}
    </section>
  );
}

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
  collapsed: ReadonlySet<string>;
  onToggle(path: string): void;
  canRevertPath(path: string): boolean;
  onRevert(path: string): void;
  onOpenFile?(path: string): void;
}) {
  return (
    <div className="session-diff-stack" ref={stackRef}>
      {rows.map((row) => (
        <SessionDiffSection
          key={row.id}
          row={row}
          mode={mode}
          whole={row === focusRow}
          collapsed={row !== focusRow && collapsed.has(row.path)}
          onToggle={() => onToggle(row.path)}
          canRevert={canRevertPath(row.path)}
          onRevert={() => onRevert(row.path)}
          onOpenFile={onOpenFile}
        />
      ))}
    </div>
  );
}

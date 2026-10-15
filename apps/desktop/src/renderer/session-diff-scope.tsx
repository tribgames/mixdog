import { ArrowUpRight, Undo2 } from 'lucide-react';
import { t } from './i18n';
import type { SessionDiffRow } from './session-diff-model';
import { DiffStats } from './session-diff-section';
import { SetiFileIcon } from './SetiFileIcon';
import { fileBaseName } from './text-format';
import { middleTruncatedDirectory } from './turn-changes-model';

/** A path outside the workspace (drive letter or leading slash) shows its
 *  name only, like an outside-the-project row. */
function isAbsoluteChangePath(path: string): boolean {
  return /^(?:[A-Za-z]:)?[\\/]/.test(path);
}

/** The file still being read for the request that opened the pane. */
function PendingFileScope({ path }: { path: string }) {
  const directory = isAbsoluteChangePath(path) ? '' : middleTruncatedDirectory(path);
  return (
    <span className="session-diff-summary session-diff-scope session-diff-file-scope" title={path}>
      <SetiFileIcon name={fileBaseName(path)} className="session-diff-row-icon" />
      {directory && <span className="session-diff-row-dir">{directory}/</span>}
      <span className="session-diff-count">{fileBaseName(path)}</span>
    </span>
  );
}

/** A file's tab names that file (folder, name, counts) with its open and undo. */
function FocusFileScope({
  row,
  onOpenFile,
  canRevert,
  onRevert,
}: {
  row: SessionDiffRow;
  onOpenFile?(path: string): void;
  canRevert: boolean;
  onRevert(): void;
}) {
  const directory = row.outside ? '' : middleTruncatedDirectory(row.path);
  const deleted = row.status === 'D';
  const openLabel = deleted ? t('Deleted files cannot be opened') : t('Open file in tab');
  return (
    <>
      <span className="session-diff-summary session-diff-scope session-diff-file-scope" title={row.path}>
        <SetiFileIcon name={fileBaseName(row.path)} className="session-diff-row-icon" />
        {directory && <span className="session-diff-row-dir">{directory}/</span>}
        <span className="session-diff-count">{fileBaseName(row.path)}</span>
        <DiffStats additions={row.additions} deletions={row.deletions} />
      </span>
      {onOpenFile && (
        <button
          type="button"
          className="browser-pane-nav-button session-diff-open"
          aria-label={openLabel}
          data-tooltip={openLabel}
          disabled={deleted}
          onClick={() => onOpenFile(row.path)}
        >
          <ArrowUpRight size={15} aria-hidden="true" />
        </button>
      )}
      <button
        type="button"
        className="browser-pane-nav-button session-diff-revert"
        aria-label={t('Revert {{file}}', { file: row.path })}
        data-tooltip={t('Revert {{file}}', { file: row.path })}
        disabled={!canRevert}
        onClick={onRevert}
      >
        <Undo2 size={15} aria-hidden="true" />
      </button>
    </>
  );
}

/** The Changes tab sums every file in the composer chip's short form
 *  ("Files 3 +12 −4"). A narrow pane beside the source picker drops the
 *  count (27-search-review.css) rather than clip it; the tooltip keeps it. */
function ChangesScope({ rows, showCount }: { rows: readonly SessionDiffRow[]; showCount: boolean }) {
  const additions = rows.reduce((total, row) => total + row.additions, 0);
  const deletions = rows.reduce((total, row) => total + row.deletions, 0);
  const count = rows.length === 1 ? t('1 file changed') : t('{{count}} files changed', { count: rows.length });
  return (
    <span className="session-diff-summary session-diff-scope" title={showCount ? count : undefined}>
      {showCount && <span className="session-diff-count">{t('Files {{count}}', { count: rows.length })}</span>}
      {showCount && <DiffStats additions={additions} deletions={deletions} />}
    </span>
  );
}

/** Row 2 belongs to the selected tab: the file being read, the selected
 *  file, or every file's totals. */
export function SessionDiffScope({
  pendingPath,
  focusRow,
  rows,
  showCount,
  onOpenFile,
  canRevertPath,
  onRevert,
}: {
  pendingPath: string;
  focusRow: SessionDiffRow | null;
  rows: readonly SessionDiffRow[];
  showCount: boolean;
  onOpenFile?(path: string): void;
  canRevertPath(path: string): boolean;
  onRevert(path: string): void;
}) {
  if (pendingPath) return <PendingFileScope path={pendingPath} />;
  if (focusRow) {
    return (
      <FocusFileScope
        row={focusRow}
        onOpenFile={onOpenFile}
        canRevert={canRevertPath(focusRow.path)}
        onRevert={() => onRevert(focusRow.path)}
      />
    );
  }
  return <ChangesScope rows={rows} showCount={showCount} />;
}

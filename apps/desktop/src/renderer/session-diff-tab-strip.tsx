import { FileDiff, FileText, X } from 'lucide-react';
import { t } from './i18n';
import { fileBaseName } from './text-format';
import type { SessionDiffFileTabs } from './use-session-diff-tabs';

/** A file tab of the strip: the file it names, by an id of its own (a diff row is one). */
export type SessionDiffTab = { id: string; path: string };

/** One tab strip, like the browser's and terminal's: "Changes" (every file)
 *  is always a tab of it, never a header title, and file tabs sit beside it. */
export function SessionDiffTabStrip({
  pendingPath,
  showChanges,
  focusRow,
  tabRows,
  fileTabs,
  onShowAllFiles,
  onCloseChanges,
  onOpenDiffTab,
  onCloseDiffTab,
}: {
  /** The file being read for the request that opened the pane ('' = none). */
  pendingPath: string;
  showChanges: boolean;
  /** The selected file tab; null: Changes (or the pending file) is selected. */
  focusRow: SessionDiffTab | null;
  tabRows: readonly SessionDiffTab[];
  fileTabs?: SessionDiffFileTabs;
  onShowAllFiles(): void;
  onCloseChanges(): void;
  onOpenDiffTab(path: string): void;
  onCloseDiffTab(path: string): void;
}) {
  return (
    // While a file is read the list is busy: its placeholder cell is not a
    // tab, so assistive technology hears the loading state, not a dead tab.
    <div
      className="browser-tab-list session-diff-tabs"
      role="tablist"
      aria-label={t('Files')}
      aria-busy={pendingPath ? true : undefined}
    >
      {pendingPath && (
        <div
          className="browser-tab is-active"
          data-session-diff-tab={pendingPath}
          data-pending="true"
          aria-hidden="true"
        >
          <span className="browser-tab-select" title={pendingPath}>
            <FileDiff size={14} aria-hidden="true" />
            <span>{fileBaseName(pendingPath)}</span>
          </span>
        </div>
      )}
      {showChanges && (
        <div className={`browser-tab${focusRow ? '' : ' is-active'}`} data-session-diff-changes-tab="">
          <button
            type="button"
            role="tab"
            aria-selected={!focusRow}
            className="browser-tab-select"
            title={t('Changes')}
            onClick={onShowAllFiles}
          >
            <FileDiff size={14} aria-hidden="true" />
            <span>{t('Changes')}</span>
          </button>
          <button
            type="button"
            className="browser-tab-close"
            aria-label={`${t('Close tab')}: ${t('Changes')}`}
            onClick={onCloseChanges}
          >
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      )}
      {tabRows.map((row) => (
        <div
          key={row.id}
          className={`browser-tab${row.id === focusRow?.id ? ' is-active' : ''}`}
          data-session-diff-tab={row.path}
        >
          <button
            type="button"
            role="tab"
            aria-selected={row.id === focusRow?.id}
            className="browser-tab-select"
            title={row.path}
            onClick={() => onOpenDiffTab(row.path)}
          >
            <FileDiff size={14} aria-hidden="true" />
            <span>{fileBaseName(row.path)}</span>
          </button>
          <button
            type="button"
            className="browser-tab-close"
            aria-label={`${t('Close tab')}: ${fileBaseName(row.path)}`}
            onClick={() => onCloseDiffTab(row.path)}
          >
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      ))}
      {fileTabs?.tabs.map((tab) => (
        <div key={tab.key} className="browser-tab" data-session-diff-file-tab={tab.key}>
          <button
            type="button"
            role="tab"
            aria-selected="false"
            className="browser-tab-select"
            title={tab.title}
            onClick={() => fileTabs?.onSelect(tab.key)}
          >
            <FileText size={15} aria-hidden="true" />
            <span>{tab.name}</span>
          </button>
          <button
            type="button"
            className="browser-tab-close"
            aria-label={`${t('Close tab')}: ${tab.name}`}
            onClick={() => fileTabs?.onClose(tab.key)}
          >
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}

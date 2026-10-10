import { Search, X } from 'lucide-react';
import { memo, useState } from 'react';
import type { DesktopGitStatus } from '../shared/contract';
import { ErrorNotice } from './ErrorNotice';
import { FilesRootPane, SetiFileIcon } from './ExplorerTree';
import { t } from './i18n';
import { scheduleEditorPanePrefetch } from './lazy-widgets';
import { useWorkspaceSearch, type SearchContentResults, type SearchNameResults } from './use-workspace-search';

const EMPTY_CHANGED_FILES = new Set<string>();
const ignoreFilesReadyChange = () => {};

/** File name and parent folder of a project-relative result path. */
function splitRelPath(relPath: string): { name: string; parent: string } {
  const normalized = relPath.replace(/\\/g, '/');
  const split = normalized.lastIndexOf('/');
  return split >= 0
    ? { name: normalized.slice(split + 1), parent: normalized.slice(0, split) }
    : { name: normalized, parent: '' };
}

function SearchNameResultList({
  results,
  onOpenFile,
}: {
  results: SearchNameResults;
  onOpenFile?(project: string, rel: string, mode?: 'preview' | 'pinned'): void;
}) {
  const totalNameHits = results.reduce((sum, result) => sum + result.paths.length, 0);
  if (totalNameHits === 0) return <p className="utility-dock-empty">{t('No matching files.')}</p>;
  return (
    <div className="workbench-search-results" role="tree" aria-label={t('File name results')}>
      <p className="workbench-search-summary">
        {totalNameHits === 1 ? t('1 file') : t('{{count}} files', { count: totalNameHits })}
      </p>
      {results.flatMap(({ project, paths }) =>
        paths.map((relPath) => {
          const { name, parent } = splitRelPath(relPath);
          return (
            <button
              type="button"
              role="treeitem"
              className="workbench-search-name-row"
              key={`${project}:${relPath}`}
              onPointerEnter={scheduleEditorPanePrefetch}
              onFocus={scheduleEditorPanePrefetch}
              onClick={() => onOpenFile?.(project, relPath, 'preview')}
            >
              <SetiFileIcon name={name} />
              <b>{name}</b>
              <small>{parent}</small>
            </button>
          );
        })
      )}
    </div>
  );
}

function SearchContentResultList({
  results,
  onOpenFile,
  onOpenFileAt,
}: {
  results: SearchContentResults;
  onOpenFile?(project: string, rel: string, mode?: 'preview' | 'pinned'): void;
  onOpenFileAt?(project: string, rel: string, line?: number): void;
}) {
  const totalMatches = results.reduce((sum, result) => sum + result.matchCount, 0);
  if (results.length === 0) return <p className="utility-dock-empty">{t('No results found.')}</p>;
  return (
    <div className="workbench-search-results" role="tree" aria-label={t('Search results')}>
      <p className="workbench-search-summary">
        {totalMatches === 1 ? t('1 result') : t('{{count}} results', { count: totalMatches })}
      </p>
      {results.flatMap(({ project, files, limitHit }) =>
        files.map((file) => {
          const { name, parent } = splitRelPath(file.relPath);
          return (
            <details open className="workbench-search-file" key={`${project}:${file.relPath}`}>
              <summary>
                <SetiFileIcon name={name} />
                <b>{name}</b>
                <small>{parent}</small>
                <i>{file.matches.length}</i>
              </summary>
              {file.matches.map((match, index) => (
                <button
                  type="button"
                  role="treeitem"
                  // biome-ignore lint/suspicious/noArrayIndexKey: match list is positional and never reorders; index disambiguates identical line:column
                  key={`${match.line}:${match.column}:${index}`}
                  onPointerEnter={scheduleEditorPanePrefetch}
                  onFocus={scheduleEditorPanePrefetch}
                  onClick={() =>
                    onOpenFileAt
                      ? onOpenFileAt(project, file.relPath, match.line)
                      : onOpenFile?.(project, file.relPath, 'preview')
                  }
                >
                  <span>{match.line}</span>
                  <code>{match.preview || match.matchText}</code>
                </button>
              ))}
              {limitHit && <p className="utility-dock-empty">{t('Result limit reached.')}</p>}
            </details>
          );
        })
      )}
    </div>
  );
}

/** Dock Search view: name/contents search over the project, or its file tree when idle. */
export const SearchPane = memo(function SearchPane({
  projectPath,
  gitStatus,
  active,
  activeFileKey = '',
  onOpenFile,
  onOpenFileAt,
  onRenameEntry,
  headerActionSlot = null,
}: {
  projectPath: string;
  gitStatus: DesktopGitStatus | null;
  active: boolean;
  /** The editor tab the tree reveals (`file:<project>:<rel>`). */
  activeFileKey?: string;
  onOpenFile?(project: string, rel: string, mode?: 'preview' | 'pinned'): void;
  onOpenFileAt?(project: string, rel: string, line?: number): void;
  onRenameEntry?(projectPath: string, relPath: string, newName: string): Promise<void>;
  /** The panel title row's action slot. With it, the tree's actions ride the
   *  title row and the Names/Contents tabs keep the full width in both modes
   *  — sharing their row, the tabs narrowed only while the tree showed (user:
   *  이름 내용이 좌우로 전체 차지하게 해야지). */
  headerActionSlot?: HTMLElement | null;
}) {
  // The tree's New File / New Folder / Refresh / Collapse All actions portal
  // into the title row, or into the mode row where no title row is shown.
  const [explorerActions, setExplorerActions] = useState<HTMLDivElement | null>(null);
  const {
    folders,
    query,
    setQuery,
    searchMode,
    setSearchMode,
    searchInputRef,
    nameResults,
    contentResults,
    searchLoading,
    searchError,
  } = useWorkspaceSearch(projectPath, active);
  const searching = Boolean(query.trim());
  const contentsMode = searchMode === 'contents';
  const renderBody = () => {
    if (searching) {
      if (searchLoading) return <p className="utility-dock-empty">{t('Searching…')}</p>;
      if (searchError) return <ErrorNotice error={searchError} role="status" />;
      return contentsMode ? (
        <SearchContentResultList results={contentResults} onOpenFile={onOpenFile} onOpenFileAt={onOpenFileAt} />
      ) : (
        <SearchNameResultList results={nameResults} onOpenFile={onOpenFile} />
      );
    }
    if (contentsMode) {
      return (
        <p className="utility-dock-empty">
          {folders.length === 0 ? t('Open a project to search files.') : t('Search project files by name or contents.')}
        </p>
      );
    }
    if (folders.length === 0) return <p className="utility-dock-empty">{t('Open a project to browse its files.')}</p>;
    return (
      <FilesRootPane
        projectPath={projectPath}
        gitStatus={gitStatus}
        changed={EMPTY_CHANGED_FILES}
        activeFileKey={activeFileKey}
        active={active}
        readinessKey={`search-files:${projectPath}`}
        onReadyChange={ignoreFilesReadyChange}
        onOpenFile={onOpenFile}
        onRenameEntry={onRenameEntry}
        headerSlot={headerActionSlot ?? explorerActions}
      />
    );
  };
  return (
    <div className="workbench-explorer">
      {/* Workspace open/add/save toolbar removed on purpose: Mixdog exposes
        ONE Project concept — no multi-root workspace UI (user:
        Project 개념만 있고 워크트리 격리가 없는데 혼용돼 헷갈린다). */}
      <div className="workbench-explorer-search">
        <label className="workbench-search-input">
          <Search size={14} aria-hidden="true" />
          <input
            ref={searchInputRef}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder={contentsMode ? t('Search text') : t('Search files')}
            aria-label={contentsMode ? t('Search text in project files') : t('Search project files by name')}
          />
          {query && (
            <button type="button" aria-label={t('Clear search')} onClick={() => setQuery('')}>
              <X size={14} aria-hidden="true" />
            </button>
          )}
        </label>
        <div className="workbench-search-mode-row">
          <div className="workbench-search-mode" role="tablist" aria-label={t('Search mode')}>
            <button type="button" role="tab" aria-selected={!contentsMode} onClick={() => setSearchMode('names')}>
              {t('Names')}
            </button>
            <button type="button" role="tab" aria-selected={contentsMode} onClick={() => setSearchMode('contents')}>
              {t('Contents')}
            </button>
          </div>
          {!headerActionSlot && <div className="workbench-explorer-actions" ref={setExplorerActions} />}
        </div>
      </div>
      {renderBody()}
    </div>
  );
});

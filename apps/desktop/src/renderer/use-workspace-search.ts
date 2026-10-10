import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  DesktopWorkspaceFolder,
  DesktopWorkspaceTextFileResult,
  DesktopWorkspaceTextSearchOptions,
} from '../shared/contract';
import { useSurfaceNavigationReset } from './surface-activity';

export type SearchNameResults = Array<{ project: string; paths: string[] }>;
export type SearchContentResults = Array<{
  project: string;
  files: DesktopWorkspaceTextFileResult[];
  matchCount: number;
  limitHit: boolean;
}>;

/** Dock Search state: query/mode, debounced name and full-text lookups with a
 *  generation guard, and the Ctrl+Shift+F focus request. */
export function useWorkspaceSearch(projectPath: string, active: boolean) {
  const folders = useMemo<DesktopWorkspaceFolder[]>(() => (projectPath ? [{ path: projectPath }] : []), [projectPath]);
  // Names filters paths; Contents runs full-text search with the same field.
  const [query, setQuery] = useState('');
  const [searchMode, setSearchMode] = useState<'names' | 'contents'>('names');
  useSurfaceNavigationReset(active, () => setSearchMode('names'));
  const [nameResults, setNameResults] = useState<SearchNameResults>([]);
  const [contentResults, setContentResults] = useState<SearchContentResults>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState('');
  const searchGeneration = useRef(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchProjects = useMemo(() => folders.map((folder) => folder.path), [folders]);
  const searchProjectsKey = searchProjects.join('\u0000');
  const searchOptions = useMemo<DesktopWorkspaceTextSearchOptions>(
    () => ({
      query: query.trim(),
      maxResults: 2_000,
    }),
    [query]
  );
  // Ctrl+Shift+F lands here: switch to Contents and focus the field.
  useEffect(() => {
    const focusSearch = () => {
      setSearchMode('contents');
      window.requestAnimationFrame(() => {
        const input = searchInputRef.current;
        if (input && !input.closest('[inert]')) {
          input.focus({ preventScroll: true });
          input.select();
        }
      });
    };
    window.addEventListener('mixdog:focus-dock-search', focusSearch);
    return () => window.removeEventListener('mixdog:focus-dock-search', focusSearch);
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: searchProjectsKey is the content signature of searchProjects, so equal folder lists do not restart the search
  useEffect(() => {
    const current = ++searchGeneration.current;
    const trimmed = query.trim();
    if (!active || !trimmed || searchProjects.length === 0) {
      setNameResults([]);
      setContentResults([]);
      setSearchLoading(false);
      setSearchError('');
      return undefined;
    }
    setSearchLoading(true);
    setSearchError('');
    const timer = window.setTimeout(() => {
      if (searchMode === 'names') {
        void Promise.allSettled(
          searchProjects.map(async (project) => ({
            project,
            paths: await window.mixdogDesktop.searchProjectFiles(project, trimmed, 200),
          }))
        ).then((settled) => {
          if (searchGeneration.current !== current) return;
          setNameResults(settled.flatMap((result) => (result.status === 'fulfilled' ? result.value : [])));
          setSearchLoading(false);
        });
        return;
      }
      void Promise.allSettled(
        searchProjects.map(async (project) => {
          if (window.mixdogDesktop.searchWorkspaceText) {
            return { project, ...(await window.mixdogDesktop.searchWorkspaceText(project, searchOptions)) };
          }
          const paths = await window.mixdogDesktop.searchProjectFiles(project, trimmed, 200);
          return {
            project,
            matchCount: paths.length,
            limitHit: false,
            files: paths.map((relPath) => ({
              relPath,
              matches: [{ line: 1, column: 1, endColumn: 1, preview: relPath, matchText: '' }],
            })),
          };
        })
      )
        .then((settled) => {
          if (searchGeneration.current !== current) return;
          const rows = settled.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
          if (!rows.length && settled.every((result) => result.status === 'rejected')) {
            const rejected = settled.find((result) => result.status === 'rejected');
            throw rejected && rejected.status === 'rejected' ? rejected.reason : new Error('Search failed.');
          }
          setContentResults(rows);
          setSearchLoading(false);
        })
        .catch((reason) => {
          if (searchGeneration.current !== current) return;
          setContentResults([]);
          setSearchLoading(false);
          setSearchError(reason instanceof Error ? reason.message : String(reason));
        });
    }, 90);
    return () => window.clearTimeout(timer);
  }, [active, query, searchMode, searchOptions, searchProjects, searchProjectsKey]);
  return {
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
  };
}

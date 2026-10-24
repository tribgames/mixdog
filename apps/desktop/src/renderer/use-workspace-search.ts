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

/** One finished search: the query and mode it answered, and what it found. */
export interface SettledSearch {
  /** The projects it searched. */
  projects: string;
  query: string;
  mode: 'names' | 'contents';
  names: SearchNameResults;
  contents: SearchContentResults;
  error: string;
}

/** Dock Search state: query/mode, debounced name and full-text lookups with a
 *  generation guard, and the Ctrl+Shift+F focus request. */
export function useWorkspaceSearch(projectPath: string, active: boolean) {
  const folders = useMemo<DesktopWorkspaceFolder[]>(() => (projectPath ? [{ path: projectPath }] : []), [projectPath]);
  // Names filters paths; Contents runs full-text search with the same field.
  const [query, setQuery] = useState('');
  const [searchMode, setSearchMode] = useState<'names' | 'contents'>('names');
  // The newest finished search. The results area keeps showing it (or the
  // idle body, before the first one) while the next query is read, so typing
  // never blanks the list or swaps it for a placeholder; `pending` tells the
  // field a read is under way.
  const [settled, setSettled] = useState<SettledSearch | null>(null);
  // Closing Search resets its mode and drops its results (the query stays).
  useSurfaceNavigationReset(active, () => {
    setSearchMode('names');
    setSettled(null);
  });
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
  useEffect(() => {
    const current = ++searchGeneration.current;
    const trimmed = query.trim();
    // Leaving Search or emptying the field drops the results; coming back reads them again.
    if (!active || !trimmed) {
      setSettled(null);
      return undefined;
    }
    if (searchProjects.length === 0) {
      setSettled({ projects: searchProjectsKey, query: trimmed, mode: searchMode, names: [], contents: [], error: '' });
      return undefined;
    }
    const timer = window.setTimeout(() => {
      if (searchMode === 'names') {
        void Promise.allSettled(
          searchProjects.map(async (project) => ({
            project,
            paths: await window.mixdogDesktop.searchProjectFiles(project, trimmed, 200),
          }))
        ).then((results) => {
          if (searchGeneration.current !== current) return;
          setSettled({
            projects: searchProjectsKey,
            query: trimmed,
            mode: 'names',
            names: results.flatMap((result) => (result.status === 'fulfilled' ? result.value : [])),
            contents: [],
            error: '',
          });
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
        .then((results) => {
          if (searchGeneration.current !== current) return;
          const rows = results.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
          if (!rows.length && results.every((result) => result.status === 'rejected')) {
            const rejected = results.find((result) => result.status === 'rejected');
            throw rejected && rejected.status === 'rejected' ? rejected.reason : new Error('Search failed.');
          }
          setSettled({
            projects: searchProjectsKey,
            query: trimmed,
            mode: 'contents',
            names: [],
            contents: rows,
            error: '',
          });
        })
        .catch((reason) => {
          if (searchGeneration.current !== current) return;
          setSettled({
            projects: searchProjectsKey,
            query: trimmed,
            mode: 'contents',
            names: [],
            contents: [],
            error: reason instanceof Error ? reason.message : String(reason),
          });
        });
    }, 90);
    return () => window.clearTimeout(timer);
  }, [active, query, searchMode, searchOptions, searchProjects, searchProjectsKey]);
  const trimmedQuery = query.trim();
  // Only the current mode's results show: a Names tab never presents Contents rows.
  const shown = trimmedQuery && settled?.projects === searchProjectsKey && settled.mode === searchMode ? settled : null;
  return {
    folders,
    query,
    setQuery,
    searchMode,
    setSearchMode,
    searchInputRef,
    /** The results to show for a non-empty query; null until its first search finishes. */
    settled: shown,
    /** A read for the current query and mode is under way. */
    pending: active && Boolean(trimmedQuery) && (!shown || shown.query !== trimmedQuery),
  };
}

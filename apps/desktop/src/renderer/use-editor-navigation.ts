import { useCallback, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { NavigationSelection, WorkspaceSelection, WorkspaceTab } from './navigation';
import { getEditorLanguageSnapshot, subscribeEditorLanguageStore, type EditorProblem } from './editor-language-store';
import { primeEditorFileLoad } from './editor-file-loader';
import { prefetchEditorPane } from './lazy-widgets';
import { reportEditorLoadStage } from './renderer-load-metrics';
import { navigationKey } from './text-format';
import { editorFileOpener } from '../shared/file-preview';
import { openEditorFileExternally } from './editor-external-file';
import { showDesktopToast } from './desktop-toasts';
import { errorMessageText } from './ErrorNotice';
import { t } from './i18n';
import { isRemoteHostRenderer } from './remote-ui-projection';
import {
  recordNavigationVisit,
  walkNavigationHistory,
  type EditorNavigationLocation,
  type NavigationHistory,
} from './navigation-history';

interface UseEditorNavigationOptions {
  setTabs: Dispatch<SetStateAction<WorkspaceTab[]>>;
  openSelectionInFocusedPane(selection: WorkspaceSelection, replaceKey?: string, options?: { preview?: boolean }): void;
  /** The window's Back/Forward history, shared with session activation. */
  navigationHistory: MutableRefObject<NavigationHistory>;
  /** Re-opens a session entry through the normal open path. */
  openSession(sessionId: string): void | Promise<void>;
  /** False for a session that no longer exists: Back/Forward skip it. */
  sessionAvailable(sessionId: string): boolean;
}

export interface EditorNavigationState {
  fileReveal: { key: string; line: number; nonce: number } | null;
  latestEditorLocation: MutableRefObject<EditorNavigationLocation | null>;
  editorNavigationHistory: MutableRefObject<NavigationHistory>;
  openFileTab(
    project: string,
    rel: string,
    line?: number,
    accessToken?: string,
    recordHistory?: boolean,
    openMode?: 'preview' | 'pinned'
  ): void;
  openProblemQuickFix(problem: EditorProblem): void;
  /** Back (-1) / Forward (1) through the window's history: sessions and editor locations. */
  navigateEditorHistory(offset: -1 | 1): void;
}

export function useEditorNavigation({
  setTabs,
  openSelectionInFocusedPane,
  navigationHistory,
  openSession,
  sessionAvailable,
}: UseEditorNavigationOptions): EditorNavigationState {
  const [fileReveal, setFileReveal] = useState<{ key: string; line: number; nonce: number } | null>(null);
  const latestEditorLocation = navigationHistory.current.editorLocation;
  const [, setEditorNavigationRevision] = useState(0);

  const recordEditorNavigation = useCallback(
    (target: EditorNavigationLocation) => {
      recordNavigationVisit(navigationHistory.current, { kind: 'editor', location: target });
      setEditorNavigationRevision((revision) => revision + 1);
    },
    [navigationHistory]
  );

  const openFileTab = useCallback(
    (
      project: string,
      rel: string,
      line?: number,
      accessToken?: string,
      recordHistory = true,
      openMode: 'preview' | 'pinned' = 'pinned'
    ) => {
      const cleanProject = String(project || '').trim();
      const cleanRel = String(rel || '')
        .replace(/\\/g, '/')
        .replace(/^\/+/, '');
      if (!cleanProject || !cleanRel) return;
      if (!isRemoteHostRenderer() && editorFileOpener(cleanRel) === 'os') {
        void openEditorFileExternally(cleanProject, cleanRel, accessToken);
        return;
      }
      void primeEditorFileLoad(window.mixdogDesktop, cleanProject, cleanRel, accessToken)?.catch(() => {});
      void prefetchEditorPane()
        .then(() => reportEditorLoadStage(cleanProject, cleanRel, accessToken, 'module'))
        .catch(() => {});
      const fileSelection: NavigationSelection = {
        kind: 'file',
        project: cleanProject,
        rel: cleanRel,
        ...(accessToken ? { accessToken } : {}),
      };
      const key = navigationKey(fileSelection);
      const targetLocation = {
        project: cleanProject,
        rel: cleanRel,
        line: typeof line === 'number' && line > 0 ? line : 1,
        ...(accessToken ? { accessToken } : {}),
      };
      if (recordHistory) recordEditorNavigation(targetLocation);
      else latestEditorLocation.current = targetLocation;
      setTabs((current) => {
        const existingIndex = current.findIndex(
          (tab) =>
            tab.key === key ||
            (tab.selection.kind === 'file' && tab.selection.project === cleanProject && tab.selection.rel === cleanRel)
        );
        if (existingIndex < 0) {
          return [
            ...current,
            {
              key,
              title: cleanRel.split('/').at(-1) || cleanRel,
              selection: fileSelection,
            },
          ];
        }
        const existing = current[existingIndex];
        if (existing.selection.kind !== 'file') return current;
        const resolvedAccessToken = accessToken || existing.selection.accessToken;
        const resolvedSelection: NavigationSelection = {
          ...fileSelection,
          ...(resolvedAccessToken ? { accessToken: resolvedAccessToken } : {}),
        };
        const resolvedKey = navigationKey(resolvedSelection);
        if (existing.key === resolvedKey && existing.selection.accessToken === resolvedAccessToken) return current;
        return current.map((tab, index) =>
          index === existingIndex ? { ...tab, key: resolvedKey, selection: resolvedSelection } : tab
        );
      });
      openSelectionInFocusedPane(fileSelection, '', { preview: openMode === 'preview' });
      if (typeof line === 'number' && line > 0) {
        setFileReveal({ key, line, nonce: Date.now() });
      }
    },
    [latestEditorLocation, openSelectionInFocusedPane, recordEditorNavigation, setTabs]
  );

  const openProblemQuickFix = useCallback(
    (problem: EditorProblem) => {
      openFileTab(problem.projectPath, problem.relPath, problem.startLineNumber);
      let done = false;
      let timeout = 0;
      let unsubscribe = () => {};
      const stop = () => {
        if (done) return;
        done = true;
        window.clearTimeout(timeout);
        unsubscribe();
      };
      const tryOpen = () => {
        const active = getEditorLanguageSnapshot().active;
        if (
          !active ||
          active.projectPath.replace(/[\\/]+/g, '/').toLocaleLowerCase() !==
            problem.projectPath.replace(/[\\/]+/g, '/').toLocaleLowerCase() ||
          active.relPath.replace(/\\/g, '/').toLocaleLowerCase() !==
            problem.relPath.replace(/\\/g, '/').toLocaleLowerCase()
        )
          return;
        stop();
        window.requestAnimationFrame(() =>
          window.dispatchEvent(
            new CustomEvent('mixdog:editor-action', {
              detail: {
                action: 'quickFix',
                line: problem.startLineNumber,
                column: problem.startColumn,
              },
            })
          )
        );
      };
      unsubscribe = subscribeEditorLanguageStore(tryOpen);
      timeout = window.setTimeout(stop, 4_000);
      tryOpen();
    },
    [openFileTab]
  );

  const navigateEditorHistory = useCallback(
    (offset: -1 | 1) => {
      void walkNavigationHistory(navigationHistory.current, offset, {
        available: (entry) => entry.kind === 'editor' || sessionAvailable(entry.id),
        openSession,
        openEditor: ({ project, rel, line, accessToken }) => openFileTab(project, rel, line, accessToken, false),
      })
        .then((moved) => {
          if (moved) setEditorNavigationRevision((revision) => revision + 1);
        })
        .catch((error: unknown) => {
          // Every candidate failed to open: the index stayed, so tell the user.
          showDesktopToast(t('Could not open · {{reason}}', { reason: errorMessageText(error) }), 'error');
        });
    },
    [navigationHistory, openFileTab, openSession, sessionAvailable]
  );

  return {
    fileReveal,
    latestEditorLocation,
    editorNavigationHistory: navigationHistory,
    openFileTab,
    openProblemQuickFix,
    navigateEditorHistory,
  };
}

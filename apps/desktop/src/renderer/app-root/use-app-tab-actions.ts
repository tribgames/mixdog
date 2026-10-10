import type React from 'react';
import { useEffect } from 'react';
import type { PullRequestOpenHandler } from '../PullRequestsPane';
import type { SourceControlDiffRequest } from '../SourceControlDock';
import type { WorkspaceSelection, WorkspaceTab } from '../navigation';
import { t } from '../i18n';
import { isRemoteHostRenderer } from '../remote-ui-projection';
import { navigationKey, newBrowserSelection, newStudioSelection } from '../text-format';
import { onBrowserMainRequested, type BrowserMainRequest } from '../browser-main-request';
import { canSplitPaneSize, paneActiveSelection } from '../pane-layout';
import type { usePaneWorkspace } from '../pane-workspace-state';
import { beginStudioLoad, reportStudioLoadStage } from '../renderer-load-metrics';
import { loadStudioViewModule } from '../studio-loader';
import { prefetchBrowserPane, prefetchDiffView, prefetchEditorPane, prefetchTerminalPane } from '../lazy-widgets';
import { useAgentBrowserSurfaceRequests } from '../use-agent-browser-surface-requests';
import { browserSurfaceRevealPlan } from '../session-browser-policy';
import { onTerminalRevealRequested } from '../terminal-command-request';
import { useStableEvent } from '../use-stable-event';
import { desktopFeatureEnabled } from '../desktop-feature-config';
import type { useAppSideDocks } from '../use-app-side-docks';
import type { useSessionPaneSurfaces } from '../use-session-pane-surfaces';
import { cleanDiffTarget, paneSize } from './workspace-targets';

export interface UseAppTabActionsOptions {
  paneWorkspace: ReturnType<typeof usePaneWorkspace>;
  setTabs: React.Dispatch<React.SetStateAction<WorkspaceTab[]>>;
  closeSidebarPanels: () => void;
  setSessionSideSurface: (sessionId: string, surface: 'terminal' | 'browser') => void;
  paneSideDocks: ReturnType<typeof useAppSideDocks>['paneSideDocks'];
  closePaneRightRegion: ReturnType<typeof useAppSideDocks>['closePaneRightRegion'];
  sessionPaneSurfaces: ReturnType<typeof useSessionPaneSurfaces>;
  openFileTab: (
    project: string,
    rel: string,
    line?: number,
    accessToken?: string,
    preview?: boolean,
    mode?: 'preview' | 'pinned'
  ) => void;
  openSession: (sessionId: string, force?: boolean, title?: string) => Promise<void>;
  activeProjectPath: string;
  /** Opens the project file search (quick open). */
  openQuickOpen: () => void;
}

export function useAppTabActions({
  paneWorkspace,
  setTabs,
  closeSidebarPanels,
  setSessionSideSurface,
  paneSideDocks,
  closePaneRightRegion,
  sessionPaneSurfaces,
  openFileTab,
  openSession,
  activeProjectPath,
  openQuickOpen,
}: UseAppTabActionsOptions) {
  const { openInFocused: openSelectionInFocusedPane, splitFocused: splitFocusedPane } = paneWorkspace;

  const openUtilityTab = (
    utilitySelection: Extract<WorkspaceSelection, { kind: 'studio' | 'terminal' }>,
    title: string,
    leafId = paneWorkspace.focusedLeafId
  ) => {
    paneWorkspace.focusLeaf(leafId);
    const key = navigationKey(utilitySelection);
    setTabs((current) =>
      current.some((tab) => tab.key === key) ? current : [...current, { key, title, selection: utilitySelection }]
    );
    openSelectionInFocusedPane(utilitySelection);
  };

  const openStudioTab = (leafId = paneWorkspace.focusedLeafId) => {
    closeSidebarPanels();
    const metricToken = beginStudioLoad();
    void loadStudioViewModule()
      .then(() => reportStudioLoadStage('module', '', false, metricToken))
      .catch(() => {});
    openUtilityTab(newStudioSelection(), t('Studio'), leafId);
  };

  // The side browser's "Open in main tab": the page's URL opens as a new main
  // browser tab in the pane that owned the side browser, and the side panel
  // folds. The tab gets its own browser page (user-only, same sign-in
  // partition), loaded at the URL.
  const openBrowserTab = (url: string, title: string | undefined, leafId = paneWorkspace.focusedLeafId) => {
    void prefetchBrowserPane().catch(() => {});
    paneWorkspace.focusLeaf(leafId);
    openSelectionInFocusedPane(newBrowserSelection(url, title));
  };

  const openTerminalTab = (leafId = paneWorkspace.focusedLeafId) => {
    void prefetchTerminalPane().catch(() => {});
    const leaf = paneWorkspace.leaves.find((candidate) => candidate.id === leafId);
    const selection = leaf ? paneActiveSelection(leaf) : null;
    if (selection?.kind !== 'session') return;
    setSessionSideSurface(selection.id, 'terminal');
    paneSideDocks.select(leafId, 'terminal');
  };

  const sessionOwners = paneWorkspace.leaves.map((leaf) => {
    const selection = paneActiveSelection(leaf);
    return {
      leafId: leaf.id,
      sessionId: selection?.kind === 'session' ? selection.id : null,
    };
  });

  useAgentBrowserSurfaceRequests({
    owners: sessionOwners,
    focusedLeafId: paneWorkspace.focusedLeafId,
    surfaces: sessionPaneSurfaces,
    prefetch: prefetchBrowserPane,
    select: paneSideDocks.select,
    temporarySelect: paneSideDocks.temporarySelect,
  });

  const openBrowserInMain = useStableEvent((request: BrowserMainRequest) => {
    const { leafId } = browserSurfaceRevealPlan(sessionOwners, request.sessionId, paneWorkspace.focusedLeafId);
    if (!leafId) return;
    // Fold the dock while the leaf still shows the session that owns it.
    closePaneRightRegion(leafId);
    openBrowserTab(request.url, request.title, leafId);
  });
  useEffect(() => onBrowserMainRequested(openBrowserInMain), [openBrowserInMain]);

  // A chat code block's Run: the session's terminal opens beside the pane
  // showing that session (the focused one when several do).
  const revealSessionTerminal = useStableEvent((sessionId: string) => {
    void prefetchTerminalPane().catch(() => {});
    setSessionSideSurface(sessionId, 'terminal');
    const { leafId } = browserSurfaceRevealPlan(sessionOwners, sessionId, paneWorkspace.focusedLeafId);
    if (leafId) paneSideDocks.select(leafId, 'terminal');
  });
  useEffect(() => onTerminalRevealRequested(revealSessionTerminal), [revealSessionTerminal]);

  const openDiffTab = (project: string, rel: string, request: SourceControlDiffRequest) => {
    const target = cleanDiffTarget(project, rel);
    if (!target) return;
    const cleanRel = target.rel;
    void prefetchDiffView().catch(() => {});
    const diffSelection: Extract<WorkspaceSelection, { kind: 'diff' }> = {
      kind: 'diff',
      ...target,
      ...request,
    };
    const key = navigationKey(diffSelection);
    setTabs((current) =>
      current.some((tab) => tab.key === key)
        ? current
        : [
            ...current,
            {
              key,
              title: t('{{name}} (Diff)', { name: cleanRel.split('/').at(-1) || cleanRel }),
              selection: diffSelection,
            },
          ]
    );
    openSelectionInFocusedPane(diffSelection);
  };

  const openPullRequestTab: PullRequestOpenHandler = (project, pullRequest, mode, toSide = false) => {
    if (!desktopFeatureEnabled('pullRequests')) return;
    const cleanProject = String(project || '').trim();
    if (!cleanProject || !Number.isInteger(pullRequest.number) || pullRequest.number <= 0) return;
    const instanceId = toSide ? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` : undefined;
    const pullRequestSelection: Extract<WorkspaceSelection, { kind: 'pull-request' }> = {
      kind: 'pull-request',
      project: cleanProject,
      number: pullRequest.number,
      title: pullRequest.title,
      mode,
      ...(instanceId ? { instanceId } : {}),
    };
    const key = navigationKey(pullRequestSelection);
    const title =
      mode === 'changes'
        ? t('Changes in Pull Request #{{number}}', { number: pullRequest.number })
        : pullRequest.title || t('Pull Request #{{number}}', { number: pullRequest.number });
    setTabs((current) => {
      const existing = current.findIndex((tab) => tab.key === key);
      if (existing < 0) return [...current, { key, title, selection: pullRequestSelection }];
      const next = [...current];
      next[existing] = { key, title, selection: pullRequestSelection };
      return next;
    });
    const focusedLeaf = paneWorkspace.focusedLeaf;
    if (toSide && focusedLeaf?.tabs.length) {
      const size = paneSize(focusedLeaf.id);
      if (!size || canSplitPaneSize('row', size.width, size.height)) {
        splitFocusedPane('row', pullRequestSelection, size);
        return;
      }
    }
    openSelectionInFocusedPane(pullRequestSelection);
  };

  const dockOpenFile = useStableEvent((project: string, rel: string, mode?: 'preview' | 'pinned') => {
    openFileTab(project, rel, undefined, undefined, true, mode);
  });
  const dockOpenFileAt = useStableEvent(openFileTab);
  const dockOpenDiff = useStableEvent(openDiffTab);
  const dockOpenPullRequest = useStableEvent(openPullRequestTab);
  const dockOpenLeadSession = useStableEvent((sessionId: string) => {
    void openSession(sessionId);
  });
  const dockOpenAgentSession = useStableEvent((sessionId: string, title: string, _ownerSessionId: string) => {
    const childSessionId = String(sessionId || '').trim();
    if (!childSessionId) return;
    void openSession(childSessionId, false, String(title || '').trim());
  });

  const chooseFileTab = async (leafId = paneWorkspace.focusedLeafId) => {
    void prefetchEditorPane().catch(() => {});
    // The OS file chooser would open on the host; remote surfaces search the project instead.
    if (isRemoteHostRenderer()) {
      paneWorkspace.focusLeaf(leafId);
      openQuickOpen();
      return;
    }
    const picked = await window.mixdogDesktop?.chooseFiles?.(activeProjectPath || null);
    if (!picked?.length) return;
    paneWorkspace.focusLeaf(leafId);
    for (const entry of picked) {
      if (entry.dir || !entry.projectPath || !entry.relPath) continue;
      openFileTab(entry.projectPath, entry.relPath, undefined, entry.accessToken);
    }
  };

  const openDroppedPaths = useStableEvent(async (leafId: string, paths: string[]) => {
    const entries = await window.mixdogDesktop?.resolveLocalPaths?.(paths);
    if (!entries?.length) return;
    paneWorkspace.focusLeaf(leafId);
    for (const entry of entries) {
      if (!entry.dir && entry.projectPath && entry.relPath) {
        openFileTab(entry.projectPath, entry.relPath, undefined, entry.accessToken);
      }
    }
  });

  return {
    openUtilityTab,
    openStudioTab,
    openTerminalTab,
    openBrowserTab,
    openDiffTab,
    openPullRequestTab,
    dockOpenFile,
    dockOpenFileAt,
    dockOpenDiff,
    dockOpenPullRequest,
    dockOpenLeadSession,
    dockOpenAgentSession,
    chooseFileTab,
    openDroppedPaths,
  };
}

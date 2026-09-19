import type React from 'react';
import type { PullRequestOpenHandler } from '../PullRequestsPane';
import type { SourceControlDiffRequest } from '../SourceControlDock';
import type { WorkspaceSelection, WorkspaceTab } from '../navigation';
import { navigationKey, newStudioSelection } from '../text-format';
import { canSplitPaneSize, paneActiveSelection } from '../pane-layout';
import type { usePaneWorkspace } from '../pane-workspace-state';
import { beginStudioLoad, reportStudioLoadStage } from '../renderer-load-metrics';
import { loadStudioViewModule } from '../studio-loader';
import { prefetchBrowserPane, prefetchDiffView, prefetchEditorPane, prefetchTerminalPane } from '../lazy-widgets';
import { useAgentBrowserSurfaceRequests } from '../use-agent-browser-surface-requests';
import { useStableEvent } from '../use-stable-event';
import { desktopFeatureEnabled } from '../desktop-feature-config';
import type { useAppSideDocks } from '../use-app-side-docks';
import type { useSessionPaneSurfaces } from '../use-session-pane-surfaces';

export interface UseAppTabActionsOptions {
  paneWorkspace: ReturnType<typeof usePaneWorkspace>;
  setTabs: React.Dispatch<React.SetStateAction<WorkspaceTab[]>>;
  closeSidebarPanels: () => void;
  setSessionSideSurface: (sessionId: string, surface: 'terminal' | 'browser') => void;
  paneSideDocks: ReturnType<typeof useAppSideDocks>['paneSideDocks'];
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
}

export function useAppTabActions({
  paneWorkspace,
  setTabs,
  closeSidebarPanels,
  setSessionSideSurface,
  paneSideDocks,
  sessionPaneSurfaces,
  openFileTab,
  openSession,
  activeProjectPath,
}: UseAppTabActionsOptions) {
  const { openInFocused: openSelectionInFocusedPane, splitFocused: splitFocusedPane } = paneWorkspace;

  const openUtilityTab = (
    utilitySelection: Extract<WorkspaceSelection, { kind: 'studio' | 'terminal' | 'browser' }>,
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
    openUtilityTab(newStudioSelection(), 'Studio', leafId);
  };

  const openTerminalTab = (leafId = paneWorkspace.focusedLeafId) => {
    void prefetchTerminalPane().catch(() => {});
    const leaf = paneWorkspace.leaves.find((candidate) => candidate.id === leafId);
    const selection = leaf ? paneActiveSelection(leaf) : null;
    if (selection?.kind !== 'session') return;
    setSessionSideSurface(selection.id, 'terminal');
    paneSideDocks.select(leafId, 'terminal');
  };

  useAgentBrowserSurfaceRequests({
    owners: paneWorkspace.leaves.map((leaf) => {
      const selection = paneActiveSelection(leaf);
      return {
        leafId: leaf.id,
        sessionId: selection?.kind === 'session' ? selection.id : null,
      };
    }),
    focusedLeafId: paneWorkspace.focusedLeafId,
    surfaces: sessionPaneSurfaces,
    prefetch: prefetchBrowserPane,
    select: paneSideDocks.select,
    temporarySelect: paneSideDocks.temporarySelect,
  });

  const openDiffTab = (project: string, rel: string, request: SourceControlDiffRequest) => {
    const cleanProject = String(project || '').trim();
    const cleanRel = String(rel || '')
      .replace(/\\/g, '/')
      .replace(/^\/+/, '');
    if (!cleanProject || !cleanRel) return;
    void prefetchDiffView().catch(() => {});
    const diffSelection: Extract<WorkspaceSelection, { kind: 'diff' }> = {
      kind: 'diff',
      project: cleanProject,
      rel: cleanRel,
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
              title: `${cleanRel.split('/').at(-1) || cleanRel} (Diff)`,
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
        ? `Changes in Pull Request #${pullRequest.number}`
        : pullRequest.title || `Pull Request #${pullRequest.number}`;
    setTabs((current) => {
      const existing = current.findIndex((tab) => tab.key === key);
      if (existing < 0) return [...current, { key, title, selection: pullRequestSelection }];
      const next = [...current];
      next[existing] = { key, title, selection: pullRequestSelection };
      return next;
    });
    const focusedLeaf = paneWorkspace.focusedLeaf;
    if (toSide && focusedLeaf?.tabs.length) {
      const paneElement = Array.from(document.querySelectorAll<HTMLElement>('[data-pane-id]')).find(
        (element) => element.dataset.paneId === focusedLeaf.id
      );
      const rect = paneElement?.getBoundingClientRect();
      if (!rect || canSplitPaneSize('row', rect.width, rect.height)) {
        splitFocusedPane('row', pullRequestSelection, rect ? { width: rect.width, height: rect.height } : undefined);
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

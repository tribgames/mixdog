import React, { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { DesktopSessionSummary, DesktopWorkspaceFolder } from '../shared/contract';
import { AgentActivityPane } from './AgentActivityPane';
import { AgentGroupsMenu } from './agent-group-visibility';
import { DesktopLoadingSurface } from './RendererRecovery';
import type { PullRequestOpenHandler } from './PullRequestsPane';
import { SearchPane } from './SearchPane';
import { SourceControlDock, type SourceControlDiffRequest } from './SourceControlDock';
import { SurfaceActiveContext } from './surface-activity';
import { beginBootSurface, reportBootSurfaceReady, reportBootSurfaceStage } from './boot-metrics';
import type { Snapshot } from './desktop-types';
import { desktopUtilityDockTabEnabled, type DesktopUtilityDockTab } from './desktop-feature-config';
import { t } from './i18n';
import { useUtilityDockGit } from './use-utility-dock-git';
import { useUtilityDockProject } from './use-utility-dock-project';

export { prewarmUtilityDockGitState } from './utility-dock-git-state';
export type UtilityDockTab = DesktopUtilityDockTab;

const MemoSourceControlDock = memo(SourceControlDock);
/** One retained Dock layer. The provider is the bounded lifecycle signal every
 *  escaping body portal (menus, selects) and every background loader inside
 *  the pane subscribes to, so `inert` can never leave an interactive orphan
 *  attached to document.body. */
function DockPane({ tab, active, children }: { tab: UtilityDockTab; active: boolean; children: ReactNode }) {
  return (
    <SurfaceActiveContext.Provider value={active}>
      <div
        className="utility-dock-pane stable-surface-layer"
        data-tab={tab}
        data-surface-active={active ? 'true' : 'false'}
        aria-hidden={active ? undefined : 'true'}
        inert={!active}
      >
        {children}
      </div>
    </SurfaceActiveContext.Provider>
  );
}

/** One retained view layer. Inactive layers stay mounted (tree, scroll and
 *  draft state survive a round trip) but are hidden and inert. */
function UtilityDockViewSection({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <section className="utility-dock-view-section" data-active={active ? 'true' : 'false'}>
      <div
        className="utility-dock-view-section-body"
        inert={active ? undefined : true}
        aria-hidden={active ? undefined : true}
      >
        {children}
      </div>
    </section>
  );
}

function utilityDockLoadingLabel(tab: UtilityDockTab): string {
  if (tab === 'search') return t('Preparing Search…');
  if (tab === 'source-control') return t('Preparing Source Control…');
  if (tab === 'pull-requests') return t('Preparing Pull Requests…');
  return t('Preparing Agents…');
}

function utilityDockTabTitle(tab: UtilityDockTab): string {
  if (tab === 'agents') return t('Agents');
  if (tab === 'search') return t('Search');
  if (tab === 'pull-requests') return t('Pull Requests');
  return t('Source Control');
}

export const UtilityDock = memo(function UtilityDock({
  open,
  tab,
  snapshot,
  projectPath = '',
  workspaceFolders,
  onSelectProject,
  onOpenFile,
  onOpenDiff,
  onOpenPullRequest,
  onOpenFileAt,
  activeFileKey = '',
  onRenameProjectEntry,
  sessions = [],
  sessionsReady = true,
  activeSessionIds = [],
  unreadSessionIds,
  onPrefetchSession,
  onOpenLeadSession,
  onOpenAgentSession,
  entering = false,
  contentReady = true,
  prewarm = false,
  showTitle = true,
  title,
  titleDragProps,
  metricSurface = 'dock',
}: {
  /** The hosting side section is expanded. Closed docks keep their layers
   *  mounted (prewarm) but run no polling or reads. */
  open: boolean;
  tab: UtilityDockTab;
  snapshot: Snapshot;
  sessions?: readonly DesktopSessionSummary[];
  sessionsReady?: boolean;
  activeSessionIds?: readonly string[];
  /** Recent-list unread sessions: the Agents pane shows their idle rows as
   *  completed work instead of plain rest. */
  unreadSessionIds?: ReadonlySet<string>;
  onPrefetchSession?(sessionId: string): void;
  projectPath?: string;
  workspaceFolders?: readonly DesktopWorkspaceFolder[];
  /** Main App owns the shared Search / Source Control / Pull Requests
   *  project cache. Standalone hosts omit this and keep a local override. */
  onSelectProject?(projectPath: string): void;
  onOpenFile?(project: string, rel: string, mode?: 'preview' | 'pinned'): void;
  onOpenDiff?(project: string, rel: string, request: SourceControlDiffRequest): void;
  onOpenPullRequest?: PullRequestOpenHandler;
  onOpenFileAt?(project: string, rel: string, line?: number): void;
  /** Search's file tree reveals this editor tab (`file:<project>:<rel>`). */
  activeFileKey?: string;
  /** Explorer rename that keeps the workspace's open tabs attached. */
  onRenameProjectEntry?(projectPath: string, relPath: string, newName: string): Promise<void>;
  onOpenLeadSession?(sessionId: string): void;
  onOpenAgentSession?(sessionId: string, title: string, ownerSessionId: string): void;
  /** Surface re-entry: render already-open, without the slide-in replay. */
  entering?: boolean;
  /** The shell may pre-mount at width 0; defer the expensive selected body. */
  contentReady?: boolean;
  /** Mount the selected body while CLOSED (user: 사이드탭 즉시 열리게): the
   *  pane dock hidden-mounts its remembered view after boot, so the first
   *  expand toggles `hidden` on a live tree instead of mounting Source
   *  Control — toolbar, windowed rows, commit box — behind the click. Open-
   *  gated effects (refresh scheduler, project list) still wait for `open`. */
  prewarm?: boolean;
  /** Pane docks drop the tool-title row so content tops align with the
   *  shared unit header (user: 소스 제어 타이틀 줄 제거). */
  showTitle?: boolean;
  title?: string;
  titleDragProps?: React.HTMLAttributes<HTMLElement>;
  metricSurface?: 'sidebar' | 'dock';
}) {
  const { dockProjectPath, dockProjectOptions, projectSelectControl } = useUtilityDockProject({
    open,
    projectPath,
    workspaceFolders,
    snapshot,
    onSelectProject,
  });
  const surfaceKeys = {
    'source-control': `source-control:${dockProjectPath}`,
    'pull-requests': `pull-requests:${dockProjectPath}`,
  };
  const { refreshDockGitStatus, gitSurfaceSelected, dockGitStatus, dockGitStatusReady, dockGitLoading, dockGitError } =
    useUtilityDockGit({ dockProjectPath, open, contentReady, tab });
  const [, setReadyPaneKeys] = useState<Partial<Record<UtilityDockTab, string>>>({});
  const setPaneReady = useCallback((pane: UtilityDockTab, key: string, ready: boolean) => {
    setReadyPaneKeys((current) => {
      if (ready) {
        if (current[pane] === key) return current;
        return { ...current, [pane]: key };
      }
      if (current[pane] !== key) return current;
      const next = { ...current };
      delete next[pane];
      return next;
    });
  }, []);
  const setSourceControlReady = useCallback(
    (key: string, ready: boolean) => setPaneReady('source-control', key, ready),
    [setPaneReady]
  );
  const setSourceGraphReady = useCallback(
    (key: string, ready: boolean) => setPaneReady('pull-requests', key, ready),
    [setPaneReady]
  );
  const selectedSurfaceDataReady = contentReady && (gitSurfaceSelected ? dockGitStatusReady : true);
  // The selected layer reveals in its FIRST ready paint.
  const selectedSurfaceVisible = contentReady;
  useEffect(() => {
    if (!open || !contentReady) return;
    beginBootSurface(metricSurface, tab);
    reportBootSurfaceStage(metricSurface, tab, 'module');
    reportBootSurfaceReady(metricSurface, tab, 'shell');
    if (!selectedSurfaceDataReady) return;
    reportBootSurfaceStage(metricSurface, tab, 'data');
  }, [contentReady, metricSurface, open, tab, selectedSurfaceDataReady]);
  const loadingLabel = utilityDockLoadingLabel(tab);
  // Instant switching (user: 탭 전환이 즉시 되어야 한다): a tab the user has
  // actually opened keeps its layer mounted for the life of the dock, so a
  // round trip re-presents the SAME DOM with its tree/SCM/PR expansion,
  // scroll and draft state intact instead of rebuilding it. Layers mount
  // lazily on first selection, so an unopened surface still allocates no DOM
  // and starts no background reads; every retained-but-inactive layer is
  // presentation-only (inert + aria-hidden) and passes active=false down, so
  // no second surface polls, fetches or duplicates the active effects.
  const [committedTabs, setCommittedTabs] = useState<ReadonlySet<UtilityDockTab>>(() => new Set());
  const mountedTabs = useMemo(() => {
    if ((!open && !prewarm) || !contentReady || committedTabs.has(tab)) return committedTabs;
    return new Set([...committedTabs, tab]);
  }, [committedTabs, contentReady, open, tab, prewarm]);
  useEffect(() => {
    if (mountedTabs !== committedTabs) setCommittedTabs(mountedTabs);
  }, [committedTabs, mountedTabs]);
  const paneMounted = (pane: UtilityDockTab) => contentReady && mountedTabs.has(pane);
  const paneActive = (pane: UtilityDockTab) => open && pane === tab;
  const dockTitle = title || utilityDockTabTitle(tab);
  const [headerActionSlot, setHeaderActionSlot] = useState<HTMLDivElement | null>(null);
  if (!desktopUtilityDockTabEnabled(tab)) return null;
  return (
    <aside
      className="utility-dock"
      data-state={open ? 'open' : 'closed'}
      data-entering={entering ? 'true' : undefined}
      aria-hidden={open ? undefined : true}
      inert={open ? undefined : true}
      aria-label={t('Utility panel')}
    >
      {showTitle && (
        <header {...titleDragProps} className="utility-dock-header" data-tab={tab}>
          <b>{dockTitle}</b>
          {tab === 'agents' && <AgentGroupsMenu />}
          {/* The showing pane's own title-row actions (Search's file tree). */}
          <div className="utility-dock-header-actions workbench-explorer-actions" ref={setHeaderActionSlot} />
        </header>
      )}
      <div
        className="stable-surface-switch utility-dock-body"
        data-ready={selectedSurfaceVisible ? 'true' : 'false'}
        data-transitioning="false"
      >
        {desktopUtilityDockTabEnabled('agents') && paneMounted('agents') && (
          <UtilityDockViewSection active={paneActive('agents')}>
            <DockPane tab="agents" active={paneActive('agents')}>
              <AgentActivityPane
                active={paneActive('agents')}
                showGroupActions={!showTitle}
                sessions={sessions}
                sessionsReady={sessionsReady}
                activeSessionIds={activeSessionIds}
                unreadSessionIds={unreadSessionIds}
                onPrefetchSession={onPrefetchSession}
                onOpenLeadSession={onOpenLeadSession}
                onOpenSession={onOpenAgentSession}
              />
            </DockPane>
          </UtilityDockViewSection>
        )}
        {desktopUtilityDockTabEnabled('search') && paneMounted('search') && (
          <UtilityDockViewSection active={paneActive('search')}>
            <DockPane tab="search" active={paneActive('search')}>
              {/* The project switcher rides above the search field and its filters
          (user: 검색창 필터 위에 프로젝트 선택이 사라짐). */}
              {dockProjectOptions.length > 0 && (
                <div className="utility-dock-project-row" title={dockProjectPath || t('Select project')}>
                  {projectSelectControl}
                </div>
              )}
              <SearchPane
                projectPath={dockProjectPath}
                gitStatus={dockGitStatus}
                active={paneActive('search')}
                activeFileKey={activeFileKey}
                onOpenFile={onOpenFile}
                onOpenFileAt={onOpenFileAt}
                onRenameEntry={onRenameProjectEntry}
                headerActionSlot={showTitle && paneActive('search') ? headerActionSlot : null}
              />
            </DockPane>
          </UtilityDockViewSection>
        )}
        {desktopUtilityDockTabEnabled('source-control') && paneMounted('source-control') && (
          <UtilityDockViewSection active={paneActive('source-control')}>
            <DockPane tab="source-control" active={paneActive('source-control')}>
              <MemoSourceControlDock
                projectPath={dockProjectPath}
                projectSelect={null}
                status={dockGitStatus}
                statusReady={dockGitStatusReady}
                loading={dockGitLoading}
                statusError={dockGitError}
                onRefreshStatus={refreshDockGitStatus}
                headerSlot={null}
                active={paneActive('source-control')}
                readinessKey={surfaceKeys['source-control']}
                onReadyChange={setSourceControlReady}
                onOpenFile={onOpenFile}
                onOpenDiff={onOpenDiff}
              />
            </DockPane>
          </UtilityDockViewSection>
        )}
        {desktopUtilityDockTabEnabled('pull-requests') && paneMounted('pull-requests') && (
          <UtilityDockViewSection active={paneActive('pull-requests')}>
            <DockPane tab="pull-requests" active={paneActive('pull-requests')}>
              <MemoSourceControlDock
                surface="prs"
                projectPath={dockProjectPath}
                status={dockGitStatus}
                statusReady={dockGitStatusReady}
                loading={dockGitLoading}
                statusError={dockGitError}
                onRefreshStatus={refreshDockGitStatus}
                headerSlot={null}
                active={paneActive('pull-requests')}
                readinessKey={surfaceKeys['pull-requests']}
                onReadyChange={setSourceGraphReady}
                onOpenFile={onOpenFile}
                onOpenPullRequest={onOpenPullRequest}
                onOpenDiff={onOpenDiff}
              />
            </DockPane>
          </UtilityDockViewSection>
        )}
        {!selectedSurfaceVisible && (
          // biome-ignore lint/a11y/useAriaPropsSupportedByRole: aria-label is only set together with role="status" (source-control tab)
          <div
            className="pane-surface-cover"
            role={tab === 'source-control' ? 'status' : undefined}
            aria-label={tab === 'source-control' ? loadingLabel : undefined}
          >
            {/* A genuinely uncached project gets an opaque target shell, not a
            spinner that appears briefly and makes the final body pop. */}
            {tab !== 'source-control' && <DesktopLoadingSurface label={loadingLabel} />}
          </div>
        )}
      </div>
    </aside>
  );
});

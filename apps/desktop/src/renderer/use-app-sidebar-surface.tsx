import { Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { DesktopProjectSummary } from '../shared/contract';
import { SidebarPanelBoundary } from './sidebar-panel-surface';
import { isRemoteHostRenderer } from './remote-ui-projection';
import type { SidebarPanelKey } from './app-shell-components';
import type { ExtensionsSection } from './extension-sections';
import type { useAppShellPanels } from './use-app-shell-panels';
import { useStableEvent } from './use-stable-event';
import type { SidebarViewGroup } from './sidebar-view-layout';
import { InitialSurface } from './InitialSurface';
import type { ProjectAddDialogHandle, ProjectAddDialogHost } from './ProjectAddDialogHost';
import type { ProjectEditorDialog, ProjectEditorDialogHandle } from './ProjectEditorDialog';
import { useDeferredModule } from './deferred-module';
import { showDesktopToast } from './desktop-toasts';
import { errorMessageText } from './ErrorNotice';
import { projectAddDialogModule, projectEditorDialogModule } from './first-screen-deferred';

/** A deferred dialog host's pending open: replayed once its module has
 *  mounted, so the first open needs no extra click. A failed load drops the
 *  open with a toast (these hosts render inside the app shell itself, so a
 *  thrown error would take the whole window down); the next open retries. */
function useDeferredOpen<Handle>(load: () => Promise<unknown>) {
  const ref = useRef<Handle>(null);
  const [requested, setRequested] = useState<{ open(handle: Handle): void } | null>(null);
  useEffect(() => {
    if (!requested || !ref.current) return;
    requested.open(ref.current);
    setRequested(null);
  });
  const request = (open: (handle: Handle) => void) => {
    if (ref.current) {
      open(ref.current);
      return;
    }
    setRequested({ open });
    load().catch((error: unknown) => {
      setRequested(null);
      showDesktopToast(errorMessageText(error), 'error');
    });
  };
  return { ref, request };
}

type ShellPanels = ReturnType<typeof useAppShellPanels>;

const SIDEBAR_PANEL_TITLES: Record<SidebarPanelKey, string> = {
  schedules: 'Schedules',
  webhooks: 'Webhooks',
  projects: 'Projects',
  workflows: 'Workflow',
  extensions: 'Extensions',
  skills: 'Skills',
};

type SidebarSurface = 'sessions' | 'schedules' | 'webhooks' | 'projects';

/** Which sidebar surface is requested and which one is presented: a cold
 *  destination keeps the outgoing surface's pixels until it can paint. */
function useSidebarPresentation({
  schedulesOpen,
  webhooksOpen,
  projectsOpen,
  sidebarOpen,
  viewGroups,
  loadedSidebarPanels,
  failedSidebarPanels,
  mountedSidebarPanels,
}: {
  schedulesOpen: boolean;
  webhooksOpen: boolean;
  projectsOpen: boolean;
  sidebarOpen: boolean;
  viewGroups: readonly SidebarViewGroup[];
  loadedSidebarPanels: ReadonlySet<string>;
  failedSidebarPanels: ReadonlySet<string>;
  mountedSidebarPanels: ReadonlySet<string>;
}) {
  let requestedSidebarSurface: SidebarSurface = 'sessions';
  if (schedulesOpen) requestedSidebarSurface = 'schedules';
  else if (webhooksOpen) requestedSidebarSurface = 'webhooks';
  else if (projectsOpen) requestedSidebarSurface = 'projects';
  const sidebarGroupFor = (surface: SidebarSurface): readonly SidebarPanelKey[] =>
    surface === 'sessions' ? [] : (viewGroups.find((group) => group.includes(surface)) ?? [surface]);
  const requestedSidebarGroup = sidebarGroupFor(requestedSidebarSurface);
  const sidebarPanel = requestedSidebarSurface === 'sessions' ? null : requestedSidebarSurface;
  // The sidebar subtree owns every visited panel's DOM and state, so it stays
  // mounted (inert + aria-hidden + zero width via .sidebar-collapsed / the
  // narrow drawer transform) once it has been opened: collapsing must not
  // destroy a visited destination's scroll, drafts, or dialogs. Warmth is
  // scoped to THIS tree instance — if the host ever unmounts, every panel
  // starts cold again.
  const [sidebarTreeBooted, setSidebarTreeBooted] = useState(sidebarOpen);
  useEffect(() => {
    if (sidebarOpen && !sidebarTreeBooted) setSidebarTreeBooted(true);
  }, [sidebarOpen, sidebarTreeBooted]);
  const sidebarTreeMounted = sidebarOpen || sidebarTreeBooted;
  // Entering a rail panel for the FIRST time cold-mounts its Suspense chunk,
  // so that one transition still settles hidden before it becomes visible
  // (user: 사이드탭 메뉴 전환 시 툭 튐). Once a destination has genuinely
  // resolved its module AND committed its content on screen, it is warm: the
  // request IS the presentation and flips in the click's own commit, because
  // an artificial settle window there only reads as input lag (user: 좌측
  // 메뉴 전환이 느리다).
  const warmSidebarSurfaces = useRef<ReadonlySet<SidebarSurface>>(new Set(['sessions']));
  const [laggedSidebarSurface, setLaggedSidebarSurface] = useState<SidebarSurface>('sessions');
  const requestedSidebarPanelReady =
    requestedSidebarSurface === 'sessions' ||
    requestedSidebarGroup.every(
      (panel) =>
        (loadedSidebarPanels.has(panel) ||
          // A failed chunk still has content to present: the panel-local
          // unavailable state. It is presentable, never warm.
          failedSidebarPanels.has(panel)) &&
        mountedSidebarPanels.has(panel)
    );
  // A resolved module whose pane is already mounted hidden is just as ready
  // as a previously presented destination: both can become visible in this
  // click's own commit. Projects is prepared this way after boot so its rows
  // and overflow options never first-mount in front of the user.
  const requestedSidebarSurfaceWarm =
    sidebarTreeMounted &&
    (warmSidebarSurfaces.current.has(requestedSidebarSurface) ||
      (requestedSidebarSurface !== 'sessions' &&
        requestedSidebarGroup.every((panel) => loadedSidebarPanels.has(panel) && mountedSidebarPanels.has(panel))));
  const presentedSidebarSurface: SidebarSurface = requestedSidebarSurfaceWarm
    ? requestedSidebarSurface
    : laggedSidebarSurface;
  useLayoutEffect(() => {
    if (laggedSidebarSurface === requestedSidebarSurface) return undefined;
    if (requestedSidebarSurfaceWarm) {
      // Presentation already followed the request during render; keep the
      // cold fallback aligned so the NEXT cold destination lags from the
      // surface the user is actually looking at.
      setLaggedSidebarSurface(requestedSidebarSurface);
      return undefined;
    }
    // A hidden sidebar has nothing to present: closing during a cold settle
    // cancels the pending commit (cleanup below), and reopening restarts the
    // full settle for the still-unresolved destination.
    if (!sidebarOpen || !sidebarTreeMounted) return undefined;
    // Never swap onto an unresolved chunk: the outgoing surface keeps its
    // pixels until the incoming panel can actually paint content. Once the
    // hidden pane is mounted and resolved, commit from the layout effect so
    // the requested destination appears in the click's next paint without an
    // extra font/three-frame settle window.
    if (!requestedSidebarPanelReady) return undefined;
    setLaggedSidebarSurface(requestedSidebarSurface);
    return undefined;
  }, [
    laggedSidebarSurface,
    requestedSidebarPanelReady,
    requestedSidebarSurface,
    requestedSidebarSurfaceWarm,
    sidebarOpen,
    sidebarTreeMounted,
  ]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: sidebarGroupFor is a pure lookup; re-runs only on the listed surface/mount state
  useLayoutEffect(() => {
    if (!sidebarTreeMounted) {
      // The panel trees died with their host: nothing may claim to be warm.
      warmSidebarSurfaces.current = new Set(['sessions']);
      return;
    }
    // Warm means committed usable content: the panel is mounted, its module
    // resolved, and it has actually been presented inside the open sidebar.
    if (!sidebarOpen || presentedSidebarSurface === 'sessions') return;
    const presentedGroup = sidebarGroupFor(presentedSidebarSurface);
    if (!presentedGroup.every((panel) => loadedSidebarPanels.has(panel))) return;
    if (!presentedGroup.every((panel) => mountedSidebarPanels.has(panel))) return;
    if (warmSidebarSurfaces.current.has(presentedSidebarSurface)) return;
    warmSidebarSurfaces.current = new Set([...warmSidebarSurfaces.current, presentedSidebarSurface]);
  }, [loadedSidebarPanels, mountedSidebarPanels, presentedSidebarSurface, sidebarOpen, sidebarTreeMounted]);
  // ACTIVE is the panel lifecycle the panes themselves see. A hidden sidebar
  // has no active destination: rail panels portal their editors to
  // document.body, where the sidebar's inert/aria-hidden does not reach, so a
  // titlebar/backdrop collapse must deactivate the panel even though the
  // request is unchanged. Panels close only their dialogs on deactivation and
  // keep list/filter state.
  const presentedSidebarGroup = sidebarGroupFor(presentedSidebarSurface);
  const presentedSidebarPanel =
    presentedSidebarSurface === 'sessions' ? null : (presentedSidebarGroup[0] ?? presentedSidebarSurface);
  return { sidebarPanel, sidebarTreeMounted, presentedSidebarPanel };
}

/** The project dialogs (editor and add) hosted outside the sidebar panels,
 *  plus the project actions the Projects panel and those dialogs share. */
function useSidebarProjectActions({
  projects,
  refreshProjects,
  renameProject,
  removeProject,
}: {
  projects: DesktopProjectSummary[];
  refreshProjects(): Promise<DesktopProjectSummary[]>;
  renameProject(path: string, alias: string): unknown;
  removeProject(path: string): unknown;
}) {
  const [revealedProject, setRevealedProject] = useState({ path: '', nonce: 0 });
  const onProjectAddedRef = useRef<((path: string) => void) | null>(null);
  const projectsCreate = useStableEvent(async (path: string, name?: string) => {
    const host = window.mixdogDesktop;
    if (!host) throw new Error('Desktop bridge is unavailable.');
    await host.addProject(path);
    if (name) await host.renameProject(path, name);
    await refreshProjects();
    // The Sessions tab expands and scrolls to the added (or already known) folder.
    setRevealedProject((current) => ({ path, nonce: current.nonce + 1 }));
    // "Move to project → New project…" finishes by moving its session here.
    const onAdded = onProjectAddedRef.current;
    onProjectAddedRef.current = null;
    onAdded?.(path);
  });
  // Project rows carry no open action (user: 클릭 없애 그냥) — the panel lists
  // and edits projects; NEW TASK is minted from its own entries only.
  const projectsRename = useStableEvent((path: string, alias: string) => void renameProject(path, alias));
  const projectsRemove = useStableEvent((path: string) => void removeProject(path));
  const projectsChooseFolder = useCallback(
    // Remote surfaces browse the host in-app (ProjectListSection), never the OS chooser.
    async () => (isRemoteHostRenderer() ? null : ((await window.mixdogDesktop?.chooseProject()) ?? null)),
    []
  );
  const projectsMemoryControl = useCallback<
    NonNullable<React.ComponentProps<ShellPanels['sidebarPanes']['projects']>['onMemoryControl']>
  >(
    async (input) =>
      (
        await window.mixdogDesktop.invokeCapability({
          capability: 'memoryControl',
          args: [input, { silent: true }],
        })
      ).value,
    []
  );
  // One editor host outside the sidebar panels: opened by "Project settings"
  // over the current screen, and never closed by panel activation changes.
  // Both dialogs' chunks stay off the first screen: they mount once loaded
  // (first open or the idle lane), and an open before that is replayed.
  const projectEditor = useDeferredOpen<ProjectEditorDialogHandle>(projectEditorDialogModule.load);
  const ProjectEditor: typeof ProjectEditorDialog | undefined = useDeferredModule(projectEditorDialogModule, {
    load: false,
  })?.ProjectEditorDialog;
  const openProjectSettings = useStableEvent((path: string) => projectEditor.request((handle) => handle.open(path)));
  const projectEditorHost = ProjectEditor ? (
    <ProjectEditor
      ref={projectEditor.ref}
      projects={projects}
      onRename={projectsRename}
      onRemove={projectsRemove}
      onMemoryControl={projectsMemoryControl}
    />
  ) : null;
  // One add-project dialog host outside the panels: the Projects panel action
  // and the Sessions header menu both open it, and the phone drawer closing
  // never unmounts it.
  const projectAdd = useDeferredOpen<ProjectAddDialogHandle>(projectAddDialogModule.load);
  const ProjectAdd: typeof ProjectAddDialogHost | undefined = useDeferredModule(projectAddDialogModule, {
    load: false,
  })?.ProjectAddDialogHost;
  // `onAdded` runs once if this open ends in an added project; every other
  // open replaces it, so an abandoned dialog never moves a later add.
  const openProjectAdd = useStableEvent((onAdded?: (path: string) => void) => {
    onProjectAddedRef.current = onAdded ?? null;
    projectAdd.request((handle) => handle.open());
  });
  const projectAddHost = ProjectAdd ? (
    <ProjectAdd
      ref={projectAdd.ref}
      projects={projects}
      onChooseFolder={projectsChooseFolder}
      onCreateProject={projectsCreate}
    />
  ) : null;
  return {
    revealedProject,
    projectsRename,
    projectsRemove,
    projectsMemoryControl,
    openProjectSettings,
    projectEditorHost,
    openProjectAdd,
    projectAddHost,
  };
}

export function useAppSidebarSurface({
  schedulesOpen,
  webhooksOpen,
  projectsOpen,
  sidebarOpen,
  viewGroups,
  loadedSidebarPanels,
  failedSidebarPanels,
  mountedSidebarPanels,
  sidebarPanes,
  markSidebarPanelFailed,
  retrySidebarPanel,
  runningAutomationNames,
  projects,
  projectsReady,
  selectedProjectPath,
  extensionsSection,
  onExtensionsSectionChange,
  closeSidebarForNavigation,
  startTask,
  openStudio,
  openSession,
  refreshProjects,
  renameProject,
  removeProject,
}: {
  schedulesOpen: boolean;
  webhooksOpen: boolean;
  projectsOpen: boolean;
  sidebarOpen: boolean;
  viewGroups: readonly SidebarViewGroup[];
  loadedSidebarPanels: ReadonlySet<string>;
  failedSidebarPanels: ReadonlySet<string>;
  mountedSidebarPanels: ReadonlySet<string>;
  sidebarPanes: ShellPanels['sidebarPanes'];
  markSidebarPanelFailed(panel: SidebarPanelKey): void;
  retrySidebarPanel(panel: SidebarPanelKey): void;
  runningAutomationNames: { schedule: Set<string>; webhook: Set<string> };
  projects: DesktopProjectSummary[];
  projectsReady: boolean;
  selectedProjectPath: string;
  extensionsSection: ExtensionsSection;
  onExtensionsSectionChange(section: ExtensionsSection): void;
  closeSidebarForNavigation(): void;
  startTask(): unknown;
  /** Opens a Studio workspace tab in the focused pane. */
  openStudio(): unknown;
  openSession(sessionId: string): unknown;
  refreshProjects(): Promise<DesktopProjectSummary[]>;
  renameProject(path: string, alias: string): unknown;
  removeProject(path: string): unknown;
}) {
  const { sidebarPanel, sidebarTreeMounted, presentedSidebarPanel } = useSidebarPresentation({
    schedulesOpen,
    webhooksOpen,
    projectsOpen,
    sidebarOpen,
    viewGroups,
    loadedSidebarPanels,
    failedSidebarPanels,
    mountedSidebarPanels,
  });
  const SchedulesPane = sidebarPanes.schedules;
  const WebhooksPane = sidebarPanes.webhooks;
  const ProjectsPane = sidebarPanes.projects;
  const WorkflowsPane = sidebarPanes.workflows;
  const ExtensionsPane = sidebarPanes.extensions;
  const SkillsPane = sidebarPanes.skills;
  const sidebarPanelTitle = presentedSidebarPanel ? SIDEBAR_PANEL_TITLES[presentedSidebarPanel] : '';
  // Stable sidebar handlers + memoised panel children: SessionSidebar, its
  // rows, and every rail panel are memoised, but fresh inline closures and a
  // fresh children fragment on every App render defeated those boundaries —
  // a mere tab switch re-rendered the whole sidebar tree (profiled:
  // SessionRow/panel subtrees dominated fast-switch commits, user: 빨리
  // 움직이면 전 화면 잔상이 남는다).
  const sidebarNewTask = useStableEvent(() => {
    closeSidebarForNavigation();
    startTask();
  });
  // The Sessions panel's second fixed launcher row: Studio opens as a
  // workspace tab exactly like New Task (user: 세션 위에 새 작업·새 스튜디오
  // 고정), so the phone drawer closes the same way before the tab lands.
  const sidebarNewStudio = useStableEvent(() => {
    closeSidebarForNavigation();
    openStudio();
  });
  const sidebarResumeSession = useStableEvent((sessionId: string) => {
    closeSidebarForNavigation();
    openSession(sessionId);
  });
  const {
    revealedProject,
    projectsRename,
    projectsRemove,
    projectsMemoryControl,
    openProjectSettings,
    projectEditorHost,
    openProjectAdd,
    projectAddHost,
  } = useSidebarProjectActions({ projects, refreshProjects, renameProject, removeProject });
  const renderSidebarPanel = (panel: SidebarPanelKey, active: boolean): React.ReactNode => {
    if (!mountedSidebarPanels.has(panel)) return null;
    const label = SIDEBAR_PANEL_TITLES[panel];
    let content: React.ReactNode;
    if (panel === 'schedules') {
      content = <SchedulesPane active={active} runningNames={runningAutomationNames.schedule} />;
    } else if (panel === 'webhooks') {
      content = <WebhooksPane active={active} runningNames={runningAutomationNames.webhook} />;
    } else if (panel === 'extensions') {
      content = (
        <ExtensionsPane active={active} section={extensionsSection} onSectionChange={onExtensionsSectionChange} />
      );
    } else if (panel === 'skills') {
      content = <SkillsPane active={active} />;
    } else if (panel === 'workflows') {
      content = (
        <div
          className="schedules-pane workflows-pane stable-surface-preserved stable-takeover-surface"
          data-surface-active={active ? 'true' : 'false'}
          inert={active ? undefined : true}
          aria-hidden={active ? undefined : true}
        >
          <div className="schedules-page">
            <WorkflowsPane active={active} />
          </div>
        </div>
      );
    } else {
      content = (
        <ProjectsPane
          active={active}
          projects={projects}
          projectsReady={projectsReady}
          selectedProjectPath={selectedProjectPath}
          onAddProject={() => openProjectAdd()}
          onRename={projectsRename}
          onRemove={projectsRemove}
          onMemoryControl={projectsMemoryControl}
        />
      );
    }
    return (
      <SidebarPanelBoundary
        label={label}
        active={active}
        onFailure={() => markSidebarPanelFailed(panel)}
        onRetry={() => retrySidebarPanel(panel)}
      >
        <Suspense fallback={<InitialSurface />}>{content}</Suspense>
      </SidebarPanelBoundary>
    );
  };

  return {
    presentedSidebarPanel,
    sidebarNewTask,
    sidebarNewStudio,
    sidebarPanel,
    sidebarPanelTitle,
    sidebarResumeSession,
    sidebarTreeMounted,
    renderSidebarPanel,
    openProjectSettings,
    projectEditorHost,
    projectAddHost,
    openProjectAdd,
    revealedProject,
  };
}

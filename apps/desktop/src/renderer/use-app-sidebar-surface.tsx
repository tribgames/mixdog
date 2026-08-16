import { Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DesktopProjectSummary } from "../shared/contract";
import { scheduleStableSurfaceCommit } from "./PaneSurfaceGate";
import { SidebarPanelBoundary } from "./sidebar-panel-surface";
import type { SidebarPanelKey } from "./app-shell-components";
import type { useAppShellPanels } from "./use-app-shell-panels";
import { useStableEvent } from "./use-stable-event";

type ShellPanels = ReturnType<typeof useAppShellPanels>;

export function useAppSidebarSurface({
  utilitiesOpen,
  schedulesOpen,
  webhooksOpen,
  projectsOpen,
  workflowsOpen,
  sidebarOpen,
  loadedSidebarPanels,
  failedSidebarPanels,
  mountedSidebarPanels,
  sidebarPanes,
  markSidebarPanelFailed,
  retrySidebarPanel,
  runningAutomationNames,
  projects,
  selectedProjectPath,
  closeSidebarForNavigation,
  startTask,
  openSession,
  openStudioTab,
  openTerminalTab,
  openFolderTab,
  refreshProjects,
  renameProject,
  removeProject,
}: {
  utilitiesOpen: boolean;
  schedulesOpen: boolean;
  webhooksOpen: boolean;
  projectsOpen: boolean;
  workflowsOpen: boolean;
  sidebarOpen: boolean;
  loadedSidebarPanels: ReadonlySet<string>;
  failedSidebarPanels: ReadonlySet<string>;
  mountedSidebarPanels: ReadonlySet<string>;
  sidebarPanes: ShellPanels["sidebarPanes"];
  markSidebarPanelFailed(panel: SidebarPanelKey): void;
  retrySidebarPanel(panel: SidebarPanelKey): void;
  runningAutomationNames: { schedule: Set<string>; webhook: Set<string> };
  projects: DesktopProjectSummary[];
  selectedProjectPath: string;
  closeSidebarForNavigation(): void;
  startTask(): unknown;
  openSession(sessionId: string): unknown;
  openStudioTab(): unknown;
  openTerminalTab(): unknown;
  openFolderTab(): unknown;
  refreshProjects(): Promise<DesktopProjectSummary[]>;
  renameProject(path: string, alias: string): unknown;
  removeProject(path: string): unknown;
}) {
  type SidebarSurface = "sessions" | "utilities" | "schedules" | "webhooks" | "projects" | "workflows";
  const requestedSidebarSurface: SidebarSurface = utilitiesOpen ? "utilities"
    : schedulesOpen ? "schedules"
    : webhooksOpen ? "webhooks"
    : projectsOpen ? "projects"
    : workflowsOpen ? "workflows"
    : "sessions";
  const sidebarPanel = requestedSidebarSurface === "sessions" ? null : requestedSidebarSurface;
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
  const warmSidebarSurfaces = useRef<ReadonlySet<SidebarSurface>>(new Set(["sessions"]));
  const [laggedSidebarSurface, setLaggedSidebarSurface] = useState<SidebarSurface>("sessions");
  const requestedSidebarPanelReady = requestedSidebarSurface === "sessions"
    || ((loadedSidebarPanels.has(requestedSidebarSurface)
      // A failed chunk still has content to present: the panel-local
      // unavailable state. It is presentable, never warm.
      || failedSidebarPanels.has(requestedSidebarSurface))
      && mountedSidebarPanels.has(requestedSidebarSurface));
  // A resolved module whose pane is already mounted hidden is just as ready
  // as a previously presented destination: both can become visible in this
  // click's own commit. Projects is prepared this way after boot so its rows
  // and overflow options never first-mount in front of the user.
  const requestedSidebarSurfaceWarm = sidebarTreeMounted
    && (warmSidebarSurfaces.current.has(requestedSidebarSurface)
      || (requestedSidebarSurface !== "sessions"
        && loadedSidebarPanels.has(requestedSidebarSurface)
        && mountedSidebarPanels.has(requestedSidebarSurface)));
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
    // pixels until the incoming panel can actually paint content.
    if (!requestedSidebarPanelReady) return undefined;
    return scheduleStableSurfaceCommit(() => setLaggedSidebarSurface(requestedSidebarSurface));
  }, [
    laggedSidebarSurface,
    requestedSidebarPanelReady,
    requestedSidebarSurface,
    requestedSidebarSurfaceWarm,
    sidebarOpen,
    sidebarTreeMounted,
  ]);
  useLayoutEffect(() => {
    if (!sidebarTreeMounted) {
      // The panel trees died with their host: nothing may claim to be warm.
      warmSidebarSurfaces.current = new Set(["sessions"]);
      return;
    }
    // Warm means committed usable content: the panel is mounted, its module
    // resolved, and it has actually been presented inside the open sidebar.
    if (!sidebarOpen || presentedSidebarSurface === "sessions") return;
    if (!loadedSidebarPanels.has(presentedSidebarSurface)) return;
    if (!mountedSidebarPanels.has(presentedSidebarSurface)) return;
    if (warmSidebarSurfaces.current.has(presentedSidebarSurface)) return;
    warmSidebarSurfaces.current = new Set([
      ...warmSidebarSurfaces.current,
      presentedSidebarSurface,
    ]);
  }, [
    loadedSidebarPanels,
    mountedSidebarPanels,
    presentedSidebarSurface,
    sidebarOpen,
    sidebarTreeMounted,
  ]);
  const presentedSidebarPanel = presentedSidebarSurface === "sessions"
    ? null
    : presentedSidebarSurface;
  // ACTIVE is the panel lifecycle the panes themselves see. A hidden sidebar
  // has no active destination: rail panels portal their editors to
  // document.body, where the sidebar's inert/aria-hidden does not reach, so a
  // titlebar/backdrop collapse must deactivate the panel even though the
  // request is unchanged. Panels close only their dialogs on deactivation and
  // keep list/filter state.
  const activeSidebarPanel = sidebarOpen ? presentedSidebarPanel : null;
  const SchedulesPane = sidebarPanes.schedules;
  const WebhooksPane = sidebarPanes.webhooks;
  const ProjectsPane = sidebarPanes.projects;
  const WorkflowsPane = sidebarPanes.workflows;
  const UtilitiesPane = sidebarPanes.utilities;
  const sidebarPanelTitle = presentedSidebarSurface === "utilities" ? "Utilities"
    : presentedSidebarSurface === "schedules" ? "Schedules"
    : presentedSidebarSurface === "webhooks" ? "Webhooks"
    : presentedSidebarSurface === "projects" ? "Projects"
    : presentedSidebarSurface === "workflows" ? "Workflows"
    : "";
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
  const sidebarResumeSession = useStableEvent((sessionId: string) => {
    closeSidebarForNavigation();
    openSession(sessionId);
  });
  // Utilities rows launch tabs WITHOUT resetting the rail to Sessions: the
  // panel stays selected so repeated launches need no re-entry (user: 한번
  // 누르면 세션창으로 이동되는데 그냥 유지되도록).
  const utilitiesOpenStudio = useStableEvent(() => openStudioTab());
  const utilitiesOpenTerminal = useStableEvent(() => openTerminalTab());
  const utilitiesOpenExplorer = useStableEvent(() => openFolderTab());
  const projectsCreate = useStableEvent(async (path: string, name?: string) => {
    const host = window.mixdogDesktop;
    if (!host) throw new Error("Desktop bridge is unavailable.");
    await host.addProject(path);
    if (name) await host.renameProject(path, name);
    await refreshProjects();
  });
  // Project rows carry no open action (user: 클릭 없애 그냥) — the panel lists
  // and edits projects; NEW TASK is minted from its own entries only.
  const projectsRename = useStableEvent((path: string, alias: string) => void renameProject(path, alias));
  const projectsRemove = useStableEvent((path: string) => void removeProject(path));
  const projectsSaveInstructions = useStableEvent(async (path: string, content: string) => {
    const host = window.mixdogDesktop;
    if (!host?.writeInstructions) throw new Error("Desktop bridge is unavailable.");
    await host.writeInstructions(path, content);
  });
  const sidebarPanelChildren = useMemo(() => <>
    {/* One bounded boundary per destination: a rejected chunk becomes a
        compact panel-local unavailable state instead of escaping to the
        root and replacing the whole app. */}
    {mountedSidebarPanels.has("utilities") && (
    <SidebarPanelBoundary label="Utilities" active={activeSidebarPanel === "utilities"}
      onFailure={() => markSidebarPanelFailed("utilities")}
      onRetry={() => retrySidebarPanel("utilities")}>
    <Suspense fallback={null}>
      <UtilitiesPane active={activeSidebarPanel === "utilities"}
        onOpenStudio={utilitiesOpenStudio}
        onOpenTerminal={utilitiesOpenTerminal}
        onOpenExplorer={utilitiesOpenExplorer} />
    </Suspense>
    </SidebarPanelBoundary>
    )}
    {mountedSidebarPanels.has("schedules") && (
    <SidebarPanelBoundary label="Schedules" active={activeSidebarPanel === "schedules"}
      onFailure={() => markSidebarPanelFailed("schedules")}
      onRetry={() => retrySidebarPanel("schedules")}>
    <Suspense fallback={null}>
      <SchedulesPane active={activeSidebarPanel === "schedules"}
        runningNames={runningAutomationNames.schedule} />
    </Suspense>
    </SidebarPanelBoundary>
    )}
    {mountedSidebarPanels.has("webhooks") && (
    <SidebarPanelBoundary label="Webhooks" active={activeSidebarPanel === "webhooks"}
      onFailure={() => markSidebarPanelFailed("webhooks")}
      onRetry={() => retrySidebarPanel("webhooks")}>
    <Suspense fallback={null}>
      <WebhooksPane active={activeSidebarPanel === "webhooks"}
        runningNames={runningAutomationNames.webhook} />
    </Suspense>
    </SidebarPanelBoundary>
    )}
    {mountedSidebarPanels.has("workflows") && (
    <SidebarPanelBoundary label="Workflows" active={activeSidebarPanel === "workflows"}
      onFailure={() => markSidebarPanelFailed("workflows")}
      onRetry={() => retrySidebarPanel("workflows")}>
    <Suspense fallback={null}>
      <WorkflowsPane active={activeSidebarPanel === "workflows"} />
    </Suspense>
    </SidebarPanelBoundary>
    )}
    {mountedSidebarPanels.has("projects") && (
    <SidebarPanelBoundary label="Projects" active={activeSidebarPanel === "projects"}
      onFailure={() => markSidebarPanelFailed("projects")}
      onRetry={() => retrySidebarPanel("projects")}>
    <Suspense fallback={null}>
      <ProjectsPane active={activeSidebarPanel === "projects"}
        projects={projects} selectedProjectPath={selectedProjectPath}
        onChooseFolder={async () => (await window.mixdogDesktop?.chooseProject()) ?? null}
        onCreateProject={projectsCreate}
        onRename={projectsRename}
        onRemove={projectsRemove}
        instructionsSupported={!!window.mixdogDesktop?.readInstructions}
        onReadInstructions={async (path) => (await window.mixdogDesktop?.readInstructions?.(path)) ?? ''}
        onSaveInstructions={projectsSaveInstructions}
        onMemoryControl={async (input) => (await window.mixdogDesktop.invokeCapability({
          capability: 'memoryControl',
          args: [input, { silent: true }],
        })).value} />
    </Suspense>
    </SidebarPanelBoundary>
    )}
  </>, [
    ProjectsPane,
    SchedulesPane,
    UtilitiesPane,
    WebhooksPane,
    WorkflowsPane,
    activeSidebarPanel,
    markSidebarPanelFailed,
    mountedSidebarPanels,
    projects,
    projectsCreate,
    projectsRemove,
    projectsRename,
    projectsSaveInstructions,
    retrySidebarPanel,
    runningAutomationNames,
    selectedProjectPath,
    utilitiesOpenExplorer,
    utilitiesOpenStudio,
    utilitiesOpenTerminal,
  ]);


  return {
    presentedSidebarPanel,
    sidebarNewTask,
    sidebarPanel,
    sidebarPanelChildren,
    sidebarPanelTitle,
    sidebarResumeSession,
    sidebarTreeMounted,
  };
}

import { Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DesktopProjectSummary } from "../shared/contract";
import { SidebarPanelBoundary } from "./sidebar-panel-surface";
import { SidebarPanelSection } from "./session-sidebar";
import type { SidebarPanelKey } from "./app-shell-components";
import type { ExtensionsSection } from "./extension-sections";
import type { useAppShellPanels } from "./use-app-shell-panels";
import { useStableEvent } from "./use-stable-event";
import type { SidebarViewGroup, SidebarViewPlacement } from "./sidebar-view-layout";

type ShellPanels = ReturnType<typeof useAppShellPanels>;

export function useAppSidebarSurface({
  utilitiesOpen,
  schedulesOpen,
  webhooksOpen,
  projectsOpen,
  workflowsOpen,
  sidebarOpen,
  viewGroups,
  getViewDragProps,
  onMoveView,
  loadedSidebarPanels,
  failedSidebarPanels,
  mountedSidebarPanels,
  sidebarPanes,
  markSidebarPanelFailed,
  retrySidebarPanel,
  runningAutomationNames,
  projects,
  selectedProjectPath,
  extensionsSection,
  onExtensionsSectionChange,
  closeSidebarForNavigation,
  startTask,
  openSession,
  openBrowserTab,
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
  viewGroups: readonly SidebarViewGroup[];
  getViewDragProps(panel: SidebarPanelKey): React.HTMLAttributes<HTMLElement>;
  onMoveView(
    sourceId: SidebarPanelKey,
    targetId: SidebarPanelKey,
    placement: SidebarViewPlacement,
  ): void;
  loadedSidebarPanels: ReadonlySet<string>;
  failedSidebarPanels: ReadonlySet<string>;
  mountedSidebarPanels: ReadonlySet<string>;
  sidebarPanes: ShellPanels["sidebarPanes"];
  markSidebarPanelFailed(panel: SidebarPanelKey): void;
  retrySidebarPanel(panel: SidebarPanelKey): void;
  runningAutomationNames: { schedule: Set<string>; webhook: Set<string> };
  projects: DesktopProjectSummary[];
  selectedProjectPath: string;
  extensionsSection: ExtensionsSection;
  onExtensionsSectionChange(section: ExtensionsSection): void;
  closeSidebarForNavigation(): void;
  startTask(): unknown;
  openSession(sessionId: string): unknown;
  openBrowserTab(): unknown;
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
  const sidebarGroupFor = (surface: SidebarSurface): readonly SidebarPanelKey[] =>
    surface === "sessions"
      ? []
      : viewGroups.find((group) => group.includes(surface)) ?? [surface];
  const requestedSidebarGroup = sidebarGroupFor(requestedSidebarSurface);
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
    || requestedSidebarGroup.every((panel) =>
      (loadedSidebarPanels.has(panel)
        // A failed chunk still has content to present: the panel-local
        // unavailable state. It is presentable, never warm.
        || failedSidebarPanels.has(panel))
      && mountedSidebarPanels.has(panel));
  // A resolved module whose pane is already mounted hidden is just as ready
  // as a previously presented destination: both can become visible in this
  // click's own commit. Projects is prepared this way after boot so its rows
  // and overflow options never first-mount in front of the user.
  const requestedSidebarSurfaceWarm = sidebarTreeMounted
    && (warmSidebarSurfaces.current.has(requestedSidebarSurface)
      || (requestedSidebarSurface !== "sessions"
        && requestedSidebarGroup.every((panel) =>
          loadedSidebarPanels.has(panel) && mountedSidebarPanels.has(panel))));
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
  useLayoutEffect(() => {
    if (!sidebarTreeMounted) {
      // The panel trees died with their host: nothing may claim to be warm.
      warmSidebarSurfaces.current = new Set(["sessions"]);
      return;
    }
    // Warm means committed usable content: the panel is mounted, its module
    // resolved, and it has actually been presented inside the open sidebar.
    if (!sidebarOpen || presentedSidebarSurface === "sessions") return;
    const presentedGroup = sidebarGroupFor(presentedSidebarSurface);
    if (!presentedGroup.every((panel) => loadedSidebarPanels.has(panel))) return;
    if (!presentedGroup.every((panel) => mountedSidebarPanels.has(panel))) return;
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
  // ACTIVE is the panel lifecycle the panes themselves see. A hidden sidebar
  // has no active destination: rail panels portal their editors to
  // document.body, where the sidebar's inert/aria-hidden does not reach, so a
  // titlebar/backdrop collapse must deactivate the panel even though the
  // request is unchanged. Panels close only their dialogs on deactivation and
  // keep list/filter state.
  const presentedSidebarGroup = sidebarGroupFor(presentedSidebarSurface);
  const presentedSidebarPanel = presentedSidebarSurface === "sessions"
    ? null
    : presentedSidebarGroup[0] ?? presentedSidebarSurface;
  const activeSidebarPanels = sidebarOpen
    ? new Set<SidebarPanelKey>(presentedSidebarGroup)
    : new Set<SidebarPanelKey>();
  const SchedulesPane = sidebarPanes.schedules;
  const WebhooksPane = sidebarPanes.webhooks;
  const ProjectsPane = sidebarPanes.projects;
  const WorkflowsPane = sidebarPanes.workflows;
  const UtilitiesPane = sidebarPanes.utilities;
  const ExtensionsPane = sidebarPanes.extensions;
  const sidebarPanelTitle = presentedSidebarPanel === "utilities" ? "Utilities"
    : presentedSidebarPanel === "schedules" ? "Schedules"
    : presentedSidebarPanel === "webhooks" ? "Webhooks"
    : presentedSidebarPanel === "projects" ? "Projects"
    : presentedSidebarPanel === "workflows" ? "Workflows"
    : presentedSidebarPanel === "extensions" ? "Extensions"
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
  const utilitiesOpenBrowser = useStableEvent(() => openBrowserTab());
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
  const renderSidebarPanel = (
    panel: SidebarPanelKey,
    active: boolean,
  ): React.ReactNode => {
    if (!mountedSidebarPanels.has(panel)) return null;
    const label = panel === "utilities" ? "Utilities"
      : panel === "schedules" ? "Schedules"
      : panel === "webhooks" ? "Webhooks"
      : panel === "projects" ? "Projects"
      : panel === "extensions" ? "Extensions"
      : "Workflows";
    const content = panel === "utilities"
      ? <UtilitiesPane active={active}
          onOpenBrowser={utilitiesOpenBrowser}
          onOpenStudio={utilitiesOpenStudio}
          onOpenTerminal={utilitiesOpenTerminal}
          onOpenExplorer={utilitiesOpenExplorer} />
      : panel === "schedules"
        ? <SchedulesPane active={active} runningNames={runningAutomationNames.schedule} />
        : panel === "webhooks"
          ? <WebhooksPane active={active} runningNames={runningAutomationNames.webhook} />
          : panel === "workflows"
            ? <WorkflowsPane active={active} />
            : panel === "extensions"
               ? <ExtensionsPane active={active} section={extensionsSection}
                   onSectionChange={onExtensionsSectionChange} />
            : <ProjectsPane active={active}
                projects={projects} selectedProjectPath={selectedProjectPath}
                onChooseFolder={async () => (await window.mixdogDesktop?.chooseProject()) ?? null}
                onCreateProject={projectsCreate}
                onRename={projectsRename}
                onRemove={projectsRemove}
                instructionsSupported={!!window.mixdogDesktop?.readInstructions}
                onReadInstructions={async (path) =>
                  (await window.mixdogDesktop?.readInstructions?.(path)) ?? ''}
                onSaveInstructions={projectsSaveInstructions}
                onMemoryControl={async (input) => (await window.mixdogDesktop.invokeCapability({
                  capability: 'memoryControl',
                  args: [input, { silent: true }],
                })).value} />;
    return <SidebarPanelBoundary label={label} active={active}
      onFailure={() => markSidebarPanelFailed(panel)}
      onRetry={() => retrySidebarPanel(panel)}>
      <Suspense fallback={null}>{content}</Suspense>
    </SidebarPanelBoundary>;
  };
  const sidebarPanelChildren = useMemo(() => {
    const sectioned = presentedSidebarGroup.length > 1;
    const panelSurface = (
      panel: SidebarPanelKey,
      label: string,
      render: (active: boolean) => React.ReactNode,
    ) => {
      const active = activeSidebarPanels.has(panel);
      return <SidebarPanelSection key={panel} id={panel} title={label}
        active={active} sectioned={sectioned && active}
        order={active ? presentedSidebarGroup.indexOf(panel) : undefined}
        dragProps={getViewDragProps(panel)} onMoveView={onMoveView}>
        {(sectionActive) => (
          <SidebarPanelBoundary label={label} active={sectionActive}
            onFailure={() => markSidebarPanelFailed(panel)}
            onRetry={() => retrySidebarPanel(panel)}>
            <Suspense fallback={null}>{render(sectionActive)}</Suspense>
          </SidebarPanelBoundary>
        )}
      </SidebarPanelSection>;
    };
    return <>
    {/* One bounded boundary per destination: a rejected chunk becomes a
        compact panel-local unavailable state instead of escaping to the
        root and replacing the whole app. */}
    {mountedSidebarPanels.has("utilities") && (
    panelSurface("utilities", "Utilities", (active) =>
      <UtilitiesPane active={active}
        onOpenBrowser={utilitiesOpenBrowser}
        onOpenStudio={utilitiesOpenStudio}
        onOpenTerminal={utilitiesOpenTerminal}
        onOpenExplorer={utilitiesOpenExplorer} />)
    )}
    {mountedSidebarPanels.has("schedules") && (
    panelSurface("schedules", "Schedules", (active) =>
      <SchedulesPane active={active}
        runningNames={runningAutomationNames.schedule} />)
    )}
    {mountedSidebarPanels.has("webhooks") && (
    panelSurface("webhooks", "Webhooks", (active) =>
      <WebhooksPane active={active}
        runningNames={runningAutomationNames.webhook} />)
    )}
    {mountedSidebarPanels.has("workflows") && (
    panelSurface("workflows", "Workflows", (active) =>
      <WorkflowsPane active={active} />)
    )}
    {mountedSidebarPanels.has("extensions") && (
    panelSurface("extensions", "Extensions", (active) =>
      <ExtensionsPane active={active} section={extensionsSection}
        onSectionChange={onExtensionsSectionChange} />)
    )}
    {mountedSidebarPanels.has("projects") && (
    panelSurface("projects", "Projects", (active) =>
      <ProjectsPane active={active}
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
        })).value} />)
    )}
  </>;
  }, [
    ProjectsPane,
    SchedulesPane,
    UtilitiesPane,
    WebhooksPane,
    WorkflowsPane,
    ExtensionsPane,
    activeSidebarPanels,
    getViewDragProps,
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
    extensionsSection,
    onExtensionsSectionChange,
    onMoveView,
    presentedSidebarGroup,
    utilitiesOpenBrowser,
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
    renderSidebarPanel,
  };
}

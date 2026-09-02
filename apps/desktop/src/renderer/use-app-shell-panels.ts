import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { defaultSessionLaneStore, useSessionLane } from "./session-lane-store";
import { getSidePanelMode, sidePanelLayout, subscribeSidePanelMode, type SidePanelMode } from "./side-panel-preferences";
import type { CommandSurface as CommandSurfaceName } from "./slash-commands";
import type { SettingsSection as SettingsViewSection } from "./settings/SettingsView";
import { useBottomPanelState } from "./BottomPanel";
import { desktopFeatureEnabled } from "./desktop-feature-config";
import { DEFAULT_PROBLEMS_PANEL_FILTER, type ProblemsPanelFilter } from "./WorkbenchProblems";
import {
  createExtensionsPane,
  createProjectsPane,
  createSchedulesPane,
  createWebhooksPane,
  createWorkflowsPane,
  loadSidebarPanelModule,
  type SidebarPanelKey,
} from "./app-shell-components";
import { useSidePanelOpenFlip } from "./app-side-panel-flip";
import { usePageHideFlush } from "./layout-persistence";
import { useResponsiveShellBands } from "./use-responsive-shell-bands";

const SIDEBAR_OPEN_KEY = "mixdog.desktop-sidebar-open.v1";

export function useAppShellPanels(activeBottomPanelPaneId: string) {
  const preferredSidePanelMode = useSyncExternalStore(
    subscribeSidePanelMode,
    getSidePanelMode,
    (): SidePanelMode => "close-both",
  );
  // Narrow web/desktop windows use the both-folding policy; the layout now
  // depends only on available resolution, never device or pointer type.
  const { narrowShell, bottomSheetBand } = useResponsiveShellBands();
  const responsiveSidePanels = narrowShell;
  const activeSidePanelMode = responsiveSidePanels ? "close-both" : preferredSidePanelMode;
  const activeSidePanelLayout = sidePanelLayout(activeSidePanelMode);
  // Chrome-like responsive side panels (user decision): crossing into the
  // narrow band changes the panels' MODE (inline → overlay drawer), never
  // their meaning — a drawer always starts closed, and returning to the
  // desktop band restores the inline open/collapsed states exactly as they
  // were (접혀있던 걸 굳이 펼치거나 펼쳐져 있던 걸 굳이 접지 않기).
  const wasNarrowShell = useRef(narrowShell);
  // Callback-safe mirror: the sheet-exclusivity rule below runs inside
  // stable useCallbacks and must read the CURRENT band.
  const narrowShellRef = useRef(narrowShell);
  narrowShellRef.current = narrowShell;
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    if (!desktopFeatureEnabled("sessions")) return false;
    if (activeSidePanelLayout.sidebarLockedOpen) return true;
    try {
      if (responsiveSidePanels) return false;
      // Default layout starts MINIMIZED on both edges (user decision): only
      // an explicit stored "true" (the user opened it before) restores an
      // open sidebar. The right dock already defaults to closed.
      return window.localStorage.getItem(SIDEBAR_OPEN_KEY) === "true";
    } catch {
      return false;
    }
  });
  const desktopSidebarOpen = useRef(sidebarOpen);
  const persistSidebarState = useCallback(() => {
    if (narrowShell || wasNarrowShell.current) return;
    desktopSidebarOpen.current = sidebarOpen;
    try { window.localStorage.setItem(SIDEBAR_OPEN_KEY, String(sidebarOpen)); }
    catch { /* layout persistence is a convenience only */ }
  }, [narrowShell, sidebarOpen]);
  usePageHideFlush(persistSidebarState);
  useEffect(() => {
    // Narrow-band drawer toggles are transient: they update neither the
    // stored preference nor the restore target. The wasNarrowShell guard
    // also holds the first wide render back until the crossing effect below
    // has re-applied the inline state.
    if (narrowShell || wasNarrowShell.current) return;
    const timer = window.setTimeout(persistSidebarState, 120);
    return () => window.clearTimeout(timer);
  }, [narrowShell, persistSidebarState]);
  // Projects panel (rail → Projects): hosted in the session-panel area with
  // popup editors (user decision — Schedules grammar, no takeover).
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsViewSection | null>(null);
  const [commandSurface, setCommandSurface] = useState<CommandSurfaceName | null>(null);
  const [commandSurfaceSessionId, setCommandSurfaceSessionId] = useState("");
  const commandSurfaceLane = useSessionLane(commandSurfaceSessionId, defaultSessionLaneStore);
  // The session travels WITH the open request. The clear used to live here
  // unconditionally, so a caller that had just named its pane session saw it
  // wiped inside the same batch and /context read the blank control session
  // instead (user: /context가 0으로 나온다). A surface that owns no
  // conversation simply passes nothing.
  const openConversationCommandSurface = useCallback((
    surface: CommandSurfaceName,
    sessionId = "",
  ) => {
    if (surface === "usage" && !desktopFeatureEnabled("usage")) return;
    setSettingsOpen(false);
    setCommandSurfaceSessionId(
      surface === "context" || surface === "inherit" ? sessionId : "");
    setCommandSurface(surface);
  }, []);
  // The right dock is now PER-PANE state (pane-side-dock.tsx); this hook
  // keeps the window-level drawer, bottom panel, and rail surfaces only.
  const bottomPanel = useBottomPanelState(activeBottomPanelPaneId);
  const [problemsFilter, setProblemsFilter] = useState<ProblemsPanelFilter>(
    () => ({ ...DEFAULT_PROBLEMS_PANEL_FILTER }),
  );
  const [problemsCollapseNonce, setProblemsCollapseNonce] = useState(0);
  // View Transition update callbacks can land a frame after the click. Keep
  // the user's latest intent separately so rapid toggles never read a stale
  // rendered state or let an older close completion reverse the newest input.
  const sidebarOpenIntent = useRef(sidebarOpen);
  const [sidebarMotion, setSidebarMotion] = useState<"animated" | "instant">("animated");
  const applySidebarOpen = useCallback((
    open: boolean,
    motion: "animated" | "instant" = "animated",
  ) => {
    sidebarOpenIntent.current = open;
    setSidebarMotion(motion);
    setSidebarOpen(open);
  }, []);
  // The bottom panel is the SAME kind of narrow-band surface as the side
  // sheets (user: 하단 탭도 좌우 탭과 같은 취급 — 겹치면 안 된다): while a
  // sheet would overlap it (dock ≤940px, drawer ≤760px), opening either
  // side folds the bottom panel, mirroring the bottom-panel toggle that
  // folds the sheets. Wide inline layouts coexist untouched.
  const dismissBottomPanelForSheet = useCallback((band: "dock" | "drawer") => {
    const query = band === "dock" ? "(max-width: 940px)" : "(max-width: 760px)";
    if (window.matchMedia?.(query).matches === true && bottomPanel.open) {
      bottomPanel.setOpen(false);
    }
  }, [bottomPanel]);
  const appliedSidePanelMode = useRef(activeSidePanelMode);
  useEffect(() => {
    // Existing installs retain their last folding state on launch. A mode
    // CHANGE applies immediately; navigation applies the same exact policy.
    if (appliedSidePanelMode.current === activeSidePanelMode) return;
    appliedSidePanelMode.current = activeSidePanelMode;
    applySidebarOpen(activeSidePanelLayout.sidebarOpen && desktopFeatureEnabled("sessions"));
    // The dock half of the policy applies inside usePaneSideDocks.
  }, [activeSidePanelMode]);
  // Manual toggles ALWAYS win (user: a dead open/close button reads as a
  // bug). The keep-open policy re-applies on the next navigation instead of
  // rejecting the click outright.
  // Both directions commit their final layout synchronously in one frame,
  // without snapshot interpolation.
  const {
    mainPanel: mainPanelRef,
    beginOpen: beginSidePanelOpen,
    beginClose: beginSidePanelClose,
  } = useSidePanelOpenFlip();
  const openSidebar = useCallback(() => {
    if (sidebarOpenIntent.current) return;
    sidebarOpenIntent.current = true;
    dismissBottomPanelForSheet("drawer");
    beginSidePanelOpen("sidebar", () => applySidebarOpen(true));
  }, [applySidebarOpen, beginSidePanelOpen, dismissBottomPanelForSheet]);
  // Toggle spam queues expensive panel mounts and replays them after the
  // clicks stop (user: 연타하면 예약되어서 여러 번 열린다): clicks inside
  // one motion window coalesce into the FIRST one instead of stacking.
  // The window is measured on the EVENT clock, not the handler clock: a
  // mount that blocks longer than the window would otherwise re-space the
  // queued clicks and let every one of them through (user: 여러 번 예약된
  // 것처럼 다시 열려).
  const lastSidePanelToggle = useRef(0);
  const sidePanelToggleReady = useCallback((stamp?: number) => {
    const now = typeof stamp === "number" && stamp > 0 ? stamp : performance.now();
    if (lastSidePanelToggle.current > 0
      && now - lastSidePanelToggle.current < 220) return false;
    lastSidePanelToggle.current = now;
    return true;
  }, []);
  const toggleSidebar = useCallback((event?: { timeStamp?: number }) => {
    if (!sidebarOpenIntent.current && !desktopFeatureEnabled("sessions")) return;
    if (!sidePanelToggleReady(event?.timeStamp)) return;
    const nextOpen = !sidebarOpenIntent.current;
    sidebarOpenIntent.current = nextOpen;
    if (nextOpen) {
      dismissBottomPanelForSheet("drawer");
      beginSidePanelOpen("sidebar", () => applySidebarOpen(true));
    } else {
      beginSidePanelClose("sidebar", () => applySidebarOpen(false));
    }
  }, [applySidebarOpen, beginSidePanelClose, beginSidePanelOpen, dismissBottomPanelForSheet, sidePanelToggleReady]);
  // Expanding the bottom panel in the sheet band dismisses the overlay
  // drawer — last press wins. The right dock lives INSIDE each pane now, so
  // it no longer competes with the bottom panel as a window sheet.
  const dismissSheetsForBottomPanel = useCallback(() => {
    if (window.matchMedia?.("(max-width: 940px)").matches !== true) return;
    if (narrowShellRef.current && sidebarOpenIntent.current) applySidebarOpen(false);
  }, [applySidebarOpen]);
  const toggleBottomPanel = useCallback(() => {
    if (!bottomPanel.open) dismissSheetsForBottomPanel();
    bottomPanel.toggle();
  }, [bottomPanel, dismissSheetsForBottomPanel]);
  // The breakpoint crossing itself (user: 축소할 때 왼쪽 세션창은 숨기고
  // 다시 늘리면 열리게 — 아래쪽도): the LEFT drawer hides on the way IN and
  // the stored inline state returns on the way OUT; the RIGHT sheet is the
  // one surface that survives the crossing (user: 오른쪽이 우선순위가
  // 높다). The bottom panel follows the same hide/restore rule on its own
  // 940px sheet band below. Runs after the side-panel mode effect above so
  // a mode-policy write never overrides the restore.
  useEffect(() => {
    if (wasNarrowShell.current === narrowShell) return;
    wasNarrowShell.current = narrowShell;
    if (narrowShell) {
      if (sidebarOpenIntent.current) applySidebarOpen(false, "instant");
      return;
    }
    if (desktopSidebarOpen.current !== sidebarOpenIntent.current) {
      applySidebarOpen(desktopSidebarOpen.current, "instant");
    }
  }, [narrowShell, applySidebarOpen]);
  // Bottom panel band (≤940px = the width where it becomes an overlay
  // sheet): hide on shrink, restore the stored wide state on expand.
  const wasBottomSheetBand = useRef(bottomSheetBand);
  const desktopBottomPanelOpen = useRef(bottomPanel.open);
  useEffect(() => {
    // Narrow-band opens are transient, exactly like the drawer's.
    if (bottomSheetBand || wasBottomSheetBand.current) return;
    desktopBottomPanelOpen.current = bottomPanel.open;
  }, [bottomPanel.open, bottomSheetBand]);
  useEffect(() => {
    if (wasBottomSheetBand.current === bottomSheetBand) return;
    wasBottomSheetBand.current = bottomSheetBand;
    if (bottomSheetBand) {
      if (bottomPanel.open) bottomPanel.setOpen(false, "instant");
      return;
    }
    if (desktopBottomPanelOpen.current !== bottomPanel.open) {
      bottomPanel.setOpen(desktopBottomPanelOpen.current, "instant");
    }
  }, [bottomSheetBand, bottomPanel]);
  // Workflow and agent configuration panel (rail → Workflows).
  const [workflowsOpen, setWorkflowsOpen] = useState(false);
  // Rail destinations pre-mount hidden after boot and stay mounted while the
  // sidebar remains open. Their shared reference cache coalesces hydration, so
  // this constructs rows, route controls and overflow options without issuing
  // duplicate provider/catalog requests.
  const [mountedSidebarPanels, setMountedSidebarPanels] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const mountSidebarPanel = useCallback((panel: string) => {
    setMountedSidebarPanels((current) => {
      if (current.has(panel)) return current;
      return new Set([...current, panel]);
    });
  }, []);
  // "Already visited" is not enough to present a destination instantly: the
  // panel's lazy chunk must have RESOLVED, otherwise a fast swap would only
  // reveal the Suspense fallback (null) as an empty panel. A rejected chunk
  // never lands here, so that destination keeps the safe settle path.
  const [loadedSidebarPanels, setLoadedSidebarPanels] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const trackSidebarPanelModule = useCallback((panel: string, load: Promise<unknown>) => {
    void load.then(() => {
      setLoadedSidebarPanels((current) => {
        if (current.has(panel)) return current;
        return new Set([...current, panel]);
      });
    }).catch(() => { /* an unresolved chunk simply stays cold */ });
  }, []);
  // A rejected chunk is reported by the panel-local boundary. The destination
  // then presents a compact unavailable state (it has real content to show)
  // but never counts as warm, so it keeps the safe settle path.
  const [failedSidebarPanels, setFailedSidebarPanels] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [sidebarPanes, setSidebarPanes] = useState(() => ({
    schedules: createSchedulesPane(),
    webhooks: createWebhooksPane(),
    projects: createProjectsPane(),
    workflows: createWorkflowsPane(),
    extensions: createExtensionsPane(),
  }));
  const markSidebarPanelFailed = useCallback((panel: SidebarPanelKey) => {
    setFailedSidebarPanels((current) => {
      if (current.has(panel)) return current;
      return new Set([...current, panel]);
    });
  }, []);
  const retrySidebarPanel = useCallback((panel: SidebarPanelKey) => {
    // A fresh lazy component is the only way back from a rejected loader.
    setSidebarPanes((current) => panel === "schedules"
      ? { ...current, schedules: createSchedulesPane() }
      : panel === "webhooks"
        ? { ...current, webhooks: createWebhooksPane() }
        : panel === "projects"
          ? { ...current, projects: createProjectsPane() }
          : panel === "extensions"
            ? { ...current, extensions: createExtensionsPane() }
          : { ...current, workflows: createWorkflowsPane() });
    setFailedSidebarPanels((current) => {
      if (!current.has(panel)) return current;
      const next = new Set(current);
      next.delete(panel);
      return next;
    });
    trackSidebarPanelModule(panel, loadSidebarPanelModule[panel]());
  }, [trackSidebarPanelModule]);
  // Scheduled-tasks panel (rail → Schedules): lives in the session-panel
  // area, so navigation leaves it alone (user decision).
  const [schedulesOpen, setSchedulesOpen] = useState(false);
  const openSchedules = useCallback(() => {
    if (!desktopFeatureEnabled("schedules")) return;
    mountSidebarPanel("schedules");
    trackSidebarPanelModule("schedules", loadSidebarPanelModule.schedules());
    setSchedulesOpen(true);
    setWebhooksOpen(false);
    setProjectsOpen(false);
    setWorkflowsOpen(false);
    openSidebar();
  }, [mountSidebarPanel, openSidebar, trackSidebarPanelModule]);
  // Inbound-webhooks panel: same session-panel concept as Schedules
  // (user decision — moved out of the settings dialog).
  const [webhooksOpen, setWebhooksOpen] = useState(false);
  const openWebhooks = useCallback(() => {
    if (!desktopFeatureEnabled("webhooks")) return;
    mountSidebarPanel("webhooks");
    trackSidebarPanelModule("webhooks", loadSidebarPanelModule.webhooks());
    setWebhooksOpen(true);
    setSchedulesOpen(false);
    setProjectsOpen(false);
    setWorkflowsOpen(false);
    openSidebar();
  }, [mountSidebarPanel, openSidebar, trackSidebarPanelModule]);
  const openProjects = useCallback(() => {
    if (!desktopFeatureEnabled("projects")) return;
    mountSidebarPanel("projects");
    trackSidebarPanelModule("projects", loadSidebarPanelModule.projects());
    setProjectsOpen(true);
    setSchedulesOpen(false);
    setWebhooksOpen(false);
    setWorkflowsOpen(false);
    openSidebar();
  }, [mountSidebarPanel, openSidebar, trackSidebarPanelModule]);
  const openWorkflows = useCallback(() => {
    if (!desktopFeatureEnabled("workflows")) return;
    mountSidebarPanel("workflows");
    trackSidebarPanelModule("workflows", loadSidebarPanelModule.workflows());
    setWorkflowsOpen(true);
    setSchedulesOpen(false);
    setWebhooksOpen(false);
    setProjectsOpen(false);
    openSidebar();
  }, [mountSidebarPanel, openSidebar, trackSidebarPanelModule]);
  // Returns the rail panel area to the Sessions list.
  const closeSidebarPanels = useCallback(() => {
    setSchedulesOpen(false);
    setWebhooksOpen(false);
    setProjectsOpen(false);
    setWorkflowsOpen(false);
  }, []);
  // A collapsed drawer forgets its rail destination on EVERY close path
  // (toggle, backdrop, exclusivity, band crossing): the next open always
  // starts from Sessions (user: 다시 열고 닫을 때 세션으로 초기화).
  useEffect(() => {
    if (!sidebarOpen) closeSidebarPanels();
  }, [closeSidebarPanels, sidebarOpen]);
  // Re-selecting the visible rail destination mirrors the Sessions button:
  // collapse the whole sidebar, but clear the destination first so the next
  // expand always starts from Sessions instead of restoring a stale panel.
  const closeActiveRailPanel = useCallback(() => {
    closeSidebarPanels();
    sidebarOpenIntent.current = false;
    beginSidePanelClose("sidebar", () => applySidebarOpen(false));
  }, [applySidebarOpen, beginSidePanelClose, closeSidebarPanels]);
  return {
    applySidebarOpen,
    bottomPanel,
    bottomSheetBand,
    closeActiveRailPanel,
    closeSidebarPanels,
    commandSurface,
    commandSurfaceLane,
    commandSurfaceSessionId,
    dismissSheetsForBottomPanel,
    failedSidebarPanels,
    loadedSidebarPanels,
    mainPanelRef,
    markSidebarPanelFailed,
    mountSidebarPanel,
    mountedSidebarPanels,
    openConversationCommandSurface,
    openProjects,
    openSchedules,
    openSidebar,
    openWebhooks,
    openWorkflows,
    problemsCollapseNonce,
    problemsFilter,
    projectsOpen,
    retrySidebarPanel,
    schedulesOpen,
    setCommandSurface,
    setCommandSurfaceSessionId,
    setProblemsCollapseNonce,
    setProblemsFilter,
    setSettingsOpen,
    setSettingsSection,
    settingsOpen,
    settingsSection,
    sidebarMotion,
    sidebarOpen,
    sidebarOpenIntent,
    sidebarPanes,
    toggleBottomPanel,
    toggleSidebar,
    trackSidebarPanelModule,
    wasBottomSheetBand,
    webhooksOpen,
    workflowsOpen,
  };
}

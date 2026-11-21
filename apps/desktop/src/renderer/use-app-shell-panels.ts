import {
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { announceDrawerDismiss, paintDrawerIntent, settleDrawerIntent } from './drawer-intent';
import { defaultSessionLaneStore, useSessionLane } from './session-lane-store';
import {
  getSidePanelMode,
  sidePanelLayout,
  subscribeSidePanelMode,
  type SidePanelMode,
} from './side-panel-preferences';
import type { CommandSurface as CommandSurfaceName } from './slash-commands';
import type { SettingsSection as SettingsViewSection } from './settings/SettingsView';
import { useBottomPanelState } from './BottomPanel';
import { desktopFeatureEnabled } from './desktop-feature-config';
import { DEFAULT_PROBLEMS_PANEL_FILTER, type ProblemsPanelFilter } from './WorkbenchProblems';
import {
  createExtensionsPane,
  createProjectsPane,
  createSkillsPane,
  createSchedulesPane,
  createWebhooksPane,
  createWorkflowsPane,
  loadSidebarPanelModule,
  type SidebarPanelKey,
} from './app-shell-components';
import { useSidePanelOpenFlip } from './app-side-panel-flip';
import { usePageHideFlush } from './layout-persistence';
import { NEW_SCHEDULE_REQUEST_EVENT } from './routine-editor-request';
import { BOTTOM_SHEET_QUERY, NARROW_SHELL_QUERY, useResponsiveShellBands } from './use-responsive-shell-bands';

const SIDEBAR_OPEN_KEY = 'mixdog.desktop-sidebar-open.v1';

/** The rail destinations' mount, chunk-load and failure bookkeeping. */
function useSidebarPanelRegistry() {
  const [mountedSidebarPanels, setMountedSidebarPanels] = useState<ReadonlySet<string>>(() => new Set());
  const mountSidebarPanel = useCallback((panel: string) => {
    setMountedSidebarPanels((current) => {
      if (current.has(panel)) return current;
      return new Set([...current, panel]);
    });
  }, []);
  const [loadedSidebarPanels, setLoadedSidebarPanels] = useState<ReadonlySet<string>>(() => new Set());
  const trackSidebarPanelModule = useCallback((panel: string, load: Promise<unknown>) => {
    void load
      .then(() => {
        setLoadedSidebarPanels((current) => {
          if (current.has(panel)) return current;
          return new Set([...current, panel]);
        });
      })
      .catch(() => {
        /* an unresolved chunk simply stays cold */
      });
  }, []);
  // A rejected chunk is reported by the panel-local boundary. The destination
  // then presents a compact unavailable state (it has real content to show)
  // but never counts as warm, so it keeps the safe settle path.
  const [failedSidebarPanels, setFailedSidebarPanels] = useState<ReadonlySet<string>>(() => new Set());
  const [sidebarPanes, setSidebarPanes] = useState(() => ({
    schedules: createSchedulesPane(),
    webhooks: createWebhooksPane(),
    projects: createProjectsPane(),
    workflows: createWorkflowsPane(),
    extensions: createExtensionsPane(),
    skills: createSkillsPane(),
  }));
  const markSidebarPanelFailed = useCallback((panel: SidebarPanelKey) => {
    setFailedSidebarPanels((current) => {
      if (current.has(panel)) return current;
      return new Set([...current, panel]);
    });
  }, []);
  const retrySidebarPanel = useCallback(
    (panel: SidebarPanelKey) => {
      // A fresh lazy component is the only way back from a rejected loader.
      setSidebarPanes((current) => {
        if (panel === 'schedules') return { ...current, schedules: createSchedulesPane() };
        if (panel === 'webhooks') return { ...current, webhooks: createWebhooksPane() };
        if (panel === 'projects') return { ...current, projects: createProjectsPane() };
        if (panel === 'workflows') return { ...current, workflows: createWorkflowsPane() };
        if (panel === 'skills') return { ...current, skills: createSkillsPane() };
        return { ...current, extensions: createExtensionsPane() };
      });
      setFailedSidebarPanels((current) => {
        if (!current.has(panel)) return current;
        const next = new Set(current);
        next.delete(panel);
        return next;
      });
      trackSidebarPanelModule(panel, loadSidebarPanelModule[panel]());
    },
    [trackSidebarPanelModule]
  );
  return {
    mountedSidebarPanels,
    mountSidebarPanel,
    loadedSidebarPanels,
    trackSidebarPanelModule,
    failedSidebarPanels,
    sidebarPanes,
    markSidebarPanelFailed,
    retrySidebarPanel,
  };
}

/** Bottom panel band (≤940px = the width where it becomes an overlay sheet):
 *  hide on shrink, restore the stored wide state on expand. Returns the ref
 *  holding whether the previous render was in the sheet band. */
function useBottomPanelBandRestore(bottomPanel: ReturnType<typeof useBottomPanelState>, bottomSheetBand: boolean) {
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
      if (bottomPanel.open) bottomPanel.setOpen(false, 'instant');
      return;
    }
    if (desktopBottomPanelOpen.current !== bottomPanel.open) {
      bottomPanel.setOpen(desktopBottomPanelOpen.current, 'instant');
    }
  }, [bottomSheetBand, bottomPanel]);
  return wasBottomSheetBand;
}

/** Which rail destination (Schedules, Webhooks, Projects) the session-panel
 *  area shows, if any; navigation leaves it alone and a closed drawer resets it. */
function useRailPanels({
  sidebarOpen,
  openSidebar,
  mountSidebarPanel,
  trackSidebarPanelModule,
}: {
  sidebarOpen: boolean;
  openSidebar: () => void;
  mountSidebarPanel: (panel: string) => void;
  trackSidebarPanelModule: (panel: string, load: Promise<unknown>) => void;
}) {
  const [schedulesOpen, setSchedulesOpen] = useState(false);
  const [webhooksOpen, setWebhooksOpen] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const showRailPanel = useCallback(
    (panel: 'schedules' | 'webhooks' | 'projects') => {
      if (!desktopFeatureEnabled(panel)) return;
      mountSidebarPanel(panel);
      trackSidebarPanelModule(panel, loadSidebarPanelModule[panel]());
      setSchedulesOpen(panel === 'schedules');
      setWebhooksOpen(panel === 'webhooks');
      setProjectsOpen(panel === 'projects');
      openSidebar();
    },
    [mountSidebarPanel, openSidebar, trackSidebarPanelModule]
  );
  const openSchedules = useCallback(() => showRailPanel('schedules'), [showRailPanel]);
  const openWebhooks = useCallback(() => showRailPanel('webhooks'), [showRailPanel]);
  const openProjects = useCallback(() => showRailPanel('projects'), [showRailPanel]);
  // A bot room's "Create routine" opens the panel; the panel opens its editor.
  useEffect(() => {
    window.addEventListener(NEW_SCHEDULE_REQUEST_EVENT, openSchedules);
    return () => window.removeEventListener(NEW_SCHEDULE_REQUEST_EVENT, openSchedules);
  }, [openSchedules]);
  // Returns the rail panel area to the Sessions list.
  const closeSidebarPanels = useCallback(() => {
    setSchedulesOpen(false);
    setWebhooksOpen(false);
    setProjectsOpen(false);
  }, []);
  // A collapsed drawer forgets its rail destination on EVERY close path
  // (toggle, backdrop, exclusivity, band crossing): the next open always
  // starts from Sessions.
  useEffect(() => {
    if (!sidebarOpen) closeSidebarPanels();
  }, [closeSidebarPanels, sidebarOpen]);
  return { schedulesOpen, webhooksOpen, projectsOpen, openSchedules, openWebhooks, openProjects, closeSidebarPanels };
}

function useCommandSurfaceState() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsViewSection | null>(null);
  const [commandSurface, setCommandSurface] = useState<CommandSurfaceName | null>(null);
  const [commandSurfaceSessionId, setCommandSurfaceSessionId] = useState('');
  const commandSurfaceLane = useSessionLane(commandSurfaceSessionId, defaultSessionLaneStore);
  const openConversationCommandSurface = useCallback((surface: CommandSurfaceName, sessionId = '') => {
    if (surface === 'stats' && !desktopFeatureEnabled('usage')) return;
    setSettingsOpen(false);
    setCommandSurfaceSessionId(surface === 'context' || surface === 'inherit' ? sessionId : '');
    setCommandSurface(surface);
  }, []);
  return {
    settingsOpen,
    setSettingsOpen,
    settingsSection,
    setSettingsSection,
    commandSurface,
    setCommandSurface,
    commandSurfaceSessionId,
    setCommandSurfaceSessionId,
    commandSurfaceLane,
    openConversationCommandSurface,
  };
}

function useSidePanelToggleGate() {
  const lastToggle = useRef(0);
  return useCallback((stamp?: number) => {
    const now = typeof stamp === 'number' && stamp > 0 ? stamp : performance.now();
    if (lastToggle.current > 0 && now - lastToggle.current < 220) return false;
    lastToggle.current = now;
    return true;
  }, []);
}

export function useAppShellPanels(activeBottomPanelPaneId: string) {
  const preferredSidePanelMode = useSyncExternalStore(
    subscribeSidePanelMode,
    getSidePanelMode,
    (): SidePanelMode => 'close-both'
  );
  // Narrow web/desktop windows use the both-folding policy; the layout now
  // depends only on available resolution, never device or pointer type.
  const { narrowShell, bottomSheetBand } = useResponsiveShellBands();
  const responsiveSidePanels = narrowShell;
  const activeSidePanelMode = responsiveSidePanels ? 'close-both' : preferredSidePanelMode;
  const activeSidePanelLayout = sidePanelLayout(activeSidePanelMode);
  const wasNarrowShell = useRef(narrowShell);
  // Callback-safe mirror: the sheet-exclusivity rule below runs inside
  // stable useCallbacks and must read the CURRENT band.
  const narrowShellRef = useRef(narrowShell);
  narrowShellRef.current = narrowShell;
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    if (!desktopFeatureEnabled('sessions')) return false;
    if (activeSidePanelLayout.sidebarLockedOpen) return true;
    try {
      if (responsiveSidePanels) return false;
      // First launch starts with the session sidebar OPEN (user decision):
      // only an explicit stored "false" (the user folded it before) keeps it
      // minimized. The right dock still defaults to closed.
      return window.localStorage.getItem(SIDEBAR_OPEN_KEY) !== 'false';
    } catch {
      return false;
    }
  });
  const desktopSidebarOpen = useRef(sidebarOpen);
  const persistSidebarState = useCallback(() => {
    if (narrowShell || wasNarrowShell.current) return;
    desktopSidebarOpen.current = sidebarOpen;
    try {
      window.localStorage.setItem(SIDEBAR_OPEN_KEY, String(sidebarOpen));
    } catch {
      /* layout persistence is a convenience only */
    }
  }, [narrowShell, sidebarOpen]);
  usePageHideFlush(persistSidebarState);
  useEffect(() => {
    if (narrowShell || wasNarrowShell.current) return;
    const timer = window.setTimeout(persistSidebarState, 120);
    return () => window.clearTimeout(timer);
  }, [narrowShell, persistSidebarState]);
  const {
    settingsOpen,
    setSettingsOpen,
    settingsSection,
    setSettingsSection,
    commandSurface,
    setCommandSurface,
    commandSurfaceSessionId,
    setCommandSurfaceSessionId,
    commandSurfaceLane,
    openConversationCommandSurface,
  } = useCommandSurfaceState();
  // The right dock is PER-PANE state (pane-side-dock.tsx); this hook
  // keeps the window-level drawer, bottom panel, and rail surfaces only.
  const bottomPanel = useBottomPanelState(activeBottomPanelPaneId);
  const [problemsFilter, setProblemsFilter] = useState<ProblemsPanelFilter>(() => ({
    ...DEFAULT_PROBLEMS_PANEL_FILTER,
  }));
  const [problemsCollapseNonce, setProblemsCollapseNonce] = useState(0);
  const sidebarOpenIntent = useRef(sidebarOpen);
  // Every route to a closed drawer (toggle, swipe, backdrop, back gesture, a
  // navigation) records its intent here, and announces it at once: a request
  // waiting on the open drawer must not outlive the dismissal into the commit.
  const setSidebarIntent = useCallback((open: boolean) => {
    sidebarOpenIntent.current = open;
    if (!open) announceDrawerDismiss();
  }, []);
  const [sidebarMotion, setSidebarMotion] = useState<'animated' | 'instant'>('animated');
  const applySidebarOpen = useCallback(
    (open: boolean, motion: 'animated' | 'instant' = 'animated') => {
      setSidebarIntent(open);
      if (narrowShellRef.current && motion === 'animated') {
        // A phone drawer tap: the sheet's look flips through CSS on this very
        // frame, and the shell's heavy render commits as a transition behind it.
        paintDrawerIntent(open);
        startTransition(() => {
          setSidebarMotion(motion);
          setSidebarOpen(open);
        });
        return;
      }
      setSidebarMotion(motion);
      setSidebarOpen(open);
    },
    [setSidebarIntent]
  );
  // Every commit checks whether the rendered drawer has reached the latest
  // tap's intent; only then does the CSS stamp go.
  useLayoutEffect(() => {
    settleDrawerIntent(sidebarOpen, sidebarOpenIntent.current);
  });
  const dismissBottomPanelForSheet = useCallback(
    (band: 'dock' | 'drawer') => {
      const query = band === 'dock' ? BOTTOM_SHEET_QUERY : NARROW_SHELL_QUERY;
      if (window.matchMedia?.(query).matches === true && bottomPanel.open) {
        bottomPanel.setOpen(false);
      }
    },
    [bottomPanel]
  );
  const appliedSidePanelMode = useRef(activeSidePanelMode);
  // biome-ignore lint/correctness/useExhaustiveDependencies: applies only when the side-panel mode changes; layout and applySidebarOpen are read at that moment
  useEffect(() => {
    // Existing installs retain their last folding state on launch. A mode
    // CHANGE applies immediately; navigation applies the same exact policy.
    if (appliedSidePanelMode.current === activeSidePanelMode) return;
    appliedSidePanelMode.current = activeSidePanelMode;
    applySidebarOpen(activeSidePanelLayout.sidebarOpen && desktopFeatureEnabled('sessions'));
    // The dock half of the policy applies inside usePaneSideDocks.
  }, [activeSidePanelMode]);
  const { mainPanel: mainPanelRef } = useSidePanelOpenFlip(narrowShell);
  const openSidebar = useCallback(() => {
    if (sidebarOpenIntent.current) return;
    sidebarOpenIntent.current = true;
    dismissBottomPanelForSheet('drawer');
    applySidebarOpen(true);
  }, [applySidebarOpen, dismissBottomPanelForSheet]);
  const sidePanelToggleReady = useSidePanelToggleGate();
  const toggleSidebar = useCallback(
    (event?: { timeStamp?: number }) => {
      if (!sidebarOpenIntent.current && !desktopFeatureEnabled('sessions')) return;
      if (!sidePanelToggleReady(event?.timeStamp)) return;
      const nextOpen = !sidebarOpenIntent.current;
      setSidebarIntent(nextOpen);
      if (nextOpen) {
        dismissBottomPanelForSheet('drawer');
        applySidebarOpen(true);
      } else {
        applySidebarOpen(false);
      }
    },
    [applySidebarOpen, dismissBottomPanelForSheet, setSidebarIntent, sidePanelToggleReady]
  );
  // Expanding the bottom panel in the sheet band dismisses the overlay
  // drawer — last press wins. The right dock lives INSIDE each pane now, so
  // it no longer competes with the bottom panel as a window sheet.
  const dismissSheetsForBottomPanel = useCallback(() => {
    if (window.matchMedia?.(BOTTOM_SHEET_QUERY).matches !== true) return;
    if (narrowShellRef.current && sidebarOpenIntent.current) applySidebarOpen(false);
  }, [applySidebarOpen]);
  const toggleBottomPanel = useCallback(() => {
    if (!bottomPanel.open) dismissSheetsForBottomPanel();
    bottomPanel.toggle();
  }, [bottomPanel, dismissSheetsForBottomPanel]);
  useEffect(() => {
    if (wasNarrowShell.current === narrowShell) return;
    wasNarrowShell.current = narrowShell;
    if (narrowShell) {
      if (sidebarOpenIntent.current) applySidebarOpen(false, 'instant');
      return;
    }
    if (desktopSidebarOpen.current !== sidebarOpenIntent.current) {
      applySidebarOpen(desktopSidebarOpen.current, 'instant');
    }
  }, [narrowShell, applySidebarOpen]);
  const wasBottomSheetBand = useBottomPanelBandRestore(bottomPanel, bottomSheetBand);
  const {
    mountedSidebarPanels,
    mountSidebarPanel,
    loadedSidebarPanels,
    trackSidebarPanelModule,
    failedSidebarPanels,
    sidebarPanes,
    markSidebarPanelFailed,
    retrySidebarPanel,
  } = useSidebarPanelRegistry();
  const { schedulesOpen, webhooksOpen, projectsOpen, openSchedules, openWebhooks, openProjects, closeSidebarPanels } =
    useRailPanels({ sidebarOpen, openSidebar, mountSidebarPanel, trackSidebarPanelModule });
  // Re-selecting the visible rail destination mirrors the Sessions button:
  // collapse the whole sidebar, but clear the destination first so the next
  // expand always starts from Sessions instead of restoring a stale panel.
  const closeActiveRailPanel = useCallback(() => {
    closeSidebarPanels();
    setSidebarIntent(false);
    applySidebarOpen(false);
  }, [applySidebarOpen, closeSidebarPanels, setSidebarIntent]);
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
  };
}

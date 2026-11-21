import { startTransition, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { preloadAgentPool } from './AgentActivityPane';
import { loadOnboardingWizardModule, loadSidebarPanelModule, type SidebarPanelKey } from './app-shell-components';
import {
  preloadSessionGoalIsland,
  preloadUtilityDock,
  prewarmUtilityDockGitState,
  utilityDockModule,
} from './app-snapshot-views';
import { armBootWarmup, BOOT_WARMUP, BOOT_WARMUP_ARM_DELAY_MS, scheduleBootWarmup } from './boot-warmup';
import { onFirstConversationPaint } from './boot-metrics';
import { readMixyStatus } from './mixy-identity';
import { prefetchExplorerRoot } from './explorer-root-cache';
import { loadCommandSurfaceModule } from './command-surface-loader';
import { type ChunkPrefetchName, fetchChunkGraph } from './chunk-prefetch';
import { FIRST_SCREEN_DEFERRED_MODULES } from './first-screen-deferred';
import {
  desktopFeatureEnabled,
  desktopSidebarDestinationEnabled,
  desktopUtilityDockTabEnabled,
} from './desktop-feature-config';
import { applyDesktopThemePreference, getDesktopThemePreference } from './desktop-theme';
import { applyStoredSkin } from './desktop-skin';
import { installHostDisplaySync } from './host-display-sync';
import type { RecordValue } from './desktop-types';
import { prefetchSurfaceForSelection } from './lazy-widgets';
import { prefetchQuotaUsage } from './quota-usage-cache';
import { loadSidebarReferences, WORKFLOW_REFERENCE_KEYS } from './sidebar-reference-cache';
import { connectionQuality } from './network-conditions';
import { paneActiveSessionIds } from './pane-layout';
import type { usePaneWorkspace } from './pane-workspace-state';
import { isMobileDeviceSurface } from './mobile-surface';
import { isElectronRenderer, isNativeDesktopWindow, isRemoteHostRenderer } from './remote-ui-projection';
import { previewSessionTranscript, requestSessionRead, usesVisibleSessionActivation } from './session-read-request';
import { DEFAULT_SIDEBAR_VIEW_ORDER } from './sidebar-view-layout';
import { loadStudioViewModule } from './studio-loader';
import { asRecord, navigationKey } from './text-format';
import type { useAppShellPanels } from './use-app-shell-panels';
import { loadSidebarUsageModule } from './use-usage-rail-pin';
import { invokeOrHeld } from './section-capabilities';

import type { DesktopSessionSummary } from '../shared/contract';

/** Bounded so the warm reads stay a few small tails inside the renderer lane
 *  and daemon idle budgets. */
const RECENT_SESSION_WARMUP_COUNT = 6;
/** A phone with no touch this long takes its side-sheet panes anyway. */
const PHONE_SHEET_PANE_IDLE_MS = 30_000;

/** Background data stays cold on a metered/slow link (never on the native shell). */
function backgroundWarmupThrottled(): boolean {
  return !isNativeDesktopWindow() && connectionQuality() !== 'normal';
}

type ShellPanels = ReturnType<typeof useAppShellPanels>;
type SidebarModuleTracker = ShellPanels['trackSidebarPanelModule'];
type WarmupWorkspace = Pick<ReturnType<typeof usePaneWorkspace>, 'leaves' | 'focusedLeafId'>;

/** A phone keeps its secondary rail panels cold until its idle lane opens
 *  after the first conversation paints. */
function hiddenPanelsStayCold(): boolean {
  return isMobileDeviceSurface();
}

/** The phone's side-sheet pane chunks, last in the lane and only on a normal
 *  link. The lane only downloads them (modulepreload); each is evaluated on its first open. */
export function phoneSheetPaneWarmups(): Array<() => void> {
  if (connectionQuality() !== 'normal') return [];
  const panes: ChunkPrefetchName[] = [
    'diff',
    'terminal',
    'browser',
    'visualize',
    'editor',
    ...(desktopFeatureEnabled('settings') ? (['settings'] as const) : []),
  ];
  // Fetching and evaluating five chunks right after the first paint doubled
  // the blocking time of a cold open, so the lane takes them only once the
  // user touches the page, or after a long idle.
  return afterFirstPhoneTouch(() =>
    panes.map((name, index) =>
      scheduleBootWarmup({
        id: `module:phone-sheet:${name}`,
        priority: BOOT_WARMUP.phoneSheetPane + index,
        run: () => fetchChunkGraph(name),
      })
    )
  );
}

/** Queue phone warm-ups on the first touch (or key), or after a long idle. */
function afterFirstPhoneTouch(schedule: () => Array<() => void>): Array<() => void> {
  let cancels: Array<() => void> = [];
  const queue = () => {
    release();
    cancels = schedule();
  };
  const events = ['pointerdown', 'keydown'] as const;
  const timer = window.setTimeout(queue, PHONE_SHEET_PANE_IDLE_MS);
  function release() {
    window.clearTimeout(timer);
    for (const event of events) window.removeEventListener(event, queue, true);
  }
  for (const event of events) window.addEventListener(event, queue, { capture: true, passive: true });
  return [
    () => {
      release();
      for (const cancel of cancels) cancel();
    },
  ];
}

export function useAppModuleWarmup(startupSettled: boolean, trackSidebarPanelModule: SidebarModuleTracker) {
  useEffect(() => {
    if (!startupSettled) return undefined;
    const nativeWindow = isNativeDesktopWindow();
    const cancels = [
      ...(hiddenPanelsStayCold() ? phoneSheetPaneWarmups() : []),
      scheduleBootWarmup({
        id: 'module:session-goal',
        priority: BOOT_WARMUP.sessionGoalModule,
        run: () => preloadSessionGoalIsland().catch(() => {}),
      }),
    ];
    // In Electron these surfaces already load on restore, mount or open.
    // Keep the browser's idle warmup: its first open otherwise pays the relay
    // round trip for code as well as data.
    if (!isElectronRenderer()) {
      cancels.push(
        scheduleBootWarmup({
          id: 'module:studio',
          priority: BOOT_WARMUP.studioModule,
          run: () => loadStudioViewModule().catch(() => {}),
        }),
        scheduleBootWarmup({
          id: 'module:command-surface',
          priority: BOOT_WARMUP.commandSurfaceModule,
          run: () => loadCommandSurfaceModule().catch(() => {}),
        })
      );
      for (const [name, module] of Object.entries(FIRST_SCREEN_DEFERRED_MODULES)) {
        if (name === 'starter-guide' && hiddenPanelsStayCold()) continue;
        cancels.push(
          scheduleBootWarmup({
            id: `module:deferred:${name}`,
            priority: BOOT_WARMUP.surfaceChunk,
            run: () => module.load().catch(() => {}),
          })
        );
      }
    }
    // The subscription usage that dialog opens on: its first open after boot
    // waited on a cold ledger read. A remote client reads it when the dialog opens instead.
    if (desktopFeatureEnabled('usage') && !isRemoteHostRenderer()) {
      cancels.push(
        scheduleBootWarmup({
          id: 'data:quota-usage',
          priority: BOOT_WARMUP.quotaUsage,
          run: () => prefetchQuotaUsage(window.mixdogDesktop),
        })
      );
    }
    if (!nativeWindow && !hiddenPanelsStayCold()) {
      if (connectionQuality() === 'normal') {
        cancels.push(
          scheduleBootWarmup({
            id: 'module:utility-dock',
            priority: BOOT_WARMUP.utilityDockModule,
            run: () => preloadUtilityDock().catch(() => {}),
          })
        );
        for (const panel of DEFAULT_SIDEBAR_VIEW_ORDER) {
          if (!desktopSidebarDestinationEnabled(panel)) continue;
          cancels.push(
            scheduleBootWarmup({
              id: `module:sidebar:${panel}`,
              priority: BOOT_WARMUP.sidebarPanel,
              run: () => {
                const module = loadSidebarPanelModule[panel]();
                trackSidebarPanelModule(panel, module);
                return module.catch(() => {});
              },
            })
          );
        }
        if (desktopSidebarDestinationEnabled('workflows')) {
          cancels.push(
            scheduleBootWarmup({
              id: 'data:sidebar-workflows',
              priority: BOOT_WARMUP.sidebarPanel,
              run: () => loadSidebarReferences(window.mixdogDesktop, WORKFLOW_REFERENCE_KEYS).catch(() => {}),
            })
          );
        }
      }
    }
    return () => {
      for (const cancel of cancels) cancel();
    };
  }, [startupSettled, trackSidebarPanelModule]);
}

export function useStartupCommitMeasurement() {
  const measured = useRef(false);
  useEffect(() => {
    if (!import.meta.env?.DEV || measured.current) return;
    measured.current = true;
    performance.mark('mixdog:startup:first-commit');
    performance.measure(
      'mixdog:startup:entry-to-first-commit',
      'mixdog:startup:renderer-entry',
      'mixdog:startup:first-commit'
    );
    const duration = performance.getEntriesByName('mixdog:startup:entry-to-first-commit').at(-1)?.duration;
    console.info(`[perf] desktop startup first commit: ${duration?.toFixed(1) ?? '?'}ms`);
  }, []);
}

export function useAppAgentRailPreload() {
  useEffect(() => {
    // The agents panel is not on a phone's first screen: its catalog read
    // waits in the idle lane, behind the opening conversation.
    if (!hiddenPanelsStayCold()) {
      preloadAgentPool(window.mixdogDesktop);
      return undefined;
    }
    const cancels = [
      scheduleBootWarmup({
        id: 'data:agent-pool',
        priority: BOOT_WARMUP.agentPool,
        run: () => preloadAgentPool(window.mixdogDesktop),
      }),
      // Whether Mixy exists: the closed drawer's bot section reads it only when
      // shown, so its first opening added Mixy's row above the list in view.
      scheduleBootWarmup({
        id: 'data:mixy-status',
        priority: BOOT_WARMUP.agentPool,
        run: () => readMixyStatus(window.mixdogDesktop),
      }),
    ];
    return () => {
      for (const cancel of cancels) cancel();
    };
  }, []);
}

export function useAppThemePreference() {
  useEffect(() => {
    let live = true;
    const systemTheme =
      typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    // Desktop theme is local; it never changes the engine/TUI preference.
    const applyStoredPreference = () => {
      const preference = getDesktopThemePreference();
      if (!preference) return false;
      applyDesktopThemePreference(preference);
      return true;
    };
    const handleSystemThemeChange = () => {
      if (live && getDesktopThemePreference() === 'system') applyStoredPreference();
    };
    systemTheme?.addEventListener('change', handleSystemThemeChange);
    if (!applyStoredPreference()) applyDesktopThemePreference('dark');
    applyStoredSkin();
    // A paired browser with no theme/language of its own follows the host PC.
    const stopHostDisplaySync = installHostDisplaySync();
    return () => {
      live = false;
      stopHostDisplaySync();
      systemTheme?.removeEventListener('change', handleSystemThemeChange);
    };
  }, []);
}

export function useAppOnboarding(setSettingsOpen: Dispatch<SetStateAction<boolean>>) {
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [onboardingReady, setOnboardingReady] = useState(isRemoteHostRenderer);
  useEffect(() => {
    const openOnboarding = () => {
      setSettingsOpen(false);
      setOnboardingOpen(true);
    };
    window.addEventListener('mixdog:open-onboarding', openOnboarding);
    return () => window.removeEventListener('mixdog:open-onboarding', openOnboarding);
  }, [setSettingsOpen]);
  useEffect(() => {
    let live = true;
    const invoke = window.mixdogDesktop?.invokeCapability;
    // Phones and tablets never auto-open the wizard: setup belongs to the PC.
    if (!invoke || isMobileDeviceSurface()) {
      setOnboardingReady(true);
      return () => {
        live = false;
      };
    }
    void invokeOrHeld<RecordValue>(window.mixdogDesktop, { capability: 'getOnboardingStatus' })
      .then(async (result) => {
        if (asRecord(result?.value)?.completed !== false) return;
        // Keep the current frame while the wizard loads; Settings is not part of it.
        await loadOnboardingWizardModule().catch(() => undefined);
        if (live) setOnboardingOpen(true);
      })
      .catch(() => {})
      .finally(() => {
        if (live) setOnboardingReady(true);
      });
    return () => {
      live = false;
    };
  }, []);
  return { onboardingOpen, setOnboardingOpen, onboardingReady };
}

export function useLaunchTabMeasurements() {
  useEffect(() => {
    if (!window.mixdogDesktop?.perfLog) return undefined;
    const startedAt = performance.now();
    let last = '';
    const timers = [100, 400, 1000, 2000, 3500].map((delay) =>
      window.setTimeout(() => {
        const tab = document.querySelector('.workspace-tab');
        const box = tab?.getBoundingClientRect();
        const line = box
          ? `tabs=${document.querySelectorAll('.workspace-tab').length} left=${box.left.toFixed(1)} top=${box.top.toFixed(1)} w=${box.width.toFixed(1)} h=${box.height.toFixed(1)}`
          : 'tabs=0';
        if (line !== last) {
          last = line;
          window.mixdogDesktop?.perfLog?.(`launch-tab t=${(performance.now() - startedAt).toFixed(0)}ms ${line}`);
        }
      }, delay)
    );
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, []);
}

export function useAppWorkspaceWarmup({
  ready,
  workspace,
  sessions,
  mountSidebarPanel,
  trackSidebarPanelModule,
}: {
  ready: boolean;
  workspace: WarmupWorkspace;
  sessions: readonly DesktopSessionSummary[];
  mountSidebarPanel: ShellPanels['mountSidebarPanel'];
  trackSidebarPanelModule: SidebarModuleTracker;
}) {
  useTranscriptWarmup(ready, workspace, sessions);
  useSurfaceChunkWarmup(ready, workspace);
  useBootWarmupArm(ready);
  useSidebarMountWarmup(ready, mountSidebarPanel, trackSidebarPanelModule);
}

function useTranscriptWarmup(ready: boolean, workspace: WarmupWorkspace, sessions: readonly DesktopSessionSummary[]) {
  useEffect(() => {
    if (!ready || usesVisibleSessionActivation() || backgroundWarmupThrottled()) return undefined;
    const sessionIds = paneActiveSessionIds(workspace.leaves, workspace.focusedLeafId);
    if (sessionIds.length === 0) return undefined;
    const cancels = sessionIds.map((sessionId, index) =>
      scheduleBootWarmup({
        id: `transcript:${sessionId}`,
        priority: BOOT_WARMUP.transcript + index,
        run: () => requestSessionRead(sessionId),
      })
    );
    return () => {
      for (const cancel of cancels) cancel();
    };
  }, [ready, workspace.focusedLeafId, workspace.leaves]);
  // Once per boot, preview recent transcripts without opening their runtimes.
  const recentWarmed = useRef(false);
  useEffect(() => {
    if (!ready || recentWarmed.current || !usesVisibleSessionActivation() || sessions.length === 0) return;
    recentWarmed.current = true;
    const open = new Set(paneActiveSessionIds(workspace.leaves, workspace.focusedLeafId));
    sessions
      .filter((session) => !session.archived && !session.sourceType && !open.has(session.id))
      .sort((left, right) => (right.activityAt ?? right.updatedAt) - (left.activityAt ?? left.updatedAt))
      .slice(0, RECENT_SESSION_WARMUP_COUNT)
      .forEach((session, index) => {
        scheduleBootWarmup({
          id: `transcript:${session.id}`,
          priority: BOOT_WARMUP.recentTranscript + index,
          run: () => previewSessionTranscript(session.id),
        });
      });
  }, [ready, sessions, workspace.focusedLeafId, workspace.leaves]);
}

function useSurfaceChunkWarmup(ready: boolean, workspace: WarmupWorkspace) {
  useEffect(() => {
    if (!ready || backgroundWarmupThrottled()) return undefined;
    const queue = workspace.leaves.flatMap((leaf) => [...leaf.tabs]);
    if (queue.length === 0) return undefined;
    const cancels = queue.map((selection, index) =>
      scheduleBootWarmup({
        id: `chunk:${navigationKey(selection)}`,
        priority: BOOT_WARMUP.surfaceChunk + index,
        run: () => prefetchSurfaceForSelection(selection),
      })
    );
    return () => {
      for (const cancel of cancels) cancel();
    };
  }, [ready, workspace.leaves]);
}

function useBootWarmupArm(ready: boolean) {
  useEffect(() => {
    if (!ready) return undefined;
    const nativeWindow = isNativeDesktopWindow();
    const host = window as typeof window & { __mixdogWindowShown?: boolean };
    let fallbackTimer = 0;
    const arm = () => {
      window.removeEventListener('mixdog:window-shown', arm);
      window.clearTimeout(fallbackTimer);
      armBootWarmup(BOOT_WARMUP_ARM_DELAY_MS);
    };
    // Every warm-up on a phone is a relay round trip or a chunk download on
    // the same link the opening transcript arrives on: the lane opens only
    // once that first conversation has painted.
    if (hiddenPanelsStayCold()) return onFirstConversationPaint(arm);
    if (!nativeWindow || host.__mixdogWindowShown) arm();
    else {
      window.addEventListener('mixdog:window-shown', arm, { once: true });
      // Recover a missed native show event without holding the idle lane forever.
      fallbackTimer = window.setTimeout(arm, 1_200);
    }
    return () => {
      window.removeEventListener('mixdog:window-shown', arm);
      window.clearTimeout(fallbackTimer);
    };
  }, [ready]);
}

function useSidebarMountWarmup(
  ready: boolean,
  mountSidebarPanel: ShellPanels['mountSidebarPanel'],
  trackSidebarPanelModule: SidebarModuleTracker
) {
  useEffect(() => {
    if (!ready) return undefined;
    const cancels = [
      scheduleBootWarmup({
        id: 'module:utility-dock',
        priority: BOOT_WARMUP.utilityDockModule,
        run: () => preloadUtilityDock().catch(() => {}),
      }),
    ];
    if (desktopFeatureEnabled('usage')) {
      cancels.push(
        scheduleBootWarmup({
          id: 'module:usage-flyout',
          priority: BOOT_WARMUP.usageFlyoutModule,
          run: () => loadSidebarUsageModule().catch(() => {}),
        })
      );
    }
    // A hidden page mounts as a transition: React yields between components,
    // so a tap that lands meanwhile never waits behind the whole page's render.
    const mountHidden = (panel: string) => startTransition(() => mountSidebarPanel(panel));
    const mountPanels = (panels: readonly SidebarPanelKey[]) =>
      panels.flatMap((panel, index) =>
        desktopSidebarDestinationEnabled(panel)
          ? [
              scheduleBootWarmup({
                id: `mount:sidebar:${panel}`,
                priority: BOOT_WARMUP.sidebarPanel + index,
                run: () => {
                  const module = loadSidebarPanelModule[panel]();
                  trackSidebarPanelModule(panel, module);
                  return module.then(() => mountHidden(panel)).catch(() => {});
                },
              }),
            ]
          : []
      );
    // The Bots page draws the dock chunk's Agents pane, which mounts its body
    // hidden the same way (use-app-workbench-views `prewarm`).
    const mountBotsPage = () =>
      desktopUtilityDockTabEnabled('agents')
        ? [
            scheduleBootWarmup({
              id: 'mount:sidebar:agents',
              priority: BOOT_WARMUP.sidebarPanel,
              run: () =>
                utilityDockModule
                  .load()
                  .then(() => mountHidden('agents'))
                  .catch(() => {}),
            }),
          ]
        : [];
    const mountPages = () => [...mountBotsPage(), ...mountPanels(DEFAULT_SIDEBAR_VIEW_ORDER)];
    if (!hiddenPanelsStayCold() || connectionQuality() === 'normal') cancels.push(...mountPages());
    return () => {
      for (const cancel of cancels) cancel();
    };
  }, [ready, mountSidebarPanel, trackSidebarPanelModule]);
}

export function useAppDockWarmup(ready: boolean, projectPath: string) {
  useEffect(() => {
    if (!ready || !projectPath) return undefined;
    if (backgroundWarmupThrottled() || !window.mixdogDesktop?.gitStatus) return undefined;
    return scheduleBootWarmup({
      id: 'dock:git-state',
      priority: BOOT_WARMUP.dockGitState,
      run: () => prewarmUtilityDockGitState(projectPath).catch(() => {}),
    });
  }, [ready, projectPath]);
  useEffect(() => {
    if (!ready || !projectPath || backgroundWarmupThrottled()) return undefined;
    return scheduleBootWarmup({
      id: 'dock:explorer-root',
      priority: BOOT_WARMUP.dockExplorerRoot,
      run: () => prefetchExplorerRoot(window.mixdogDesktop, projectPath).catch(() => {}),
    });
  }, [ready, projectPath]);
  const [dockBodyWarm, setDockBodyWarm] = useState(false);
  useEffect(() => {
    if (!ready || dockBodyWarm || backgroundWarmupThrottled()) return undefined;
    return scheduleBootWarmup({
      id: 'dock:body',
      priority: BOOT_WARMUP.dockBody,
      run: () => setDockBodyWarm(true),
    });
  }, [ready, dockBodyWarm]);
  return dockBodyWarm;
}

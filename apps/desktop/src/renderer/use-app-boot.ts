import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { preloadAgentPool } from './AgentActivityPane';
import {
  loadOnboardingWizardModule,
  loadSettingsViewModule,
  loadSidebarPanelModule,
  type SidebarPanelKey,
} from './app-shell-components';
import {
  preloadSessionGoalIsland,
  preloadUtilityDock,
  prewarmUtilityDockGitState,
  requestSessionRead,
} from './app-snapshot-views';
import { armBootWarmup, BOOT_WARMUP, BOOT_WARMUP_ARM_DELAY_MS, scheduleBootWarmup } from './boot-warmup';
import { onFirstConversationPaint } from './boot-metrics';
import { prefetchExplorerRoot } from './explorer-root-cache';
import { loadCommandSurfaceModule } from './command-surface-loader';
import { type ChunkPrefetchName, fetchChunkGraph } from './chunk-prefetch';
import { FIRST_SCREEN_DEFERRED_MODULES } from './first-screen-deferred';
import { desktopFeatureEnabled, desktopSidebarDestinationEnabled } from './desktop-feature-config';
import { applyDesktopThemePreference, getDesktopThemePreference } from './desktop-theme';
import { applyStoredSkin } from './desktop-skin';
import { installHostDisplaySync } from './host-display-sync';
import type { RecordValue } from './desktop-types';
import { prefetchEditorPane, prefetchSurfaceForSelection } from './lazy-widgets';
import { prefetchQuotaUsage } from './quota-usage-cache';
import { loadSidebarReferences, WORKFLOW_REFERENCE_KEYS } from './sidebar-reference-cache';
import { connectionQuality } from './network-conditions';
import { paneActiveSessionIds } from './pane-layout';
import type { usePaneWorkspace } from './pane-workspace-state';
import { isMobileDeviceSurface } from './mobile-surface';
import { isNativeDesktopWindow, isRemoteHostRenderer } from './remote-ui-projection';
import { DEFAULT_SIDEBAR_VIEW_ORDER } from './sidebar-view-layout';
import { loadStudioViewModule } from './studio-loader';
import { asRecord, navigationKey } from './text-format';
import type { useAppShellPanels } from './use-app-shell-panels';
import { loadSidebarUsageModule } from './use-usage-rail-pin';

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

/** A phone keeps the panels it does not show at start (Settings and the rail
 *  panels: Workflows, Extensions, Schedules, Webhooks, Projects) cold while
 *  its first screen loads — the rail panels until the first touch, Settings
 *  until it opens: their hidden mounts are capability reads queued on the relay
 *  link and main-thread work on a slow CPU, for surfaces most opens never
 *  visit. Desktop windows keep warming them. */
function hiddenPanelsStayCold(): boolean {
  return isMobileDeviceSurface();
}

export function useAppSettingsMount(settingsOpen: boolean) {
  const settingsMounted = useRef(false);
  if (settingsOpen) settingsMounted.current = true;
  const [settingsPrewarmed, setSettingsPrewarmed] = useState(false);
  useEffect(() => {
    if (!desktopFeatureEnabled('settings') || settingsPrewarmed || hiddenPanelsStayCold()) return undefined;
    return scheduleBootWarmup({
      id: 'settings:mount',
      priority: BOOT_WARMUP.settingsMount,
      run: () =>
        loadSettingsViewModule()
          .then(() => setSettingsPrewarmed(true))
          .catch(() => {}),
    });
  }, [settingsPrewarmed]);
  return { settingsMounted, settingsPrewarmed };
}

/** The phone's side-sheet panes (Changes' diff view, Terminal, Browser,
 *  Visualize, the editor), last in the lane — which a phone only opens once
 *  its first conversation painted — and only on a normal link. Tapped cold, each
 *  chunk was fetched over the relay inside the tap, so the sheet opened onto a
 *  blank body. The lane DOWNLOADS them only (modulepreload: fetched and
 *  compiled off the main thread); each is evaluated on its first open.
 *  Evaluated in the lane, Monaco alone held the main thread ~400ms at a
 *  phone's CPU between two swipes of a reader, and the transcript could not
 *  mount the rows the next swipe brought in. */
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
      scheduleBootWarmup({
        id: 'module:studio',
        priority: BOOT_WARMUP.studioModule,
        run: () => loadStudioViewModule().catch(() => {}),
      }),
      // Monaco + the Markdown preview. A phone opens no file at start, so it
      // takes them, with the other side-sheet panes, at the lane's tail.
      ...(hiddenPanelsStayCold()
        ? phoneSheetPaneWarmups()
        : [
            scheduleBootWarmup({
              id: 'module:editor',
              priority: BOOT_WARMUP.editorModule,
              run: () => prefetchEditorPane().catch(() => {}),
            }),
          ]),
      // The /context · /usage dialog chunk. A native window used to skip this
      // lane and pay the whole import on the first open (user: 컨텍스트창 왜
      // 바로 안 열리고 로딩이 심하지); the idle lane still yields to input.
      scheduleBootWarmup({
        id: 'module:command-surface',
        priority: BOOT_WARMUP.commandSurfaceModule,
        run: () => loadCommandSurfaceModule().catch(() => {}),
      }),
      scheduleBootWarmup({
        id: 'module:session-goal',
        priority: BOOT_WARMUP.sessionGoalModule,
        run: () => preloadSessionGoalIsland().catch(() => {}),
      }),
      // Surfaces kept off the first screen's bundle, one per idle slice, so
      // their first open renders at once instead of through a placeholder.
      // Phones never render the starter guide.
      ...Object.entries(FIRST_SCREEN_DEFERRED_MODULES).flatMap(([name, module]) =>
        name === 'starter-guide' && hiddenPanelsStayCold()
          ? []
          : [
              scheduleBootWarmup({
                id: `module:deferred:${name}`,
                priority: BOOT_WARMUP.surfaceChunk,
                run: () => module.load().catch(() => {}),
              }),
            ]
      ),
    ];
    // The subscription usage that dialog opens on: its first open after boot
    // waited on a cold ledger read (user: 처음에 유즈에이지 창 눌러서 진입할 때
    // 바로 안 나오네). A remote client reads it when the dialog opens instead.
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

export function useAppSettingsPreload() {
  useEffect(() => {
    // The agents panel is not on a phone's first screen: its catalog read
    // waits in the idle lane, behind the opening conversation.
    if (!hiddenPanelsStayCold()) {
      preloadAgentPool(window.mixdogDesktop);
      return undefined;
    }
    return scheduleBootWarmup({
      id: 'data:agent-pool',
      priority: BOOT_WARMUP.agentPool,
      run: () => preloadAgentPool(window.mixdogDesktop),
    });
  }, []);
  // The capability sweep remains behind the opening conversation in the idle lane.
  useEffect(() => {
    if (!desktopFeatureEnabled('settings') || hiddenPanelsStayCold()) return undefined;
    return scheduleBootWarmup({
      id: 'settings:preload',
      priority: BOOT_WARMUP.settingsPreload,
      run: () =>
        loadSettingsViewModule()
          .then((module) => {
            const host = window.mixdogDesktop;
            return host ? module.preloadSettings(host).catch(() => {}) : undefined;
          })
          .catch(() => {}),
    });
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
  // A paired remote surface never holds its boot cover for this read: it is a
  // capability read that queues on the desktop behind the boot's usage and
  // provider probes, so the conversation stayed covered for seconds after its
  // view sync. Pairing implies a set-up desktop; an incomplete onboarding still
  // opens the wizard when the answer lands.
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
    void invoke<RecordValue>({ capability: 'getOnboardingStatus' })
      .then(async (result) => {
        if (asRecord(result.value)?.completed !== false) return;
        // Load both chunks before mounting the wizard to retain the current frame.
        await Promise.all([loadSettingsViewModule(), loadOnboardingWizardModule()]).catch(() => undefined);
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
  // Native panes warm active transcripts; a phone keeps background data cold.
  useEffect(() => {
    if (!ready || backgroundWarmupThrottled()) return undefined;
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
  // Once per boot, after the catalog lands: a session opened earlier was
  // cold again after every restart (0.3-1.5s disk parse on its first click).
  const recentWarmed = useRef(false);
  useEffect(() => {
    if (!ready || recentWarmed.current || backgroundWarmupThrottled() || sessions.length === 0) return;
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
          run: () => requestSessionRead(session.id),
        });
      });
  }, [ready, sessions, workspace.focusedLeafId, workspace.leaves]);
  // Code may warm on a normal remote link; it is cached independently of transcripts.
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
                  return module.then(() => mountSidebarPanel(panel)).catch(() => {});
                },
              }),
            ]
          : []
      );
    // Desktop mounts every rail page hidden at idle, so no first entry mounts
    // its page in front of the user (user: 사이드 뷰가 늦게 뜨고 튐). A phone
    // mounts them once the user first touches the page (most often to open
    // that drawer), on a normal link. Opened cold, each page painted its
    // placeholder until its chunk and its list crossed the relay (user: 메뉴
    // 목록이 바로 안 나온다).
    if (!hiddenPanelsStayCold()) cancels.push(...mountPanels(DEFAULT_SIDEBAR_VIEW_ORDER));
    else if (connectionQuality() === 'normal')
      cancels.push(...afterFirstPhoneTouch(() => mountPanels(DEFAULT_SIDEBAR_VIEW_ORDER)));
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

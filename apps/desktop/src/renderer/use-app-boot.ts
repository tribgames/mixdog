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
import { loadCommandSurfaceModule } from './command-surface-loader';
import { desktopFeatureEnabled, desktopSidebarDestinationEnabled } from './desktop-feature-config';
import { applyDesktopThemePreference, getDesktopThemePreference } from './desktop-theme';
import type { RecordValue } from './desktop-types';
import { prefetchSurfaceForSelection } from './lazy-widgets';
import { prefetchQuotaUsage } from './quota-usage-cache';
import { connectionQuality } from './network-conditions';
import { paneActiveSessionIds } from './pane-layout';
import type { usePaneWorkspace } from './pane-workspace-state';
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

/** Background data stays cold on a metered/slow link (never on the native shell). */
function backgroundWarmupThrottled(): boolean {
  return !isNativeDesktopWindow() && connectionQuality() !== 'normal';
}

type ShellPanels = ReturnType<typeof useAppShellPanels>;
type SidebarModuleTracker = ShellPanels['trackSidebarPanelModule'];
type WarmupWorkspace = Pick<ReturnType<typeof usePaneWorkspace>, 'leaves' | 'focusedLeafId'>;

export function useAppSettingsMount(settingsOpen: boolean) {
  const settingsMounted = useRef(false);
  if (settingsOpen) settingsMounted.current = true;
  const [settingsPrewarmed, setSettingsPrewarmed] = useState(false);
  useEffect(() => {
    if (!desktopFeatureEnabled('settings') || settingsPrewarmed) return undefined;
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
    if (!nativeWindow) {
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
    preloadAgentPool(window.mixdogDesktop);
  }, []);
  // The capability sweep remains behind the opening conversation in the idle lane.
  useEffect(() => {
    if (!desktopFeatureEnabled('settings')) return undefined;
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
    return () => {
      live = false;
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
    if (!invoke) {
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
    if (!ready) return undefined;
    const nativeSurface = isNativeDesktopWindow();
    if (!nativeSurface && connectionQuality() !== 'normal') return undefined;
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
    const panels: SidebarPanelKey[] = ['schedules', 'webhooks', 'projects', 'extensions'];
    panels.forEach((panel, index) => {
      if (!desktopSidebarDestinationEnabled(panel)) return;
      cancels.push(
        scheduleBootWarmup({
          id: `mount:sidebar:${panel}`,
          priority: BOOT_WARMUP.sidebarPanel + index,
          run: () => {
            const module = loadSidebarPanelModule[panel]();
            trackSidebarPanelModule(panel, module);
            return module.then(() => mountSidebarPanel(panel)).catch(() => {});
          },
        })
      );
    });
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

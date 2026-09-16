import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { preloadAgentPool } from './AgentActivityPane';
import {
  loadOnboardingWizardModule,
  loadSettingsViewModule,
  loadSidebarPanelModule,
  type SidebarPanelKey,
} from './app-shell-components';
import { preloadUtilityDock, prewarmUtilityDockGitState, requestSessionRead } from './app-snapshot-views';
import { armBootWarmup, BOOT_WARMUP, BOOT_WARMUP_ARM_DELAY_MS, scheduleBootWarmup } from './boot-warmup';
import { loadCommandSurfaceModule } from './command-surface-loader';
import { desktopFeatureEnabled, desktopSidebarDestinationEnabled } from './desktop-feature-config';
import { applyDesktopThemePreference, getDesktopThemePreference } from './desktop-theme';
import type { RecordValue } from './desktop-types';
import { prefetchSurfaceForSelection } from './lazy-widgets';
import { isMobileRemoteSurface } from './MobileTabOverview';
import { connectionQuality } from './network-conditions';
import { paneActiveSessionIds } from './pane-layout';
import type { usePaneWorkspace } from './pane-workspace-state';
import { DEFAULT_SIDEBAR_VIEW_ORDER } from './sidebar-view-layout';
import { loadStudioViewModule } from './studio-loader';
import { asRecord, navigationKey } from './text-format';
import type { useAppShellPanels } from './use-app-shell-panels';

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
    const nativeWindow = Boolean(window.mixdogDesktop?.bootContext?.bootId);
    const cancels = [
      scheduleBootWarmup({
        id: 'module:studio',
        priority: BOOT_WARMUP.studioModule,
        run: () => loadStudioViewModule().catch(() => {}),
      }),
    ];
    if (!nativeWindow) {
      cancels.push(
        scheduleBootWarmup({
          id: 'module:command-surface',
          priority: BOOT_WARMUP.commandSurfaceModule,
          run: () => loadCommandSurfaceModule().catch(() => {}),
        })
      );
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
  const [onboardingReady, setOnboardingReady] = useState(false);
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
  mountSidebarPanel,
  trackSidebarPanelModule,
}: {
  ready: boolean;
  workspace: WarmupWorkspace;
  mountSidebarPanel: ShellPanels['mountSidebarPanel'];
  trackSidebarPanelModule: SidebarModuleTracker;
}) {
  // Native panes warm active transcripts; a phone keeps background data cold.
  useEffect(() => {
    if (!ready || isMobileRemoteSurface()) return undefined;
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
  // Code may warm on a normal remote link; it is cached independently of transcripts.
  useEffect(() => {
    if (!ready) return undefined;
    const nativeSurface = Boolean(window.mixdogDesktop?.bootContext?.bootId);
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
    const nativeWindow = Boolean(window.mixdogDesktop?.bootContext?.bootId);
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
    if (isMobileRemoteSurface() || !window.mixdogDesktop?.gitStatus) return undefined;
    return scheduleBootWarmup({
      id: 'dock:git-state',
      priority: BOOT_WARMUP.dockGitState,
      run: () => prewarmUtilityDockGitState(projectPath).catch(() => {}),
    });
  }, [ready, projectPath]);
  const [dockBodyWarm, setDockBodyWarm] = useState(false);
  useEffect(() => {
    if (!ready || dockBodyWarm || isMobileRemoteSurface()) return undefined;
    return scheduleBootWarmup({
      id: 'dock:body',
      priority: BOOT_WARMUP.dockBody,
      run: () => setDockBodyWarm(true),
    });
  }, [ready, dockBodyWarm]);
  return dockBodyWarm;
}

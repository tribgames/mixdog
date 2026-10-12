import type React from 'react';
import { useCallback } from 'react';
import { desktopFeatureEnabled } from '../desktop-feature-config';
import { extensionSectionForSettings, type ExtensionsSection } from '../extension-sections';
import type { SettingsSection as SlashSettingsSection } from '../slash-commands';
import { loadSidebarPanelModule, warmSettingsView } from '../app-shell-components';
import { requestOpenModelPicker } from '../model-picker-event';
import { useAppUiOpenRequest, type SetupLaneSource } from '../app-shell-ui-open-request';
import { defaultSessionLaneStore } from '../session-lane-store';
import { useSetupDesktopRequest } from '../use-setup-desktop-request';
import { useSettingsChangeSync, useSetupChangeAnnouncer } from '../setup-change-refresh';
import { useProviderModelsSync } from '../sidebar-reference-cache';
import type { Snapshot } from '../desktop-types';
import type { useAppShellPanels } from '../use-app-shell-panels';
import type { useAppSideDocks } from '../use-app-side-docks';

export interface UseAppSettingsRouterOptions {
  workbenchSideLayout: ReturnType<typeof useAppSideDocks>['workbenchSideLayout'];
  setExtensionsSection: (section: ExtensionsSection) => void;
  setSettingsOpen: (open: boolean) => void;
  setCommandSurface: ReturnType<typeof useAppShellPanels>['setCommandSurface'];
  mountSidebarPanel: ReturnType<typeof useAppShellPanels>['mountSidebarPanel'];
  trackSidebarPanelModule: (name: string, promise: Promise<unknown>) => void;
  paneSideDocks: ReturnType<typeof useAppSideDocks>['paneSideDocks'];
  focusedLeafIdRef: React.MutableRefObject<string>;
  setActiveSideViews: React.Dispatch<React.SetStateAction<ReturnType<typeof useAppSideDocks>['activeSideViews']>>;
  applySidebarOpen: (open: boolean, motion?: 'animated' | 'instant') => void;
  setSettingsSection: ReturnType<typeof useAppShellPanels>['setSettingsSection'];

  uiOpenRequest: Snapshot['uiOpenRequest'];
  sessionId: Snapshot['sessionId'];
  openConversationCommandSurface: ReturnType<typeof useAppShellPanels>['openConversationCommandSurface'];
  setupUiRequest: Snapshot['setupUiRequest'];
  setupChanged?: Snapshot['setupChanged'];
}

export function useAppSettingsRouter({
  workbenchSideLayout,
  setExtensionsSection,
  setSettingsOpen,
  setCommandSurface,
  mountSidebarPanel,
  trackSidebarPanelModule,
  paneSideDocks,
  focusedLeafIdRef,
  setActiveSideViews,
  applySidebarOpen,
  setSettingsSection,
  uiOpenRequest,
  sessionId,
  openConversationCommandSurface,
  setupUiRequest,
  setupChanged,
}: UseAppSettingsRouterOptions) {
  const openSettings = useCallback(
    (section: SlashSettingsSection | null = null) => {
      const extensionSection = extensionSectionForSettings(section);
      if (extensionSection) {
        if (!desktopFeatureEnabled('extensions')) return;
        const side = workbenchSideLayout.sideOf('extensions');
        setExtensionsSection(extensionSection);
        setSettingsOpen(false);
        setCommandSurface(null);
        mountSidebarPanel('extensions');
        trackSidebarPanelModule('extensions', loadSidebarPanelModule.extensions());
        if (side === 'right') {
          paneSideDocks.open(focusedLeafIdRef.current, 'extensions');
          return;
        }
        setActiveSideViews((current) => (current.left === 'extensions' ? current : { ...current, left: 'extensions' }));
        applySidebarOpen(true);
        return;
      }
      if (section === 'model' && requestOpenModelPicker()) {
        setSettingsOpen(false);
        setCommandSurface(null);
        return;
      }
      if (section === 'workflow' || section === 'websearch' || section === 'model') {
        if (!desktopFeatureEnabled('projects')) return;
        setSettingsOpen(false);
        setCommandSurface(null);
        mountSidebarPanel('workflows');
        trackSidebarPanelModule('workflows', loadSidebarPanelModule.workflows());
        setActiveSideViews((current) => (current.left === 'workflows' ? current : { ...current, left: 'workflows' }));
        applySidebarOpen(true);
        return;
      }
      if (!desktopFeatureEnabled('settings')) return;
      (window as unknown as Record<string, unknown>).__mixdogSettingsOpenAt = performance.now();
      warmSettingsView();
      setCommandSurface(null);
      setSettingsSection(section === 'memory' ? 'memory-enabled' : section);
      setSettingsOpen(true);
    },
    [
      applySidebarOpen,
      mountSidebarPanel,
      paneSideDocks.open,
      trackSidebarPanelModule,
      workbenchSideLayout.sideOf,
      setCommandSurface,
      setSettingsOpen,
      setSettingsSection,
      setExtensionsSection,
      setActiveSideViews,
      focusedLeafIdRef,
    ]
  );

  // Setup requests from split-pane sessions arrive on their session lanes.
  // Only a session this window shows may navigate it or claim a request.
  const subscribeSessionLanes = useCallback<SetupLaneSource>(
    (listener) =>
      window.mixdogDesktop.subscribeSessionState?.((update) => {
        if (defaultSessionLaneStore.subscribedSessionIds().includes(update.sessionId)) listener(update);
      }) ?? (() => {}),
    []
  );

  useAppUiOpenRequest({
    uiOpenRequest,
    sessionId,
    openConversationCommandSurface,
    openSettings,
    subscribeSessionLanes,
  });

  useSetupDesktopRequest(setupUiRequest, sessionId, window.mixdogDesktop, subscribeSessionLanes);
  useSetupChangeAnnouncer(setupChanged, sessionId, subscribeSessionLanes);
  useProviderModelsSync(window.mixdogDesktop);
  useSettingsChangeSync(window.mixdogDesktop);

  return {
    openSettings,
  };
}

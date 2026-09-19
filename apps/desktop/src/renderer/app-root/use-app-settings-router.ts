import type React from 'react';
import { useCallback } from 'react';
import { desktopFeatureEnabled } from '../desktop-feature-config';
import { extensionSectionForSettings, type ExtensionsSection } from '../extension-sections';
import { projectsSectionForSettings, type ProjectsSection } from '../project-sections';
import type { SettingsSection as SlashSettingsSection } from '../slash-commands';
import { loadSidebarPanelModule, warmSettingsView } from '../app-shell-components';
import { useAppUiOpenRequest } from '../app-shell-ui-open-request';
import { useSetupDesktopRequest } from '../use-setup-desktop-request';
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
  setProjectsSection: (section: ProjectsSection) => void;
  openProjects: () => void;
  setSettingsSection: ReturnType<typeof useAppShellPanels>['setSettingsSection'];

  uiOpenRequest: Snapshot['uiOpenRequest'];
  sessionId: Snapshot['sessionId'];
  openConversationCommandSurface: ReturnType<typeof useAppShellPanels>['openConversationCommandSurface'];
  setupUiRequest: Snapshot['setupUiRequest'];
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
  setProjectsSection,
  openProjects,
  setSettingsSection,
  uiOpenRequest,
  sessionId,
  openConversationCommandSurface,
  setupUiRequest,
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
      const projectsTab = projectsSectionForSettings(section);
      if (projectsTab) {
        if (!desktopFeatureEnabled('projects')) return;
        setCommandSurface(null);
        setProjectsSection(projectsTab);
        openProjects();
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
      openProjects,
      paneSideDocks.open,
      trackSidebarPanelModule,
      workbenchSideLayout.sideOf,
      setCommandSurface,
      setSettingsOpen,
      setSettingsSection,
      setExtensionsSection,
      setProjectsSection,
      setActiveSideViews,
      focusedLeafIdRef,
    ]
  );

  useAppUiOpenRequest({
    uiOpenRequest,
    sessionId,
    openConversationCommandSurface,
    openSettings,
  });

  useSetupDesktopRequest(setupUiRequest, sessionId, window.mixdogDesktop);

  return {
    openSettings,
  };
}

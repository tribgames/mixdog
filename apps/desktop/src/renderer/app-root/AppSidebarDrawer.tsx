import type React from 'react';
import type { ComponentProps } from 'react';
import { ActivityRail } from '../ActivityRail';
import {
  WorkbenchSideIconBar,
  WorkbenchSidePanel,
  type WorkbenchSide,
  type WorkbenchSideTitleDragProps,
  type WorkbenchSideViewId,
} from '../workbench-side-view-layout';
import { SidebarDiffColumn } from '../sidebar-diff-column';
import { loadSidebarPanelModule, warmSettingsView } from '../app-shell-components';
import type { useAppShellPanels } from '../use-app-shell-panels';
import type { useAppSideDocks } from '../use-app-side-docks';
import type { createAppSideViewDescriptors } from '../app-side-view-descriptors';
import type { useSideViewReordering } from '../app-shell-side-views';
import type { useAppSidebarSurface } from '../use-app-sidebar-surface';
import type { useAppSettingsRouter } from './use-app-settings-router';

export interface AppSidebarDrawerProps {
  sidebarOpen: boolean;
  sidebarMotion: ReturnType<typeof useAppShellPanels>['sidebarMotion'];
  sidebarPanel: ReturnType<typeof useAppSidebarSurface>['sidebarPanel'];
  closeSidebarPanels: () => void;
  openSidebar: () => void;
  toggleSidebar: () => void;
  settingsOpen: boolean;
  openProjects: () => void;
  refreshProjects: () => Promise<unknown>;
  trackSidebarPanelModule: (name: string, promise: Promise<unknown>) => void;
  openSchedules: () => void;
  openWebhooks: () => void;
  closeActiveRailPanel: () => void;
  closeSidebarForNavigation: (motion?: 'animated' | 'instant') => void;
  openSettings: ReturnType<typeof useAppSettingsRouter>['openSettings'];
  setCommandSurface: ReturnType<typeof useAppShellPanels>['setCommandSurface'];

  workbenchSideLayout: ReturnType<typeof useAppSideDocks>['workbenchSideLayout'];
  sideViewDescriptors: ReturnType<typeof createAppSideViewDescriptors>;
  activeSideViews: ReturnType<typeof useAppSideDocks>['activeSideViews'];
  selectWorkbenchSideView: (viewId: WorkbenchSideViewId) => void;
  moveWorkbenchSideGroup: ReturnType<typeof useSideViewReordering>['moveWorkbenchSideGroup'];
  moveWorkbenchSideView: ReturnType<typeof useSideViewReordering>['moveWorkbenchSideView'];
  renderWorkbenchSideView: (
    side: WorkbenchSide,
    id: WorkbenchSideViewId,
    active: boolean,
    titleDragProps: WorkbenchSideTitleDragProps
  ) => React.ReactNode;

  sidebarDiff: ReturnType<typeof useAppSideDocks>['sidebarDiff'];
  closeSidebarDiff: () => void;
  openFileTab: (project: string, rel: string, line?: number) => void;
}

export function AppSidebarDrawer({
  sidebarOpen,
  sidebarMotion,
  sidebarPanel,
  closeSidebarPanels,
  openSidebar,
  toggleSidebar,
  settingsOpen,
  openProjects,
  refreshProjects,
  trackSidebarPanelModule,
  openSchedules,
  openWebhooks,
  closeActiveRailPanel,
  closeSidebarForNavigation,
  openSettings,
  setCommandSurface,
  workbenchSideLayout,
  sideViewDescriptors,
  activeSideViews,
  selectWorkbenchSideView,
  moveWorkbenchSideGroup,
  moveWorkbenchSideView,
  renderWorkbenchSideView,
  sidebarDiff,
  closeSidebarDiff,
  openFileTab,
}: AppSidebarDrawerProps) {
  let activeRailSurface: ComponentProps<typeof ActivityRail>['activeSurface'] = null;
  if (settingsOpen) {
    activeRailSurface = 'settings';
  } else if (sidebarOpen && sidebarPanel) {
    activeRailSurface = sidebarPanel;
  }

  return (
    <div className="sidebar-drawer-frame" data-state={sidebarOpen ? 'open' : 'closed'} data-motion={sidebarMotion}>
      <ActivityRail
        sidebarOpen={sidebarOpen && !sidebarPanel}
        onToggleSessions={() => {
          if (sidebarPanel) {
            closeSidebarPanels();
            openSidebar();
          } else toggleSidebar();
        }}
        activeSurface={activeRailSurface}
        onOpenProjects={() => {
          openProjects();
          void refreshProjects().catch(() => undefined);
        }}
        onPrefetchProjects={() => {
          trackSidebarPanelModule('projects', loadSidebarPanelModule.projects());
        }}
        onOpenSchedules={openSchedules}
        onPrefetchSchedules={() => {
          trackSidebarPanelModule('schedules', loadSidebarPanelModule.schedules());
        }}
        onOpenWebhooks={openWebhooks}
        onPrefetchWebhooks={() => {
          trackSidebarPanelModule('webhooks', loadSidebarPanelModule.webhooks());
        }}
        onCloseActiveSurface={closeActiveRailPanel}
        onOpenSettings={() => {
          closeSidebarForNavigation('instant');
          openSettings();
        }}
        onOpenProviders={() => {
          closeSidebarForNavigation('instant');
          openSettings('providers');
        }}
        onOpenUsageStats={() => setCommandSurface('stats')}
        onPrefetchSettings={warmSettingsView}
        navigationItems={workbenchSideLayout.layout.left.flatMap((group) => {
          const descriptor = sideViewDescriptors.get(group[0]);
          return descriptor ? [{ id: group[0], label: descriptor.tooltip || descriptor.label }] : [];
        })}
        primaryNavigation={
          <WorkbenchSideIconBar
            side="left"
            groups={workbenchSideLayout.layout.left}
            activeRoot={activeSideViews.left}
            descriptors={sideViewDescriptors}
            orientation="vertical"
            onSelect={selectWorkbenchSideView}
            onMoveGroup={moveWorkbenchSideGroup}
            onMoveView={moveWorkbenchSideView}
          />
        }
      />
      <WorkbenchSidePanel
        side="left"
        open={sidebarOpen}
        groups={workbenchSideLayout.layout.left}
        activeRoot={activeSideViews.left}
        descriptors={sideViewDescriptors}
        onSelect={selectWorkbenchSideView}
        onMoveGroup={moveWorkbenchSideGroup}
        onMoveView={moveWorkbenchSideView}
        renderView={(id, active, titleDragProps) => renderWorkbenchSideView('left', id, active, titleDragProps)}
      />
      <SidebarDiffColumn
        diff={sidebarDiff?.diff ?? null}
        showing={
          Boolean(sidebarDiff) &&
          sidebarOpen &&
          workbenchSideLayout.layout.left.length > 0 &&
          activeSideViews.left === sidebarDiff?.view
        }
        onClose={closeSidebarDiff}
        openFileTab={openFileTab}
      />
    </div>
  );
}

import type React from 'react';
import { memo, useMemo } from 'react';
import { ActivityRail } from '../ActivityRail';
import { useStableEvent } from '../use-stable-event';
import { useEdgeSwipeDrawers } from '../use-edge-swipe-drawers';
import { isMobileDeviceSurface, useMobileRemoteSurface } from '../mobile-surface';
import { RemotePcCard, remotePcSurface } from '../RemotePcSwitcher';
import {
  WorkbenchSidePanel,
  type WorkbenchSide,
  type WorkbenchSideTitleDragProps,
  type WorkbenchSideViewId,
} from '../workbench-side-view-layout';
import { SidebarDiffColumn } from '../sidebar-diff-column';
import type { StarterGuide as StarterGuideComponent } from '../StarterGuide';
import { starterGuideModule } from '../first-screen-deferred';
import { useDeferredModule } from '../deferred-module';
import { warmSettingsView } from '../app-shell-components';
import type { useAppShellPanels } from '../use-app-shell-panels';
import type { useAppSideDocks } from '../use-app-side-docks';
import type { createAppSideViewDescriptors } from '../app-side-view-descriptors';
import type { useSideViewReordering } from '../app-shell-side-views';
import type { useAppSettingsRouter } from './use-app-settings-router';

interface AppSidebarDrawerProps {
  sidebarOpen: boolean;
  sidebarMotion: ReturnType<typeof useAppShellPanels>['sidebarMotion'];
  openSidebar: () => void;
  applySidebarOpen: (open: boolean) => void;
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  /** Onboarding is open or still deciding whether to open. */
  onboardingActive: boolean;
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

/** The desktop sidebar's footer guide. Phones never render it, so its chunk
 *  stays off their first screen; a desktop boot holds the cover until it is in. */
const StarterGuide = memo(function StarterGuide(props: React.ComponentProps<typeof StarterGuideComponent>) {
  const module = useDeferredModule(starterGuideModule, { bootSurface: 'starter-guide' });
  return module ? <module.StarterGuide {...props} /> : null;
});

export function AppSidebarDrawer({
  sidebarOpen,
  sidebarMotion,
  openSidebar,
  applySidebarOpen,
  settingsOpen,
  setSettingsOpen,
  onboardingActive,
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
  const phone = useMobileRemoteSurface();
  useEdgeSwipeDrawers({ sidebarOpen, openSidebar, applySidebarOpen });
  // The rail and the starter guide are memoised; their handlers and items
  // keep one identity across App commits (a session switch is several).
  const openSettingsFromRail = useStableEvent((section?: Parameters<typeof openSettings>[0]) => {
    closeSidebarForNavigation('instant');
    openSettings(section);
  });
  const openRailSettings = useStableEvent(() => openSettingsFromRail());
  const openRailProviders = useStableEvent(() => openSettingsFromRail('providers'));
  const openUsageStats = useStableEvent(() => setCommandSurface('stats'));
  const closeSettings = useStableEvent(() => setSettingsOpen(false));
  const selectSideView = useStableEvent(selectWorkbenchSideView);
  const leftLayout = workbenchSideLayout.layout.left;
  const navigationItems = useMemo(
    () =>
      leftLayout.flat().flatMap((id) => {
        const descriptor = sideViewDescriptors.get(id);
        return descriptor ? [descriptor] : [];
      }),
    [leftLayout, sideViewDescriptors]
  );
  return (
    <div
      className="sidebar-drawer-frame"
      data-state={sidebarOpen ? 'open' : 'closed'}
      data-motion={sidebarMotion}
      // The PC card's grid (07-mobile-chrome.css); RemotePcCard renders
      // exactly when this holds.
      data-remote-pc={phone && remotePcSurface() ? 'true' : undefined}
    >
      {/* Phone drawer: the PC being driven sits above the rail and whichever
          side panel is active (renders nothing off a remote surface). */}
      {phone && <RemotePcCard />}
      <ActivityRail
        settingsOpen={settingsOpen}
        onOpenSettings={openRailSettings}
        onOpenProviders={openRailProviders}
        onOpenUsageStats={openUsageStats}
        onPrefetchSettings={warmSettingsView}
        navigationItems={navigationItems}
        activeNavigationId={sidebarOpen ? activeSideViews.left : null}
        onSelectNavigation={selectSideView}
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
        footer={
          // Phones and tablets get no starter guide (welcome, tour, checklist).
          isMobileDeviceSurface() ? undefined : (
            <StarterGuide
              descriptors={sideViewDescriptors}
              onboardingActive={onboardingActive}
              onOpenView={selectSideView}
              onOpenSettings={openSettingsFromRail}
              onCloseSettings={closeSettings}
            />
          )
        }
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

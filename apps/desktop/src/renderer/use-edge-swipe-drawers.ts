import { useEffect, useRef } from 'react';
import { isIOSWebSurface, isInstalledWebAppSurface } from './mobile-surface';
import { requestSetDockOpen } from './open-dock-tab-event';
import { installEdgeSwipe, type DrawerControl } from './touch-gestures';

interface SidebarSwipeState {
  sidebarOpen: boolean;
  openSidebar: () => void;
  applySidebarOpen: (open: boolean) => void;
}

const IOS_TAB_EDGE_INSET_PX = 24;
const DOCK_SELECTOR = '.pane-side-dock';

/** Edge swipes for the phone's two sheets: the session drawer (left) and the
 *  files dock (right). The dock's open state lives per pane, so it is read off
 *  the DOM and driven through the shell's dock event. */
export function useEdgeSwipeDrawers(state: SidebarSwipeState): void {
  const latest = useRef(state);
  latest.current = state;
  useEffect(() => {
    const dock = (): HTMLElement | null =>
      document.querySelector<HTMLElement>(`${DOCK_SELECTOR}[data-open="true"]`) ??
      document.querySelector<HTMLElement>(DOCK_SELECTOR);
    const drawers: DrawerControl[] = [
      {
        side: 'left',
        isOpen: () => latest.current.sidebarOpen,
        setOpen: (open) => (open ? latest.current.openSidebar() : latest.current.applySidebarOpen(false)),
        element: () => document.querySelector<HTMLElement>('.sidebar-drawer-frame'),
        backdrop: () => document.querySelector<HTMLElement>('.sidebar-backdrop'),
      },
      {
        side: 'right',
        isOpen: () => dock()?.dataset.open === 'true',
        setOpen: requestSetDockOpen,
        element: dock,
      },
    ];
    // A Safari tab swipes back/forward from the screen edge itself; an installed
    // app has no such gesture.
    const edgeInset = isIOSWebSurface() && !isInstalledWebAppSurface() ? IOS_TAB_EDGE_INSET_PX : 0;
    return installEdgeSwipe(window, drawers, { edgeInset });
  }, []);
}

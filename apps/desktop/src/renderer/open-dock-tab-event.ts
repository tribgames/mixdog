import type { DesktopUtilityDockTab } from './desktop-feature-config';

/** Asks the app shell to open a utility dock tab (useAppSideDocks listens),
 *  from chrome that has no route to the shell's dock state. */
export const OPEN_DOCK_TAB_EVENT = 'mixdog:open-dock-tab';

export type OpenDockTabDetail = { tab: DesktopUtilityDockTab };

export function requestOpenDockTab(tab: DesktopUtilityDockTab): void {
  window.dispatchEvent(new CustomEvent<OpenDockTabDetail>(OPEN_DOCK_TAB_EVENT, { detail: { tab } }));
}

/** Asks the app shell to open or fold the focused pane's right dock. */
export const SET_DOCK_OPEN_EVENT = 'mixdog:set-dock-open';

export function requestSetDockOpen(open: boolean): void {
  window.dispatchEvent(new CustomEvent<{ open: boolean }>(SET_DOCK_OPEN_EVENT, { detail: { open } }));
}

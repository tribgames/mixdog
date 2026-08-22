// The utility dock's view grouping — the same customization the activity-rail
// sidebar offers, so it runs on the same shared view-group layout and differs
// only in its ids, storage key and drag MIME types.
import type { UtilityDockTab } from "./UtilityDock";
import { createViewGroupLayout, type ViewGroupPlacement } from "./view-group-layout";

export const UTILITY_DOCK_VIEW_MIME = "application/x-mixdog-utility-dock-view";
export const UTILITY_DOCK_GROUP_MIME = "application/x-mixdog-utility-dock-group";

export type UtilityDockViewGroup = readonly UtilityDockTab[];
export type UtilityDockViewPlacement = ViewGroupPlacement;

export const DEFAULT_UTILITY_DOCK_VIEW_ORDER: readonly UtilityDockTab[] = [
  "agents",
  "search",
  "source-control",
  "pull-requests",
];

const utilityDockViewLayout = createViewGroupLayout<UtilityDockTab>({
  storageKey: "mixdog.desktop.utility-dock-view-layout.v1",
  viewMime: UTILITY_DOCK_VIEW_MIME,
  groupMime: UTILITY_DOCK_GROUP_MIME,
  defaultOrder: DEFAULT_UTILITY_DOCK_VIEW_ORDER,
});

export const normalizeUtilityDockViewGroups = utilityDockViewLayout.normalize;
export const moveUtilityDockViewGroup = utilityDockViewLayout.moveGroup;
export const moveUtilityDockView = utilityDockViewLayout.moveView;
export const utilityDockViewDragId = utilityDockViewLayout.viewDragId;
export const utilityDockGroupDragId = utilityDockViewLayout.groupDragId;
/** The dock publishes exactly the four members it always has: the shared
 *  factory's `groupFor`/`reset` belong to the sidebar hook alone. */
export const useUtilityDockViewLayout = (available: readonly UtilityDockTab[]) => {
  const { groups, moveGroup, moveView, getViewDragProps } =
    utilityDockViewLayout.useLayout(available);
  return { groups, moveGroup, moveView, getViewDragProps };
};

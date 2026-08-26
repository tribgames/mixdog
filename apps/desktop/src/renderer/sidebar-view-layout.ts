// The activity-rail sidebar's view grouping. Everything below the surface's
// own vocabulary (ids, storage key, drag MIME types) lives in the shared
// view-group layout the utility dock uses too.
import type { SidebarPanelKey } from "./app-shell-components";
import { createViewGroupLayout, type ViewGroupPlacement } from "./view-group-layout";

export const SIDEBAR_VIEW_MIME = "application/x-mixdog-sidebar-view";
export const SIDEBAR_GROUP_MIME = "application/x-mixdog-sidebar-group";

export type SidebarViewGroup = readonly SidebarPanelKey[];
export type SidebarViewPlacement = ViewGroupPlacement;

export const DEFAULT_SIDEBAR_VIEW_ORDER: readonly SidebarPanelKey[] = [
  "projects",
  "workflows",
  "extensions",
  "schedules",
  "webhooks",
  "utilities",
];

const sidebarViewLayout = createViewGroupLayout<SidebarPanelKey>({
  storageKey: "mixdog.desktop.sidebar-view-layout.v1",
  viewMime: SIDEBAR_VIEW_MIME,
  groupMime: SIDEBAR_GROUP_MIME,
  defaultOrder: DEFAULT_SIDEBAR_VIEW_ORDER,
});

export const normalizeSidebarViewGroups = sidebarViewLayout.normalize;
export const moveSidebarViewGroup = sidebarViewLayout.moveGroup;
export const moveSidebarView = sidebarViewLayout.moveView;
export const sidebarViewDragId = sidebarViewLayout.viewDragId;
export const sidebarGroupDragId = sidebarViewLayout.groupDragId;
export const useSidebarViewLayout = sidebarViewLayout.useLayout;

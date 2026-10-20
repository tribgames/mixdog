// The rail's sidebar destinations in first-launch order. Their placement and
// grouping live in the workbench side-view layout; this module only names
// the panel set.
import type { SidebarPanelKey } from './app-shell-components';

export type SidebarViewGroup = readonly SidebarPanelKey[];

export const DEFAULT_SIDEBAR_VIEW_ORDER: readonly SidebarPanelKey[] = [
  'projects',
  'workflows',
  'extensions',
  'skills',
  'schedules',
  'webhooks',
];

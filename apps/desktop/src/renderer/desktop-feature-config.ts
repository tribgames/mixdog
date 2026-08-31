/**
 * Internal desktop feature locks.
 *
 * Set an entry to false and rebuild the desktop app. This is intentionally
 * source-controlled configuration: it has no user-facing settings UI and no
 * localStorage override.
 */
export type DesktopFeatureId =
  | "sessions"
  | "utilities"
  | "projects"
  | "workflows"
  | "extensions"
  | "schedules"
  | "webhooks"
  | "usage"
  | "settings"
  | "agents"
  | "explorer"
  | "sourceControl"
  | "pullRequests";

export const DESKTOP_FEATURES: Readonly<Record<DesktopFeatureId, boolean>> = {
  sessions: true,
  utilities: true,
  projects: true,
  workflows: true,
  extensions: true,
  schedules: true,
  webhooks: false,
  usage: true,
  settings: true,
  agents: true,
  explorer: true,
  sourceControl: true,
  pullRequests: false,
};

export type DesktopSidebarDestination =
  | "sessions"
  | "utilities"
  | "projects"
  | "workflows"
  | "extensions"
  | "schedules"
  | "webhooks";

export type DesktopUtilityDockTab =
  | "agents"
  | "search"
  | "source-control"
  | "pull-requests";

const UTILITY_DOCK_FEATURES: Readonly<Record<DesktopUtilityDockTab, DesktopFeatureId>> = {
  agents: "agents",
  search: "explorer",
  "source-control": "sourceControl",
  "pull-requests": "pullRequests",
};

const UTILITY_DOCK_TABS: readonly DesktopUtilityDockTab[] = [
  "agents",
  "search",
  "source-control",
  "pull-requests",
];

export function desktopFeatureEnabled(feature: DesktopFeatureId): boolean {
  return DESKTOP_FEATURES[feature];
}

export function desktopSidebarDestinationEnabled(
  destination: DesktopSidebarDestination,
): boolean {
  return desktopFeatureEnabled(destination);
}

export function desktopUtilityDockTabEnabled(tab: DesktopUtilityDockTab): boolean {
  return desktopFeatureEnabled(UTILITY_DOCK_FEATURES[tab]);
}

export function firstEnabledDesktopUtilityDockTab(): DesktopUtilityDockTab | null {
  return UTILITY_DOCK_TABS.find(desktopUtilityDockTabEnabled) ?? null;
}

export const hasDesktopUtilityDockFeature =
  firstEnabledDesktopUtilityDockTab() !== null;

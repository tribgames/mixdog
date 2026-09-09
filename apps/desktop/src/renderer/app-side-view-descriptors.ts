import {
  Bot,
  Clock,
  FileDiff,
  GitCompare,
  Github,
  Globe,
  MessageSquare,
  Package,
  PanelsTopLeft,
  Search,
  SquareTerminal,
  Webhook,
} from "lucide-react";
import { t } from "./i18n";

import type {
  WorkbenchSideViewDescriptor,
  WorkbenchSideViewId,
} from "./workbench-side-view-layout";

export function createAppSideViewDescriptors(
  onPrefetch: (id: WorkbenchSideViewId) => void,
): ReadonlyMap<WorkbenchSideViewId, WorkbenchSideViewDescriptor> {
  return new Map([
    ["sessions", { id: "sessions", label: t("Sessions"), icon: MessageSquare }],
    ["projects", { id: "projects", label: t("Projects"), icon: PanelsTopLeft,
      onPrefetch: () => onPrefetch("projects") }],
    ["extensions", { id: "extensions", label: t("Extensions"), icon: Package,
      onPrefetch: () => onPrefetch("extensions") }],
    ["schedules", { id: "schedules", label: t("Schedules"), icon: Clock,
      onPrefetch: () => onPrefetch("schedules") }],
    ["webhooks", { id: "webhooks", label: t("Webhooks"), icon: Webhook,
      onPrefetch: () => onPrefetch("webhooks") }],
    ["browser", { id: "browser", label: t("Browser Use"), title: t("Browser"), icon: Globe,
      onPrefetch: () => onPrefetch("browser") }],
    ["terminal", { id: "terminal", label: t("Terminal"), icon: SquareTerminal,
      onPrefetch: () => onPrefetch("terminal") }],
    ["session-diff", {
      id: "session-diff",
      label: t("Changes"),
      tooltip: t("Changes"),
      icon: FileDiff,
      onPrefetch: () => onPrefetch("session-diff"),
    }],
    ["agents", { id: "agents", label: t("Agents"), icon: Bot,
      onPrefetch: () => onPrefetch("agents") }],
    ["search", { id: "search", label: t("Search"), icon: Search,
      onPrefetch: () => onPrefetch("search") }],
    ["source-control", {
      id: "source-control",
      label: t("Source Control"),
      icon: GitCompare,
      onPrefetch: () => onPrefetch("source-control"),
    }],
    ["pull-requests", {
      id: "pull-requests",
      label: t("GitHub"),
      tooltip: t("GitHub"),
      icon: Github,
      onPrefetch: () => onPrefetch("pull-requests"),
    }],
  ]);
}

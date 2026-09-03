import {
  Bot,
  Clock,
  FileDiff,
  GitCompare,
  Github,
  Globe,
  Layers3,
  MessageSquare,
  Package,
  PanelsTopLeft,
  Search,
  Sparkles,
  SquareTerminal,
  Webhook,
} from "lucide-react";

import type {
  WorkbenchSideViewDescriptor,
  WorkbenchSideViewId,
} from "./workbench-side-view-layout";

export function createAppSideViewDescriptors(
  onPrefetch: (id: WorkbenchSideViewId) => void,
): ReadonlyMap<WorkbenchSideViewId, WorkbenchSideViewDescriptor> {
  return new Map([
    ["sessions", { id: "sessions", label: "Sessions", icon: MessageSquare }],
    ["projects", { id: "projects", label: "Projects", icon: PanelsTopLeft,
      onPrefetch: () => onPrefetch("projects") }],
    ["workflows", { id: "workflows", label: "Workflows", icon: Layers3,
      onPrefetch: () => onPrefetch("workflows") }],
    ["extensions", { id: "extensions", label: "Extensions", icon: Package,
      onPrefetch: () => onPrefetch("extensions") }],
    ["schedules", { id: "schedules", label: "Schedules", icon: Clock,
      onPrefetch: () => onPrefetch("schedules") }],
    ["webhooks", { id: "webhooks", label: "Webhooks", icon: Webhook,
      onPrefetch: () => onPrefetch("webhooks") }],
    ["studio", { id: "studio", label: "Studio", icon: Sparkles,
      onPrefetch: () => onPrefetch("studio") }],
    ["browser", { id: "browser", label: "Browser Use", title: "Browser", icon: Globe,
      onPrefetch: () => onPrefetch("browser") }],
    ["terminal", { id: "terminal", label: "Terminal", icon: SquareTerminal,
      onPrefetch: () => onPrefetch("terminal") }],
    ["session-diff", {
      id: "session-diff",
      label: "Diff",
      tooltip: "Session Diff",
      icon: FileDiff,
      onPrefetch: () => onPrefetch("session-diff"),
    }],
    ["agents", { id: "agents", label: "Agents", icon: Bot,
      onPrefetch: () => onPrefetch("agents") }],
    ["search", { id: "search", label: "Search", icon: Search,
      onPrefetch: () => onPrefetch("search") }],
    ["source-control", {
      id: "source-control",
      label: "Source Control",
      icon: GitCompare,
      onPrefetch: () => onPrefetch("source-control"),
    }],
    ["pull-requests", {
      id: "pull-requests",
      label: "Pull Requests",
      tooltip: "GitHub Pull Requests",
      icon: Github,
      onPrefetch: () => onPrefetch("pull-requests"),
    }],
  ]);
}

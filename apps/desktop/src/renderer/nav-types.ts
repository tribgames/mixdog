export type NavigationSelection =
  | { kind: "new"; draftId?: string }
  | { kind: "project"; path: string }
  | { kind: "session"; id: string; title?: string }
  | { kind: "file"; project: string; rel: string; accessToken?: string };

/** Pane-only surfaces do not participate in the focused chat engine route.
 * They still use the same tab/split/persistence model as task and file tabs. */
export type WorkspaceSelection =
  | NavigationSelection
  | { kind: "studio"; id: string }
  | { kind: "terminal"; id: string; cwd?: string }
  | { kind: "folder"; id: string; path: string }
  | {
    kind: "pull-request";
    project: string;
    number: number;
    title?: string;
    mode: "overview" | "changes";
    instanceId?: string;
  }
  | {
    kind: "diff";
    project: string;
    rel: string;
    source: "staged" | "unstaged" | "commit";
    hash?: string;
    untracked?: boolean;
  };

export interface WorkspaceTab {
  key: string;
  title: string;
  selection: WorkspaceSelection;
  preview?: boolean;
  pinned?: boolean;
  dirty?: boolean;
}

export function nextWorkspaceTabAfterClose(
  tabs: readonly WorkspaceTab[],
  closingKey: string,
): WorkspaceTab | undefined {
  const index = tabs.findIndex((tab) => tab.key === closingKey);
  if (index < 0) return undefined;
  const remaining = tabs.filter((tab) => tab.key !== closingKey);
  return remaining[Math.min(index, remaining.length - 1)];
}

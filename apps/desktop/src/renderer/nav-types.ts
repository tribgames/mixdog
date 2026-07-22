export type NavigationSelection =
  | { kind: "new"; draftId?: string }
  | { kind: "project"; path: string }
  | { kind: "session"; id: string };

export interface WorkspaceTab {
  key: string;
  title: string;
  selection: NavigationSelection;
}

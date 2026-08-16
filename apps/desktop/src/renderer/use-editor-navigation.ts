import {
  useCallback,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type {
  NavigationSelection,
  WorkspaceSelection,
  WorkspaceTab,
} from "./navigation";
import {
  getEditorLanguageSnapshot,
  subscribeEditorLanguageStore,
  type EditorProblem,
} from "./editor-language-store";
import { primeEditorFileLoad } from "./editor-file-loader";
import { prefetchEditorPane } from "./lazy-widgets";
import { reportEditorLoadStage } from "./renderer-load-metrics";
import { navigationKey } from "./text-format";

export interface EditorNavigationLocation {
  project: string;
  rel: string;
  line: number;
  accessToken?: string;
}

interface EditorNavigationHistory {
  entries: EditorNavigationLocation[];
  index: number;
}

interface UseEditorNavigationOptions {
  setTabs: Dispatch<SetStateAction<WorkspaceTab[]>>;
  openSelectionInFocusedPane(
    selection: WorkspaceSelection,
    replaceKey?: string,
    options?: { preview?: boolean },
  ): void;
}

export interface EditorNavigationState {
  fileReveal: { key: string; line: number; nonce: number } | null;
  latestEditorLocation: MutableRefObject<EditorNavigationLocation | null>;
  editorNavigationHistory: MutableRefObject<EditorNavigationHistory>;
  openFileTab(
    project: string,
    rel: string,
    line?: number,
    accessToken?: string,
    recordHistory?: boolean,
    openMode?: "preview" | "pinned",
  ): void;
  openProblemQuickFix(problem: EditorProblem): void;
  navigateEditorHistory(offset: -1 | 1): void;
}

export function useEditorNavigation({
  setTabs,
  openSelectionInFocusedPane,
}: UseEditorNavigationOptions): EditorNavigationState {
  const [fileReveal, setFileReveal] =
    useState<{ key: string; line: number; nonce: number } | null>(null);
  const latestEditorLocation = useRef<EditorNavigationLocation | null>(null);
  const editorNavigationHistory = useRef<EditorNavigationHistory>({ entries: [], index: -1 });
  const [, setEditorNavigationRevision] = useState(0);

  const recordEditorNavigation = useCallback((target: EditorNavigationLocation) => {
    const history = editorNavigationHistory.current;
    const entries = history.entries.slice(0, history.index + 1);
    const same = (left: EditorNavigationLocation | undefined, right: EditorNavigationLocation) =>
      Boolean(left && left.project === right.project && left.rel === right.rel
        && left.line === right.line && left.accessToken === right.accessToken);
    const append = (location: EditorNavigationLocation | null) => {
      if (location && !same(entries.at(-1), location)) entries.push(location);
    };
    append(latestEditorLocation.current);
    append(target);
    history.entries = entries.slice(-200);
    history.index = history.entries.length - 1;
    latestEditorLocation.current = target;
    setEditorNavigationRevision((revision) => revision + 1);
  }, []);

  const openFileTab = useCallback((
    project: string,
    rel: string,
    line?: number,
    accessToken?: string,
    recordHistory = true,
    openMode: "preview" | "pinned" = "pinned",
  ) => {
    const cleanProject = String(project || "").trim();
    const cleanRel = String(rel || "").replace(/\\/g, "/").replace(/^\/+/, "");
    if (!cleanProject || !cleanRel) return;
    void primeEditorFileLoad(
      window.mixdogDesktop,
      cleanProject,
      cleanRel,
      accessToken,
    )?.catch(() => {});
    void prefetchEditorPane()
      .then(() => reportEditorLoadStage(
        cleanProject,
        cleanRel,
        accessToken,
        "module",
      ))
      .catch(() => {});
    const fileSelection: NavigationSelection = {
      kind: "file",
      project: cleanProject,
      rel: cleanRel,
      ...(accessToken ? { accessToken } : {}),
    };
    const key = navigationKey(fileSelection);
    const targetLocation = {
      project: cleanProject,
      rel: cleanRel,
      line: typeof line === "number" && line > 0 ? line : 1,
      ...(accessToken ? { accessToken } : {}),
    };
    if (recordHistory) recordEditorNavigation(targetLocation);
    else latestEditorLocation.current = targetLocation;
    setTabs((current) => {
      const existingIndex = current.findIndex((tab) =>
        tab.key === key
        || (tab.selection.kind === "file"
          && tab.selection.project === cleanProject
          && tab.selection.rel === cleanRel));
      if (existingIndex < 0) {
        return [...current, {
          key,
          title: cleanRel.split("/").at(-1) || cleanRel,
          selection: fileSelection,
        }];
      }
      const existing = current[existingIndex];
      if (existing.selection.kind !== "file") return current;
      const resolvedAccessToken = accessToken || existing.selection.accessToken;
      if (existing.key === navigationKey({
        ...fileSelection,
        ...(resolvedAccessToken ? { accessToken: resolvedAccessToken } : {}),
      }) && existing.selection.accessToken === resolvedAccessToken) return current;
      const resolvedSelection: NavigationSelection = {
        ...fileSelection,
        ...(resolvedAccessToken ? { accessToken: resolvedAccessToken } : {}),
      };
      return current.map((tab, index) => index === existingIndex
        ? { ...tab, key: navigationKey(resolvedSelection), selection: resolvedSelection }
        : tab);
    });
    openSelectionInFocusedPane(
      fileSelection,
      "",
      { preview: openMode === "preview" },
    );
    if (typeof line === "number" && line > 0) {
      setFileReveal({ key, line, nonce: Date.now() });
    }
  }, [openSelectionInFocusedPane, recordEditorNavigation, setTabs]);

  const openProblemQuickFix = useCallback((problem: EditorProblem) => {
    openFileTab(problem.projectPath, problem.relPath, problem.startLineNumber);
    let done = false;
    let timeout = 0;
    let unsubscribe = () => {};
    const stop = () => {
      if (done) return;
      done = true;
      window.clearTimeout(timeout);
      unsubscribe();
    };
    const tryOpen = () => {
      const active = getEditorLanguageSnapshot().active;
      if (!active
        || active.projectPath.replace(/[\\/]+/g, "/").toLocaleLowerCase()
          !== problem.projectPath.replace(/[\\/]+/g, "/").toLocaleLowerCase()
        || active.relPath.replace(/\\/g, "/").toLocaleLowerCase()
          !== problem.relPath.replace(/\\/g, "/").toLocaleLowerCase()) return;
      stop();
      window.requestAnimationFrame(() => window.dispatchEvent(
        new CustomEvent("mixdog:editor-action", {
          detail: {
            action: "quickFix",
            line: problem.startLineNumber,
            column: problem.startColumn,
          },
        }),
      ));
    };
    unsubscribe = subscribeEditorLanguageStore(tryOpen);
    timeout = window.setTimeout(stop, 4_000);
    tryOpen();
  }, [openFileTab]);

  const navigateEditorHistory = useCallback((offset: -1 | 1) => {
    const history = editorNavigationHistory.current;
    const nextIndex = history.index + offset;
    const target = history.entries[nextIndex];
    if (!target) return;
    history.index = nextIndex;
    latestEditorLocation.current = target;
    setEditorNavigationRevision((revision) => revision + 1);
    openFileTab(
      target.project,
      target.rel,
      target.line,
      target.accessToken,
      false,
    );
  }, [openFileTab]);

  return {
    fileReveal,
    latestEditorLocation,
    editorNavigationHistory,
    openFileTab,
    openProblemQuickFix,
    navigateEditorHistory,
  };
}

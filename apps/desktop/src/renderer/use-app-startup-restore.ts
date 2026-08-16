import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useEffect,
  useRef,
} from "react";

import type { DesktopSessionSummary } from "../shared/contract";
import { sessionSummaryTitle } from "../shared/session-title.mjs";
import { markBootStage } from "./boot-metrics";
import type { Snapshot } from "./desktop-types";
import type { NavigationSelection, WorkspaceSelection } from "./navigation";
import { startupRestorePlan } from "./renderer-logic.mjs";

export function useAppStartupRestore({
  restorePending,
  restoredFromStorage,
  startupFocusedPaneSelection,
  startupNavigationSelection,
  projectCatalogReady,
  snapshot,
  snapshotReady,
  sessions,
  selectionRef,
  viewedSessionRef,
  unreadViewedSessionRef,
  setSelection,
  setStartupSettled,
  activateSelection,
  openSessionRef,
  lastNewTaskPrefs,
  effectiveDraftProjectPath,
  preferredDraftProjectPath,
  setNewTaskDeferred,
  resetNewTaskDraft,
  lastSessionStorageKey,
  lastProjectStorageKey,
}: {
  restorePending: boolean;
  restoredFromStorage: boolean;
  startupFocusedPaneSelection: WorkspaceSelection | null | undefined;
  startupNavigationSelection: NavigationSelection | null | undefined;
  projectCatalogReady: boolean;
  snapshot: Snapshot;
  snapshotReady: boolean;
  sessions: DesktopSessionSummary[];
  selectionRef: MutableRefObject<NavigationSelection>;
  viewedSessionRef: MutableRefObject<string>;
  unreadViewedSessionRef: MutableRefObject<string>;
  setSelection: Dispatch<SetStateAction<NavigationSelection>>;
  setStartupSettled: Dispatch<SetStateAction<boolean>>;
  activateSelection(
    selection: NavigationSelection,
    title: string,
    replaceKey?: string,
  ): void;
  openSessionRef: MutableRefObject<(sessionId: string, force?: boolean) => Promise<void>>;
  lastNewTaskPrefs: MutableRefObject<{ projectPath: string } | null>;
  effectiveDraftProjectPath(path: string): string;
  preferredDraftProjectPath: string;
  setNewTaskDeferred: Dispatch<SetStateAction<boolean>>;
  resetNewTaskDraft(projectPath: string): void;
  lastSessionStorageKey: string;
  lastProjectStorageKey: string;
}) {
  const restoredStartupNavigation = useRef(false);

  useEffect(() => {
    const settleStartup = () => {
      (window as { __mixdogStartupSettled?: boolean }).__mixdogStartupSettled = true;
      setStartupSettled(true);
      markBootStage("startup-settled");
      window.dispatchEvent(new Event("mixdog:startup-settled"));
    };
    if (restoredStartupNavigation.current) return;
    if (restorePending) {
      window.requestAnimationFrame(settleStartup);
      return;
    }
    if (restoredFromStorage && startupFocusedPaneSelection) {
      restoredStartupNavigation.current = true;
      if (startupNavigationSelection) {
        selectionRef.current = startupNavigationSelection;
        setSelection(startupNavigationSelection);
        viewedSessionRef.current = startupNavigationSelection.kind === "session"
          ? startupNavigationSelection.id
          : "";
        unreadViewedSessionRef.current = viewedSessionRef.current;
        try {
          if (startupNavigationSelection.kind === "session") {
            window.localStorage.setItem(
              lastSessionStorageKey,
              startupNavigationSelection.id,
            );
          } else {
            window.localStorage.removeItem(lastSessionStorageKey);
          }
        } catch {
          // Startup routing remains best-effort.
        }
      }
      window.requestAnimationFrame(settleStartup);
      return;
    }
    if (!projectCatalogReady || !snapshotReady) return;
    restoredStartupNavigation.current = true;
    let storedSessionId = "";
    try {
      storedSessionId = window.localStorage.getItem(lastSessionStorageKey) || "";
    } catch {
      // Continue with the safe draft fallback.
    }
    const plan = startupRestorePlan({
      storedSessionId,
      storedSessionKnown: Boolean(storedSessionId
        && sessions.some((session) => session.id === storedSessionId)),
      engineSessionId: String(snapshot.sessionId || ""),
    });
    if (plan.clearStored) {
      try {
        window.localStorage.removeItem(lastSessionStorageKey);
      } catch {
        // A stale key is harmless.
      }
    }
    try {
      window.mixdogDesktop?.perfLog?.(
        `startup-restore action=${plan.action} target=${plan.sessionId || "(none)"}`
        + ` stored=${storedSessionId || "(none)"}`
        + ` engine=${String(snapshot.sessionId || "") || "(none)"}`,
      );
    } catch {
      // Diagnostics only.
    }
    if (plan.action === "activate") {
      const current = sessions.find((session) => session.id === plan.sessionId);
      activateSelection(
        { kind: "session", id: plan.sessionId },
        current
          ? sessionSummaryTitle(current)
          : String(snapshot.desktopSessionTitle || "New task"),
      );
      settleStartup();
      return;
    }
    if (plan.action === "resume") {
      void openSessionRef.current(plan.sessionId, true).finally(settleStartup);
      return;
    }
    let storedProject = "";
    try {
      storedProject = window.localStorage.getItem(lastProjectStorageKey) || "";
    } catch {
      // Continue with the preferred draft project.
    }
    const cachedDraftProject = lastNewTaskPrefs.current
      ? effectiveDraftProjectPath(lastNewTaskPrefs.current.projectPath)
      : effectiveDraftProjectPath(storedProject || preferredDraftProjectPath);
    if (!cachedDraftProject) {
      setNewTaskDeferred(true);
      settleStartup();
      return;
    }
    resetNewTaskDraft(cachedDraftProject);
    activateSelection({ kind: "new" }, "New task");
    settleStartup();
  }, [
    activateSelection,
    effectiveDraftProjectPath,
    lastNewTaskPrefs,
    lastProjectStorageKey,
    lastSessionStorageKey,
    openSessionRef,
    preferredDraftProjectPath,
    projectCatalogReady,
    resetNewTaskDraft,
    restorePending,
    restoredFromStorage,
    selectionRef,
    sessions,
    setNewTaskDeferred,
    setSelection,
    setStartupSettled,
    snapshot,
    snapshotReady,
    startupFocusedPaneSelection,
    startupNavigationSelection,
    unreadViewedSessionRef,
    viewedSessionRef,
  ]);
}

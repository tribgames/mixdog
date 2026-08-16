import { useCallback, useRef, type MutableRefObject } from "react";
import type {
  DesktopPromptContent,
  DesktopSessionSummary,
  DesktopSubmitOptions,
  SessionSnapshot,
} from "../shared/contract";
import { promptTitle } from "../shared/session-title.mjs";
import type { NavigationSelection } from "./navigation";
import type { PaneLeaf } from "./pane-layout";
import { remoteNewTaskMode, setRemoteNewTaskMode } from "./remote-preferences";
import { asRecord, navigationKey } from "./text-format";
import type { DraftPanePrefs } from "./use-draft-pane-preferences";

export function useAppSubmitRouting({
  selectionRef,
  focusedLeafIdRef,
  paneLeavesRef,
  navigationEpoch,
  resolvedDraftPrefsFor,
  effectiveDraftProjectPath,
  clearNewTaskPreferences,
  setNewTaskDeferred,
  stageCreatedSession,
  activateSelection,
  promoteSelectionInLeaf,
  registerWorkspaceSelection,
  applySessionLaneResult,
}: {
  selectionRef: MutableRefObject<NavigationSelection>;
  focusedLeafIdRef: MutableRefObject<string>;
  paneLeavesRef: MutableRefObject<PaneLeaf[]>;
  navigationEpoch: MutableRefObject<number>;
  resolvedDraftPrefsFor(draftKey: string): DraftPanePrefs;
  effectiveDraftProjectPath(candidate: unknown): string;
  clearNewTaskPreferences(target?: NavigationSelection): void;
  setNewTaskDeferred(value: boolean): void;
  stageCreatedSession(session: DesktopSessionSummary): void;
  activateSelection(selection: NavigationSelection, title: string, replaceKey?: string): void;
  promoteSelectionInLeaf(leafId: string, selection: NavigationSelection, replaceKey?: string): void;
  registerWorkspaceSelection(selection: NavigationSelection, title: string, replaceKey?: string): void;
  applySessionLaneResult(sessionId: string, snapshot: SessionSnapshot | null): void;
}) {
  type SubmitRoute = {
    selection: NavigationSelection;
    leafId: string;
  };
  const submitFromRoute = useCallback(async (
    route: SubmitRoute,
    content: DesktopPromptContent,
    options?: DesktopSubmitOptions,
  ): Promise<unknown> => {
    const host = window.mixdogDesktop;
    if (!host) return false;
    const routeSelection = route.selection;
    const draftKey = routeSelection.kind === "new" ? navigationKey(routeSelection) : "";
    const draftPrefsKey = routeSelection.kind === "new"
      ? routeSelection.draftId || "default"
      : "";
    const draftPrefs = draftPrefsKey ? resolvedDraftPrefsFor(draftPrefsKey) : null;
    const submitEpoch = navigationEpoch.current;
    const draftRouteStillExists = () => Boolean(draftKey)
      && paneLeavesRef.current.some((leaf) => leaf.id === route.leafId
        && leaf.tabs.some((tab) => navigationKey(tab) === draftKey));
    const draftStillSelected = () => draftRouteStillExists()
      && focusedLeafIdRef.current === route.leafId
      && selectionRef.current.kind === "new"
      && navigationKey(selectionRef.current) === draftKey
      && navigationEpoch.current === submitEpoch;
    let startedSessionId = "";
    let accepted: unknown;
    // One-shot channel-relay reservation: capture the draft's Remote choice at
    // submit time. The atomic new-task path claims the seat host-side at
    // session creation (attach immediately); success consumes the reservation
    // so the NEXT new task starts remote-off again (user decision).
    const newTaskRemoteRequested = routeSelection.kind === "new"
      && remoteNewTaskMode() === "on";
    const submittedProjectPath = routeSelection.kind === "new"
      ? effectiveDraftProjectPath(draftPrefs?.projectPath || "")
      : "";
    try {
      if (routeSelection.kind === "new") {
        const result = await host.submitNewTask(content, options, {
          ...(submittedProjectPath
            ? { projectPath: submittedProjectPath }
            : {}),
          ...(draftPrefs?.modelSelection
            ? { route: draftPrefs.modelSelection }
            : {}),
          ...(draftPrefs?.workflow?.id
            ? { workflowId: draftPrefs.workflow.id }
            : {}),
          ...(newTaskRemoteRequested ? { remote: true } : {}),
        });
        accepted = result.accepted;
        startedSessionId = result.accepted ? String(result.sessionId || "") : "";
        if (result.accepted && !startedSessionId) {
          throw new Error("New task submission was accepted without a session id.");
        }
        if (result.accepted && startedSessionId) {
          const resultSessionId = String(asRecord(result.snapshot)?.sessionId || "");
          if (resultSessionId !== startedSessionId) {
            throw new Error("New task session returned a mismatched session snapshot.");
          }
          applySessionLaneResult(startedSessionId, result.snapshot);
        }
        if (result.accepted && draftStillSelected()) {
          clearNewTaskPreferences(routeSelection);
          setNewTaskDeferred(false);
        }
      } else if (routeSelection.kind === "session") {
        accepted = await host.submitToSession(routeSelection.id, content, options);
      } else {
        throw new Error("Prompt submission requires a New task draft or session.");
      }
    } catch (reason) {
      throw reason;
    }
    if (accepted === true) {
      // Consume the reservation once a session actually claimed it, even when
      // the user already navigated away: the seat is taken either way.
      if (newTaskRemoteRequested) setRemoteNewTaskMode("off");
      if (routeSelection.kind === "new" && draftRouteStillExists()) {
        const activeSessionId = startedSessionId;
        if (activeSessionId) {
          const title = promptTitle(content, options?.displayText || "") || "New task";
          const sessionSelection = { kind: "session", id: activeSessionId } as const;
          const submittedAt = Number(options?.submittedAt);
          const activityAt = Number.isFinite(submittedAt) && submittedAt > 0
            ? submittedAt
            : Date.now();
          // One commit owns both visible changes: the draft pane promotes and
          // its keyed Recent row appears. The host catalog later reconciles
          // metadata onto this row instead of inserting/removing it around the
          // first prompt acknowledgement.
          stageCreatedSession({
            id: activeSessionId,
            preview: title,
            title,
            updatedAt: activityAt,
            activityAt,
            messageCount: 1,
            cwd: submittedProjectPath,
            classification: submittedProjectPath ? "project" : "task",
            projectPath: submittedProjectPath || null,
            working: true,
          } satisfies DesktopSessionSummary);
          if (draftStillSelected()) {
            navigationEpoch.current += 1;
            activateSelection(sessionSelection, title, draftKey);
            setNewTaskDeferred(false);
          } else {
            // The ACK belongs to the pane/draft that dispatched it. A focus
            // change while it was in flight may not redirect the promotion or
            // pull the user back from the pane they moved to.
            promoteSelectionInLeaf(route.leafId, sessionSelection, draftKey);
            registerWorkspaceSelection(sessionSelection, title, draftKey);
          }
        }
      }
    }
    return accepted;
  }, [
    activateSelection,
    clearNewTaskPreferences,
    effectiveDraftProjectPath,
    promoteSelectionInLeaf,
    registerWorkspaceSelection,
    resolvedDraftPrefsFor,
    stageCreatedSession,
  ]);
  const submitFromRouteRef = useRef(submitFromRoute);
  submitFromRouteRef.current = submitFromRoute;
  const submit = useCallback((
    content: DesktopPromptContent,
    options?: DesktopSubmitOptions,
  ): Promise<unknown> => submitFromRouteRef.current({
    selection: selectionRef.current,
    leafId: focusedLeafIdRef.current,
  }, content, options), []);
  // Split panes: a session pane's prompt path is addressed by ITS sessionId,
  // never by the globally active selection. Snapshot lanes are already
  // pane-local; routing every submit through the active route made a focused
  // pane's Enter land in — or promote onto — another pane's session, or stall
  // silently when selection and focus disagreed (user: 다른 세션이 복사됨 /
  // 간헐적으로 입력이 안 먹음).
  const submitToPaneSession = useCallback(async (
    sessionId: string,
    content: DesktopPromptContent,
    options?: DesktopSubmitOptions,
  ): Promise<unknown> => {
    const host = window.mixdogDesktop;
    if (!host) return false;
    // The service transport owns the authoritative request deadline. A shorter
    // renderer watchdog raced valid auto-clear/session-recovery intake: it
    // restored the draft while the same submission was accepted moments later,
    // inviting a duplicate retry.
    return await host.submitToSession(sessionId, content, options);
  }, []);
  // Stable per-session submit identity so memoised pane trees do not
  // re-render from a fresh closure on every App commit.
  const paneSessionSubmitCache = useRef(new Map<string, (
    content: DesktopPromptContent,
    options?: DesktopSubmitOptions,
  ) => Promise<unknown>>());
  const submitToPaneSessionRef = useRef(submitToPaneSession);
  submitToPaneSessionRef.current = submitToPaneSession;
  const paneSubmitFor = (sessionId: string) => {
    let fn = paneSessionSubmitCache.current.get(sessionId);
    if (!fn) {
      fn = (content, options) =>
        submitToPaneSessionRef.current(sessionId, content, options);
      paneSessionSubmitCache.current.set(sessionId, fn);
      while (paneSessionSubmitCache.current.size > 32) {
        const oldest = paneSessionSubmitCache.current.keys().next().value;
        if (oldest === undefined) break;
        paneSessionSubmitCache.current.delete(oldest);
      }
    }
    return fn;
  };
  const paneDraftSubmitCache = useRef(new Map<string, (
    content: DesktopPromptContent,
    options?: DesktopSubmitOptions,
  ) => Promise<unknown>>());
  const paneDraftSubmitFor = (
    draftSelection: Extract<NavigationSelection, { kind: "new" }>,
    leafId: string,
  ) => {
    const key = `${leafId}\u0000${navigationKey(draftSelection)}`;
    let fn = paneDraftSubmitCache.current.get(key);
    if (!fn) {
      fn = (content, options) => submitFromRouteRef.current({
        selection: draftSelection,
        leafId,
      }, content, options);
      paneDraftSubmitCache.current.set(key, fn);
      while (paneDraftSubmitCache.current.size > 32) {
        const oldest = paneDraftSubmitCache.current.keys().next().value;
        if (oldest === undefined) break;
        paneDraftSubmitCache.current.delete(oldest);
      }
    }
    return fn;
  };


  return { paneDraftSubmitFor, paneSubmitFor, submit };
}

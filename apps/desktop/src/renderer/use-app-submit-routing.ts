import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import type {
  DesktopPromptContent,
  DesktopSessionSummary,
  DesktopSubmitOptions,
  SessionSnapshot,
} from '../shared/contract';
import { promptTitle } from '../shared/session-title.mjs';
import { displaySessionTitle } from './session-display-title';
import type { NavigationSelection } from './navigation';
import type { PaneLeaf } from './pane-layout';
import { asRecord, navigationKey } from './text-format';
import { noteDraftPromotion } from './composer-draft';
import { submittedDraftRoute } from './draft-pane-prefs-store';
import type { ResolvedDraftPrefs } from './use-draft-pane-preferences';
import { sendDraftWithWorktreeIntent } from './worktree-branch-model';

const MAX_CACHED_SUBMIT_ENTRIES = 32;

/** Drops insertion-oldest entries beyond the cap; `keep` is never evicted. */
function evictOldest(map: Map<string, unknown>, keep?: string): void {
  while (map.size > MAX_CACHED_SUBMIT_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest === undefined || oldest === keep) break;
    map.delete(oldest);
  }
}

type SubmitFn = (content: DesktopPromptContent, options?: DesktopSubmitOptions) => Promise<unknown>;

/** The stable submit function for `key`, created once so memoised pane trees
 *  do not re-render from a fresh closure on every App commit. */
function cachedSubmit(cache: Map<string, SubmitFn>, key: string, make: SubmitFn): SubmitFn {
  let fn = cache.get(key);
  if (!fn) {
    fn = make;
    cache.set(key, fn);
    evictOldest(cache);
  }
  return fn;
}

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
  seedCreatedSessionLane,
}: {
  selectionRef: MutableRefObject<NavigationSelection>;
  focusedLeafIdRef: MutableRefObject<string>;
  paneLeavesRef: MutableRefObject<PaneLeaf[]>;
  navigationEpoch: MutableRefObject<number>;
  resolvedDraftPrefsFor(draftKey: string): ResolvedDraftPrefs;
  effectiveDraftProjectPath(candidate: unknown): string;
  clearNewTaskPreferences(target?: NavigationSelection): void;
  setNewTaskDeferred(value: boolean): void;
  stageCreatedSession(session: DesktopSessionSummary): void;
  activateSelection(selection: NavigationSelection, title: string, replaceKey?: string): void;
  promoteSelectionInLeaf(leafId: string, selection: NavigationSelection, replaceKey?: string): void;
  registerWorkspaceSelection(selection: NavigationSelection, title: string, replaceKey?: string): void;
  seedCreatedSessionLane(sessionId: string, snapshot: SessionSnapshot | null): void;
}) {
  type SubmitRoute = {
    selection: NavigationSelection;
  };
  const draftSubmissions = useRef(new Map<string, Promise<string>>());
  /** Claims the draft's creation slot before the first await, so a same-tick
   *  second submit already observes it. The claim settles with the created
   *  session id, or drops itself when the draft never reached one (retryable). */
  const claimDraftSubmission = (draftKey: string) => {
    let settle: (sessionId: string) => void = () => {};
    draftSubmissions.current.set(
      draftKey,
      new Promise<string>((resolve) => {
        settle = resolve;
      })
    );
    evictOldest(draftSubmissions.current, draftKey);
    return (sessionId: string) => {
      if (!sessionId) draftSubmissions.current.delete(draftKey);
      settle(sessionId);
    };
  };
  // Drafts whose session is minted; their mapping is retired once the draft tab leaves every pane.
  const endedDrafts = useRef(new Set<string>());
  useEffect(() => {
    for (const draftKey of endedDrafts.current) {
      if (paneLeavesRef.current.some((leaf) => leaf.tabs.some((tab) => navigationKey(tab) === draftKey))) continue;
      endedDrafts.current.delete(draftKey);
      draftSubmissions.current.delete(draftKey);
    }
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: refs and stable setters are read at call time; the listed callbacks are the only inputs that change the identity
  const submitFromRoute = useCallback(
    async (route: SubmitRoute, content: DesktopPromptContent, options?: DesktopSubmitOptions): Promise<unknown> => {
      const host = window.mixdogDesktop;
      if (!host) return false;
      const routeSelection = route.selection;
      const draftKey = routeSelection.kind === 'new' ? navigationKey(routeSelection) : '';
      const draftPrefsKey = routeSelection.kind === 'new' ? routeSelection.draftId || 'default' : '';
      const draftPrefs = draftPrefsKey ? resolvedDraftPrefsFor(draftPrefsKey) : null;
      const draftRoute = submittedDraftRoute(draftPrefs);
      // The pane holding the draft's tab now: a tab dragged to another pane
      // or split off while its prompt is in flight promotes where it went.
      const draftLeafId = () =>
        draftKey
          ? (paneLeavesRef.current.find((leaf) => leaf.tabs.some((tab) => navigationKey(tab) === draftKey))?.id ?? '')
          : '';
      const draftRouteStillExists = () => Boolean(draftLeafId());
      // Shown now, however the user got back to it.
      const draftStillSelected = () =>
        draftRouteStillExists() &&
        focusedLeafIdRef.current === draftLeafId() &&
        selectionRef.current.kind === 'new' &&
        navigationKey(selectionRef.current) === draftKey;
      let startedSessionId = '';
      let accepted: unknown;
      const submittedProjectPath =
        routeSelection.kind === 'new' ? effectiveDraftProjectPath(draftPrefs?.projectPath || '') : '';
      if (routeSelection.kind === 'new') {
        const pendingDraftSession = draftSubmissions.current.get(draftKey);
        const draftSessionId = pendingDraftSession ? await pendingDraftSession : '';
        // This draft already owns a session, promoted or still promoting: the
        // prompt joins that engine queue instead of minting a second session.
        if (draftSessionId) return await host.submitToSession(draftSessionId, content, options);
        const settleDraftSession = claimDraftSubmission(draftKey);
        // The draft's "Worktree" choice rides with its first prompt; it is
        // given back when the task was not started, so a retry keeps it.
        try {
          const result = (await sendDraftWithWorktreeIntent(draftPrefsKey, (choice) =>
            host.submitNewTask(content, options, {
              ...(submittedProjectPath ? { projectPath: submittedProjectPath } : {}),
              ...(draftRoute ? { route: draftRoute } : {}),
              ...(draftPrefs?.workflow?.id ? { workflowId: draftPrefs.workflow.id } : {}),
              ...(draftPrefs?.orchestrationMode ? { orchestrationMode: draftPrefs.orchestrationMode } : {}),
              ...(choice ? { worktree: choice } : {}),
            })
          )) ?? { accepted: false, sessionId: '', snapshot: null };
          accepted = result.accepted;
          startedSessionId = result.accepted ? String(result.sessionId || '') : '';
          if (result.accepted && !startedSessionId) {
            throw new Error('New task submission was accepted without a session id.');
          }
          if (startedSessionId) {
            const resultSessionId = String(asRecord(result.snapshot)?.sessionId || '');
            if (resultSessionId !== startedSessionId) {
              throw new Error('New task session returned a mismatched session snapshot.');
            }
            seedCreatedSessionLane(startedSessionId, result.snapshot);
            // The composer of this draft hands its late chips to exactly this session.
            noteDraftPromotion(draftPrefsKey, startedSessionId);
          }
          if (result.accepted && draftStillSelected()) {
            clearNewTaskPreferences(routeSelection);
            setNewTaskDeferred(false);
          }
        } finally {
          settleDraftSession(startedSessionId);
        }
      } else if (routeSelection.kind === 'session') {
        accepted = await host.submitToSession(routeSelection.id, content, options);
      } else {
        throw new Error('Prompt submission requires a New task draft or session.');
      }
      if (accepted === true) {
        if (routeSelection.kind === 'new' && draftRouteStillExists()) {
          if (startedSessionId) {
            const title = promptTitle(content, options?.displayText || '') || 'New task';
            const sessionSelection = { kind: 'session', id: startedSessionId } as const;
            const submittedAt = Number(options?.submittedAt);
            const activityAt = Number.isFinite(submittedAt) && submittedAt > 0 ? submittedAt : Date.now();
            stageCreatedSession({
              id: startedSessionId,
              preview: title,
              title,
              updatedAt: activityAt,
              activityAt,
              messageCount: 1,
              cwd: submittedProjectPath,
              classification: submittedProjectPath ? 'project' : 'task',
              projectPath: submittedProjectPath || null,
              working: true,
            } satisfies DesktopSessionSummary);
            if (draftStillSelected()) {
              navigationEpoch.current += 1;
              activateSelection(sessionSelection, displaySessionTitle(title), draftKey);
              setNewTaskDeferred(false);
            } else {
              // The ACK belongs to the pane/draft that dispatched it. A focus
              // change while it was in flight may not redirect the promotion or
              // pull the user back from the pane they moved to.
              promoteSelectionInLeaf(draftLeafId(), sessionSelection, draftKey);
              registerWorkspaceSelection(sessionSelection, displaySessionTitle(title), draftKey);
            }
          }
        }
      }
      if (startedSessionId) {
        if (draftRouteStillExists()) endedDrafts.current.add(draftKey);
        else draftSubmissions.current.delete(draftKey);
      }
      return accepted;
    },
    [
      activateSelection,
      clearNewTaskPreferences,
      effectiveDraftProjectPath,
      promoteSelectionInLeaf,
      registerWorkspaceSelection,
      resolvedDraftPrefsFor,
      stageCreatedSession,
    ]
  );
  const submitFromRouteRef = useRef(submitFromRoute);
  submitFromRouteRef.current = submitFromRoute;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the selection ref is read at call time so submit keeps a stable identity
  const submit = useCallback(
    (content: DesktopPromptContent, options?: DesktopSubmitOptions): Promise<unknown> =>
      submitFromRouteRef.current({ selection: selectionRef.current }, content, options),
    []
  );
  const paneSessionSubmitCache = useRef(new Map<string, SubmitFn>());
  const paneSubmitFor = (sessionId: string) =>
    cachedSubmit(paneSessionSubmitCache.current, sessionId, async (content, options) => {
      const host = window.mixdogDesktop;
      if (!host) return false;
      return await host.submitToSession(sessionId, content, options);
    });
  const paneDraftSubmitCache = useRef(new Map<string, SubmitFn>());
  const paneDraftSubmitFor = (draftSelection: Extract<NavigationSelection, { kind: 'new' }>, leafId: string) => {
    const key = `${leafId}\u0000${navigationKey(draftSelection)}`;
    return cachedSubmit(paneDraftSubmitCache.current, key, (content, options) =>
      submitFromRouteRef.current({ selection: draftSelection }, content, options)
    );
  };

  return { paneDraftSubmitFor, paneSubmitFor, submit };
}

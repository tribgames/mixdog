import { useEffect, useState, type ReactNode, type Ref } from 'react';
import { ComposerQueueTrayContext } from './composer-island-state';
import {
  ComposerIsland,
  type ComposerIslandFlash,
  type ComposerIslandModelMismatch,
  type ComposerIslandQuota,
  type ComposerIslandQuotaResume,
} from './ComposerIsland';
import type { TranscriptItem } from './desktop-types';
import { SessionGoalHost } from './session-goal-submission';

// The changed-files segment only paints for a file-touching turn, so its diff
// analysis stays out of the first-screen bundle.
type TurnReviewModule = typeof import('./TurnReview');
let loadedReviewModule: TurnReviewModule | null = null;
let reviewModulePromise: Promise<TurnReviewModule> | null = null;

/**
 * The chrome stacked ABOVE the prompt input, with the composer itself as the
 * last child. A New Task draft keeps its project/workflow/mode context bar; a
 * session gets the composer island in a fixed slot instead (Goal, background
 * jobs, changed files, model mismatch, tool approval, flashes), then the
 * queued follow-up tray attached to the composer's top edge.
 *
 * The dock overlays the transcript and its measured height is the bottom
 * clearance. The island slot reserves a constant height and every island
 * expansion overlays upward, so only the queue tray changes the dock height.
 */
export function ComposerDock({
  dockRef,
  sessionId,
  goalIsland,
  goalSubmissionId,
  approval,
  islandFlash,
  modelMismatch,
  quotaExhausted,
  quotaResume,
  showProjectSelector,
  contextBar,
  reviewItems,
  reviewActive,
  reviewBusy,
  reviewSessionId,
  reviewCwd,
  onOpenSessionDiff,
  onOpenAgentSession,
  onOpenBackgroundJobs,
  children,
}: {
  dockRef?: Ref<HTMLDivElement>;
  /** The pane's visible session ('' while hidden or a draft): the island's
   *  background jobs read its lane. */
  sessionId: string;
  goalIsland?: ReactNode;
  /** Closes previous-turn Goal chrome with the optimistic row (see
   *  session-goal-submission). */
  goalSubmissionId: string;
  /** The live tool approval card; the island grows into it. */
  approval?: ReactNode;
  islandFlash?: ComposerIslandFlash | null;
  modelMismatch?: ComposerIslandModelMismatch | null;
  quotaExhausted?: ComposerIslandQuota | null;
  quotaResume?: ComposerIslandQuotaResume | null;
  showProjectSelector: boolean;
  contextBar?: ReactNode;
  reviewItems: TranscriptItem[];
  reviewActive: boolean;
  reviewBusy: boolean;
  reviewSessionId: string;
  reviewCwd: string;
  /** The files segment opens the pane's side dock on the session diff; when
   *  absent (no dock) it expands the island to the turn's file list. */
  onOpenSessionDiff?: () => void;
  /** The jobs panel opens an agent's session. */
  onOpenAgentSession?: (sessionId: string, title: string, ownerSessionId: string) => void;
  /** The agent/shell segments open the pane's side dock on the jobs list;
   *  when absent they expand the island's popover. */
  onOpenBackgroundJobs?: (kind: 'agent' | 'shell') => void;
  children: ReactNode;
}) {
  const [reviewModule, setReviewModule] = useState(() => loadedReviewModule);
  const [moduleFailure, setModuleFailure] = useState<{ error: unknown } | null>(null);
  const [queueTray, setQueueTray] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (reviewModule) return undefined;
    let active = true;
    reviewModulePromise ??= import('./TurnReview').then((module) => (loadedReviewModule = module));
    void reviewModulePromise.then(
      (module) => {
        if (active) setReviewModule(module);
      },
      (error: unknown) => {
        if (active) setModuleFailure({ error });
      }
    );
    return () => {
      active = false;
    };
  }, [reviewModule]);
  if (moduleFailure) throw moduleFailure.error;
  const TurnReviewBar = reviewModule?.TurnReviewBar;

  return (
    <div className="composer-region" ref={dockRef}>
      {showProjectSelector ? (
        <div className="composer-context-bar">{contextBar}</div>
      ) : (
        <ComposerIsland
          sessionId={sessionId}
          onOpenAgentSession={onOpenAgentSession}
          onOpenBackgroundJobs={onOpenBackgroundJobs}
          goal={<SessionGoalHost submissionId={goalSubmissionId}>{goalIsland}</SessionGoalHost>}
          files={
            // Keep the entry gate until the module and its authoritative read
            // are ready, but do not let Suspense's reveal throttle hold an
            // already loaded segment (and the entire transcript) for 300ms.
            TurnReviewBar ? (
              <TurnReviewBar
                variant="segment"
                items={reviewItems}
                active={reviewActive}
                busy={reviewBusy}
                sessionId={reviewSessionId}
                cwd={reviewCwd}
                onOpenChanges={onOpenSessionDiff}
              />
            ) : (
              <span hidden data-entry-pending />
            )
          }
          approval={approval}
          flash={islandFlash}
          modelMismatch={modelMismatch}
          quotaExhausted={quotaExhausted}
          quotaResume={quotaResume}
        />
      )}
      <div className="composer-queue-tray" ref={setQueueTray} />
      <ComposerQueueTrayContext.Provider value={queueTray}>{children}</ComposerQueueTrayContext.Provider>
    </div>
  );
}

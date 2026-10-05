import { useEffect, useState, type ReactNode } from 'react';
import type { TranscriptItem } from './desktop-types';
import { SessionGoalHost } from './session-goal-submission';

// The review bar only paints for a file-touching turn, so its diff analysis
// stays out of the first-screen bundle.
type TurnReviewModule = typeof import('./TurnReview');
let loadedReviewModule: TurnReviewModule | null = null;
let reviewModulePromise: Promise<TurnReviewModule> | null = null;

/**
 * The chrome stacked ABOVE the prompt input: Goal capsule, tool approval, the draft-only context bar, and the turn-review slot, with
 * the composer itself as the last child.
 *
 * Slots take space only while their content renders. Their geometry commits
 * once, with no retained closing card or height animation: each animation
 * step used to resize and scroll the entire transcript above the input.
 * The timeline applies the resulting viewport change before paint.
 */

export function ComposerDock({
  goalIsland,
  goalSubmissionId,
  approval,
  showProjectSelector,
  contextBar,
  reviewItems,
  reviewActive,
  reviewBusy,
  reviewSessionId,
  reviewCwd,
  onOpenFile,
  children,
}: {
  goalIsland?: ReactNode;
  /** Closes previous-turn Goal chrome with the optimistic row (see
   *  session-goal-submission). */
  goalSubmissionId: string;
  approval?: ReactNode;
  showProjectSelector: boolean;
  contextBar?: ReactNode;
  reviewItems: TranscriptItem[];
  reviewActive: boolean;
  reviewBusy: boolean;
  reviewSessionId: string;
  reviewCwd: string;
  onOpenFile?: (project: string, rel: string) => void;
  children: ReactNode;
}) {
  const [reviewModule, setReviewModule] = useState(() => loadedReviewModule);
  const [moduleFailure, setModuleFailure] = useState<{ error: unknown } | null>(null);
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
    <div className="composer-region">
      <SessionGoalHost placement="composer" submissionId={goalSubmissionId}>
        {goalIsland}
      </SessionGoalHost>
      {approval && <div className="composer-approval-row">{approval}</div>}
      {showProjectSelector && <div className="composer-context-bar">{contextBar}</div>}
      {/* Review sits attached ABOVE the input (user: 채팅창 위에 붙어야 한다).
          It is not a timeline row: as scroll content it read as a detached
          card floating over the composer. */}
      <div className="turn-review-slot">
        {/* Keep the entry gate until the module and its authoritative read
            are ready, but do not let Suspense's reveal throttle hold an
            already loaded review slot (and the entire transcript) for 300ms. */}
        {TurnReviewBar ? (
          <TurnReviewBar
            items={reviewItems}
            active={reviewActive}
            busy={reviewBusy}
            sessionId={reviewSessionId}
            cwd={reviewCwd}
            onOpenFile={onOpenFile}
          />
        ) : (
          <span hidden data-entry-pending />
        )}
      </div>
      {children}
    </div>
  );
}

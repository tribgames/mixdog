import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type Ref, type RefObject } from 'react';
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
 * The dock overlays the transcript. Visible slots contribute measured bottom
 * clearance, while Goal and review disclosures expand above their fixed
 * footprints without changing the scroller's height or reading position.
 */

/** The open review grows upward past its reserved slot; publish that excess
 *  as `--turn-review-lift` so the Goal capsule above rides on top of it
 *  instead of covering the file list. */
function useTurnReviewLift(slotRef: RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    const slot = slotRef.current;
    const region = slot?.parentElement;
    if (!slot || !region) return undefined;
    let bar: Element | null = null;
    const apply = () => {
      const lift = bar ? Math.max(0, Math.round(bar.getBoundingClientRect().height - slot.offsetHeight)) : 0;
      region.style.setProperty('--turn-review-lift', `${lift}px`);
    };
    const resize = new ResizeObserver(apply);
    const track = () => {
      const next = slot.querySelector(':scope > .turn-review-bar');
      if (next !== bar) {
        if (bar) resize.unobserve(bar);
        bar = next;
        if (bar) resize.observe(bar);
      }
      apply();
    };
    const mutations = new MutationObserver(track);
    mutations.observe(slot, { childList: true });
    resize.observe(slot);
    track();
    return () => {
      mutations.disconnect();
      resize.disconnect();
      region.style.removeProperty('--turn-review-lift');
    };
  }, [slotRef]);
}

export function ComposerDock({
  dockRef,
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
  dockRef?: Ref<HTMLDivElement>;
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
  const reviewSlotRef = useRef<HTMLDivElement | null>(null);
  useTurnReviewLift(reviewSlotRef);
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
      <SessionGoalHost placement="composer" submissionId={goalSubmissionId}>
        {goalIsland}
      </SessionGoalHost>
      {approval && <div className="composer-approval-row">{approval}</div>}
      {showProjectSelector && <div className="composer-context-bar">{contextBar}</div>}
      {/* Review sits attached ABOVE the input (user: 채팅창 위에 붙어야 한다).
          It is not a timeline row: as scroll content it read as a detached
          card floating over the composer. */}
      <div className="turn-review-slot" ref={reviewSlotRef}>
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

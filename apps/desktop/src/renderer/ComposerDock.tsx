import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ApprovalOpenSessionContext } from './approval-prompt';
import { IslandSegmentPending } from './composer-island-state';
import {
  ComposerIsland,
  type ComposerIslandFlash,
  type ComposerIslandQuotaResume,
  rememberedSegmentAdvances,
  rememberedSlotHeight,
} from './ComposerIsland';
import { ComposerQuotaCard, type ComposerQuotaCardModel } from './ComposerQuotaCard';
import type { DesktopSessionWorkspace } from '../shared/contract';
import type { TranscriptItem } from './desktop-types';
import { BranchIslandSegment } from './WorktreeIslandSegment';
import { IslandGitSegment } from './IslandGitSegment';
import { SessionGoalHost } from './session-goal-submission';
import { requestSessionDiffFile, requestSessionDiffList } from './session-diff-focus';
import { useStableEvent } from './use-stable-event';

// The changed-files segment only paints for a file-touching turn, so its diff
// analysis stays out of the first-screen bundle.
type TurnReviewModule = typeof import('./TurnReview');
let loadedReviewModule: TurnReviewModule | null = null;
let reviewModulePromise: Promise<TurnReviewModule> | null = null;

/** Just over the island's own 2.5 s flash, so one showing completes. */
const WORKTREE_FLASH_MS = 2_600;

interface ComposerDockProps {
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
  /** The quota card, between the island and the composer. */
  quotaCard?: ComposerQuotaCardModel | null;
  quotaResume?: ComposerIslandQuotaResume | null;
  showProjectSelector: boolean;
  /** Agent mode: the island carries no branch, files or PR segment. */
  agentMode?: boolean;
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
  /** The session's live workspace: a git checkout adds the island's branch segment. */
  workspace?: DesktopSessionWorkspace | null;
  /** A message sent behind the running turn waits to be read: the branch
   *  segment cannot switch. */
  pendingInput?: boolean;
  children: ReactNode;
}

function useTurnReviewBar() {
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
  return reviewModule?.TurnReviewBar;
}

function useContextBarHeight(shown: boolean) {
  const ref = useRef<HTMLDivElement | null>(null);
  const height = useRef(0);
  useEffect(() => {
    const bar = shown ? ref.current : null;
    if (!bar) return undefined;
    const observer = new ResizeObserver(() => {
      height.current = bar.offsetHeight;
    });
    observer.observe(bar);
    return () => {
      observer.disconnect();
      height.current = 0;
    };
  }, [shown]);
  return { ref, height };
}

/** The chrome stacked above the prompt input, the composer itself the last child: a New Task draft's context bar, or a session's island and quota card. */
export function ComposerDock({
  sessionId,
  goalIsland,
  goalSubmissionId,
  approval,
  islandFlash,
  quotaCard,
  quotaResume,
  showProjectSelector,
  agentMode = false,
  contextBar,
  reviewItems,
  reviewActive,
  reviewBusy,
  reviewSessionId,
  reviewCwd,
  onOpenSessionDiff,
  onOpenAgentSession,
  workspace,
  pendingInput = false,
  children,
}: ComposerDockProps) {
  const [worktreeFlash, setWorktreeFlash] = useState<{ sessionId: string; flash: ComposerIslandFlash } | null>(null);
  useEffect(() => {
    if (!worktreeFlash) return undefined;
    const timer = window.setTimeout(() => setWorktreeFlash(null), WORKTREE_FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [worktreeFlash]);
  const { ref: contextBarRef, height: contextBarHeight } = useContextBarHeight(showProjectSelector);
  const TurnReviewBar = useTurnReviewBar();
  const openSessionDiff = useStableEvent(() => onOpenSessionDiff?.());
  const hasSessionDiff = Boolean(onOpenSessionDiff);
  const openChanges = useMemo(
    () =>
      hasSessionDiff
        ? () => {
            requestSessionDiffList(reviewSessionId);
            openSessionDiff();
          }
        : undefined,
    [hasSessionDiff, openSessionDiff, reviewSessionId]
  );
  const openChangeFile = useMemo(
    () =>
      hasSessionDiff
        ? (path: string) => {
            requestSessionDiffFile(reviewSessionId, path);
            openSessionDiff();
          }
        : undefined,
    [hasSessionDiff, openSessionDiff, reviewSessionId]
  );
  const openAgentSessionEvent = useStableEvent((agentSessionId: string, title: string, ownerSessionId: string) =>
    onOpenAgentSession?.(agentSessionId, title, ownerSessionId)
  );
  const openAgentSession = onOpenAgentSession ? openAgentSessionEvent : undefined;
  // The approval card's "세션 열기": the asking sub-agent's session, owned by this chat.
  const openApprovalSession = useMemo(
    () => (openAgentSession ? (agentSessionId: string) => openAgentSession(agentSessionId, '', reviewSessionId) : null),
    [openAgentSession, reviewSessionId]
  );
  const dockedApproval = useMemo(
    () =>
      approval ? (
        <ApprovalOpenSessionContext.Provider value={openApprovalSession}>
          {approval}
        </ApprovalOpenSessionContext.Provider>
      ) : null,
    [approval, openApprovalSession]
  );
  // Keep the entry gate until the module and its authoritative read
  // are ready, but do not let Suspense's reveal throttle hold an
  // already loaded segment (and the entire transcript) for 300ms.
  const files = useMemo(
    () =>
      TurnReviewBar ? (
        <TurnReviewBar
          variant="segment"
          items={reviewItems}
          active={reviewActive}
          busy={reviewBusy}
          sessionId={reviewSessionId}
          cwd={reviewCwd}
          onOpenChanges={openChanges}
          onOpenChangeFile={openChangeFile}
        />
      ) : (
        <IslandSegmentPending kind="files" holdEntry />
      ),
    [TurnReviewBar, reviewItems, reviewActive, reviewBusy, reviewSessionId, reviewCwd, openChanges, openChangeFile]
  );
  const goal = useMemo(
    () => <SessionGoalHost submissionId={goalSubmissionId}>{goalIsland}</SessionGoalHost>,
    [goalSubmissionId, goalIsland]
  );
  const onBranchFlash = useCallback(
    (flash: ComposerIslandFlash, owner: string) => setWorktreeFlash({ sessionId: owner, flash }),
    []
  );
  const branch = useCallback(
    (locked: boolean) => (
      <BranchIslandSegment
        sessionId={sessionId}
        workspace={workspace}
        projectPath={reviewCwd}
        locked={locked}
        onViewChanges={openChanges}
        onFlash={onBranchFlash}
      />
    ),
    [sessionId, workspace, reviewCwd, openChanges, onBranchFlash]
  );
  const gitCwd = workspace?.cwd || reviewCwd;
  const git = useMemo(() => <IslandGitSegment sessionId={sessionId} cwd={gitCwd} />, [sessionId, gitCwd]);

  // The route names a session whose first lane snapshot has not arrived
  // (a reload, a session opening): no island yet, so it mounts once, whole
  // (branch segment included), instead of empty and then growing.
  const awaitingLane = Boolean(reviewSessionId) && !sessionId;
  // The session whose island this dock carried last: across a switch, the
  // incoming island reserves that island's resting height when its own
  // session has none remembered (see ComposerIsland carriedHeight).
  const islandSession = useRef('');
  const islandShown = !showProjectSelector && !awaitingLane && Boolean(reviewSessionId);
  useLayoutEffect(() => {
    if (islandShown) islandSession.current = reviewSessionId;
  });
  const carrying = Boolean(islandSession.current) && islandSession.current !== reviewSessionId;
  const carriedHeight = carrying ? (rememberedSlotHeight(islandSession.current) ?? 0) : 0;
  const carriedAdvances = carrying ? rememberedSegmentAdvances(islandSession.current) : undefined;
  // While the lane is awaited, the slot keeps the height that island will
  // reserve at mount: dropping the slot for the wait lifted the composer by
  // the pill's height and set it back down once the lane landed.
  const awaitingSlotHeight =
    awaitingLane && !showProjectSelector ? (rememberedSlotHeight(reviewSessionId) ?? carriedHeight) : 0;

  return (
    <div className="composer-region">
      {showProjectSelector && contextBar != null && (
        <div ref={contextBarRef} className="composer-context-bar">
          {contextBar}
        </div>
      )}
      {!showProjectSelector && !awaitingLane && (
        <ComposerIsland
          key={reviewSessionId}
          routeSessionId={reviewSessionId}
          sessionId={sessionId}
          onOpenAgentSession={openAgentSession}
          goal={goal}
          files={agentMode ? undefined : files}
          workBusy={reviewBusy || pendingInput}
          branch={agentMode ? undefined : branch}
          git={agentMode ? undefined : git}
          approval={dockedApproval}
          flash={islandFlash ?? (sessionId && worktreeFlash?.sessionId === sessionId ? worktreeFlash.flash : null)}
          quotaResume={quotaResume}
          heldHeight={contextBarHeight.current}
          carriedHeight={carriedHeight}
          carriedAdvances={carriedAdvances}
        />
      )}
      {awaitingSlotHeight > 0 && (
        <div
          className="composer-island-slot"
          data-presence="grace"
          aria-hidden="true"
          style={{ '--island-slot-height': `${awaitingSlotHeight}px` } as CSSProperties}
        />
      )}
      {!showProjectSelector && quotaCard ? <ComposerQuotaCard card={quotaCard} /> : null}
      {children}
    </div>
  );
}

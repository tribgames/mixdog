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

/**
 * The chrome stacked ABOVE the prompt input, with the composer itself as the
 * last child. A New Task draft keeps its project/workflow/mode context bar; a
 * session gets the composer island in a fixed slot instead (Goal, background
 * jobs, changed files, a waiting quota resume, tool approval, flashes), then
 * the quota card.
 *
 * The dock is an in-flow sibling below the transcript viewport: every member
 * takes its real height (an empty island slot none), and the transcript
 * viewport above gets whatever the dock leaves.
 */
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
  const [reviewModule, setReviewModule] = useState(() => loadedReviewModule);
  // The merge notice belongs to the session that merged (the segment names it
  // when the merge settles, so a route change mid-merge cannot strand it) and
  // expires on its own: the dock outlives session switches and the island
  // remounts per session, so a kept notice would replay on every remount and
  // other sessions.
  const [worktreeFlash, setWorktreeFlash] = useState<{ sessionId: string; flash: ComposerIslandFlash } | null>(null);
  useEffect(() => {
    if (!worktreeFlash) return undefined;
    const timer = window.setTimeout(() => setWorktreeFlash(null), WORKTREE_FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [worktreeFlash]);
  const [moduleFailure, setModuleFailure] = useState<{ error: unknown } | null>(null);
  // The draft context bar's height as last committed (0 once it is gone): the
  // island that replaces it in the next commit (the draft's first submit)
  // mounts at that height, so the swap moves nothing even when the new
  // session's pill has nothing to carry yet.
  const contextBarRef = useRef<HTMLDivElement | null>(null);
  const contextBarHeight = useRef(0);
  // Observed rather than read every commit: an offsetHeight read in a layout
  // effect forces a synchronous layout inside each click commit.
  // Observed rather than read every commit: an offsetHeight read in a layout
  // effect forces a synchronous layout inside each click commit.
  useEffect(() => {
    const bar = showProjectSelector ? contextBarRef.current : null;
    if (!bar) return undefined;
    const observer = new ResizeObserver(() => {
      contextBarHeight.current = bar.offsetHeight;
    });
    observer.observe(bar);
    return () => {
      observer.disconnect();
      contextBarHeight.current = 0;
    };
  }, [showProjectSelector]);
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
  const TurnReviewBar = reviewModule?.TurnReviewBar;
  // The island is memoised: everything handed to it keeps its identity until
  // what it shows changes. The pane's open routes are fresh closures on every
  // App commit, so they are called through stable events; whether a route
  // exists still decides what the segments offer.
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
  if (moduleFailure) throw moduleFailure.error;

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
        // One island per session: a surviving slot carried the outgoing
        // session's height into the new one and animated toward it (with the
        // 1.5s collapse grace), shifting the end-pinned transcript by the
        // slot height on every switch. Keyed by the route address, which
        // changes in the same commit as the transcript, unlike the snapshot.
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

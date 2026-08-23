// Phone tab traversal: a horizontal swipe across the work area steps to the
// neighbouring tab of the pane it started in, giving the projected surface the
// same tab traversal the desktop gets from its keyboard (user: 좌우 스와이프로
// pc 컨트롤 방향키처럼).
//
// The page turn is an INTERACTIVE view transition: the browser snapshots the
// outgoing and incoming surfaces, and JS scrubs their transforms with the
// finger, then completes or reverses them on release. Chrome on Android (the
// projected phone surface) supports startViewTransition; where it does not —
// or under prefers-reduced-motion, or when a snapshot fails to become
// interactive in time — the same gesture still switches tabs discretely.
//
// Living in its own module keeps the installed effect testable without
// mounting the whole workspace; the logic itself is unchanged.
import { flushSync } from "react-dom";

import {
  shouldCommitSwipe,
  SWIPE_LOCK_AXIS_RATIO,
  SWIPE_LOCK_DISTANCE,
  SWIPE_VIEW_TRANSITION_READY_TIMEOUT_MS,
  swipeGestureAllowed,
  swipeIntent,
  swipeProgress,
  swipeTransitionFallbackCommits,
  swipeTargetIndex,
} from "./mobile-tab-swipe";
import type { PaneLeaf } from "./pane-layout";
import type { WorkspaceSelection } from "./nav-types";
import { navigationKey } from "./text-format";

type SwipeViewTransition = {
  ready: Promise<void>;
  finished: Promise<void>;
  skipTransition: () => void;
};

export interface MobileTabSwipeWorkspace {
  leaves: readonly PaneLeaf[];
  activateTab(leafId: string, key: string): void;
}

export function installMobileTabSwipe({
  workspace,
  onFocusSelection,
}: {
  /** Read live on every gesture frame: the pane tree changes under it. */
  workspace: () => MobileTabSwipeWorkspace;
  onFocusSelection: (selection: WorkspaceSelection) => void;
}): () => void {
  const transitionDocument = document as Document & {
    startViewTransition?: (update: () => void) => SwipeViewTransition;
  };
  const root = document.documentElement;
  const startViewTransition = transitionDocument.startViewTransition
    ?.bind(transitionDocument);
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const scrubDuration = 1_000;
  let startX = 0;
  let startY = 0;
  let leafId = "";
  let gestureCell: HTMLElement | null = null;
  let gestureTarget: Element | null = null;
  let tracking = false;
  let lastX = 0;
  let lastTime = 0;
  let velocityX = 0;
  let lockedIntent: "previous" | "next" | null = null;
  let dragProgress = 0;
  let originalKey = "";
  let originalSelection: WorkspaceSelection | null = null;
  let transitionCell: HTMLElement | null = null;
  let activeTransition: SwipeViewTransition | null = null;
  let snapshotAnimations: Animation[] = [];
  let pendingCommit: boolean | null = null;
  let settling = false;
  let transitionReadyTimer = 0;
  let transitionSettleTimer = 0;
  let interactiveTransitionAvailable = true;
  let cancelPendingUpdate: (() => void) | null = null;
  let activeTargetApplied = false;
  const onGestureTargetTouchMove: EventListener = (event) =>
    onTouchMove(event as TouchEvent);
  const onGestureTargetTouchEnd: EventListener = (event) =>
    onTouchEnd(event as TouchEvent);
  const onGestureTargetTouchCancel: EventListener = () => onTouchCancel();
  /** React may replace the touched tab surface inside the view-transition
   *  update. Touch Events keep targeting that now-detached element, so they no
   *  longer bubble to document. Listen on the original target as well until
   *  release; document capture handles the normal attached path first. */
  const clearGestureTargetListeners = (): void => {
    if (!gestureTarget) return;
    gestureTarget.removeEventListener("touchmove", onGestureTargetTouchMove);
    gestureTarget.removeEventListener("touchend", onGestureTargetTouchEnd);
    gestureTarget.removeEventListener("touchcancel", onGestureTargetTouchCancel);
    gestureTarget = null;
  };
  const retainGestureTargetListeners = (target: Element): void => {
    clearGestureTargetListeners();
    gestureTarget = target;
    target.addEventListener("touchmove", onGestureTargetTouchMove, { passive: false });
    target.addEventListener("touchend", onGestureTargetTouchEnd, { passive: false });
    target.addEventListener("touchcancel", onGestureTargetTouchCancel, { passive: true });
  };
  const clearTransitionMarkers = (): void => {
    delete root.dataset.mobileTabSwipe;
    if (transitionCell) delete transitionCell.dataset.mobileTabSwipeSurface;
    transitionCell = null;
  };
  const clearTransitionTimers = (): void => {
    if (transitionReadyTimer) window.clearTimeout(transitionReadyTimer);
    if (transitionSettleTimer) window.clearTimeout(transitionSettleTimer);
    transitionReadyTimer = 0;
    transitionSettleTimer = 0;
  };
  const restoreOriginalSelection = (): void => {
    if (!originalSelection || !originalKey) return;
    const current = workspace();
    const selection = originalSelection;
    flushSync(() => {
      current.activateTab(leafId, originalKey);
      onFocusSelection(selection);
    });
  };
  const clearTransitionState = (): void => {
    clearTransitionTimers();
    clearGestureTargetListeners();
    activeTransition = null;
    snapshotAnimations = [];
    pendingCommit = null;
    settling = false;
    cancelPendingUpdate = null;
    activeTargetApplied = false;
    originalKey = "";
    originalSelection = null;
    clearTransitionMarkers();
  };
  const updateVelocity = (x: number, time: number): void => {
    const elapsed = time - lastTime;
    if (elapsed > 0 && elapsed <= 100) {
      const instantaneous = (x - lastX) / elapsed;
      velocityX = velocityX === 0
        ? instantaneous
        : velocityX * 0.65 + instantaneous * 0.35;
    } else if (elapsed > 100) {
      velocityX = 0;
    }
    lastX = x;
    lastTime = time;
  };
  const setSnapshotProgress = (progress: number): void => {
    dragProgress = progress;
    for (const animation of snapshotAnimations) {
      animation.currentTime = progress * scrubDuration;
    }
  };
  /** The view-transition update callback is ASYNCHRONOUS: the browser may not
   *  have run it yet when a lifecycle release finalizes the turn. Invalidate it
   *  first — otherwise skipping the transition still runs it (the spec keeps
   *  the DOM update on skip) and a hidden page activates the target it never
   *  decided to commit. Whatever the callback no longer applies is applied
   *  here instead: commit steps discretely, no decision rolls back. */
  const finishTransition = (
    transition: SwipeViewTransition,
    commit: boolean,
  ): void => {
    if (activeTransition !== transition) return;
    const fallbackIntent = lockedIntent;
    cancelPendingUpdate?.();
    for (const animation of snapshotAnimations) animation.cancel();
    try {
      transition.skipTransition();
    } catch { /* transition already finished */ }
    if (commit) {
      if (!activeTargetApplied && fallbackIntent) activateDiscreteTarget(fallbackIntent);
    } else if (activeTargetApplied) {
      restoreOriginalSelection();
    }
    clearTransitionState();
  };
  const settleTransition = (commit: boolean): void => {
    pendingCommit = commit;
    if (!activeTransition || snapshotAnimations.length === 0 || settling) return;
    settling = true;
    const transition = activeTransition;
    const animations = [...snapshotAnimations];
    const targetProgress = commit ? 1 : 0;
    const remaining = Math.abs(targetProgress - dragProgress);
    const settleDuration = Math.max(90, Math.round(240 * remaining));
    const playbackRate = (commit ? 1 : -1) * (scrubDuration / settleDuration);
    for (const animation of animations) {
      animation.currentTime = dragProgress * scrubDuration;
      animation.playbackRate = playbackRate;
      animation.play();
    }
    void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
      finishTransition(transition, commit);
    });
    transitionSettleTimer = window.setTimeout(
      () => finishTransition(transition, commit),
      settleDuration + 120,
    );
  };
  /** The browser ended the transition without the gesture asking. An ABORT is
   *  a browser failure (`ready`/`finished` rejected, or the ready deadline
   *  passed) and retires interactive transitions for this install; a plain
   *  `finished` — what a hidden page does, fulfilling instead of rejecting —
   *  is not, so the next gesture may still animate. Ignoring either path
   *  stranded activeTransition with paused snapshots and every later
   *  touchstart returned immediately: the swipe stayed dead until reload.
   *  Both finalize on the decision the reader had already made. */
  const releaseInteractiveTransition = (
    transition: SwipeViewTransition,
    { browserFailed }: { browserFailed: boolean },
  ): void => {
    if (activeTransition !== transition) return;
    finishTransition(transition, swipeTransitionFallbackCommits(pendingCommit));
    tracking = false;
    gestureCell = null;
    lockedIntent = null;
    if (browserFailed) interactiveTransitionAvailable = false;
  };
  const createSnapshotAnimations = (
    transition: SwipeViewTransition,
    intent: "previous" | "next",
  ): void => {
    if (activeTransition !== transition) return;
    const outgoingEnd = intent === "next"
      ? "translate3d(-100%, 0, 0)"
      : "translate3d(100%, 0, 0)";
    const incomingStart = intent === "next"
      ? "translate3d(100%, 0, 0)"
      : "translate3d(-100%, 0, 0)";
    const options = (pseudoElement: string): KeyframeAnimationOptions & {
      pseudoElement: string;
    } => ({
      duration: scrubDuration,
      easing: "linear",
      fill: "both",
      pseudoElement,
    });
    const created: Animation[] = [];
    try {
      created.push(root.animate(
        [
          { transform: "translate3d(0, 0, 0)" },
          { transform: outgoingEnd },
        ],
        options("::view-transition-old(mobile-tab-surface)"),
      ));
      created.push(root.animate(
        [
          { transform: incomingStart },
          { transform: "translate3d(0, 0, 0)" },
        ],
        options("::view-transition-new(mobile-tab-surface)"),
      ));
    } catch (error) {
      for (const animation of created) animation.cancel();
      throw error;
    }
    snapshotAnimations = created;
    for (const animation of snapshotAnimations) animation.pause();
    setSnapshotProgress(dragProgress);
    if (pendingCommit !== null) settleTransition(pendingCommit);
  };
  /** The pane the gesture started in and the tab a swipe in `intent` lands on.
   *  Null whenever nothing can move: the leaf is gone, or it holds one tab. */
  const swipeTarget = (intent: "previous" | "next") => {
    const current = workspace();
    const leaf = current.leaves.find((entry) => entry.id === leafId);
    if (!leaf || leaf.tabs.length <= 1) return null;
    const keys = leaf.tabs.map((tab) => navigationKey(tab));
    const activeIndex = keys.indexOf(leaf.activeKey);
    return {
      current,
      leaf,
      keys,
      activeIndex,
      targetIndex: swipeTargetIndex(activeIndex, keys.length, intent),
    };
  };
  const beginInteractiveTransition = (
    intent: "previous" | "next",
  ): boolean => {
    if (!startViewTransition || reducedMotion || !interactiveTransitionAvailable
      || !gestureCell || activeTransition) return false;
    const target = swipeTarget(intent);
    if (!target) return false;
    const { current, leaf, keys, activeIndex, targetIndex } = target;
    const targetSelection = leaf.tabs[targetIndex];
    originalSelection = leaf.tabs[activeIndex] ?? null;
    originalKey = keys[activeIndex] ?? "";
    if (!targetSelection || !originalSelection || !originalKey) return false;
    lockedIntent = intent;
    pendingCommit = null;
    settling = false;
    transitionCell = gestureCell;
    transitionCell.dataset.mobileTabSwipeSurface = "true";
    root.dataset.mobileTabSwipe = intent;
    try {
      let cancelled = false;
      const transition = startViewTransition(() => {
        if (cancelled) return;
        flushSync(() => {
          current.activateTab(leaf.id, keys[targetIndex]);
          onFocusSelection(targetSelection);
        });
        activeTargetApplied = true;
      });
      activeTransition = transition;
      cancelPendingUpdate = () => {
        cancelled = true;
      };
      transitionReadyTimer = window.setTimeout(
        () => releaseInteractiveTransition(transition, { browserFailed: true }),
        SWIPE_VIEW_TRANSITION_READY_TIMEOUT_MS,
      );
      void transition.ready
        .then(() => {
          if (activeTransition !== transition) return;
          if (transitionReadyTimer) window.clearTimeout(transitionReadyTimer);
          transitionReadyTimer = 0;
          createSnapshotAnimations(transition, intent);
        })
        .catch(() => releaseInteractiveTransition(transition, { browserFailed: true }));
      void transition.finished
        .then(() => releaseInteractiveTransition(transition, { browserFailed: false }))
        .catch(() => releaseInteractiveTransition(transition, { browserFailed: true }));
      return true;
    } catch {
      clearTransitionTimers();
      cancelPendingUpdate?.();
      cancelPendingUpdate = null;
      lockedIntent = null;
      originalKey = "";
      originalSelection = null;
      interactiveTransitionAvailable = false;
      clearTransitionMarkers();
      return false;
    }
  };
  const activateDiscreteTarget = (intent: "previous" | "next"): void => {
    const target = swipeTarget(intent);
    if (!target) return;
    const { current, leaf, keys, activeIndex, targetIndex } = target;
    const selection = leaf.tabs[targetIndex];
    if (!selection || targetIndex === activeIndex) return;
    current.activateTab(leaf.id, keys[targetIndex]);
    onFocusSelection(selection);
  };
  function onTouchStart(event: TouchEvent): void {
    if (activeTransition || tracking) return;
    tracking = false;
    gestureCell = null;
    lockedIntent = null;
    dragProgress = 0;
    velocityX = 0;
    if (event.touches.length !== 1) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !swipeGestureAllowed(target)) return;
    const cell = target?.closest<HTMLElement>("[data-pane-id]") ?? null;
    const id = cell?.dataset.paneId || "";
    if (!id) return;
    leafId = id;
    gestureCell = cell;
    startX = event.touches[0].clientX;
    startY = event.touches[0].clientY;
    lastX = startX;
    lastTime = event.timeStamp;
    tracking = true;
    retainGestureTargetListeners(target);
  }
  function onTouchMove(event: TouchEvent): void {
    if (!tracking || event.touches.length !== 1) return;
    const touch = event.touches[0];
    updateVelocity(touch.clientX, event.timeStamp);
    const deltaX = touch.clientX - startX;
    const deltaY = touch.clientY - startY;
    if (!lockedIntent) {
      const intent = swipeIntent(deltaX, deltaY, {
        minDistance: SWIPE_LOCK_DISTANCE,
        axisRatio: SWIPE_LOCK_AXIS_RATIO,
      });
      if (!intent) {
        if (Math.abs(deltaY) >= SWIPE_LOCK_DISTANCE
          && Math.abs(deltaY) > Math.abs(deltaX)) {
          tracking = false;
          gestureCell = null;
          clearGestureTargetListeners();
        }
        return;
      }
      if (!beginInteractiveTransition(intent)) return;
    }
    if (!lockedIntent || !activeTransition) return;
    event.preventDefault();
    const width = Math.max(1,
      gestureCell?.getBoundingClientRect().width ?? window.innerWidth);
    setSnapshotProgress(swipeProgress(deltaX, width, lockedIntent));
  }
  function onTouchEnd(event: TouchEvent): void {
    if (!tracking) return;
    tracking = false;
    const touch = event.changedTouches[0];
    if (!touch) {
      gestureCell = null;
      clearGestureTargetListeners();
      if (activeTransition) settleTransition(false);
      return;
    }
    updateVelocity(touch.clientX, event.timeStamp);
    const deltaX = touch.clientX - startX;
    const deltaY = touch.clientY - startY;
    if (activeTransition && lockedIntent) {
      event.preventDefault();
      const width = Math.max(1,
        gestureCell?.getBoundingClientRect().width ?? window.innerWidth);
      setSnapshotProgress(swipeProgress(deltaX, width, lockedIntent));
      const commit = shouldCommitSwipe(
        deltaX,
        width,
        velocityX,
        lockedIntent,
      );
      gestureCell = null;
      clearGestureTargetListeners();
      settleTransition(commit);
      return;
    }
    const intent = swipeIntent(deltaX, deltaY);
    if (!intent) {
      gestureCell = null;
      clearGestureTargetListeners();
      return;
    }
    if (gestureCell && beginInteractiveTransition(intent)) {
      gestureCell = null;
      clearGestureTargetListeners();
      settleTransition(true);
    } else {
      gestureCell = null;
      clearGestureTargetListeners();
      activateDiscreteTarget(intent);
    }
  }
  function onTouchCancel(): void {
    tracking = false;
    gestureCell = null;
    clearGestureTargetListeners();
    if (activeTransition) settleTransition(false);
  }
  /** A page that is going away (or already hidden) cannot animate, and its
   *  touchcancel may never arrive or arrive late. Finalize on the decision the
   *  reader had already made — none means roll back — so nothing survives the
   *  interruption: a restored page starts its next swipe from a clean state
   *  instead of a permanently blocked one. */
  const releaseForLifecycle = (): void => {
    const transition = activeTransition;
    tracking = false;
    gestureCell = null;
    clearGestureTargetListeners();
    // lockedIntent is cleared AFTER the release: it is the direction a pending
    // (now invalidated) update would have applied for an already-decided commit.
    if (transition) finishTransition(transition, swipeTransitionFallbackCommits(pendingCommit));
    lockedIntent = null;
  };
  const onVisibilityChange = (): void => {
    if (document.visibilityState === "hidden") releaseForLifecycle();
  };
  document.addEventListener("touchstart", onTouchStart, { passive: true, capture: true });
  document.addEventListener("touchmove", onTouchMove, { passive: false, capture: true });
  document.addEventListener("touchend", onTouchEnd, { passive: false, capture: true });
  document.addEventListener("touchcancel", onTouchCancel, { passive: true, capture: true });
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("pagehide", releaseForLifecycle);
  return () => {
    document.removeEventListener("touchstart", onTouchStart, true);
    document.removeEventListener("touchmove", onTouchMove, true);
    document.removeEventListener("touchend", onTouchEnd, true);
    document.removeEventListener("touchcancel", onTouchCancel, true);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("pagehide", releaseForLifecycle);
    const transition = activeTransition;
    clearTransitionTimers();
    clearGestureTargetListeners();
    cancelPendingUpdate?.();
    cancelPendingUpdate = null;
    activeTransition = null;
    for (const animation of snapshotAnimations) animation.cancel();
    snapshotAnimations = [];
    try {
      transition?.skipTransition();
    } catch { /* transition already finished */ }
    clearTransitionMarkers();
  };
}

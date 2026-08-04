import {
  type MutableRefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

export type TranscriptScrollOwner = "follow" | "user" | "restore" | "reflow" | "toggle";

interface TranscriptScrollRuntime {
  following: boolean;
  followingRef: MutableRefObject<boolean>;
  ownerRef: MutableRefObject<TranscriptScrollOwner>;
  programmaticRef: MutableRefObject<boolean>;
  markProgrammatic(): void;
  markUserInput(): void;
  takeUserControl(): void;
  resumeFollow(): void;
  suspend(owner: Exclude<TranscriptScrollOwner, "follow" | "user">): boolean;
  resolveSuspension(
    owner: Exclude<TranscriptScrollOwner, "follow" | "user">,
    shouldFollow: boolean,
  ): void;
  snapToBottom(element: HTMLDivElement): void;
  scrollToBottom(element: HTMLDivElement, behavior?: ScrollBehavior): void;
  followContentGrowth(element: HTMLDivElement): void;
  writeDelta(element: HTMLDivElement, delta: number): void;
}

const PROGRAMMATIC_SCROLL_TTL_MS = 1_500;
const FOLLOW_SETTLE_PX = 1;

function realBottom(element: HTMLElement): number {
  return Math.max(0, element.scrollHeight - element.clientHeight);
}

/**
 * The sole writer for transcript scrollTop.
 *
 * Content observers, explicit navigation, reflow restoration, and user
 * takeover all route through this runtime. Ongoing auto-follow is an immediate
 * pre-paint bottom lock; only an explicit "jump to latest" action may request
 * native smooth scrolling.
 */
export function useTranscriptScrollRuntime(): TranscriptScrollRuntime {
  const [following, setFollowing] = useState(true);
  const followingRef = useRef(true);
  const ownerRef = useRef<TranscriptScrollOwner>("follow");
  const programmaticRef = useRef(false);
  const programmaticTimerRef = useRef<number | null>(null);

  const markProgrammatic = useCallback(() => {
    programmaticRef.current = true;
    if (programmaticTimerRef.current !== null) {
      window.clearTimeout(programmaticTimerRef.current);
    }
    programmaticTimerRef.current = window.setTimeout(() => {
      programmaticTimerRef.current = null;
      programmaticRef.current = false;
    }, PROGRAMMATIC_SCROLL_TTL_MS);
  }, []);

  const markUserInput = useCallback(() => {
    programmaticRef.current = false;
    if (programmaticTimerRef.current !== null) {
      window.clearTimeout(programmaticTimerRef.current);
      programmaticTimerRef.current = null;
    }
  }, []);

  const writeScrollTop = useCallback((element: HTMLDivElement, top: number) => {
    const target = Math.max(0, Number(top) || 0);
    if (Math.abs(element.scrollTop - target) < 0.5) return;
    markProgrammatic();
    element.scrollTop = target;
  }, [markProgrammatic]);

  const publishFollowing = useCallback((next: boolean) => {
    followingRef.current = next;
    setFollowing((current) => current === next ? current : next);
  }, []);

  const takeUserControl = useCallback(() => {
    ownerRef.current = "user";
    publishFollowing(false);
  }, [publishFollowing]);

  const resumeFollow = useCallback(() => {
    ownerRef.current = "follow";
    publishFollowing(true);
  }, [publishFollowing]);

  const suspend = useCallback((
    owner: Exclude<TranscriptScrollOwner, "follow" | "user">,
  ): boolean => {
    const wasFollowing = followingRef.current;
    ownerRef.current = owner;
    // Keep the visible React state unchanged during a short layout hold, but
    // synchronously disable every follow writer.
    followingRef.current = false;
    return wasFollowing;
  }, []);

  const resolveSuspension = useCallback((
    owner: Exclude<TranscriptScrollOwner, "follow" | "user">,
    shouldFollow: boolean,
  ) => {
    if (ownerRef.current !== owner) return;
    if (shouldFollow) resumeFollow();
    else takeUserControl();
  }, [resumeFollow, takeUserControl]);

  const snapToBottom = useCallback((element: HTMLDivElement) => {
    writeScrollTop(element, realBottom(element));
  }, [writeScrollTop]);

  const followContentGrowth = useCallback((element: HTMLDivElement) => {
    if (ownerRef.current !== "follow" || !followingRef.current) return;
    const target = realBottom(element);
    const distance = target - element.scrollTop;
    if (Math.abs(distance) <= FOLLOW_SETTLE_PX) return;
    // ResizeObserver delivers after layout and before paint. Lock to the new
    // bottom in this callback instead of animating a catch-up over later frames.
    writeScrollTop(element, target);
  }, [writeScrollTop]);

  const scrollToBottom = useCallback((
    element: HTMLDivElement,
    behavior: ScrollBehavior = "auto",
  ) => {
    if (ownerRef.current !== "follow" || !followingRef.current) return;
    if (behavior === "smooth") {
      markProgrammatic();
      element.scrollTo({ top: realBottom(element), behavior: "smooth" });
      return;
    }
    snapToBottom(element);
  }, [markProgrammatic, snapToBottom]);

  const writeDelta = useCallback((element: HTMLDivElement, delta: number) => {
    if (!Number.isFinite(delta) || delta === 0) return;
    writeScrollTop(element, element.scrollTop + delta);
  }, [writeScrollTop]);

  useEffect(() => () => {
    if (programmaticTimerRef.current !== null) {
      window.clearTimeout(programmaticTimerRef.current);
    }
  }, []);

  return useMemo(() => ({
    following,
    followingRef,
    ownerRef,
    programmaticRef,
    markProgrammatic,
    markUserInput,
    takeUserControl,
    resumeFollow,
    suspend,
    resolveSuspension,
    snapToBottom,
    scrollToBottom,
    followContentGrowth,
    writeDelta,
  }), [
    followContentGrowth,
    following,
    markProgrammatic,
    markUserInput,
    resolveSuspension,
    resumeFollow,
    scrollToBottom,
    snapToBottom,
    suspend,
    takeUserControl,
    writeDelta,
  ]);
}

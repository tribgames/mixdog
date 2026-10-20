// Which avatar may move (design/mockups/mixy-art §4–5): at most one in view at
// a time. An avatar asking for a motion state claims the stage while it is on
// screen; the highest priority claim wins — a new-message bounce, then a
// typing bubble, then a working list row, then the header's idle blink — and
// the newest among equals. Every other avatar shows its still frame. Reduced
// motion leaves every avatar still, and a hidden window pauses the one moving
// (html[data-mx-av-paused], agent-avatar.css).
import { type RefObject, useEffect, useRef, useState, useSyncExternalStore } from 'react';

export type AvatarMotionState = 'still' | 'idle' | 'typing' | 'message';

/** Default claim strength by state; a caller may rank its own claim lower
 *  (a list row's typing yields to the chat's typing bubble). */
export const AVATAR_MOTION_PRIORITY = { idle: 1, typing: 3, message: 4 } as const;

const claims = new Map<number, { priority: number; at: number }>();
const listeners = new Set<() => void>();
let ids = 0;
let clock = 0;
let winner = 0;

function elect(): void {
  let best = 0;
  let rank = { priority: -1, at: -1 };
  for (const [id, claim] of claims) {
    if (claim.priority > rank.priority || (claim.priority === rank.priority && claim.at > rank.at)) {
      best = id;
      rank = claim;
    }
  }
  if (best === winner) return;
  winner = best;
  for (const listener of [...listeners]) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

let pauseInstalled = false;
function installPause(): void {
  if (pauseInstalled) return;
  pauseInstalled = true;
  const sync = () => document.documentElement.toggleAttribute('data-mx-av-paused', document.hidden);
  document.addEventListener('visibilitychange', sync);
  sync();
}

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
const reducedQuery = () => (typeof window.matchMedia === 'function' ? window.matchMedia(REDUCED_MOTION) : null);

/** Whether the user asked for reduced motion (live). */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (listener) => {
      const query = reducedQuery();
      query?.addEventListener('change', listener);
      return () => query?.removeEventListener('change', listener);
    },
    () => reducedQuery()?.matches ?? false,
    () => false
  );
}

// One observer for every avatar that asks to move: off screen, it gives up
// its claim (and shows its still frame) until it scrolls back.
let observer: IntersectionObserver | null = null;
const watchers = new Map<Element, (visible: boolean) => void>();
function watch(element: Element, onChange: (visible: boolean) => void): () => void {
  if (typeof IntersectionObserver === 'undefined') return () => {};
  observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries) watchers.get(entry.target)?.(entry.isIntersecting);
  });
  watchers.set(element, onChange);
  observer.observe(element);
  return () => {
    watchers.delete(element);
    observer?.unobserve(element);
  };
}

/** The state `element`'s avatar shows: `requested` while it holds the stage,
 *  else 'still'. */
export function useAvatarMotion(
  requested: AvatarMotionState,
  element: RefObject<Element | null>,
  priority?: number
): AvatarMotionState {
  const [id] = useState(() => {
    ids += 1;
    return ids;
  });
  const reduced = useReducedMotion();
  const [visible, setVisible] = useState(true);
  const moving = requested !== 'still';
  useEffect(() => {
    installPause();
    const node = element.current;
    if (!moving || !node) return undefined;
    return watch(node, setVisible);
  }, [element, moving]);
  const wants = moving && visible && !reduced;
  const rank = requested === 'still' ? 0 : (priority ?? AVATAR_MOTION_PRIORITY[requested]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new requested state is a new, newest claim
  useEffect(() => {
    if (!wants) return undefined;
    clock += 1;
    claims.set(id, { priority: rank, at: clock });
    elect();
    return () => {
      claims.delete(id);
      elect();
    };
  }, [id, wants, rank, requested]);
  const leading = useSyncExternalStore(
    subscribe,
    () => winner === id,
    () => false
  );
  return wants && leading ? requested : 'still';
}

/** How long a new message's bounce (or a custom message image) shows. */
export const NEW_MESSAGE_MOTION_MS = 1600;

/** True for a moment each time `count` (unread messages) grows; never on mount. */
export function useNewMessagePulse(count: number): boolean {
  const last = useRef(count);
  const [on, setOn] = useState(false);
  useEffect(() => {
    const grew = count > last.current;
    last.current = count;
    if (!grew) {
      setOn(false);
      return undefined;
    }
    setOn(true);
    const timer = setTimeout(() => setOn(false), NEW_MESSAGE_MOTION_MS);
    return () => clearTimeout(timer);
  }, [count]);
  return on;
}

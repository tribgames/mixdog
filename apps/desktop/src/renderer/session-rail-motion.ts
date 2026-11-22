// The session panel's cards as they come and go while the panel is shown: a
// card that arrives (a to-do list made, an agent started) opens from nothing
// and one that leaves closes to nothing, so the cards under it glide to their
// place instead of jumping. Cards drawn with the panel, or with another
// session, stand at once.
import { type RefObject, useLayoutEffect, useRef } from 'react';

const MOTION: KeyframeAnimationOptions = { duration: 200, easing: 'cubic-bezier(0.2, 0, 0, 1)' };
const CARD = '.session-rail-sec:not([data-leaving])';

const categoryOf = (card: HTMLElement) => card.dataset.category ?? '';
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

/** `from` nothing to the card's own height, or the reverse: the gap it holds in the column goes with it. */
function fold(card: HTMLElement, gap: number, opening: boolean): Animation {
  const open = { height: `${card.offsetHeight}px`, marginBottom: '0px', opacity: 1 };
  const closed = { height: '0px', marginBottom: `${-gap}px`, opacity: 0 };
  card.style.overflow = 'clip';
  return card.animate(opening ? [closed, open] : [open, closed], MOTION);
}

export function useSessionRailMotion(content: RefObject<HTMLElement | null>, session: string): void {
  /** The cards of the commit before, in order, for the session they were drawn for. */
  const shown = useRef<{ session: string; cards: HTMLElement[]; parents: Map<HTMLElement, ParentNode | null> } | null>(
    null
  );
  useLayoutEffect(() => {
    const root = content.current;
    if (!root) return;
    const cards = [...root.querySelectorAll<HTMLElement>(CARD)];
    const prior = shown.current;
    shown.current = { session, cards, parents: new Map(cards.map((card) => [card, card.parentNode])) };
    if (!prior || prior.session !== session || reducedMotion() || typeof root.animate !== 'function') return;
    const before = new Set(prior.cards.map(categoryOf));
    const now = new Set(cards.map(categoryOf));
    const gap = Number.parseFloat(window.getComputedStyle(root).rowGap) || 0;
    for (const card of cards) {
      if (before.has(categoryOf(card))) continue;
      void fold(card, gap, true).finished.then(
        () => card.style.removeProperty('overflow'),
        () => undefined
      );
    }
    prior.cards.forEach((card, at) => {
      if (card.isConnected || now.has(categoryOf(card))) return;
      // The card React let go of stands in its place, inert, while it closes.
      const parent = prior.parents.get(card);
      const host = parent?.isConnected ? parent : root;
      const next = prior.cards.slice(at + 1).find((other) => other.isConnected && other.parentNode === host) ?? null;
      card.setAttribute('data-leaving', '');
      card.setAttribute('aria-hidden', 'true');
      card.inert = true;
      host.insertBefore(card, next);
      const gone = () => card.remove();
      void fold(card, gap, false).finished.then(gone, gone);
    });
  });
  useLayoutEffect(
    () => () => {
      for (const card of shown.current?.cards ?? []) card.getAnimations?.().forEach((animation) => animation.cancel());
      shown.current = null;
    },
    []
  );
}
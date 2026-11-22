// The session panel's cards as they come and go while the panel is shown: a
// card that arrives (a to-do list made, an agent started) opens from nothing
// and one that leaves closes to nothing, so the cards under it glide to their
// place instead of jumping. Cards drawn with the panel, or with another
// session, stand at once.
//
// The cards are watched where they are (the panel's own children), not at the
// panel's render: a section that fills or empties by itself (the Git status)
// never renders the panel.
import { type RefObject, useLayoutEffect, useRef } from 'react';

const DURATION = 200;
const EASING = 'cubic-bezier(0.2, 0, 0, 1)';

const isCard = (node: Node | null): node is HTMLElement =>
  node?.nodeType === 1 && (node as HTMLElement).classList.contains('session-rail-sec');

interface RailMotion {
  /** Everything stands as it is now: no card opens or closes for the changes made so far. */
  stand(): void;
  end(): void;
}

function railMotion(root: HTMLElement): RailMotion {
  const view = root.ownerDocument.defaultView as Window & typeof globalThis;
  const reduced = view.matchMedia?.('(prefers-reduced-motion: reduce)');
  // A fold runs to the card's own height (`auto`), whatever it becomes meanwhile; without that the cards stand at once.
  const folds = view.CSS?.supports?.('interpolate-size', 'allow-keywords') === true;
  const still = () => !folds || reduced?.matches === true;
  const present = new Set<HTMLElement>();
  const moving = new Map<HTMLElement, Animation>();
  const leaving = new Set<HTMLElement>();

  const OPEN: Keyframe = { height: 'auto', marginBottom: '0px', opacity: 1 };
  /** Nothing, and none of the gap the card holds in the column. */
  const closed = (): Keyframe => {
    const gap = Number.parseFloat(view.getComputedStyle(root).rowGap) || 0;
    return { height: '0px', marginBottom: `${-gap}px`, opacity: 0 };
  };
  /** Where the card stands now, at rest or mid-fold. */
  const standing = (card: HTMLElement): Keyframe => {
    const style = view.getComputedStyle(card);
    return { height: style.height, marginBottom: style.marginBottom, opacity: style.opacity };
  };

  const settle = (card: HTMLElement) => {
    moving.get(card)?.cancel();
    moving.delete(card);
    if (leaving.delete(card)) {
      card.remove();
      return;
    }
    card.style.removeProperty('overflow');
    card.style.removeProperty('interpolate-size');
  };

  /** Every fold starts where the card stands, so one that turns round or takes over another goes on from there. */
  const fold = (card: HTMLElement, from: Keyframe, to: Keyframe) => {
    moving.get(card)?.cancel();
    // Hidden, not clipped: a column's item is no shorter than its content unless it scrolls.
    card.style.overflow = 'hidden';
    card.style.setProperty('interpolate-size', 'allow-keywords');
    const animation = card.animate([from, to], { duration: DURATION, easing: EASING, fill: 'both' });
    animation.onfinish = () => settle(card);
    moving.set(card, animation);
  };

  const leave = (card: HTMLElement, record: MutationRecord) => {
    present.delete(card);
    if (still()) return;
    // The card React let go of stands in its place, inert, while it closes.
    const next = record.nextSibling?.parentNode === root ? record.nextSibling : null;
    const after = record.previousSibling?.parentNode === root ? record.previousSibling.nextSibling : null;
    leaving.add(card);
    card.setAttribute('data-leaving', '');
    card.setAttribute('aria-hidden', 'true');
    card.inert = true;
    root.insertBefore(card, next ?? after);
    fold(card, standing(card), closed());
  };

  const arrive = (card: HTMLElement) => {
    present.add(card);
    // The same category back before its last card has closed: the new card takes its place and goes on from there.
    // Only closing cards stand between the two, so the order React keeps is untouched.
    const twin = [...leaving].find((other) => other.dataset.category === card.dataset.category);
    if (twin) {
      root.insertBefore(card, twin);
      const from = standing(twin);
      settle(twin);
      fold(card, from, OPEN);
      return;
    }
    if (!still()) fold(card, closed(), OPEN);
  };

  const observer = new view.MutationObserver((records) => {
    // From the last: a card put back before its neighbour finds that neighbour standing again.
    for (const record of [...records].reverse()) {
      for (const node of [...record.removedNodes].reverse()) {
        // A card moved to another place in the order is here still.
        if (isCard(node) && present.has(node) && node.parentNode !== root) leave(node, record);
      }
    }
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (isCard(node) && node.parentNode === root && !present.has(node) && !leaving.has(node)) arrive(node);
      }
    }
  });
  const stand = () => {
    observer.takeRecords();
    for (const card of [...moving.keys()]) settle(card);
    observer.takeRecords();
    present.clear();
    for (const node of root.children) if (isCard(node)) present.add(node);
  };
  const onReduced = () => {
    if (reduced?.matches) for (const card of [...moving.keys()]) settle(card);
  };

  stand();
  observer.observe(root, { childList: true });
  reduced?.addEventListener('change', onReduced);
  return {
    stand,
    end() {
      observer.disconnect();
      reduced?.removeEventListener('change', onReduced);
      for (const card of [...moving.keys()]) settle(card);
    },
  };
}

export function useSessionRailMotion(content: RefObject<HTMLElement | null>, session: string): void {
  const motion = useRef<RailMotion | null>(null);
  useLayoutEffect(() => {
    const root = content.current;
    if (!root) return;
    const made = railMotion(root);
    motion.current = made;
    return () => {
      made.end();
      motion.current = null;
    };
  }, [content]);
  // Another session's cards are drawn in the commit this follows: they stand at once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the session is the trigger, not a value read
  useLayoutEffect(() => motion.current?.stand(), [session]);
}

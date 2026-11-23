// The session panel's sections as they come and go while the panel is shown:
// a section that arrives (a to-do list made, an agent started) opens from
// nothing and one that leaves closes to nothing, so the sections under it
// glide to their place instead of jumping. Sections drawn with the panel, or
// with another session, stand at once.
//
// The sections are watched where they are (the panel's own children), not at the
// panel's render: a section that fills or empties by itself (the Git status)
// never renders the panel.
import { type RefObject, useLayoutEffect, useRef } from 'react';

const DURATION = 200;
const EASING = 'cubic-bezier(0.2, 0, 0, 1)';

const isSection = (node: Node | null): node is HTMLElement =>
  node?.nodeType === 1 && (node as HTMLElement).classList.contains('session-rail-sec');

interface RailMotion {
  /** Everything stands as it is now: no section opens or closes for the changes made so far. */
  stand(): void;
  end(): void;
}

/** Nothing: no height and none of the padding that frames the section's head and body, and below it, given back,
 *  the room the sections beside it take more for standing next to it (`shift`). */
const closed = (shift: number): Keyframe => ({
  height: '0px',
  paddingTop: '0px',
  paddingBottom: '0px',
  marginBottom: `${-shift}px`,
  opacity: 0,
});

function railMotion(root: HTMLElement): RailMotion {
  const view = root.ownerDocument.defaultView as Window & typeof globalThis;
  const reduced = view.matchMedia?.('(prefers-reduced-motion: reduce)');
  // A fold runs to the section's own height (`auto`), whatever it becomes meanwhile; without that the sections stand at once.
  const folds = view.CSS?.supports?.('interpolate-size', 'allow-keywords') === true;
  const still = () => !folds || reduced?.matches === true;
  const present = new Set<HTMLElement>();
  const moving = new Map<HTMLElement, Animation>();
  const leaving = new Set<HTMLElement>();

  /** Where the section stands now, at rest or mid-fold. */
  const standing = (section: HTMLElement): Keyframe => {
    const style = view.getComputedStyle(section);
    return {
      height: style.height,
      paddingTop: style.paddingTop,
      paddingBottom: style.paddingBottom,
      marginBottom: style.marginBottom,
      opacity: style.opacity,
    };
  };
  /** The section at rest: its own height, and the padding its place in the column gives it (read before it folds). */
  const open = (section: HTMLElement): Keyframe => {
    const style = view.getComputedStyle(section);
    return {
      height: 'auto',
      paddingTop: style.paddingTop,
      paddingBottom: style.paddingBottom,
      marginBottom: '0px',
      opacity: 1,
    };
  };
  const padding = (sections: readonly HTMLElement[]) =>
    sections.reduce((sum, node) => {
      const style = view.getComputedStyle(node);
      return sum + (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
    }, 0);
  /** How much more padding the sections beside `section` have with it between them than without it (the spacing
   *  rules read a section's neighbours: the first one, folded ones in a row). Its fold gives that room back below
   *  it, so as it comes or goes those sections glide and never jump at its first or last frame. */
  const shiftOf = (section: HTMLElement): number => {
    const beside = [section.previousElementSibling, section.nextElementSibling].filter(isSection);
    if (beside.length === 0) return 0;
    const withIt = padding(beside);
    const place = section.nextSibling;
    section.remove();
    const without = padding(beside);
    root.insertBefore(section, place);
    return withIt - without;
  };

  const settle = (section: HTMLElement) => {
    moving.get(section)?.cancel();
    moving.delete(section);
    if (leaving.delete(section)) {
      section.remove();
      return;
    }
    section.style.removeProperty('overflow');
    section.style.removeProperty('interpolate-size');
  };

  /** Every fold starts where the section stands, so one that turns round or takes over another goes on from there. */
  const fold = (section: HTMLElement, from: Keyframe, to: Keyframe) => {
    moving.get(section)?.cancel();
    // Hidden, not clipped: a column's item is no shorter than its content unless it scrolls.
    section.style.overflow = 'hidden';
    section.style.setProperty('interpolate-size', 'allow-keywords');
    const animation = section.animate([from, to], { duration: DURATION, easing: EASING, fill: 'both' });
    animation.onfinish = () => settle(section);
    moving.set(section, animation);
  };

  const leave = (section: HTMLElement, record: MutationRecord) => {
    present.delete(section);
    if (still()) return;
    // The section React let go of stands in its place, inert, while it closes.
    const next = record.nextSibling?.parentNode === root ? record.nextSibling : null;
    const after = record.previousSibling?.parentNode === root ? record.previousSibling.nextSibling : null;
    leaving.add(section);
    section.setAttribute('data-leaving', '');
    section.setAttribute('aria-hidden', 'true');
    section.inert = true;
    root.insertBefore(section, next ?? after);
    fold(section, standing(section), closed(shiftOf(section)));
  };

  const adjoins = (closing: HTMLElement, section: HTMLElement) => {
    let node = closing.nextElementSibling;
    while (node && node !== section && leaving.has(node as HTMLElement)) node = node.nextElementSibling;
    return node === section;
  };

  const arrive = (section: HTMLElement) => {
    present.add(section);
    // The same category back before its last section has closed: the new section takes its place and goes on from
    // there. Only where nothing but closing sections stands between the two, so the order React keeps is untouched;
    // with a section of the panel between them the old one closes where it is and the new one opens where it belongs.
    const twin = [...leaving].find(
      (other) => other.dataset.category === section.dataset.category && adjoins(other, section)
    );
    if (twin) {
      root.insertBefore(section, twin);
      const from = standing(twin);
      settle(twin);
      fold(section, from, open(section));
      return;
    }
    if (!still()) fold(section, closed(shiftOf(section)), open(section));
  };

  const observer = new view.MutationObserver((records) => {
    // From the last: a section put back before its neighbour finds that neighbour standing again.
    for (const record of [...records].reverse()) {
      for (const node of [...record.removedNodes].reverse()) {
        // A section moved to another place in the order is here still.
        if (isSection(node) && present.has(node) && node.parentNode !== root) leave(node, record);
      }
    }
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (isSection(node) && node.parentNode === root && !present.has(node) && !leaving.has(node)) arrive(node);
      }
    }
  });
  const stand = () => {
    observer.takeRecords();
    for (const section of [...moving.keys()]) settle(section);
    observer.takeRecords();
    present.clear();
    for (const node of root.children) if (isSection(node)) present.add(node);
  };
  const onReduced = () => {
    if (reduced?.matches) for (const section of [...moving.keys()]) settle(section);
  };

  stand();
  observer.observe(root, { childList: true });
  reduced?.addEventListener('change', onReduced);
  return {
    stand,
    end() {
      observer.disconnect();
      reduced?.removeEventListener('change', onReduced);
      for (const section of [...moving.keys()]) settle(section);
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
  // Another session's sections are drawn in the commit this follows: they stand at once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the session is the trigger, not a value read
  useLayoutEffect(() => motion.current?.stand(), [session]);
}

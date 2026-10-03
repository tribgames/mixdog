import type { WorkspaceTab } from './nav-types';

/* Browser-style tab-strip layout —
 * two proportional layout
 * domains with our flat-design constants (overlap = 0). Above the crossover
 * every tab shares one interpolated width; below it the ACTIVE tab pins at
 * its favicon+close floor while inactive tabs interpolate down to the
 * sliver. The rounded-down remainder is re-granted +1px
 * left-to-right. */
/* 160px: square cells with hairline seams made the empty run beside a short
 * title read loud at 200px (user: 탭 칸이 넓다 → 160). */
const TAB_STANDARD_WIDTH = 160;
const TAB_MIN_ACTIVE_WIDTH = 56;
const TAB_MIN_INACTIVE_WIDTH = 28;
/* Glyph-only floor, matched by the tab's CSS min-width. The sliver floor
 * above is a PREFERRED cell: once the run no longer fits, inactive cells keep
 * giving width down to this floor so the strip never overflows and
 * reveal-active never has to scroll a tab half out of view. */
const TAB_HARD_MIN_WIDTH = 20;
/* One motion beat (--mx-motion-base, 120ms) plus slack: the ghost of a closed
 * tab unmounts and the entering mark drops once the width transition has
 * settled. */
export const TAB_MOTION_SETTLE_MS = 180;

export function calculateChromeTabWidths(count: number, activeIndex: number, available: number): number[] {
  if (count <= 0) return [];
  const lerp = (a: number, b: number, f: number) => a + (b - a) * f;
  const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
  const minimum = (count - 1) * TAB_MIN_INACTIVE_WIDTH + TAB_MIN_ACTIVE_WIDTH;
  const crossover = count * TAB_MIN_ACTIVE_WIDTH;
  const preferred = count * TAB_STANDARD_WIDTH;
  let widths: number[];
  let atPreferred = false;
  if (available < crossover) {
    // LayoutDomain::kInactiveWidthBelowActiveWidth
    const fraction = minimum === crossover ? 1 : clamp01((available - minimum) / (crossover - minimum));
    widths = Array.from({ length: count }, (_, index) =>
      Math.floor(
        index === activeIndex ? TAB_MIN_ACTIVE_WIDTH : lerp(TAB_MIN_INACTIVE_WIDTH, TAB_MIN_ACTIVE_WIDTH, fraction)
      )
    );
  } else {
    // LayoutDomain::kInactiveWidthEqualsActiveWidth
    const fraction = preferred === crossover ? 1 : clamp01((available - crossover) / (preferred - crossover));
    atPreferred = fraction >= 1;
    const width = Math.floor(lerp(TAB_MIN_ACTIVE_WIDTH, TAB_STANDARD_WIDTH, fraction));
    widths = Array.from({ length: count }, () => width);
  }
  if (!atPreferred) {
    let extra = Math.floor(available) - widths.reduce((sum, width) => sum + width, 0);
    for (let index = 0; index < widths.length && extra > 0; index += 1, extra -= 1) {
      widths[index] += 1;
    }
  }
  // Hard fit: past the sliver floor the run exceeded the strip, and
  // reveal-active then scrolled it right, leaving the leading tab sliced in
  // half against the rail edge (user: 창 크기를 줄이면 위쪽 라벨 왼쪽이 잘려
  // 보인다). Inactive cells surrender the surplus evenly, down to the glyph
  // floor, so the whole run stays inside the strip.
  const room = Math.floor(available);
  const inactiveCount = count - 1;
  if (widths.reduce((sum, width) => sum + width, 0) > room && inactiveCount > 0) {
    const budget = room - widths[activeIndex];
    const each = Math.max(TAB_HARD_MIN_WIDTH, Math.floor(budget / inactiveCount));
    let spare = budget - each * inactiveCount;
    for (let index = 0; index < count; index += 1) {
      if (index === activeIndex) continue;
      widths[index] = each + (spare > 0 ? 1 : 0);
      if (spare > 0) spare -= 1;
    }
    // Still past the floor, so the run genuinely has to scroll. Pad the ACTIVE
    // cell until the scrolled-out run is a whole number of sliver cells:
    // reveal-active then lands on a cell boundary instead of slicing the
    // leading tab down the middle.
    if (widths.reduce((sum, width) => sum + width, 0) > room) {
      widths[activeIndex] += (((room - widths[activeIndex]) % each) + each) % each;
    }
  }
  return widths;
}

export type TabMenuAnchor = { key: string; left: number; top: number };
export type SetTabMenu = React.Dispatch<React.SetStateAction<TabMenuAnchor | null>>;

/** Clamp inside the window so bottom/right-edge tabs keep the whole menu visible. */
export function tabMenuAnchorAt(key: string, event: { clientX: number; clientY: number }): TabMenuAnchor {
  return {
    key,
    left: Math.max(8, Math.min(event.clientX, window.innerWidth - 208)),
    top: Math.max(8, Math.min(event.clientY, window.innerHeight - 264)),
  };
}

/** Enter/exit motion bookkeeping for the run, derived during render from the
 *  previous tab list: a lost tab stays as a ghost for one beat and a gained
 *  tab is marked entering, so the neighbours glide instead of jumping. */
export function tabsWithClosingGhosts(
  tabs: WorkspaceTab[],
  previousTabs: { current: WorkspaceTab[] },
  closingTabs: { current: Map<string, { tab: WorkspaceTab; index: number; active: boolean }> },
  enteringKeys: { current: Set<string> },
  previousActiveKey: string | null = null
) {
  const previous = previousTabs.current;
  if (tabs.length < previous.length) {
    previous.forEach((tab, index) => {
      if (!tabs.some((entry) => entry.key === tab.key)) {
        // The ghost keeps the look it closed with, so a closing active tab
        // collapses as the selected plate an opening tab grows as.
        closingTabs.current.set(tab.key, { tab, index, active: tab.key === previousActiveKey });
      }
    });
  } else if (tabs.length > previous.length) {
    const known = new Set(previous.map((tab) => tab.key));
    for (const tab of tabs) if (!known.has(tab.key)) enteringKeys.current.add(tab.key);
  }
  const displayTabs = tabs.map((tab) => ({ tab, closing: false, active: false }));
  for (const ghost of [...closingTabs.current.values()].sort((left, right) => left.index - right.index)) {
    // A key that came back inside the beat is a live tab again, never a ghost.
    if (tabs.some((tab) => tab.key === ghost.tab.key)) {
      closingTabs.current.delete(ghost.tab.key);
      continue;
    }
    displayTabs.splice(Math.min(ghost.index, displayTabs.length), 0, {
      tab: ghost.tab,
      closing: true,
      active: ghost.active,
    });
  }
  return displayTabs;
}

/** Drop index for a pointer position: the tab half rule over the measured
 *  run, falling back to the pointed tab while the run has no geometry yet. */
export function tabDropIndex({
  tabs,
  tabNodes,
  strip,
  clientX,
  target,
}: {
  tabs: WorkspaceTab[];
  tabNodes: Map<string, HTMLDivElement>;
  strip: HTMLElement;
  clientX: number;
  target: EventTarget | null;
}): number | null {
  let index = -1;
  let measured = false;
  let firstLeft = Number.POSITIVE_INFINITY;
  for (let at = 0; at < tabs.length; at += 1) {
    const rect = tabNodes.get(tabs[at].key)?.getBoundingClientRect();
    if (!rect || rect.width <= 0) continue;
    measured = true;
    firstLeft = Math.min(firstLeft, rect.left);
    if (index >= 0 || clientX < rect.left || clientX > rect.right) continue;
    index = at + (clientX - rect.left > rect.width / 2 ? 1 : 0);
  }
  if (!measured) {
    const pointedTab = (target as Element | null)?.closest?.<HTMLElement>('.workspace-tab') || null;
    const key = pointedTab && strip.contains(pointedTab) ? pointedTab.dataset.tabKey || '' : '';
    const at = tabs.findIndex((tab) => tab.key === key);
    if (at >= 0 && pointedTab) {
      const rect = pointedTab.getBoundingClientRect();
      index = at + (clientX - rect.left > rect.width / 2 ? 1 : 0);
    }
  } else if (index < 0) {
    index = clientX < firstLeft ? 0 : tabs.length;
  }
  return index < 0 ? null : index;
}

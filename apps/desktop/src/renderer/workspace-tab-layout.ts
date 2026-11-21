import type { WorkspaceTab } from './nav-types';

const TAB_STANDARD_WIDTH = 200;
const TAB_MIN_ACTIVE_WIDTH = 56;
const TAB_MIN_INACTIVE_WIDTH = 28;
/* Matched by the tab's CSS min-width. */
const TAB_HARD_MIN_WIDTH = 20;
/* One motion beat (--mx-motion-base, 120ms) plus slack. */
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

type ClosingGhost = { tab: WorkspaceTab; after: string | null; before: string | null; active: boolean };

/** Each ghost is seated right after the entry that preceded it when it closed
 *  (slot 0 when none did), falling back to just before the entry that followed it. */
function displayWithGhosts(list: WorkspaceTab[], ghosts: Iterable<ClosingGhost>) {
  const display = list.map((tab) => ({ tab, closing: false, active: false }));
  const pending = [...ghosts].filter((ghost) => !list.some((tab) => tab.key === ghost.tab.key));
  const slotOf = (key: string | null) => display.findIndex((entry) => entry.tab.key === key);
  while (pending.length) {
    const next = pending.findIndex(
      (ghost) =>
        ghost.after === null || slotOf(ghost.after) >= 0 || !pending.some((other) => other.tab.key === ghost.after)
    );
    const [ghost] = pending.splice(Math.max(next, 0), 1);
    const anchor = slotOf(ghost.after);
    const follower = slotOf(ghost.before);
    let slot = display.length;
    if (ghost.after === null) slot = 0;
    else if (anchor >= 0) slot = anchor + 1;
    else if (follower >= 0) slot = follower;
    display.splice(slot, 0, { tab: ghost.tab, closing: true, active: ghost.active });
  }
  return display;
}

/** Enter/exit motion bookkeeping, derived during render from the previous tab
 *  list: a lost tab stays as a ghost for one beat, a gained tab is marked entering. */
export function tabsWithClosingGhosts(
  tabs: WorkspaceTab[],
  previousTabs: { current: WorkspaceTab[] },
  closingTabs: { current: Map<string, ClosingGhost> },
  enteringKeys: { current: Set<string> },
  previousActiveKey: string | null = null
) {
  const previous = previousTabs.current;
  if (tabs.length < previous.length) {
    const shown = displayWithGhosts(previous, closingTabs.current.values());
    shown.forEach(({ tab, closing }, index) => {
      if (!closing && !tabs.some((entry) => entry.key === tab.key)) {
        const after = index > 0 ? shown[index - 1].tab.key : null;
        const before = shown[index + 1]?.tab.key ?? null;
        for (const ghost of closingTabs.current.values()) {
          if (ghost.after === tab.key) ghost.after = after;
          if (ghost.before === tab.key) ghost.before = before;
        }
        closingTabs.current.set(tab.key, { tab, after, before, active: tab.key === previousActiveKey });
      }
    });
  } else if (tabs.length > previous.length) {
    const known = new Set(previous.map((tab) => tab.key));
    for (const tab of tabs) if (!known.has(tab.key)) enteringKeys.current.add(tab.key);
  }
  for (const ghost of [...closingTabs.current.values()]) {
    if (tabs.some((tab) => tab.key === ghost.tab.key)) closingTabs.current.delete(ghost.tab.key);
  }
  return displayWithGhosts(tabs, closingTabs.current.values());
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

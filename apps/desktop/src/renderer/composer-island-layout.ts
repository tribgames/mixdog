import { useLayoutEffect, type RefObject } from 'react';
import {
  type IslandReservedSegment,
  type IslandSegmentReserves,
  petIslandReserveFor,
  subscribePetIslandReserve,
} from './composer-island-state';

/** Most recent last: drops the oldest entries past `max`. */
function evictOldest<K>(map: Map<K, unknown>, max: number): void {
  for (const oldest of map.keys()) {
    if (map.size <= max) break;
    map.delete(oldest);
  }
}

/** Below this the worktree name reads as noise: the narrow island keeps its glyph alone. */
const WORKTREE_NAME_MIN_PX = 72;

/** Full-label pill widths by what decides them (labelFitKey): a pill drawn
 *  again with the same content — a revisited session's island remounting, a
 *  segment re-rendering unchanged — reuses its width instead of reading it. */
const fullLabelWidths = new Map<string, number>();
const FULL_LABEL_WIDTHS_MAX = 200;

/** The pill's markup plus the root's attributes (theme, text size): equal
 *  keys lay out to equal widths. */
function labelFitKey(pill: Element): string {
  const root = document.documentElement;
  return `${root.className}|${root.getAttribute('style') ?? ''}|${JSON.stringify(root.dataset)}|${pill.innerHTML}`;
}

/** The fit's give-way attributes, in the order they come off. */
const FIT_ATTRIBUTES = ['data-compact', 'data-fit-tight', 'data-fit-pips', 'data-fit-glyph'] as const;
/** The last fitted state per room (the card's width, which every session of a
 *  window shares): a new island starts from it instead of the full labels. */
const fitByRoom = new Map<number, readonly string[]>();
const FIT_BY_ROOM_MAX = 40;
let lastFit: readonly string[] = [];
/** Once compact, the full labels come back only with this much room to spare
 *  past their width: a count that grows or shrinks a digit near the limit
 *  never flips the island between the two forms. */
const FIT_EXPAND_MARGIN_PX = 24;

function applyFit(island: HTMLElement, attributes: readonly string[]): void {
  for (const name of FIT_ATTRIBUTES) island.toggleAttribute(name, attributes.includes(name));
}

function rememberFit(island: HTMLElement, room: number): void {
  lastFit = FIT_ATTRIBUTES.filter((name) => island.hasAttribute(name));
  fitByRoom.delete(room);
  fitByRoom.set(room, lastFit);
  evictOldest(fitByRoom, FIT_BY_ROOM_MAX);
}

/** Swaps segment words for bare counts only when the full labels overflow the
 *  island's room. The room comes from the stage's ResizeObserver, whose first
 *  delivery lands after layout and before the first paint; the pill's
 *  full-label width is read only for content it has not laid out before. */
export function useIslandFit(islandRef: RefObject<HTMLDivElement | null>, pillRef: RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    const island = islandRef.current;
    const pill = pillRef.current;
    const stage = island?.parentElement;
    if (!island || !pill || !stage) return undefined;
    // The pill's full-label width depends on its content only, so it is read
    // (data-measuring, two style passes) when the content changes; a resize
    // of the room — every step of a window drag — only compares against it.
    // Read inside the mount commit, both forced a layout of the whole page.
    let needed = -1;
    let room = -1;
    const measureFull = (key: string) => {
      // data-measuring draws the full labels over data-compact (the
      // stylesheet), so the compact flag itself is never taken off to read.
      island.setAttribute('data-measuring', '');
      needed = pill.offsetWidth;
      island.removeAttribute('data-measuring');
      fullLabelWidths.set(key, needed);
      evictOldest(fullLabelWidths, FULL_LABEL_WIDTHS_MAX);
    };
    const overflows = () => pill.scrollWidth > pill.clientWidth;
    // The width the full labels may take: the room, less what the overlay bot
    // pinned above this message box takes at its right end — on both sides,
    // as the pill is centred — so they show only where they clear the bot.
    // The bot's width moves with its setting, scale and zoom, never with the
    // pill's, so the switch cannot feed back on itself.
    const budget = () => room - 2 * petIslandReserveFor(island);
    const fitLabels = (contentChanged: boolean) => {
      if (room < 0) return;
      const wasCompact = island.hasAttribute('data-compact');
      if (contentChanged || needed < 0) {
        const key = labelFitKey(pill);
        const known = fullLabelWidths.get(key);
        if (known !== undefined) needed = known;
        else measureFull(key);
      }
      // A late segment's reserve (IslandSegmentPending) holds the compact
      // width it was last drawn at: the pill measures narrower than it will
      // once the segment arrives, so a compact island waits for it.
      const reserved = wasCompact && pill.querySelector('[data-island-pending]') !== null;
      const compact = reserved || needed + (wasCompact ? FIT_EXPAND_MARGIN_PX : 0) > budget();
      if (compact !== island.hasAttribute('data-compact')) island.toggleAttribute('data-compact', compact);
      // The remembered width came from other glyph metrics (a web font that
      // landed since, a fallback face): the labels as laid out overflow, so
      // they are read again instead of trusted.
      if (!compact && overflows()) {
        measureFull(labelFitKey(pill));
        island.toggleAttribute('data-compact', needed > budget() || overflows());
      }
    };
    // Last resort once compact still overflows: the agents' running state
    // gives way to the segment's pulse and padding tightens.
    const fitTight = () => {
      if (island.hasAttribute('data-compact') && overflows()) island.setAttribute('data-fit-tight', '');
    };
    // The worktree name is the one label that gives way after compact (which
    // already drops its prefix and caps it): a name squeezed below its cap
    // takes the Goal's pips, and below a readable width only its glyph stays.
    const fitWorktree = () => {
      const name = pill.querySelector<HTMLElement>('.composer-island-seg-branch .composer-island-seg-text');
      if (!name || !island.hasAttribute('data-compact')) return;
      const cut = () => name.scrollWidth > name.clientWidth;
      if (cut() && name.clientWidth < Number.parseFloat(getComputedStyle(name).maxWidth)) {
        island.setAttribute('data-fit-pips', '');
      }
      if (cut() && name.clientWidth < WORKTREE_NAME_MIN_PX) island.setAttribute('data-fit-glyph', '');
    };
    // What the last fit decided from: a DOM change that leaves the pill's
    // markup, the room and the bot's reserve as they were decides nothing new.
    let fitSignature = '';
    const fit = (contentChanged: boolean) => {
      if (room < 0) return;
      if (contentChanged) {
        const signature = `${labelFitKey(pill)}|${room}|${petIslandReserveFor(island)}`;
        if (signature === fitSignature) return;
        fitSignature = signature;
      }
      // The narrow room's give-ways (tight padding, the worktree name's pips
      // and glyph) follow from the labels' fit, so they come off first: the
      // full-label read and the overflow check see the whole labels. Read
      // under them, a width measured beside an open side panel stayed too
      // small once the room widened again, and the full pill ran under the
      // pinned bot.
      island.removeAttribute('data-fit-tight');
      island.removeAttribute('data-fit-pips');
      island.removeAttribute('data-fit-glyph');
      fitLabels(contentChanged);
      fitWorktree();
      fitTight();
      rememberFit(island, room);
    };
    // The first paint is already fitted: the island starts from the state the
    // last one settled in at this room (the room is read here, in the mount's
    // layout effect, where the slot's own sync already lays the stage out) and
    // is fitted at once against its own labels, not after a frame.
    const initialRoom = stage.clientWidth;
    if (initialRoom > 0) {
      applyFit(island, fitByRoom.get(initialRoom) ?? lastFit);
      room = initialRoom;
      fit(true);
    }
    // Delivered after the frame's layout: the room's read costs no layout.
    // The pill is watched too: type that lands later (fonts) resizes it with
    // no change of room or content.
    const resize = new ResizeObserver(() => {
      const first = room < 0;
      room = stage.clientWidth;
      fit(first);
    });
    resize.observe(stage);
    resize.observe(pill);
    const fonts = document.fonts;
    const refit = () => {
      fullLabelWidths.clear();
      fitSignature = '';
      fit(true);
    };
    fonts?.addEventListener?.('loadingdone', refit);
    const stopReserve = subscribePetIslandReserve(() => fit(false));
    const mutation = new MutationObserver(() => fit(true));
    mutation.observe(pill, {
      subtree: true,
      childList: true,
      characterData: true,
      attributeFilter: ['hidden'],
    });
    return () => {
      resize.disconnect();
      mutation.disconnect();
      stopReserve();
      fonts?.removeEventListener?.('loadingdone', refit);
    };
  }, [islandRef, pillRef]);
}

/** How long an emptied island keeps its slot before the slot eases shut:
 *  content returning within it (one segment handing over to the next) moves
 *  nothing. */
export const ISLAND_COLLAPSE_GRACE_MS = 500;
/** How long a mount reserving its session's remembered height waits for the
 *  first segment before it takes the ordinary collapse. */
const ISLAND_RESERVE_HOLD_MS = 2_000;
/** What the island carries; the stylesheet's empty-island rule tests the same. */
const ISLAND_CONTENT =
  '.composer-island-seg, .session-goal-island, .composer-island-approval, .composer-island-flash, .composer-island-quota, .turn-review-bar';
/** A segment still reading its state (IslandSegmentPending, a Goal whose
 *  module is loading): the only thing a reserved slot can wait for. */
const ISLAND_UNDECIDED = '[data-island-pending], [data-entry-pending]';

type SlotPresence = 'open' | 'grace' | 'closing' | 'closed';

/** Each session's last resting (pill) slot height, 0 once its island emptied.
 *  A session switch remounts the island before its segments have read their
 *  state; the slot reserves this height for the mount instead of opening late
 *  and lifting the composer. Kept across reloads (most recent sessions only);
 *  a session never shown has no entry: it reserves the resting height of the
 *  island it replaces in the same dock (carriedHeight), or mounts at its true
 *  state. */
const RESTING_SLOT_HEIGHTS_KEY = 'mixdog:composer-island-resting-heights';
const RESTING_SLOT_HEIGHTS_MAX = 200;
let restingSlotHeights: Map<string, number> | null = null;

function slotHeights(): Map<string, number> {
  if (restingSlotHeights) return restingSlotHeights;
  restingSlotHeights = new Map();
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(RESTING_SLOT_HEIGHTS_KEY) || '[]');
    if (Array.isArray(stored)) {
      for (const entry of stored) {
        if (Array.isArray(entry) && typeof entry[0] === 'string' && Number.isFinite(entry[1])) {
          restingSlotHeights.set(entry[0], entry[1]);
        }
      }
    }
  } catch {
    /* an unreadable cache only costs one late opening per session */
  }
  return restingSlotHeights;
}

/** Each session's last decided advance (width plus separator margin; 0 once
 *  it showed none) of the segments that read late. A remount reserves them
 *  while the segments re-read (IslandSegmentPending). */
type AdvanceForm = 'compact' | 'full';
const segmentAdvances = new Map<string, Partial<Record<AdvanceForm, Partial<IslandSegmentReserves>>>>();
/** The pill markup each session's advances were last read from. */
const recordedPillMarkup = new Map<string, string>();
const RESERVED_SEGMENTS: Record<IslandReservedSegment, string> = {
  branch: '.composer-island-seg-branch',
  files: '.turn-review-segment',
  git: '.composer-island-git',
};

export function rememberedSegmentAdvances(sessionId: string): Partial<IslandSegmentReserves> | undefined {
  // A segment's advance is read in the form the island will start in (the
  // last fit's): its compact and full widths differ, and a reserve of the
  // other form would shift every neighbour when the segment arrives.
  if (!sessionId) return undefined;
  return segmentAdvances.get(sessionId)?.[lastFit.includes('data-compact') ? 'compact' : 'full'];
}

/** Records every reserved segment of a pill that has decided. Called where
 *  the slot has just laid the stage out (useIslandSlotPresence sync). */
function rememberSegmentAdvances(sessionId: string, pill: Element): void {
  if (!sessionId) return;
  // The same pill markup lays out to the same advances: a remount or a slot
  // re-sync of unchanged segments skips the style and layout reads.
  const form: AdvanceForm = pill.closest('.composer-island')?.hasAttribute('data-compact') ? 'compact' : 'full';
  const markup = `${form}|${labelFitKey(pill)}`;
  if (recordedPillMarkup.get(sessionId) === markup && segmentAdvances.get(sessionId)?.[form]) return;
  recordedPillMarkup.delete(sessionId);
  recordedPillMarkup.set(sessionId, markup);
  evictOldest(recordedPillMarkup, RESTING_SLOT_HEIGHTS_MAX);
  const recorded = segmentAdvances.get(sessionId);
  const next = { ...recorded?.[form] };
  for (const kind of Object.keys(RESERVED_SEGMENTS) as IslandReservedSegment[]) {
    if (pill.querySelector(`[data-island-pending="${kind}"]`)) continue;
    const segment = pill.querySelector<HTMLElement>(RESERVED_SEGMENTS[kind]);
    const margin = segment ? Number.parseFloat(window.getComputedStyle(segment).marginInlineStart) || 0 : 0;
    // The laid-out width, fractions included: a reserve of the rounded
    // offsetWidth stood up to half a pixel off the segment it holds room for.
    next[kind] = segment ? segment.getBoundingClientRect().width + margin : 0;
  }
  segmentAdvances.delete(sessionId);
  segmentAdvances.set(sessionId, { ...recorded, [form]: next });
  evictOldest(segmentAdvances, RESTING_SLOT_HEIGHTS_MAX);
}

/** A session's remembered resting slot height; undefined for a session never
 *  shown (unlike a remembered 0: its island emptied). */
export function rememberedSlotHeight(sessionId: string): number | undefined {
  return sessionId ? slotHeights().get(sessionId) : undefined;
}

function rememberSlotHeight(sessionId: string, height: number): void {
  if (!sessionId) return;
  const heights = slotHeights();
  if (heights.get(sessionId) === height) return;
  // Most recent last, so the oldest entry is the first to go.
  heights.delete(sessionId);
  heights.set(sessionId, height);
  evictOldest(heights, RESTING_SLOT_HEIGHTS_MAX);
  try {
    window.localStorage.setItem(RESTING_SLOT_HEIGHTS_KEY, JSON.stringify([...heights]));
  } catch {
    /* quota or a disabled store: the in-memory cache still serves this run */
  }
}
/** The slot's eased height; the stylesheet rounds it to whole pixels. */
const SLOT_HEIGHT = '--island-slot-height';
/** Pane height above an open panel's floor; the stylesheet caps the panel to it. */
const PANEL_ROOM = '--island-panel-room';
/** The pane's height above the dock's floor: a docked approval may take all of
 *  it (it outranks the transcript), so its buttons are never cut off. */
const APPROVAL_ROOM = '--island-approval-room';
/** Below this room (a phone with its keyboard up) the card drops its face. */
const APPROVAL_TIGHT_ROOM = 420;
/** The gap a docked card keeps clear of the pane's top edge (the tab bar),
 *  so its top border and corners never sit flush against it. */
const APPROVAL_TOP_GAP = 10;
/** The order a docked card short of room gives up space in, before its
 *  preview gets smaller than readable (15-approval-prompt.css): the stacked
 *  buttons go side by side; the last resort scrolls the island with the
 *  buttons at its floor. */
const APPROVAL_FIT_STEPS = ['row', 'compact', 'scroll'];
/** The preview's readable floor: this many lines, or all of it. */
const APPROVAL_PREVIEW_LINES = 3;

/** Fits a docked approval into the island's room: the preview's floor is
 *  measured, then space is reclaimed step by step until nothing spills. */
function fitDockedApproval(slot: HTMLElement, island: HTMLElement): void {
  slot.removeAttribute('data-approval-fit');
  const prompt = island.querySelector<HTMLElement>('.composer-island-approval > .approval-prompt');
  if (!prompt) return;
  const preview = prompt.querySelector<HTMLElement>(':scope > .approval-preview');
  if (preview?.offsetParent) {
    const style = getComputedStyle(preview);
    const px = (value: string) => Number.parseFloat(value) || 0;
    const borders = px(style.borderTopWidth) + px(style.borderBottomWidth);
    const lines =
      px(style.paddingTop) + px(style.paddingBottom) + borders + APPROVAL_PREVIEW_LINES * px(style.lineHeight);
    const floor = Math.ceil(Math.min(preview.scrollHeight + borders, lines));
    slot.style.setProperty('--approval-preview-min', `${floor}px`);
    // The compact step's floor: the preview's first row (the recipient, the
    // site, the amount), whole.
    const first =
      preview.querySelector<HTMLElement>('.approval-preview-row, .approval-amount') ?? preview.firstElementChild;
    const one =
      first instanceof HTMLElement
        ? px(style.paddingTop) + px(style.paddingBottom) + borders + first.offsetHeight
        : floor;
    slot.style.setProperty('--approval-preview-compact', `${Math.ceil(Math.min(one, floor))}px`);
  }
  // Its content and its bottom padding inside the card (an overflow the
  // card's scrollHeight would not count), the card inside the island.
  const padding = Number.parseFloat(getComputedStyle(prompt).paddingBottom) || 0;
  const fits = () => {
    const end = Math.max(0, ...[...prompt.children].map((child) => child.getBoundingClientRect().bottom));
    return end + padding <= prompt.getBoundingClientRect().bottom + 1 && island.scrollHeight <= island.clientHeight + 1;
  };
  const taken: string[] = [];
  for (const step of APPROVAL_FIT_STEPS) {
    if (fits()) return;
    taken.push(step);
    slot.setAttribute('data-approval-fit', taken.join(' '));
  }
}

/** A panel paints upward from the pill's resting floor, so its real room is
 *  the pane's top down to that floor (the dock's height varies). */
function measurePanelRoom(slot: HTMLElement, stage: HTMLElement, pane: Element) {
  const pillHeight = Number.parseFloat(getComputedStyle(slot).getPropertyValue('--island-pill-height')) || 0;
  const room = stage.getBoundingClientRect().top - pane.getBoundingClientRect().top + pillHeight;
  slot.style.setProperty(PANEL_ROOM, `${Math.max(0, Math.floor(room))}px`);
}

/** A docked approval sits on the dock's floor (the stage's bottom less its
 *  gap, which never moves as the card grows) and may reach the pane's top. */
function measureApprovalRoom(slot: HTMLElement, island: HTMLElement, stage: HTMLElement, pane: Element) {
  const gap = Number.parseFloat(getComputedStyle(stage).paddingBottom) || 0;
  const room = Math.floor(
    stage.getBoundingClientRect().bottom - gap - pane.getBoundingClientRect().top - APPROVAL_TOP_GAP
  );
  slot.style.setProperty(APPROVAL_ROOM, `${Math.max(0, room)}px`);
  slot.toggleAttribute('data-approval-tight', room < APPROVAL_TIGHT_ROOM);
  // Fitted at the island's own height, not the slot's current (eased or
  // last-fitted) one.
  slot.setAttribute('data-measuring', '');
  fitDockedApproval(slot, island);
  slot.removeAttribute('data-measuring');
}

/** Calls `sync` on size changes without a DOM change (wrapping, the pane's
 *  height bound); returns the teardown. */
function observeIslandSizes(slot: HTMLElement, island: HTMLElement, pane: Element | null, sync: () => void) {
  // Only a HEIGHT change can move the slot's target: a width-only change
  // (every step of a window drag) must not toggle data-measuring and force
  // two style passes for a target that cannot have changed.
  const observedHeights = new WeakMap<Element, number>();
  const resizeObserver = new ResizeObserver((entries) => {
    let heightChanged = false;
    for (const entry of entries) {
      const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
      if (observedHeights.get(entry.target) === height) continue;
      observedHeights.set(entry.target, height);
      heightChanged = true;
    }
    if (heightChanged) sync();
  });
  resizeObserver.observe(island);
  // The dock (textarea, queue, /btw) and the pane move the panel's floor.
  if (pane) resizeObserver.observe(pane);
  const region = slot.closest('.composer-region');
  if (region) resizeObserver.observe(region);
  for (const child of island.children) resizeObserver.observe(child);
  const children = new MutationObserver(() => {
    for (const child of island.children) resizeObserver.observe(child);
  });
  children.observe(island, { childList: true });
  return () => {
    children.disconnect();
    resizeObserver.disconnect();
  };
}

/**
 * Owns the slot's explicit height and data-presence. Content opens the slot
 * at once to the stage's real height; a change while open eases there
 * (data-motion carries the CSS transition, which reverses mid-flight on its
 * own). The last content leaving holds the slot for ISLAND_COLLAPSE_GRACE_MS,
 * then eases it to 0. Mount (a session switch remounts the island) and
 * reduced motion apply every change instantly; reduced motion turning on
 * mid-motion lands the slot at its target at once. The island's entry fade
 * (data-entry) is enabled only by content arriving, or the island changing
 * shape, after the first frame: a mounted island draws at its final state,
 * and so does an island a session had open when it was last shown, once its
 * late segments land (only an island's first appearance in a session fades).
 * Content changes are read in the mutation microtask, before the frame's
 * layout, so the transcript's viewport observer sees the new dock in the same
 * frame. Segments render from their own state, so the island's DOM, not its
 * props, is watched. An island mounted in place of other dock chrome
 * (heldHeightRef, the draft context bar) starts at that chrome's height:
 * empty, it stays there for the mount frame and then takes the ordinary
 * grace and collapse, as if its last content had just left. Otherwise an
 * island remounted for a session it showed before starts at that session's
 * resting height (a session never shown: the carried height of the island it
 * replaces) and holds it up to ISLAND_RESERVE_HOLD_MS for the first segment,
 * so an entry opens without moving the composer. The hold lasts only while a
 * segment is undecided, and holds the transcript's reveal (data-reserved).
 */
export function useIslandSlotPresence(
  slotRef: RefObject<HTMLDivElement | null>,
  islandRef: RefObject<HTMLDivElement | null>,
  heldHeightRef: RefObject<number>,
  sessionIdRef: RefObject<string>,
  carriedHeightRef: RefObject<number>
) {
  useLayoutEffect(() => {
    const slot = slotRef.current;
    const island = islandRef.current;
    const stage = island?.parentElement;
    if (!slot || !island || !stage) return undefined;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    // Dock chrome this island replaces wins; otherwise the session's resting
    // height is reserved for the mount (see restingSlotHeights).
    let held =
      heldHeightRef.current > 0
        ? heldHeightRef.current
        : (rememberedSlotHeight(sessionIdRef.current) ?? carriedHeightRef.current);
    // A reserved mount waits for its segments' first read (a cold session's
    // lane and git state), which outlasts the ordinary grace; the hold ends
    // with the first content, or once no segment is left undecided.
    let reserving = false;
    // A reserved height is only a guess at the island's resting height, so
    // while it stands the slot is unsettled dock chrome: it holds the
    // transcript's reveal (use-transcript-reveal). Revealed above it, the
    // end-pinned rows dropped by the slot's height when it closed.
    const reserve = (value: boolean) => {
      reserving = value;
      slot.toggleAttribute('data-reserved', value);
    };
    reserve(heldHeightRef.current <= 0 && held > 0);
    let armed = false;
    let grace = 0;
    let height = -1;
    let carried = false;
    let shape: string | null = null;
    // The session's island was open when it was last shown: its first
    // content after this mount (segments re-reading, a lane landing) is the
    // island coming back, not appearing, so it draws without the entry fade.
    let returning = (rememberedSlotHeight(sessionIdRef.current) ?? 0) > 0;
    const presence = (value: SlotPresence) => slot.setAttribute('data-presence', value);
    // An unchanged target starts no transition: it leaves any motion running.
    const resize = (target: number, animate: boolean) => {
      if (target === height) return;
      height = target;
      if (animate) slot.setAttribute('data-motion', '');
      else slot.removeAttribute('data-motion');
      slot.style.setProperty(SLOT_HEIGHT, `${target}px`);
    };
    // The stage's own height, unshrunk by the slot (mid-motion or squeezed).
    const natural = () => {
      slot.setAttribute('data-measuring', '');
      const value = stage.offsetHeight;
      slot.removeAttribute('data-measuring');
      return value;
    };
    const cancelGrace = () => {
      window.clearTimeout(grace);
      grace = 0;
    };
    // The height motion is over (it ran out, or reduced motion cut it short).
    const endMotion = () => {
      slot.removeAttribute('data-motion');
      if (slot.getAttribute('data-presence') === 'closing') presence('closed');
    };
    const collapse = (animate: boolean) => {
      if (animate && height > 0) {
        presence('closing');
        resize(0, true);
      } else {
        resize(0, false);
        presence('closed');
      }
    };
    const pane = slot.closest('.conversation');
    const sync = () => {
      if (pane && island.getAttribute('data-mode') === 'panel') measurePanelRoom(slot, stage, pane);
      const animate = armed && !reducedMotion.matches;
      const content = Boolean(island.querySelector(ISLAND_CONTENT));
      const mode = island.getAttribute('data-mode');
      // Set in the same microtask as the change, so the style pass that
      // shows the new content starts its fade; once set it stays. A session
      // coming back to its open island, or content landing in a retained
      // (unpainted) conversation, is no entry: the fade would replay the
      // moment the session is shown again.
      if (armed && content && (!carried || mode !== shape)) {
        if (returning || slot.closest('[data-retained]')) slot.removeAttribute('data-entry');
        else slot.setAttribute('data-entry', '');
      }
      carried = content;
      shape = mode;
      if (content) {
        returning = false;
        cancelGrace();
        reserve(false);
        // Shown first: a closed slot has no box to measure.
        presence('open');
        if (pane && mode === 'approval') measureApprovalRoom(slot, island, stage, pane);
        const target = natural();
        resize(target, animate);
        if (mode === 'pill') {
          rememberSlotHeight(sessionIdRef.current, target);
          // Laid out by natural() above.
          const pill = island.querySelector('.composer-island-pill');
          if (pill) rememberSegmentAdvances(sessionIdRef.current, pill);
        }
        return;
      }
      // Every segment has decided and none shows: nothing can fill the
      // reservation (a bot chat carries no late segments at all). Held to
      // the hold's end, it closed seconds after the entry painted and dropped
      // the end-pinned transcript by the slot's height. The room is empty, so
      // behind a still-hidden entry (Conversation data-transcript-entering)
      // there is no motion to show: it closes at once, not after the reveal
      // waited out an unseen easing.
      if (reserving && !island.querySelector(ISLAND_UNDECIDED)) {
        cancelGrace();
        reserve(false);
        held = 0;
        returning = false;
        rememberSlotHeight(sessionIdRef.current, 0);
        collapse(animate && !pane?.hasAttribute('data-transcript-entering'));
        return;
      }
      if (!armed) {
        cancelGrace();
        if (held > 0) {
          presence('grace');
          resize(held, false);
          return;
        }
        collapse(false);
        return;
      }
      // A held mount's grace starts once the island is armed.
      const state = slot.getAttribute('data-presence');
      if (state !== 'open' && !(state === 'grace' && !grace)) return;
      presence('grace');
      grace = window.setTimeout(
        () => {
          grace = 0;
          reserve(false);
          returning = false;
          rememberSlotHeight(sessionIdRef.current, 0);
          collapse(!reducedMotion.matches);
        },
        reserving ? ISLAND_RESERVE_HOLD_MS : ISLAND_COLLAPSE_GRACE_MS
      );
    };
    const onTransitionEnd = (event: TransitionEvent) => {
      if (event.target === slot && event.propertyName === SLOT_HEIGHT) endMotion();
    };
    // Dropping data-motion removes the transition, so the browser cancels it
    // and the slot takes its target height in the next style pass.
    const onMotionPreference = () => {
      if (reducedMotion.matches && slot.hasAttribute('data-motion')) endMotion();
    };
    sync();
    // The first painted frame shows the true state; changes after it animate.
    const frame = window.requestAnimationFrame(() => {
      armed = true;
      if (slot.getAttribute('data-presence') === 'grace') sync();
    });
    const mutation = new MutationObserver(sync);
    mutation.observe(island, { subtree: true, childList: true, characterData: true, attributes: true });
    const stopObserving = observeIslandSizes(slot, island, pane, sync);
    slot.addEventListener('transitionend', onTransitionEnd);
    reducedMotion.addEventListener('change', onMotionPreference);
    return () => {
      window.cancelAnimationFrame(frame);
      cancelGrace();
      mutation.disconnect();
      stopObserving();
      slot.removeEventListener('transitionend', onTransitionEnd);
      reducedMotion.removeEventListener('change', onMotionPreference);
    };
  }, [slotRef, islandRef, heldHeightRef, sessionIdRef, carriedHeightRef]);
}

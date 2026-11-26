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

/** The pill's labels give way one step at a time, least needed first (words
 *  before figures; counts and state marks never go), and come back in the
 *  reverse order. A fit is how many steps are taken; the island lists them in
 *  data-fit, which the stylesheet reads. The last step also lets a pill still
 *  wider than its room take another line, so no form runs past the pane. */
const FIT_STEPS = [
  'git-word',
  'files-word',
  'files-lines',
  'shell-word',
  'agents-word',
  'resume-time',
  'goal-time',
  'branch-cap',
  'branch-glyph',
  'resume-glyph',
  'tight',
] as const;
const LAST_FIT = FIT_STEPS.length;
/** The first fits that take the worktree name's cap and its glyph step. */
const BRANCH_CAPPED = FIT_STEPS.indexOf('branch-cap') + 1;
const BRANCH_GLYPH = FIT_STEPS.indexOf('branch-glyph') + 1;
const fitTokens = (fit: number) => FIT_STEPS.slice(0, fit).join(' ');

/** A form's pill at its natural width, and how far its capped worktree name
 *  may still squeeze before only the glyph reads. */
type FormWidth = { width: number; squeeze: number };
/** Each form's width by what decides them (labelFitKey), read as a fit needs
 *  it: a pill drawn again with the same content — a revisited session's island
 *  remounting, a segment re-rendering unchanged — reuses them. */
const formWidths = new Map<string, FormWidth[]>();
const FORM_WIDTHS_MAX = 200;

/** A wrapped pill's line starts (markLineStarts); they move nothing. */
const LINE_START_MARKS = / data-line-start=""/g;

/** The pill's markup plus the root's attributes (theme, text size): equal
 *  keys lay out to equal widths. */
function labelFitKey(pill: Element): string {
  const root = document.documentElement;
  const markup = pill.innerHTML.replace(LINE_START_MARKS, '');
  return `${root.className}|${root.getAttribute('style') ?? ''}|${JSON.stringify(root.dataset)}|${markup}`;
}

/** Marks the segments that open a wrapped pill's later lines, as laid out
 *  (offsets: a running glide reads nothing), so no separator is drawn at a
 *  line's start (15-composer.css). The separator paints outside layout, so
 *  the mark never moves a line break. */
function markLineStarts(pill: Element): void {
  let lineBottom = Number.NEGATIVE_INFINITY;
  let first = true;
  for (const child of pill.children) {
    if (!(child instanceof HTMLElement) || child.getClientRects().length === 0) continue;
    const starts = !first && child.offsetTop >= lineBottom - 0.5;
    if (child.hasAttribute('data-line-start') !== starts) child.toggleAttribute('data-line-start', starts);
    const bottom = child.offsetTop + child.offsetHeight;
    lineBottom = starts ? bottom : Math.max(lineBottom, bottom);
    first = false;
  }
}

/** The last fit per room (the card's width, which every session of a window
 *  shares): a new island starts from it instead of the full labels. */
const fitByRoom = new Map<number, number>();
const FIT_BY_ROOM_MAX = 40;
let lastFit = 0;
/** A form that gave way comes back only with this much room to spare past its
 *  width: a count that grows or shrinks a digit near the limit never flips the
 *  island between two forms. */
const FIT_EXPAND_MARGIN_PX = 24;
/** The pill's width at rest, which an opened panel takes (15-composer.css). */
const REST_WIDTH = '--island-rest-width';
/** The pill's height at rest (two lines when wrapped): an opened panel keeps
 *  its floor and its slot's height (15-composer.css). */
const REST_HEIGHT = '--island-rest-pill-height';

function applyFit(island: HTMLElement, fit: number): void {
  const tokens = fitTokens(fit);
  if (island.getAttribute('data-fit') !== tokens) island.setAttribute('data-fit', tokens);
}

function rememberFit(fit: number, room: number): void {
  lastFit = fit;
  fitByRoom.delete(room);
  fitByRoom.set(room, fit);
  evictOldest(fitByRoom, FIT_BY_ROOM_MAX);
}

export function useIslandFit(islandRef: RefObject<HTMLDivElement | null>, pillRef: RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    const island = islandRef.current;
    const pill = pillRef.current;
    const stage = island?.parentElement;
    if (!island || !pill || !stage) return undefined;
    let room = -1;
    let fit = fitByRoom.get(stage.clientWidth) ?? lastFit;
    let widths: FormWidth[] = [];
    let widthsKey = '';
    let singleLineHeight = 0;
    let wrappedHeight = 0;
    const writeRestSize = (width: number, height: number, wrapped: boolean) => {
      if (width > 0) stage.style.setProperty(REST_WIDTH, `${width}px`);
      if (height > 0) {
        stage.style.setProperty(REST_HEIGHT, `${height}px`);
        if (wrapped) wrappedHeight = height;
        else singleLineHeight = height;
      }
    };
    // A form is read under data-measuring, which lays out the steps it names
    // at the pill's natural width over the fit shown (the stylesheet), so the
    // shown fit is never taken off to read.
    const readForm = (form: number): FormWidth => {
      island.setAttribute('data-measuring', fitTokens(form));
      const width = pill.getBoundingClientRect().width;
      const name =
        form >= BRANCH_CAPPED && form < BRANCH_GLYPH
          ? pill.querySelector('.composer-island-seg-branch .composer-island-seg-text')
          : null;
      const squeeze = name ? Math.max(0, name.getBoundingClientRect().width - WORKTREE_NAME_MIN_PX) : 0;
      return { width, squeeze };
    };
    const readWidths = (key: string, fresh: boolean) => {
      widthsKey = key;
      widths = (fresh ? undefined : formWidths.get(key)) ?? [];
      formWidths.delete(key);
      formWidths.set(key, widths);
      evictOldest(formWidths, FORM_WIDTHS_MAX);
    };
    // The width a form takes in this room. The capped worktree name squeezes
    // only against the room's own edge: no style holds the bot's reserve.
    const needOf = (form: number, reserve: number) => {
      const known = widths[form] ?? readForm(form);
      widths[form] = known;
      return known.width - (reserve > 0 ? 0 : known.squeeze);
    };
    // The fullest form that fits, read from the form shown outward. A wider
    // form than the one shown needs the expand margin; while a late segment's
    // reserve (IslandSegmentPending) stands in for it, the pill measures
    // narrower than it will once the segment arrives, so nothing widens.
    const decide = () => {
      const reserve = petIslandReserveFor(island);
      const budget = room - 2 * reserve;
      const shown = needOf(fit, reserve);
      let next = fit;
      if (shown > budget) {
        while (next < LAST_FIT && needOf(next, reserve) > budget) next += 1;
      } else if (!pill.querySelector('[data-island-pending]')) {
        while (next > 0) {
          const wider = needOf(next - 1, reserve);
          if (wider + (wider > shown ? FIT_EXPAND_MARGIN_PX : 0) > budget) break;
          next -= 1;
        }
      }
      // Read before data-measuring goes: the last form is first read here.
      const fits = needOf(next, reserve) <= budget;
      island.removeAttribute('data-measuring');
      return { next, fits };
    };
    // Read as laid out: a segment still gliding to its place (useIslandGlide)
    // paints past the pill's edge without overflowing it.
    const overflows = () => withoutGlides(island, () => pill.scrollWidth > pill.clientWidth);
    const fitPill = () => {
      // The widths are trusted only for what decides them, compared on every
      // path: a room change, the bot's reserve or the pill resizing may come
      // with other type (a smaller text size) and no change of markup.
      const key = labelFitKey(pill);
      if (key !== widthsKey) readWidths(key, false);
      let decided = decide();
      applyFit(island, decided.next);
      // The remembered widths came from other glyph metrics (a web font that
      // landed since, a fallback face): a form that should fit overflows as
      // laid out, so the forms are read again instead of trusted.
      if (decided.fits && overflows()) {
        readWidths(key, true);
        decided = decide();
        applyFit(island, decided.next);
      }
      fit = decided.next;
      rememberFit(fit, room);
      markLineStarts(pill);
      const box = withoutGlides(island, () => pill.getBoundingClientRect());
      writeRestSize(box.width, box.height, fit === LAST_FIT && !decided.fits);
    };
    const refit = () => {
      // Only the resting pill is fitted: an open tab hides or fills it.
      if (room <= 0 || island.getAttribute('data-mode') !== 'pill') return;
      fitPill();
    };
    // Recompute resting pill width/height when the pane resizes while a panel
    // is open so `--island-rest-pill-height` never stays stale at a prior wrap.
    const recomputeRestForPanel = () => {
      if (room <= 0 || island.getAttribute('data-mode') !== 'panel') return;
      if (pill.hidden) {
        island.style.setProperty('--island-measure-room', `${room}px`);
        island.setAttribute('data-measuring-rest', '');
        try {
          fitPill();
        } finally {
          island.removeAttribute('data-measuring-rest');
          island.style.removeProperty('--island-measure-room');
        }
        return;
      }
      if (!widths.length) return;
      const reserve = petIslandReserveFor(island);
      const budget = room - 2 * reserve;
      let fitted: FormWidth | null = null;
      for (let form = 0; form <= LAST_FIT; form += 1) {
        const known = widths[form];
        if (!known) continue;
        const need = known.width - (reserve > 0 ? 0 : known.squeeze);
        if (need <= budget) {
          fitted = known;
          break;
        }
      }
      if (fitted) {
        stage.style.setProperty(REST_WIDTH, `${Math.min(fitted.width, Math.max(0, budget))}px`);
        if (singleLineHeight > 0) stage.style.setProperty(REST_HEIGHT, `${singleLineHeight}px`);
        else stage.style.removeProperty(REST_HEIGHT);
      } else if (wrappedHeight > 0) {
        stage.style.setProperty(REST_HEIGHT, `${wrappedHeight}px`);
      }
    };
    const initialRoom = stage.clientWidth;
    applyFit(island, fit);
    if (initialRoom > 0) {
      room = initialRoom;
      refit();
    }
    // Delivered after the frame's layout: the room's read costs no layout.
    // The pill is watched too: type that lands later (fonts) resizes it with
    // no change of room or content, and its resting width is what an opened
    // panel takes. A stage with no box (its surface hidden) decides nothing.
    const resize = new ResizeObserver(() => {
      const next = stage.clientWidth;
      if (next <= 0) return;
      const roomChanged = next !== room;
      room = next;
      const mode = island.getAttribute('data-mode');
      if (mode === 'pill') {
        refit();
      } else if (roomChanged && mode === 'panel') {
        recomputeRestForPanel();
      }
    });
    resize.observe(stage);
    resize.observe(pill);
    const fonts = document.fonts;
    const reread = () => {
      formWidths.clear();
      widthsKey = '';
      refit();
    };
    fonts?.addEventListener?.('loadingdone', reread);
    const stopReserve = subscribePetIslandReserve(refit);
    const mutation = new MutationObserver(refit);
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
      fonts?.removeEventListener?.('loadingdone', reread);
    };
  }, [islandRef, pillRef]);
}

/** Identifier retained for callers/tests inspecting island animations (none run). */
export const ISLAND_GLIDE_ID = 'island-glide';

/** Reads layout immediately (the island runs no glide animations). */
export function withoutGlides<T>(_island: Element, read: () => T): T {
  return read();
}

/** How long an emptied island keeps its slot before closing:
 *  content returning within it (one segment handing over to the next) moves
 *  nothing. */
export const ISLAND_COLLAPSE_GRACE_MS = 500;
/** What the island carries; the stylesheet's empty-island rule tests the same. */
const ISLAND_CONTENT =
  '.composer-island-seg, .session-goal-island, .composer-island-approval, .composer-island-flash, .composer-island-quota, .turn-review-bar';
/** A segment still reading its state (IslandSegmentPending, a Goal whose
 *  module is loading): the only thing a reserved slot can wait for. */
const ISLAND_UNDECIDED = '[data-island-pending], [data-entry-pending]';

type SlotPresence = 'open' | 'grace' | 'closed';

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
const segmentAdvances = new Map<string, Record<string, Partial<IslandSegmentReserves>>>();
/** The pill markup each session's advances were last read from. */
const recordedPillMarkup = new Map<string, string>();
const RESERVED_SEGMENTS: Record<IslandReservedSegment, string> = {
  branch: '.composer-island-seg-branch',
  files: '.turn-review-segment',
  git: '.composer-island-git',
};

export function rememberedSegmentAdvances(sessionId: string): Partial<IslandSegmentReserves> | undefined {
  // A segment's advance is read in the form the island will start in (the
  // last fit's): each form's widths differ, and a reserve of another form
  // would shift every neighbour when the segment arrives.
  if (!sessionId) return undefined;
  return segmentAdvances.get(sessionId)?.[fitTokens(lastFit)];
}

/** Records every reserved segment of a pill that has decided. Called where
 *  the slot has just laid the stage out (useIslandSlotPresence sync). */
function rememberSegmentAdvances(sessionId: string, pill: Element): void {
  if (!sessionId) return;
  // The same pill markup lays out to the same advances: a remount or a slot
  // re-sync of unchanged segments skips the style and layout reads.
  const form = pill.closest('.composer-island')?.getAttribute('data-fit') ?? '';
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
  const style = window.getComputedStyle(stage);
  const pillHeight =
    Number.parseFloat(style.getPropertyValue(REST_HEIGHT) || style.getPropertyValue('--island-pill-height')) || 0;
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

/** Calls `sync` on height changes without a DOM change (wrapping, the pane's
 *  height bound); returns the teardown. */
function observeIslandSizes(slot: HTMLElement, island: HTMLElement, pane: Element | null, sync: () => void) {
  // Only a HEIGHT change can move the slot's target: a width-only change
  // (every step of a window drag) must not toggle data-measuring and force
  // two style passes for a target that cannot have changed.
  const observedHeights = new WeakMap<Element, number>();
  const region = slot.closest('.composer-region');
  const resizeObserver = new ResizeObserver((entries) => {
    let heightChanged = false;
    for (const entry of entries) {
      const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
      if (observedHeights.get(entry.target) !== height) {
        observedHeights.set(entry.target, height);
        if (entry.target !== slot) heightChanged = true;
      }
    }
    if (heightChanged) sync();
  });
  resizeObserver.observe(slot);
  resizeObserver.observe(island);
  // The dock (textarea, queue, /btw) and the pane move the panel's floor.
  if (pane) resizeObserver.observe(pane);
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
    // Dock chrome this island replaces wins; otherwise the session's resting
    // height is reserved for the mount (see restingSlotHeights).
    let held =
      heldHeightRef.current > 0
        ? heldHeightRef.current
        : (rememberedSlotHeight(sessionIdRef.current) ?? carriedHeightRef.current);
    let reserving = false;
    // A reserved height is the island's resting height when the session was last shown: the room the transcript is
    // presented above while the segments read. Segments that read as before leave it as it is; an island that
    // reads empty closes it, and the end-pinned rows drop by its height.
    const reserve = (value: boolean) => {
      reserving = value;
      slot.toggleAttribute('data-reserved', value);
    };
    reserve(heldHeightRef.current <= 0 && held > 0);
    let armed = false;
    let grace = 0;
    let height = -1;
    const presence = (value: SlotPresence) => slot.setAttribute('data-presence', value);
    const resize = (target: number) => {
      if (target === height) return;
      height = target;
      slot.style.setProperty(SLOT_HEIGHT, `${target}px`);
    };
    // The stage's own height, unshrunk by the slot.
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
    const collapse = () => {
      resize(0);
      presence('closed');
    };
    const pane = slot.closest('.conversation');
    const sync = () => {
      const mode = island.getAttribute('data-mode');
      if (pane && (mode === 'pill' || mode === 'panel')) measurePanelRoom(slot, stage, pane);
      const content = Boolean(island.querySelector(ISLAND_CONTENT));
      if (content) {
        cancelGrace();
        reserve(false);
        // Shown first: a closed slot has no box to measure.
        presence('open');
        if (pane && mode === 'approval') measureApprovalRoom(slot, island, stage, pane);
        const target = natural();
        resize(target);
        if (mode === 'pill') {
          rememberSlotHeight(sessionIdRef.current, target);
          // Laid out by natural() above.
          const pill = island.querySelector('.composer-island-pill');
          if (pill) rememberSegmentAdvances(sessionIdRef.current, pill);
        }
        return;
      }
      if (reserving && !island.querySelector(ISLAND_UNDECIDED)) {
        cancelGrace();
        reserve(false);
        held = 0;
        rememberSlotHeight(sessionIdRef.current, 0);
        collapse();
        return;
      }
      if (!armed) {
        cancelGrace();
        if (held > 0) {
          presence('grace');
          resize(held);
          return;
        }
        collapse();
        return;
      }
      // A held mount's grace starts once the island is armed.
      const state = slot.getAttribute('data-presence');
      if (state !== 'open' && !(state === 'grace' && !grace)) return;
      presence('grace');
      // A slot that keeps its session's remembered room for segments still reading keeps it until they have read:
      // no elapsed time closes it under the rows it holds up.
      if (reserving) return;
      grace = window.setTimeout(() => {
        grace = 0;
        reserve(false);
        rememberSlotHeight(sessionIdRef.current, 0);
        collapse();
      }, ISLAND_COLLAPSE_GRACE_MS);
    };
    sync();
    // A held mount starts its grace after the first frame.
    const frame = window.requestAnimationFrame(() => {
      armed = true;
      if (slot.getAttribute('data-presence') === 'grace') sync();
    });
    const mutation = new MutationObserver(() => sync());
    mutation.observe(island, { subtree: true, childList: true, characterData: true, attributes: true });
    const stopObserving = observeIslandSizes(slot, island, pane, sync);
    return () => {
      window.cancelAnimationFrame(frame);
      cancelGrace();
      mutation.disconnect();
      stopObserving();
    };
  }, [slotRef, islandRef, heldHeightRef, sessionIdRef, carriedHeightRef]);
}

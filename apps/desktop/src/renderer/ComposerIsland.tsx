import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type ReactNode,
  type RefObject,
} from 'react';
import { dismissShellJobs, useDismissedShellJobs } from './background-jobs-dismissed-store';
import { AgentPoolRow } from './AgentActivityPane';
import { clearableAgentNode, dismissFinishedAgentRows, useVisibleAgentPool } from './agent-dismiss';
import type { DesktopAgentActivityState } from '../shared/agent-activity';
import {
  AGENT_POOL_RECONCILE_MS,
  agentPoolStore,
  islandAgentRows,
  poolRowKey,
  refreshAgentPool,
  startAgentPool,
  type IslandAgentRow,
} from './agent-activity-model';
import {
  backgroundJobRows,
  EMPTY_SHELL_ROW_RETENTION,
  expiredShellRows,
  retainVanishedShellRows,
  type JobKind,
  type JobRow,
  type ShellStopState,
} from './background-jobs-model';
import { type IslandUsageSummary, islandUsageSummary, useIslandSessionUsage } from './island-session-usage';
import { statsCount, statsPercent, statsTokens } from './usage-stats-model';
import { usageMoney } from './usage-format';
import { ShellJobContent, ShellRowButton, useShellStops } from './shell-job-controls';
import {
  ComposerIslandContext,
  type ComposerIslandTab,
  type IslandReservedSegment,
  type IslandSegmentReserves,
  petIslandReserveFor,
  subscribePetIslandReserve,
} from './composer-island-state';
import { desktopHeaderSnapshotsEqual } from './desktop-snapshot-store';
import { EMPTY_SNAPSHOT } from './desktop-types';
import { t } from './i18n';
import { subscribeSharedPoll } from './shared-pool-poll';
import { MxIcon } from './MxIcon';
import { defaultSessionLaneStore, useSessionLane } from './session-lane-store';
import { quotaRemainingLabel, quotaResetLabel } from './quota-continue';
import { useClock } from './use-clock';

/** A short notice the island shows in place of its pill, then returns. */
/** `icon`: the glyph before the text (default the check). */
export type ComposerIslandFlash = { key: string; text: string; icon?: 'check' | 'close-small' | 'clock' };

/** A quota-stopped turn that resumes by itself at the reset time. */
export type ComposerIslandQuotaResume = {
  /** Model the turn resumes in, display name. */
  model: string;
  /** Epoch ms of the resume. */
  resetAt: number;
  /** Drop the reservation; the session stays stopped. */
  onCancel(): void;
};

const FLASH_MS = 2_500;

/** A segment's words, plus the icon and bare count the narrow island shows
 *  instead (the count is painted from the attribute so it never joins the
 *  text content). */
export function IslandSegLabel({ text, count, icon }: { text: string; count: number; icon: string }) {
  return (
    <>
      <MxIcon name={icon} size={14} className="composer-island-seg-icon" aria-hidden="true" />
      <span className="composer-island-seg-word">{text}</span>
      <span className="composer-island-seg-num" data-count={count} aria-hidden="true" />
    </>
  );
}

/** Running work: one slowly pulsing dot (still under reduced motion). */
function JobsPulse() {
  return <span className="composer-island-pulse" aria-hidden="true" />;
}

/** Shows `flash` once per key for FLASH_MS. */
function useIslandFlash(flash: ComposerIslandFlash | null): ComposerIslandFlash | null {
  const [visible, setVisible] = useState<ComposerIslandFlash | null>(null);
  const shownKey = useRef('');
  useEffect(() => {
    if (!flash || flash.key === shownKey.current) return;
    shownKey.current = flash.key;
    setVisible(flash);
  }, [flash]);
  useEffect(() => {
    if (!visible) return undefined;
    const timer = window.setTimeout(() => setVisible(null), FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [visible]);
  return visible;
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
  for (const oldest of fitByRoom.keys()) {
    if (fitByRoom.size <= FIT_BY_ROOM_MAX) break;
    fitByRoom.delete(oldest);
  }
}

/** Swaps segment words for bare counts only when the full labels overflow the
 *  island's room. The room comes from the stage's ResizeObserver, whose first
 *  delivery lands after layout and before the first paint; the pill's
 *  full-label width is read only for content it has not laid out before. */
function useIslandFit(islandRef: RefObject<HTMLDivElement | null>, pillRef: RefObject<HTMLDivElement | null>) {
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
      for (const oldest of fullLabelWidths.keys()) {
        if (fullLabelWidths.size <= FULL_LABEL_WIDTHS_MAX) break;
        fullLabelWidths.delete(oldest);
      }
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
  return sessionId
    ? segmentAdvances.get(sessionId)?.[lastFit.includes('data-compact') ? 'compact' : 'full']
    : undefined;
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
  for (const oldest of recordedPillMarkup.keys()) {
    if (recordedPillMarkup.size <= RESTING_SLOT_HEIGHTS_MAX) break;
    recordedPillMarkup.delete(oldest);
  }
  const recorded = segmentAdvances.get(sessionId);
  const next = { ...recorded?.[form] };
  for (const kind of Object.keys(RESERVED_SEGMENTS) as IslandReservedSegment[]) {
    if (pill.querySelector(`[data-island-pending="${kind}"]`)) continue;
    const segment = pill.querySelector<HTMLElement>(RESERVED_SEGMENTS[kind]);
    const margin = segment ? Number.parseFloat(window.getComputedStyle(segment).marginInlineStart) || 0 : 0;
    next[kind] = segment ? segment.offsetWidth + margin : 0;
  }
  segmentAdvances.delete(sessionId);
  segmentAdvances.set(sessionId, { ...recorded, [form]: next });
  for (const oldest of segmentAdvances.keys()) {
    if (segmentAdvances.size <= RESTING_SLOT_HEIGHTS_MAX) break;
    segmentAdvances.delete(oldest);
  }
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
  for (const oldest of heights.keys()) {
    if (heights.size <= RESTING_SLOT_HEIGHTS_MAX) break;
    heights.delete(oldest);
  }
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

/**
 * Owns the slot's explicit height and data-presence. Content opens the slot
 * at once to the stage's real height; a change while open eases there
 * (data-motion carries the CSS transition, which reverses mid-flight on its
 * own). The last content leaving holds the slot for ISLAND_COLLAPSE_GRACE_MS,
 * then eases it to 0. Mount (a session switch remounts the island) and
 * reduced motion apply every change instantly; reduced motion turning on
 * mid-motion lands the slot at its target at once. The island's entry fade
 * (data-entry) is enabled only by content arriving, or the island changing
 * shape, after the first frame: a mounted island draws at its final state.
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

function useIslandSlotPresence(
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
      // shows the new content starts its fade; once set it stays.
      if (armed && content && (!carried || mode !== shape)) slot.setAttribute('data-entry', '');
      carried = content;
      shape = mode;
      if (content) {
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

/** An agent blocked on the user is marked for attention and never pulses;
 *  running agents pulse; a set that is only queued or waiting rests grey. */
function AgentMark({ working, needsUser = false }: { working: boolean; needsUser?: boolean }) {
  if (needsUser) return <MxIcon name="warning" size={14} className="composer-island-attention" aria-hidden="true" />;
  return <StateMark working={working} />;
}

/** Fixed-size mark slot: pulse and idle dot swap inside it without moving the pill. */
function StateMark({ working }: { working: boolean }) {
  return (
    <span className="composer-island-mark-slot" aria-hidden="true">
      {working ? <JobsPulse /> : <span className="composer-island-dot composer-island-dot-idle" />}
    </span>
  );
}

/** A jobs panel title's leading mark: agent activity, a live pulse while a
 *  shell runs, or an idle dot when only finished shells remain. */
function jobsTabMark(kind: JobKind, agents: IslandAgentRow[], runningShells: number): ReactNode {
  if (kind === 'agent') {
    return (
      <AgentMark
        working={agents.some(({ state }) => state === 'running' || state === 'cancel-unconfirmed')}
        needsUser={agents.some(({ state }) => state === 'needs-user')}
      />
    );
  }
  return <StateMark working={runningShells > 0} />;
}

function ShellJobItem({
  row,
  clock,
  stop,
  releasing,
  onStop,
  onDismiss,
}: {
  row: JobRow;
  clock: number;
  stop: ShellStopState;
  releasing: boolean;
  onStop: ComponentProps<typeof ShellRowButton>['onStop'];
  onDismiss(row: JobRow): void;
}) {
  return (
    <li className="composer-island-row" data-finished={row.finished ? 'true' : undefined}>
      <ShellJobContent row={row} clock={clock} stop={stop} releasing={releasing} />
      <ShellRowButton row={row} stop={stop} releasing={releasing} onStop={onStop} onDismiss={onDismiss} />
    </li>
  );
}

/** A jobs panel's header: its own title chip, optional state counts beside
 *  it, an optional header action, and the close button. */
function JobsPanelHead({
  mark,
  title,
  meta,
  action,
  onClose,
}: {
  mark: ReactNode;
  title: string;
  meta?: ReactNode;
  action?: ReactNode;
  onClose(): void;
}) {
  return (
    <div className="composer-island-phead">
      <span className="composer-island-tab" data-active="true">
        {mark}
        {title}
      </span>
      {meta ? <span className="composer-island-phead-meta">{meta}</span> : null}
      {action}
      <button
        type="button"
        className="composer-island-close"
        aria-label={t('Close')}
        title={t('Close')}
        onClick={onClose}
      >
        <MxIcon name="close-small" size={16} />
      </button>
    </div>
  );
}

/** The listed agents tallied by state, read by both the pill segment and the
 *  panel head. An agent waiting on its own tasks is still at work (its
 *  timer runs), so it counts as running; `waiting` is queued only; `idle` rests. */
function islandAgentCounts(agents: readonly IslandAgentRow[]) {
  const count = (...states: DesktopAgentActivityState[]) => agents.filter(({ state }) => states.includes(state)).length;
  return {
    running: count('running', 'waiting', 'cancel-unconfirmed'),
    needsUser: count('needs-user'),
    failed: count('failed'),
    waiting: count('queued'),
    idle: count('idle'),
  };
}

/** One attention state of the agents segment: its mark, then its words on a
 *  wide island or the bare count on a compact one. */
function IslandSegState({
  kind,
  mark,
  word,
  count,
}: {
  kind: DesktopAgentActivityState;
  mark: ReactNode;
  word: string;
  count: number;
}) {
  return (
    <span className="composer-island-seg-state" data-kind={kind}>
      {mark}
      <span className="composer-island-seg-word">{word}</span>
      <span className="composer-island-seg-num" data-count={count} aria-hidden="true" />
    </span>
  );
}

/** How many listed agents run, need the user, failed or wait: beside the title. */
function AgentsStateCounts({ agents }: { agents: IslandAgentRow[] }) {
  const { running, needsUser, failed, waiting: queued, idle } = islandAgentCounts(agents);
  const waiting = queued + idle;
  return (
    <>
      <span>
        {t('Island: Running')} <b>{statsCount(running)}</b>
      </span>
      {needsUser > 0 ? <span>{t('Needs you {{needs}}', { needs: needsUser })}</span> : null}
      {failed > 0 ? <span className="composer-island-failed">{t('{{failed}} failed', { failed })}</span> : null}
      {waiting > 0 ? <span>{t('Island: {{waiting}} waiting', { waiting })}</span> : null}
    </>
  );
}

/** Shown for a figure the ledger has not answered yet or cannot attribute
 *  exactly: never an invented zero. */
const SUMMARY_UNKNOWN = '-';
/** The widest figures the footer reserves room for, so a measured value lands
 *  in the box its "-" placeholder already holds. */
const SUMMARY_SAMPLE_TOKENS = 999_900_000;
const SUMMARY_SAMPLE_COST = 9_999.99;

/** One footer stat. Its box is sized by `reserve` (the same words with the
 *  widest figures, drawn invisibly by CSS), not by the live text, so the
 *  placeholder and the measured value wrap and measure alike. */
function SummaryStat({ reserve, children }: { reserve: string; children: ReactNode }) {
  return (
    <span className="composer-island-summary-stat" data-reserve={reserve}>
      <span>{children}</span>
    </span>
  );
}

/** The session's totals below the agent rows: the ledger's exact figures for
 *  the Lead and its listed agents. The three stats and the Lead/Agents split
 *  are laid out from the first render; a figure not yet measured, or one the
 *  ledger cannot attribute exactly, reads "-", never an estimate or a zero. */
function AgentsSummary({ usage }: { usage: IslandUsageSummary }) {
  const { totalTokens, leadTokens, agentTokens, cacheHitRate, costUsd } = usage;
  const splitKnown = totalTokens !== null && leadTokens !== null && agentTokens !== null;
  const split = (lead: string, agents: string) => `(${t('Lead {{lead}} · Agents {{agents}}', { lead, agents })})`;
  const sampleTokens = statsTokens(SUMMARY_SAMPLE_TOKENS);
  return (
    // biome-ignore lint/a11y/useSemanticElements: fieldset default border/padding/margin would change the styling.
    <div className="composer-island-summary" role="group" aria-label={t('Session usage')}>
      <SummaryStat reserve={`${t('Island: Total tokens')} ${sampleTokens} ${split(sampleTokens, sampleTokens)}`}>
        {t('Island: Total tokens')} <b>{totalTokens === null ? SUMMARY_UNKNOWN : statsTokens(totalTokens)}</b>{' '}
        <span className="composer-island-summary-split">
          {splitKnown
            ? split(statsTokens(leadTokens), statsTokens(agentTokens))
            : split(SUMMARY_UNKNOWN, SUMMARY_UNKNOWN)}
        </span>
      </SummaryStat>
      <SummaryStat reserve={`${t('Island: Cache hit rate')} ${statsPercent(1)}`}>
        {t('Island: Cache hit rate')} <b>{cacheHitRate === null ? SUMMARY_UNKNOWN : statsPercent(cacheHitRate)}</b>
      </SummaryStat>
      <SummaryStat reserve={`${t('Island: Approx. cost')} ${usageMoney(SUMMARY_SAMPLE_COST)}`}>
        {t('Island: Approx. cost')} <b>{costUsd === null ? SUMMARY_UNKNOWN : usageMoney(costUsd)}</b>
      </SummaryStat>
    </div>
  );
}

function AgentsPanel({
  sessionId,
  agents,
  usage,
  onClose,
  onOpenSession,
}: {
  sessionId: string;
  agents: IslandAgentRow[];
  usage: IslandUsageSummary;
  onClose(): void;
  onOpenSession?(sessionId: string, title: string, ownerSessionId: string): void;
}) {
  const clock = useClock(true);
  // The listed rows are already the tree flattened: each is judged on its own node.
  const clearable = agents.filter(({ node }) => clearableAgentNode(node)).map(({ node }) => node.agent);
  return (
    <section className="composer-island-panel" aria-label={t('Agents')}>
      <JobsPanelHead
        mark={jobsTabMark('agent', agents, 0)}
        title={t('Agent {{agent}}', { agent: agents.length })}
        meta={<AgentsStateCounts agents={agents} />}
        action={
          clearable.length > 0 ? (
            <button
              type="button"
              className="composer-island-button composer-island-phead-action"
              onClick={() => dismissFinishedAgentRows(clearable)}
            >
              {t('Clear finished')}
            </button>
          ) : undefined
        }
        onClose={onClose}
      />
      {/* The Agents window's own tree and row component; each row's own
          ledger total sits at its right edge. */}
      <div className="composer-island-pbody composer-island-jobs composer-island-agents schedules-list" role="tree">
        {agents.map(({ node, state, waitingForTasks }, index) => {
          const tokens = usage.agentRowTokens.get(node.sessionId);
          return (
            <div
              key={poolRowKey(node.agent, index)}
              className="composer-island-agent-item"
              role="none"
              data-tokens={tokens === undefined ? undefined : 'true'}
            >
              <AgentPoolRow
                agent={node.agent}
                clock={clock}
                stateOverride={state}
                waitingForTasks={waitingForTasks}
                depth={node.depth}
                parentSessionId={node.parentSessionId}
                posInSet={index + 1}
                setSize={agents.length}
                ownerSessionId={sessionId}
                onOpenSession={onOpenSession}
              />
              {tokens === undefined ? null : (
                <span className="composer-island-agent-tokens" aria-hidden="true">
                  {statsTokens(tokens)}
                </span>
              )}
            </div>
          );
        })}
      </div>
      <AgentsSummary usage={usage} />
    </section>
  );
}

function ShellsPanel({
  sessionId,
  shells,
  onClose,
  onDismiss,
  onDismissAll,
}: {
  sessionId: string;
  shells: JobRow[];
  onClose(): void;
  /** Hides a finished shell row for good. */
  onDismiss(row: JobRow): void;
  /** Hides every listed finished shell row for good. */
  onDismissAll(rows: JobRow[]): void;
}) {
  const clock = useClock(true);
  const { stopOf, releasingOf, stop } = useShellStops(sessionId);
  const runningShells = shells.filter((row) => !row.finished).length;
  const finished = shells.filter((row) => row.finished);
  return (
    <section className="composer-island-panel" aria-label={t('Background tasks')}>
      <JobsPanelHead
        mark={jobsTabMark('shell', [], runningShells)}
        title={runningShells > 0 ? t('Shell {{shell}}', { shell: runningShells }) : t('Shell')}
        meta={finished.length > 0 ? <span>{t('Island: Ended {{count}}', { count: finished.length })}</span> : undefined}
        action={
          finished.length > 0 ? (
            <button
              type="button"
              className="composer-island-button composer-island-phead-action"
              onClick={() => onDismissAll(finished)}
            >
              {t('Island: Close all')}
            </button>
          ) : undefined
        }
        onClose={onClose}
      />
      <ul className="composer-island-pbody composer-island-jobs">
        {shells.map((row) => (
          <ShellJobItem
            key={row.key}
            row={row}
            clock={clock}
            stop={stopOf(row)}
            releasing={releasingOf(row)}
            onStop={stop}
            onDismiss={onDismiss}
          />
        ))}
      </ul>
    </section>
  );
}

/** The session's shell rows with a job kept (as running) in the gap between
 *  the host dropping it from the running list and its finished record. */
function useShellRowsUntilFinished(sessionId: string, hostRows: JobRow[]): JobRow[] {
  const held = useRef({ sessionId, retention: EMPTY_SHELL_ROW_RETENTION });
  const [tick, setTick] = useState(0);
  // `tick` re-evaluates after the grace lapses.
  // biome-ignore lint/correctness/useExhaustiveDependencies: tick is the clock input
  const result = useMemo(() => {
    if (held.current.sessionId !== sessionId) held.current = { sessionId, retention: EMPTY_SHELL_ROW_RETENTION };
    const next = retainVanishedShellRows(held.current.retention, hostRows, Date.now());
    held.current.retention = next.retention;
    return next;
  }, [sessionId, hostRows, tick]);
  const { expiresAt } = result;
  useEffect(() => {
    if (!expiresAt) return undefined;
    const timer = setTimeout(() => setTick((value) => value + 1), Math.max(0, expiresAt - Date.now()) + 1);
    return () => clearTimeout(timer);
  }, [expiresAt]);
  return result.rows;
}

/** Dismisses each cleanly exited shell row SHELL_AUTO_DISMISS_MS after it
 *  finished (after it was first listed, when its finish time is unknown). */
function useAutoDismissShells(sessionId: string, rows: JobRow[]): void {
  const seen = useRef({ sessionId, at: new Map<string, number>() });
  const [tick, setTick] = useState(0);
  // `tick` re-evaluates once the next row's listing time is over.
  // biome-ignore lint/correctness/useExhaustiveDependencies: tick is the clock input
  useEffect(() => {
    if (!sessionId) return undefined;
    if (seen.current.sessionId !== sessionId) seen.current = { sessionId, at: new Map() };
    const now = Date.now();
    const at = seen.current.at;
    for (const row of rows) if (row.finished && !at.has(row.key)) at.set(row.key, now);
    const { keys, nextAt } = expiredShellRows(rows, now, (row) => at.get(row.key) ?? now);
    if (keys.length > 0) dismissShellJobs(sessionId, keys);
    if (!nextAt) return undefined;
    const timer = setTimeout(() => setTick((value) => value + 1), Math.max(0, nextAt - now) + 1);
    return () => clearTimeout(timer);
  }, [sessionId, rows, tick]);
}

/** The session's agent rows, finished ones included; polls the shared pool
 *  only while any of them is active. */
function useIslandAgentRows(sessionId: string): IslandAgentRow[] {
  const poolStore = useMemo(() => agentPoolStore(window.mixdogDesktop), []);
  // Rows the user cleared ("Clear finished") are not listed.
  const pool = useVisibleAgentPool(
    useSyncExternalStore(poolStore.subscribe, poolStore.getSnapshot, poolStore.getSnapshot)
  );
  const agentRows = useMemo(() => islandAgentRows(pool, sessionId), [pool, sessionId]);
  const hasActive = agentRows.some((row) => !row.finished);
  useEffect(() => {
    startAgentPool(poolStore);
    if (!hasActive) return undefined;
    return subscribeSharedPoll(poolStore, () => void refreshAgentPool(poolStore), AGENT_POOL_RECONCILE_MS);
  }, [hasActive, poolStore]);
  return agentRows;
}

/** The pill's agents segment: every agent of the session, finished ones
 *  included; the mark pulses while any runs or queues, rests idle once all
 *  finished, and what needs the user or waits is called out. */
function AgentsSegment({
  agents,
  expanded,
  onClick,
}: {
  agents: IslandAgentRow[];
  expanded: boolean;
  onClick(): void;
}) {
  const total = agents.length;
  const active = agents.filter((row) => !row.finished).length;
  const { running: working, waiting } = islandAgentCounts(agents);
  const title = [
    t('Agent {{agent}}', { agent: total }),
    active === 0 ? t('Done') : '',
    working > 0 ? `${t('Island: Running')} ${working}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <button
      type="button"
      className="composer-island-seg composer-island-seg-agents"
      data-finished={active === 0 ? 'true' : undefined}
      aria-expanded={expanded}
      title={title}
      onClick={onClick}
    >
      <IslandSegLabel text={t('Island: {{count}} agents', { count: total })} count={total} icon="agent" />
      <AgentMark working={working + waiting > 0} />
      {working > 0 && (
        <span className="composer-island-seg-states">
          <IslandSegState
            kind="running"
            mark={<span className="composer-island-dot" aria-hidden="true" />}
            word={`${t('Island: Running')} ${working}`}
            count={working}
          />
        </span>
      )}
    </button>
  );
}

/** The pill's shell segment counts running shells only. With only finished
 *  shells left (not yet dismissed) it reads "Shell", muted and without a
 *  number; with none it is gone. */
function ShellsSegment({
  runningCount,
  finishedCount,
  expanded,
  onClick,
}: {
  runningCount: number;
  finishedCount: number;
  expanded: boolean;
  onClick(): void;
}) {
  const live = runningCount > 0;
  if (!live && finishedCount === 0) return null;
  return (
    <button
      type="button"
      className="composer-island-seg composer-island-seg-shell"
      data-finished={live ? undefined : 'true'}
      aria-expanded={expanded}
      title={live ? t('Shell {{shell}}', { shell: runningCount }) : t('Shell')}
      onClick={onClick}
    >
      {live ? (
        <IslandSegLabel
          text={t('Island: {{count}} shells', { count: runningCount })}
          count={runningCount}
          icon="shell-prompt"
        />
      ) : (
        <>
          <MxIcon name="shell-prompt" size={14} className="composer-island-seg-icon" aria-hidden="true" />
          <span className="composer-island-seg-word">{t('Shell')}</span>
        </>
      )}
      <StateMark working={live} />
    </button>
  );
}

function QuotaPanelFrame({
  label,
  icon,
  title,
  note,
  children,
}: {
  label: string;
  icon: 'warning' | 'clock';
  title: string;
  note: string;
  children: ReactNode;
}) {
  return (
    <section className="composer-island-panel composer-island-quota" aria-label={label}>
      <div className="composer-island-pbody">
        <p className="composer-island-ptitle">
          <MxIcon name={icon} size={16} />
          {title}
        </p>
        <p className="composer-island-pnote">{note}</p>
        <div className="composer-island-pfoot">{children}</div>
      </div>
    </section>
  );
}

/** Time left until `resetAt`, refreshed once a minute; '' without a reset. */
export function useQuotaRemaining(resetAt: number | null): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (resetAt === null) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [resetAt]);
  return resetAt === null ? '' : quotaRemainingLabel(resetAt, now);
}

function ResumeRemaining({ resetAt }: { resetAt: number }) {
  return <>{useQuotaRemaining(resetAt)}</>;
}

function ResumePanel({ resume }: { resume: ComposerIslandQuotaResume }) {
  const time = quotaResetLabel(resume.resetAt);
  return (
    <QuotaPanelFrame
      label={t('Waiting to resume')}
      icon="clock"
      title={t('Resumes automatically at {{time}} in {{model}}', { time, model: resume.model })}
      note={t('{{remaining}} left. The reservation is kept even if you close and reopen the app.', {
        remaining: quotaRemainingLabel(resume.resetAt),
      })}
    >
      <button type="button" className="composer-island-button" onClick={resume.onCancel}>
        {t('Cancel resume')}
      </button>
    </QuotaPanelFrame>
  );
}

interface ComposerIslandProps {
  /** The pane's session ('' while hidden): background jobs read its lane. */
  sessionId: string;
  /** The route address the island is mounted (keyed) for; its resting slot
   *  height is remembered per address. Defaults to `sessionId`. */
  routeSessionId?: string;
  /** Opens an agent's session (same action as the Agents pane rows). */
  onOpenAgentSession?(sessionId: string, title: string, ownerSessionId: string): void;
  goal?: ReactNode;
  /** The changed-files segment: opens the side dock, or where the surface has
   *  none, expands into the turn's file list like the Goal tab. */
  files?: ReactNode;
  /** The branch segment (BranchIslandSegment), first of the git group after
   *  the divider; `locked` while the session has work running (no branch or
   *  worktree switch). */
  branch?: (locked: boolean) => ReactNode;
  /** The git action (IslandGitSegment), last in the pill. */
  git?: ReactNode;
  /** A running turn or command, or queued composer input. */
  workBusy?: boolean;
  /** The live tool approval card: the island grows into it. */
  approval?: ReactNode;
  flash?: ComposerIslandFlash | null;
  /** A waiting auto-resume: a pill segment that expands into its panel. */
  quotaResume?: ComposerIslandQuotaResume | null;
  /** The height of the dock chrome this island replaces at mount (the draft's
   *  context bar on its first submit): an empty island holds it instead of
   *  closing in that frame. Read once, at mount. */
  heldHeight?: number;
  /** The resting slot height of the island this one replaces in the same
   *  dock (a session switch). A session with no remembered height reserves
   *  it like a revisit: a first entry otherwise dropped the outgoing pill in
   *  the switch commit and reopened it once its segments had read their
   *  state, moving the composer and the end-pinned transcript down and back
   *  up. Read once, at mount. */
  carriedHeight?: number;
  /** The late segments' advances of the island this one replaces in the same
   *  dock; reserved like carriedHeight for a session with none remembered.
   *  Read once, at mount. */
  carriedAdvances?: Partial<IslandSegmentReserves>;
}

/**
 * The single island above a session's composer. Its slot takes the island's
 * real height in the dock while it carries something and eases between
 * heights (see useIslandSlotPresence); the transcript viewport above resizes
 * with it and the end pin keeps a following tail in place on every frame.
 * Memoised (sameIslandProps): its dock re-renders with every conversation
 * commit, a session switch several times.
 */
export const ComposerIsland = memo(function ComposerIsland({
  sessionId,
  routeSessionId = sessionId,
  goal,
  files,
  branch,
  git,
  workBusy = false,
  approval,
  flash,
  quotaResume,
  heldHeight = 0,
  carriedHeight = 0,
  carriedAdvances,
  onOpenAgentSession,
}: ComposerIslandProps) {
  const lane = useSessionLane(sessionId, defaultSessionLaneStore, desktopHeaderSnapshotsEqual, Boolean(sessionId));
  const snapshot = lane ?? EMPTY_SNAPSHOT;
  const dismissedShells = useDismissedShellJobs(sessionId);
  const hostJobRows = useMemo(() => backgroundJobRows(snapshot, dismissedShells), [snapshot, dismissedShells]);
  const jobRows = useShellRowsUntilFinished(sessionId, hostJobRows);
  useAutoDismissShells(sessionId, jobRows);
  const agentRows = useIslandAgentRows(sessionId);
  const shellRows = jobRows.filter((row) => !row.finished);
  const finishedShellCount = jobRows.filter((row) => row.finished).length;
  const shellCount = Math.max(Number(snapshot.shellJobs?.count) || 0, shellRows.length);
  // Finished shells keep the shells panel open-able until dismissed.
  const shellTotal = shellCount + finishedShellCount;
  // No branch or worktree switch while anything of the session still works.
  const locked = workBusy || shellCount > 0 || agentRows.some((row) => !row.finished);
  const [expanded, setExpanded] = useState<ComposerIslandTab>('');
  const toggle = (tab: 'agents' | 'shells') => setExpanded(expanded === tab ? '' : tab);
  const agentSessionIds = useMemo(() => agentRows.map(({ node }) => node.sessionId).filter(Boolean), [agentRows]);
  // Pool pushes and lane updates are the refresh cue; the hook throttles them.
  const usageRevision = useMemo(() => ({ agentRows, snapshot }), [agentRows, snapshot]);
  const sessionUsage = useIslandSessionUsage(sessionId, agentSessionIds, expanded === 'agents', usageRevision);
  const usageSummary = useMemo(
    () => islandUsageSummary(sessionUsage, agentSessionIds),
    [sessionUsage, agentSessionIds]
  );
  const islandRef = useRef<HTMLDivElement | null>(null);
  const pillRef = useRef<HTMLDivElement | null>(null);
  const slotRef = useRef<HTMLDivElement | null>(null);
  useIslandFit(islandRef, pillRef);
  const heldHeightRef = useRef(heldHeight);
  const carriedHeightRef = useRef(carriedHeight);
  const routeSessionIdRef = useRef(routeSessionId);
  routeSessionIdRef.current = routeSessionId;
  useIslandSlotPresence(slotRef, islandRef, heldHeightRef, routeSessionIdRef, carriedHeightRef);
  // Finished background work announces nothing: a flash per job would make
  // the island pop in and out.
  const visibleFlash = useIslandFlash(flash ?? null);

  // A tab whose content went away closes; a new session starts collapsed.
  useEffect(() => {
    if (expanded === 'agents' && agentRows.length === 0) setExpanded('');
    if (expanded === 'shells' && shellTotal === 0) setExpanded('');
    if (expanded === 'resume' && !quotaResume) setExpanded('');
  }, [expanded, quotaResume, agentRows.length, shellTotal]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId is the reset trigger
  useEffect(() => {
    setExpanded('');
  }, [sessionId]);
  // Outside press or Escape collapses the island's own tabs and the branch
  // and git tabs. The Goal and files tabs own their dismissal (they also
  // guard their dialogs and pickers).
  useEffect(() => {
    if (!['agents', 'shells', 'resume', 'branch', 'git'].includes(expanded)) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const island = islandRef.current;
      if (island && event.target instanceof Node && island.contains(event.target)) return;
      setExpanded('');
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded('');
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [expanded]);

  let mode = 'pill';
  if (approval) mode = 'approval';
  else if (visibleFlash) mode = 'flash';
  else if (expanded) mode = 'panel';
  const resumePanel = mode === 'panel' && expanded === 'resume' && Boolean(quotaResume);
  const agentsPanel = mode === 'panel' && expanded === 'agents' && agentRows.length > 0;
  const shellsPanel = mode === 'panel' && expanded === 'shells' && shellTotal > 0;
  const ownPanel = resumePanel || agentsPanel || shellsPanel;
  const [reserves] = useState<IslandSegmentReserves>(() => {
    const known = rememberedSegmentAdvances(routeSessionId) ?? carriedAdvances;
    return { branch: known?.branch ?? 0, files: known?.files ?? 0, git: known?.git ?? 0 };
  });
  const context = useMemo(() => ({ expanded, setExpanded, reserves }), [expanded, reserves]);

  return (
    <ComposerIslandContext.Provider value={context}>
      <div ref={slotRef} className="composer-island-slot" data-mode={mode}>
        <div className="composer-island-stage">
          <div ref={islandRef} className="composer-island" data-mode={mode} data-expanded={expanded || undefined}>
            {approval ? <div className="composer-island-approval">{approval}</div> : null}
            {mode === 'flash' && visibleFlash ? (
              <div className="composer-island-flash" role="status" key={visibleFlash.key}>
                <MxIcon name={visibleFlash.icon ?? 'check'} size={16} />
                <span>{visibleFlash.text}</span>
              </div>
            ) : null}
            <div
              ref={pillRef}
              className="composer-island-pill"
              hidden={mode === 'approval' || mode === 'flash' || ownPanel}
            >
              {quotaResume && (
                <button
                  type="button"
                  className="composer-island-seg composer-island-seg-warning"
                  aria-expanded={expanded === 'resume'}
                  onClick={() => setExpanded(expanded === 'resume' ? '' : 'resume')}
                >
                  <MxIcon name="clock" size={16} />
                  <span className="composer-island-seg-text">
                    {t('Resumes in {{model}} at {{time}}', {
                      model: quotaResume.model,
                      time: quotaResetLabel(quotaResume.resetAt),
                    })}
                  </span>
                  <span className="composer-island-seg-sub">
                    <ResumeRemaining resetAt={quotaResume.resetAt} />
                  </span>
                </button>
              )}
              {goal}
              {agentRows.length > 0 && (
                <AgentsSegment agents={agentRows} expanded={expanded === 'agents'} onClick={() => toggle('agents')} />
              )}
              <ShellsSegment
                runningCount={shellCount}
                finishedCount={finishedShellCount}
                expanded={expanded === 'shells'}
                onClick={() => toggle('shells')}
              />
              {/* Work (agents, shells) │ git (branch, files, git action); the
                  stylesheet shows the divider only between two groups. */}
              <span className="composer-island-divider" aria-hidden="true" />
              {branch?.(locked)}
              {files}
              {git}
            </div>
            {resumePanel && quotaResume ? <ResumePanel resume={quotaResume} /> : null}
            {shellsPanel && (
              <ShellsPanel
                sessionId={sessionId}
                shells={jobRows}
                onClose={() => setExpanded('')}
                onDismiss={(row) => dismissShellJobs(sessionId, [row.key])}
                onDismissAll={(rows) =>
                  dismissShellJobs(
                    sessionId,
                    rows.map((row) => row.key)
                  )
                }
              />
            )}
            {agentsPanel && (
              <AgentsPanel
                sessionId={sessionId}
                agents={agentRows}
                usage={usageSummary}
                onClose={() => setExpanded('')}
                onOpenSession={
                  onOpenAgentSession
                    ? (agentSessionId, title, owner) => {
                        onOpenAgentSession(agentSessionId, title, owner);
                        setExpanded('');
                      }
                    : undefined
                }
              />
            )}
          </div>
        </div>
      </div>
    </ComposerIslandContext.Provider>
  );
}, sameIslandProps);

/** The island's props are equal when everything it renders from is: the
 *  mount-only reserves (heldHeight, carriedHeight, carriedAdvances) are read
 *  once, at mount, so a later change of them renders nothing. */
function sameIslandProps(previous: ComposerIslandProps, next: ComposerIslandProps): boolean {
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]) as Set<keyof ComposerIslandProps>;
  for (const key of keys) {
    if (key === 'heldHeight' || key === 'carriedHeight' || key === 'carriedAdvances') continue;
    if (!Object.is(previous[key], next[key])) return false;
  }
  return true;
}

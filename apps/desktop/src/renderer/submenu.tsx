import {
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import { viewportRect } from './anchored-panel';
import { useMobileBack } from './mobile-back';

/** How long the pointer rests on an item before its submenu opens, or before
 *  a sibling it rests on takes over from the open submenu. */
export const SUBMENU_HOVER_DELAY = 200;
/** The safe zone's tip reaches this far back past the exit point, so a pointer
 *  that wobbles where it left the item still heads for the submenu. */
const SAFE_ZONE_SLACK = 4;
const SUBMENU_GAP = 4;
const SUBMENU_EDGE = 8;
/** What a submenu opened from the keyboard focuses first. */
const SUBMENU_FIRST_FOCUS = '[role^="menuitem"]:not(:disabled), input:not(:disabled)';
/** ArrowLeft there moves the caret or a slider, not out of the submenu. */
const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

type Point = { x: number; y: number };
type Box = { left: number; top: number; right: number; bottom: number };

/** The triangle the pointer may cross, over the sibling items, on its way from
 *  the point where it left an item into that item's open submenu: from the
 *  exit point to the submenu's near edge. Empty when the submenu covers the
 *  exit point's column (no side to head for). */
export function submenuSafeZone(exit: Point, panel: Box): Point[] {
  if (exit.x > panel.left && exit.x < panel.right) return [];
  const rightward = exit.x <= panel.left;
  const edge = rightward ? panel.left : panel.right;
  const tip = rightward ? exit.x - SAFE_ZONE_SLACK : exit.x + SAFE_ZONE_SLACK;
  return [
    { x: tip, y: exit.y },
    { x: edge, y: panel.top },
    { x: edge, y: panel.bottom },
  ];
}

export function pointInPolygon(point: Point, polygon: readonly Point[]): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const a = polygon[index];
    const b = polygon[previous];
    if (a.y > point.y !== b.y > point.y && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** A submenu beside its item: right of the parent menu, flipped left when only
 *  the left has room, otherwise shifted to stay on screen; its first row level
 *  with the item (`inset` is the panel's own top padding and border), moved up
 *  only as far as the bottom edge requires. */
export function submenuPosition(
  item: Box,
  menu: Box,
  size: { width: number; height: number },
  bounds: Box,
  inset = 0
): { left: number; top: number } {
  const right = menu.right + SUBMENU_GAP;
  const left = menu.left - SUBMENU_GAP - size.width;
  const fitsRight = right + size.width <= bounds.right - SUBMENU_EDGE;
  const fitsLeft = left >= bounds.left + SUBMENU_EDGE;
  const x = fitsRight || !fitsLeft ? Math.min(right, bounds.right - SUBMENU_EDGE - size.width) : left;
  const y = Math.min(item.top - inset, bounds.bottom - SUBMENU_EDGE - size.height);
  return {
    left: Math.round(Math.max(bounds.left + SUBMENU_EDGE, x)),
    top: Math.round(Math.max(bounds.top + SUBMENU_EDGE, y)),
  };
}

export interface SubmenuOptions<K extends string> {
  /** The menu itself is open: a closed one keeps no pending hover and opens no submenu. */
  menuOpen: boolean;
  /** Key of the item whose submenu is open. */
  openKey: K | null;
  open(key: K): void;
  close(): void;
  /** The open submenu's panel. */
  panel(): HTMLElement | null | undefined;
  /** False where the submenu would take the menu's place instead of opening
   *  beside it (a drilled pane): such items open on click or key. */
  hoverable?(key: K): boolean;
  /** Focuses inside a submenu opened from the keyboard; its first item by default. */
  focusPanel?(key: K): void;
  /** The item's element, where it is rendered anew while its submenu is open
   *  (a drilled pane replaces the rows); the element last used otherwise. */
  trigger?(key: K): HTMLElement | null | undefined;
}

export interface SubmenuItemProps {
  onPointerEnter(event: ReactPointerEvent<HTMLElement>): void;
  onPointerMove(event: ReactPointerEvent<HTMLElement>): void;
  onPointerLeave(event: ReactPointerEvent<HTMLElement>): void;
  onFocus(event: ReactFocusEvent<HTMLElement>): void;
}

export interface SubmenuTriggerProps extends SubmenuItemProps {
  'aria-haspopup': 'menu';
  'aria-expanded': boolean;
  onClick(event: ReactMouseEvent<HTMLElement>): void;
  onKeyDown(event: ReactKeyboardEvent<HTMLElement>): void;
}

const PLAIN = Symbol('plain item');

const pointOf = (event: { clientX: number; clientY: number }): Point => ({ x: event.clientX, y: event.clientY });

/** The pointer and keyboard grammar of one menu level's submenus. */
class SubmenuIntent<K extends string> {
  private hovered: K | typeof PLAIN | null = null;
  private hoveredElement: HTMLElement | null = null;
  private zone: Point[] | null = null;
  private timer: number | null = null;
  private pendingFocus: K | null = null;
  private watched: HTMLElement | null = null;
  private readonly elements = new Map<K, HTMLElement>();
  private readonly latest: { current: SubmenuOptions<K> };

  constructor(latest: { current: SubmenuOptions<K> }) {
    this.latest = latest;
  }

  /** Props of an item that opens a submenu. A disabled one behaves as a plain item. */
  trigger = (key: K, disabled = false): SubmenuTriggerProps => {
    const target = disabled ? PLAIN : key;
    return {
      'aria-haspopup': 'menu',
      'aria-expanded': this.latest.current.openKey === key,
      onPointerEnter: (event) => {
        this.elements.set(key, event.currentTarget);
        this.enter(target, event);
      },
      onPointerMove: this.move,
      onPointerLeave: (event) => this.leave(target, event),
      onFocus: (event) => {
        this.elements.set(key, event.currentTarget);
        this.focused(key);
      },
      onClick: (event) => {
        this.elements.set(key, event.currentTarget);
        // A click always opens: hover may have opened it already, and a toggle
        // would close the submenu under the very click aimed at it.
        if (!disabled) this.openNow(key, event.detail === 0);
      },
      onKeyDown: (event) => {
        if (event.key !== 'ArrowRight' || disabled) return;
        event.preventDefault();
        this.elements.set(key, event.currentTarget);
        this.openNow(key, true);
      },
    };
  };

  /** Props of a sibling item without a submenu: resting on it closes the open one. */
  item = (): SubmenuItemProps => ({
    onPointerEnter: (event) => this.enter(PLAIN, event),
    onPointerMove: this.move,
    onPointerLeave: (event) => this.leave(PLAIN, event),
    onFocus: () => this.focused(PLAIN),
  });

  /** Escape: closes the open submenu and returns focus to its item. */
  escape = (): boolean => {
    const key = this.latest.current.openKey;
    if (key === null) return false;
    this.cancel();
    this.latest.current.close();
    window.setTimeout(() => {
      const element = this.latest.current.trigger?.(key) ?? this.elements.get(key);
      if (element?.isConnected) element.focus({ preventScroll: true });
    }, 0);
    return true;
  };

  /** The element of the item that last opened (or was about to open) `key`. */
  element = (key: K): HTMLElement | null => this.elements.get(key) ?? null;

  settle(openKey: K | null): void {
    this.zone = null;
    // Closed by any route (Escape, a pick, back): a hover armed while it was
    // open must not open a sibling after it.
    if (openKey === null) this.cancel();
    const key = this.pendingFocus;
    this.pendingFocus = null;
    if (key !== null && key === openKey) this.focusInto(key);
  }

  /** The menu closed: its rows unmount without a pointerleave. */
  reset(): void {
    this.cancel();
    this.zone = null;
    this.hovered = null;
    this.hoveredElement = null;
    this.pendingFocus = null;
  }

  /** The open panel's own listeners: arriving in it ends the trip, and
   *  ArrowLeft steps back out. Native, so a portal rendered from inside the
   *  panel (a row's context menu) keeps its keys. */
  watchPanel(): void {
    const { openKey, panel } = this.latest.current;
    this.watch(openKey === null ? null : (panel() ?? null));
  }

  dispose(): void {
    this.cancel();
    this.watch(null);
  }

  private watch(next: HTMLElement | null): void {
    if (next === this.watched) return;
    this.watched?.removeEventListener('pointerover', this.arrived);
    this.watched?.removeEventListener('keydown', this.panelKeyDown);
    this.watched = next;
    next?.addEventListener('pointerover', this.arrived);
    next?.addEventListener('keydown', this.panelKeyDown);
  }

  private readonly arrived = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') return;
    this.cancel();
    this.zone = null;
    this.hovered = null;
  };

  private readonly panelKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'ArrowLeft' || (event.target as Element | null)?.closest?.(EDITABLE)) return;
    event.preventDefault();
    event.stopPropagation();
    this.escape();
  };

  private cancel(): void {
    if (this.timer === null) return;
    window.clearTimeout(this.timer);
    this.timer = null;
  }

  private arm(): void {
    this.cancel();
    this.timer = window.setTimeout(this.rest, SUBMENU_HOVER_DELAY);
  }

  /** The pointer rested: the item under it takes over. */
  private readonly rest = (): void => {
    this.timer = null;
    this.zone = null;
    const target = this.hovered;
    const { menuOpen, openKey, hoverable, open, close, panel } = this.latest.current;
    if (!menuOpen || target === null || target === openKey || !this.hoveredElement?.isConnected) return;
    if (target !== PLAIN && !(hoverable?.(target) ?? true)) return;
    // Focus inside the submenu that is going away follows the pointer instead
    // of falling back to the page.
    if (panel()?.contains(document.activeElement)) this.hoveredElement?.focus({ preventScroll: true });
    if (target === PLAIN) {
      if (openKey !== null) close();
      return;
    }
    open(target);
  };

  private enter(target: K | typeof PLAIN, event: ReactPointerEvent<HTMLElement>): void {
    if (event.pointerType === 'touch') return;
    this.hovered = target;
    this.hoveredElement = event.currentTarget;
    const { openKey } = this.latest.current;
    if (target === openKey) {
      this.cancel();
      this.zone = null;
      return;
    }
    if (this.zone && pointInPolygon(pointOf(event), this.zone)) {
      this.arm();
      return;
    }
    this.zone = null;
    if (target === PLAIN && openKey === null) {
      this.cancel();
      return;
    }
    this.arm();
  }

  /** Inside the safe zone every move restarts the wait: a sibling takes over
   *  only once the pointer rests there, or leaves the zone. */
  private readonly move = (event: ReactPointerEvent<HTMLElement>): void => {
    if (event.pointerType === 'touch' || !this.zone) return;
    if (!pointInPolygon(pointOf(event), this.zone)) this.zone = null;
    this.arm();
  };

  private leave(target: K | typeof PLAIN, event: ReactPointerEvent<HTMLElement>): void {
    if (event.pointerType === 'touch') return;
    if (this.hovered === target) this.hovered = null;
    if (target === PLAIN || target !== this.latest.current.openKey) return;
    const rect = this.latest.current.panel()?.getBoundingClientRect();
    this.zone = rect ? submenuSafeZone(pointOf(event), rect) : null;
  }

  /** Focus moving to another item of this menu (arrow keys) closes the open submenu. */
  private focused(target: K | typeof PLAIN): void {
    const { openKey, close } = this.latest.current;
    if (openKey === null || openKey === target) return;
    this.cancel();
    this.zone = null;
    close();
  }

  private openNow(key: K, fromKeyboard: boolean): void {
    this.cancel();
    this.zone = null;
    if (this.latest.current.openKey === key) {
      if (fromKeyboard) this.focusInto(key);
      return;
    }
    this.pendingFocus = fromKeyboard ? key : null;
    this.latest.current.open(key);
  }

  private focusInto(key: K): void {
    const { focusPanel, panel } = this.latest.current;
    if (focusPanel) focusPanel(key);
    else panel()?.querySelector<HTMLElement>(SUBMENU_FIRST_FOCUS)?.focus({ preventScroll: true });
  }
}

export type Submenu<K extends string> = Pick<SubmenuIntent<K>, 'trigger' | 'item' | 'escape' | 'element'>;

/** One menu level's submenus, opened the desktop way: resting on an item
 *  opens its submenu after SUBMENU_HOVER_DELAY; while the pointer travels from
 *  the item toward the open submenu across its siblings (the safe zone) the
 *  submenu stays; resting on a sibling hands over to that sibling's submenu,
 *  or closes it; leaving the menu closes nothing. Click or tap opens at once;
 *  ArrowRight, Enter or Space opens and focuses the submenu, ArrowLeft and
 *  Escape (the owner's dismiss handler calls `escape`) return to the item. */
export function useSubmenu<K extends string>(options: SubmenuOptions<K>): Submenu<K> {
  const latest = useRef(options);
  latest.current = options;
  const [intent] = useState(() => new SubmenuIntent<K>(latest));
  const { menuOpen, openKey } = options;
  useEffect(() => intent.settle(openKey), [intent, openKey]);
  useEffect(() => {
    if (!menuOpen) intent.reset();
  }, [intent, menuOpen]);
  useEffect(() => intent.watchPanel());
  useEffect(() => () => intent.dispose(), [intent]);
  // ABB: hardware back closes the submenu before the menu under it.
  useMobileBack(menuOpen && openKey !== null, () => latest.current.close());
  return intent;
}

function placeSubmenu(panel: HTMLElement | null, anchor: HTMLElement | null): void {
  const menu = anchor?.isConnected ? anchor.closest('[role="menu"]') : null;
  if (!panel || !anchor || !menu) return;
  const bounds = viewportRect();
  panel.style.maxHeight = `${Math.max(0, bounds.height - SUBMENU_EDGE * 2)}px`;
  const style = window.getComputedStyle(panel);
  const inset = (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.borderTopWidth) || 0);
  const { left, top } = submenuPosition(
    anchor.getBoundingClientRect(),
    menu.getBoundingClientRect(),
    { width: panel.offsetWidth, height: panel.offsetHeight },
    bounds,
    inset
  );
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
}

/** A submenu panel beside its item (submenuPosition), portaled like its menu
 *  and placed again after every render. Its keys stay inside it: the menu's
 *  roving handler runs on this panel's own items. */
export function SubmenuPanel({
  anchor,
  panelRef,
  className,
  label,
  onKeyDown,
  children,
}: {
  anchor: HTMLElement | null;
  panelRef: RefObject<HTMLDivElement | null>;
  className: string;
  label: string;
  onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void;
  children: ReactNode;
}) {
  useLayoutEffect(() => placeSubmenu(panelRef.current, anchor));
  return createPortal(
    <div
      ref={panelRef}
      className={className}
      role="menu"
      aria-label={label}
      onKeyDown={(event) => {
        onKeyDown(event);
        event.stopPropagation();
      }}
    >
      {children}
    </div>,
    document.body
  );
}

import { startTransition, type ReactNode } from 'react';
import type { Root } from 'react-dom/client';

const pendingSurfaceRenders = new WeakMap<Root, number>();

/** Renders a persistent surface's own root; on the phone from the next frame
 *  as a transition (the newest element of a frame wins), so the sheet and the
 *  placed container paint before the tree. */
export function renderSurfaceRoot(root: Root, element: ReactNode): void {
  if (!document.documentElement.hasAttribute('data-mixdog-mobile-tabs')) {
    root.render(element);
    return;
  }
  dropPendingSurfaceRender(root);
  pendingSurfaceRenders.set(
    root,
    window.requestAnimationFrame(() => {
      pendingSurfaceRenders.delete(root);
      startTransition(() => root.render(element));
    })
  );
}

/** Unmounts a persistent surface's root, dropping a render still queued for it. */
export function unmountSurfaceRoot(root: Root): void {
  dropPendingSurfaceRender(root);
  root.unmount();
}

function dropPendingSurfaceRender(root: Root): void {
  const frame = pendingSurfaceRenders.get(root);
  if (frame === undefined) return;
  window.cancelAnimationFrame(frame);
  pendingSurfaceRenders.delete(root);
}

/** The visible slot a persistent surface (terminal, browser) should follow: the
 *  foreground active slot, else the first active one. */
export function preferredSurfaceSlot<Slot extends { active: boolean; foreground: boolean; exiting?: boolean }>(
  slots: ReadonlyMap<HTMLDivElement, Slot>
): [HTMLDivElement, Slot] | null {
  const active = [...slots].filter(([, slot]) => slot.active);
  return active.find(([, slot]) => slot.foreground) ?? active.find(([, slot]) => !slot.exiting) ?? active[0] ?? null;
}

/** Only a surface shown over an open slot is interactive; a parked or
 *  `exiting` one is inert and aria-hidden with focus inside released, so Tab
 *  never reaches it. */
export function applySurfaceInteractivity(container: HTMLElement, interactive: boolean): void {
  if (interactive) {
    container.removeAttribute('inert');
    container.removeAttribute('aria-hidden');
    return;
  }
  container.setAttribute('inert', '');
  container.setAttribute('aria-hidden', 'true');
  const focused = container.ownerDocument.activeElement;
  if (focused instanceof HTMLElement && container.contains(focused)) focused.blur();
}

type SurfaceRect = { left: number; top: number; width: number; height: number };

/** Pins a fixed surface container over `rect` (viewport coordinates). The phone
 *  body follows the visual viewport through `transform` (mobile-web-runtime.css),
 *  which makes it the containing block of fixed descendants, so its origin is
 *  taken out of the coordinates. */
export function placeFixedSurface(container: HTMLElement, rect: SurfaceRect, slot?: HTMLElement): void {
  const doc = container.ownerDocument;
  const phone = doc.documentElement.hasAttribute('data-mixdog-mobile-tabs');
  const origin = phone ? doc.body.getBoundingClientRect() : { left: 0, top: 0 };
  const slideOffset = phone && slot ? followSheetSlide(container, slot) : 0;
  // Mid-slide, the offset taken out leaves float noise that would re-lay the
  // surface out every frame; the settled slot sits on a whole pixel.
  const left = slideOffset ? Math.round(rect.left - slideOffset) : rect.left;
  container.style.left = `${left - origin.left}px`;
  container.style.top = `${rect.top - origin.top}px`;
  container.style.width = `${rect.width}px`;
  container.style.height = `${rect.height}px`;
}

const SHEET_SLIDE_FOLLOW_ID = 'mx-sheet-slide-follow';

/** Runs a copy of the sheet's running `transform` transition on the container,
 *  started with it, so the surface moves on the compositor with the sheet
 *  instead of chasing the slot's rect from the main thread. Returns the
 *  sheet's current horizontal offset. */
function followSheetSlide(container: HTMLElement, slot: HTMLElement): number {
  const sheet = slot.closest<HTMLElement>('.pane-side-dock[data-open="true"]');
  const view = container.ownerDocument.defaultView;
  if (!sheet || !view || typeof sheet.getAnimations !== 'function') return 0;
  const slide = sheet
    .getAnimations()
    .find(
      (animation) =>
        (animation as CSSTransition).transitionProperty === 'transform' && animation.playState === 'running'
    );
  const follow = container.getAnimations().find((animation) => animation.id === SHEET_SLIDE_FOLLOW_ID);
  if (slide?.effect instanceof view.KeyframeEffect && follow?.startTime !== slide.startTime) {
    follow?.cancel();
    const copy = container.animate(slide.effect.getKeyframes(), slide.effect.getTiming() as KeyframeAnimationOptions);
    copy.id = SHEET_SLIDE_FOLLOW_ID;
    // A slide still pending its start time starts with the copy, in the same frame.
    if (slide.startTime !== null) copy.startTime = slide.startTime;
  }
  const transform = view.getComputedStyle(sheet).transform;
  return transform && transform !== 'none' ? new view.DOMMatrixReadOnly(transform).m41 : 0;
}

function restoreDockHeader(header: HTMLElement): void {
  delete header.dataset.surfaceExpanded;
  header.style.removeProperty('left');
  header.style.removeProperty('top');
  header.style.removeProperty('width');
}

/** The main panel's content box for an expanded surface. On desktop the frame
 *  is a 1px border (left only with the sidebar folded), a constant because
 *  computed style is read before expanding flips which element draws it. */
const EXPANDED_FRAME_WIDTH = 1;
export function expandedSheetBounds(panelNode: Element): { left: number; top: number; width: number; bottom: number } {
  const bounds = panelNode.getBoundingClientRect();
  const view = panelNode.ownerDocument.defaultView;
  const framed =
    !panelNode.ownerDocument.documentElement.hasAttribute('data-mixdog-mobile-tabs') &&
    view?.matchMedia?.('(min-width: 761px)').matches === true;
  if (!framed) return { left: bounds.left, top: bounds.top, width: bounds.width, bottom: bounds.bottom };
  const left = panelNode.closest('.app-shell')?.classList.contains('sidebar-collapsed') ? EXPANDED_FRAME_WIDTH : 0;
  return {
    left: bounds.left + left,
    top: bounds.top + EXPANDED_FRAME_WIDTH,
    width: bounds.width - left - EXPANDED_FRAME_WIDTH,
    bottom: bounds.bottom - EXPANDED_FRAME_WIDTH,
  };
}

/** Geometry of an expanded in-flow dock (file, diff, Changes): the whole main
 *  panel, same box and sheet gaps as an expanded browser/terminal. */
export function expandedDockRect(host: Element | null): SurfaceRect | undefined {
  const panelNode = host?.closest('.main-panel');
  if (!panelNode) return undefined;
  const panel = expandedSheetBounds(panelNode);
  return { left: panel.left, top: panel.top, width: panel.width, height: panel.bottom - panel.top };
}

/** An expanded surface fills the main panel below its side dock header, and
 *  the header itself widens across the same panel so its title and X span the
 *  enlarged surface. `owner.header` remembers the widened header so collapse,
 *  parking or a dock switch restores it. Returns undefined when not expanded. */
export function expandedSurfaceRect(
  slot: HTMLElement | undefined,
  expanded: boolean,
  owner: { header: HTMLElement | null }
): SurfaceRect | undefined {
  const panelNode = expanded ? slot?.closest('.main-panel') : null;
  const header = panelNode
    ? (slot?.closest('.pane-side-dock')?.querySelector<HTMLElement>(':scope > .pane-side-dock-header') ?? null)
    : null;
  if (owner.header && owner.header !== header) restoreDockHeader(owner.header);
  owner.header = header;
  if (!panelNode) return undefined;
  const panel = expandedSheetBounds(panelNode);
  let top = panel.top;
  if (header) {
    if (header.dataset.surfaceExpanded !== 'true') {
      header.style.top = `${header.getBoundingClientRect().top}px`;
      header.dataset.surfaceExpanded = 'true';
    }
    header.style.left = `${panel.left}px`;
    header.style.width = `${panel.width}px`;
    top = Math.max(panel.top, header.getBoundingClientRect().bottom);
  }
  return { left: panel.left, top, width: panel.width, height: panel.bottom - top };
}

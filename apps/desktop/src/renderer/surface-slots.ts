import { startTransition, type ReactNode } from 'react';
import type { Root } from 'react-dom/client';

const pendingSurfaceRenders = new WeakMap<Root, number>();

/** Renders a persistent surface's own root. The slot registers in the dock's
 *  layout effect, so a plain render flushed the whole terminal/browser tree
 *  synchronously inside the tap's commit, and a browser opened from the header
 *  rendered its root ahead of the app's own transition: the phone sheet's
 *  first frame waited for either. The phone renders it from the next frame as
 *  a transition instead (the newest element of a frame wins), so the sheet and
 *  the surface's placed container paint first, the tree right after. */
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

/** A persistent surface's semantics, applied to its own container in the
 *  commit that places or parks it (its root renders later on the phone,
 *  renderSurfaceRoot). Only a surface shown over an open slot is interactive.
 *  A parked one (off screen or beneath the UI) and one whose sheet is sliding
 *  closed (`exiting`, its pixels kept) are inert and aria-hidden with focus
 *  inside let go, so Tab never reaches them; a genuine reopen restores it. */
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

/** Pins a fixed surface container over `rect` (viewport coordinates). The
 *  phone body follows the visual viewport through `transform`
 *  (mobile-web-runtime.css), which makes it the containing block of every
 *  fixed descendant: viewport coordinates written as-is applied the body's
 *  offset a second time once the visual viewport panned (keyboard, pinch),
 *  shifting the terminal/browser body off the sheet header. */
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

/** The phone sheet slides in through a compositor `transform` transition, and
 *  a fixed surface over its slot used to chase the slot's rect frame by frame
 *  from the main thread: every step was a layout shift, the surface lagged the
 *  sheet behind each long task, and a terminal focused while still half
 *  off-screen panned the visual viewport. The surface now sits at the slot's
 *  settled rect (the slide's current offset taken out) and runs the sheet's
 *  own transition as a copy started at the same time, so both move as one
 *  layer. Returns the sheet's current horizontal offset. */
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

/** The main panel's CONTENT box for an expanded surface. Desktop: the panel's
 *  frame is one 1px border on top, right and bottom (plus the left when the
 *  sidebar is folded; with it open the left panel's border is the divider).
 *  The frame is a constant here, NOT read from computed style: expanding the
 *  dock flips the panel from "cells draw the frame" back to "panel draws it",
 *  and a rect measured before that flip covered the border pixels. Fixed and
 *  native surfaces paint above the DOM, so they must stay inside the frame. */
export const EXPANDED_FRAME_WIDTH = 1;
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

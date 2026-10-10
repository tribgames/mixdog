/** The visible slot a persistent surface (terminal, browser) should follow: the
 *  foreground active slot, else the first active one. */
export function preferredSurfaceSlot<Slot extends { active: boolean; foreground: boolean }>(
  slots: ReadonlyMap<HTMLDivElement, Slot>
): [HTMLDivElement, Slot] | null {
  const active = [...slots].filter(([, slot]) => slot.active);
  return active.find(([, slot]) => slot.foreground) ?? active[0] ?? null;
}

type SurfaceRect = { left: number; top: number; width: number; height: number };

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

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
  const panel = panelNode.getBoundingClientRect();
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

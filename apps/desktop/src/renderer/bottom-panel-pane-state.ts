export function bottomPanelOpenForPane(
  openPaneIds: ReadonlySet<string>,
  paneId: string,
): boolean {
  return Boolean(paneId) && openPaneIds.has(paneId);
}

export function setBottomPanelPaneOpen(
  openPaneIds: ReadonlySet<string>,
  paneId: string,
  open: boolean,
): ReadonlySet<string> {
  if (!paneId || openPaneIds.has(paneId) === open) return openPaneIds;
  const next = new Set(openPaneIds);
  if (open) next.add(paneId);
  else next.delete(paneId);
  return next;
}

export function restoreBottomPanelOpenPaneIds(
  record: Record<string, unknown>,
  activePaneId: string,
): ReadonlySet<string> {
  if (Array.isArray(record.openPaneIds)) {
    return new Set(record.openPaneIds
      .filter((value): value is string => typeof value === "string" && Boolean(value))
      .slice(0, 100));
  }
  return record.open === true && activePaneId
    ? new Set([activePaneId])
    : new Set();
}

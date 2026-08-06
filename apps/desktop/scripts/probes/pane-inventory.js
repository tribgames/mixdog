// Which pane is which (diagnosis helper for the pane-submit probe).
(() => {
  const areas = [...document.querySelectorAll('textarea')]
    .filter((element) => element.closest('.pane-chat-surface') && element.getClientRects().length > 0);
  return areas.map((element, index) => {
    const cell = element.closest('.pane-cell');
    const leaf = element.closest('.pane-leaf');
    const tabs = [...(leaf?.querySelectorAll('[role="tab"], .workspace-tab, [class*="tab-label"]') || [])]
      .map((node) => node.textContent?.trim().slice(0, 30))
      .filter(Boolean)
      .slice(0, 6);
    const items = leaf?.querySelectorAll('[data-item-kind], .transcript-item, .timeline-item').length ?? 0;
    return {
      index,
      focused: Boolean(cell?.className.includes('is-focused')),
      cellClass: cell?.className || '(no cell)',
      tabs,
      transcriptItems: items,
    };
  });
})()

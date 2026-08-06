// Why a foreground pane paints nothing (diagnosis).
(() => {
  const leaves = [...document.querySelectorAll('.pane-leaf')];
  return leaves.map((leaf, index) => {
    const cell = leaf.closest('.pane-cell');
    const tabs = [...leaf.querySelectorAll('[role="tab"], [class*="tab"]')]
      .map((node) => ({
        text: node.textContent?.trim().slice(0, 24) || '',
        active: node.getAttribute('aria-selected') === 'true' || node.className.includes('active'),
      }))
      .filter((tab) => tab.text)
      .slice(0, 6);
    const surface = leaf.querySelector('.pane-chat-surface');
    const items = surface?.querySelectorAll('[data-item-kind], .transcript-item, .timeline-item').length ?? 0;
    const withSessionAttr = [...leaf.querySelectorAll('[data-session-id], [data-session]')]
      .map((node) => node.getAttribute('data-session-id') || node.getAttribute('data-session'))
      .filter(Boolean)
      .slice(0, 3);
    const composer = leaf.querySelector('textarea');
    const routeLabel = [...leaf.querySelectorAll('button')]
      .map((node) => node.textContent?.trim() || '')
      .find((text) => text.includes('Opus') || text.includes('모델') || text.includes('Claude')) || '';
    return {
      index,
      focused: Boolean(cell?.className.includes('is-focused')),
      tabs,
      items,
      sessionAttrs: withSessionAttr,
      routeLabel,
      placeholder: composer?.placeholder || '',
      emptyState: Boolean(surface?.textContent?.trim().length === 0),
    };
  });
})()

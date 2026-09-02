(async () => {
  const visible = (element) => element instanceof HTMLElement
    && element.getClientRects().length > 0;
  const trigger = document.querySelector(
    '.browser-pane-viewport-control .mx-select-trigger',
  );
  const viewport = document.querySelector('.browser-pane-viewport');
  return {
    title: document.title,
    viewportPreset: viewport?.getAttribute('data-viewport-preset') || null,
    trigger: trigger ? {
      ariaLabel: trigger.getAttribute('aria-label'),
      width: Math.round(trigger.getBoundingClientRect().width),
      text: trigger.textContent?.trim() || '',
    } : null,
    visibleButtons: [...document.querySelectorAll('button')]
      .filter(visible)
      .slice(0, 120)
      .map((button) => ({
        ariaLabel: button.getAttribute('aria-label') || '',
        title: button.getAttribute('title') || '',
        text: button.textContent?.trim().replace(/\s+/g, ' ').slice(0, 120) || '',
      })),
  };
})()

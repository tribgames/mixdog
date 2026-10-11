// Reports each composer attachment card's thumbnail frame inset relative to its card.
(() =>
  [...document.querySelectorAll('.attachment-card')].map((card) => {
    const c = card.getBoundingClientRect();
    const frame = card.querySelector('img, svg, [class*="paper"], [class*="minimap"]');
    const f = frame ? frame.getBoundingClientRect() : null;
    return {
      name: card.getAttribute('data-tooltip'),
      frame: frame ? (frame.className?.baseVal ?? frame.className) : null,
      left: f ? Math.round(f.left - c.left) : null,
      right: f ? Math.round(c.right - f.right) : null,
      top: f ? Math.round(f.top - c.top) : null,
    };
  }))();

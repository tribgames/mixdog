// Built-in feature cards currently rendered in Settings / Extensions (id and
// visible text), or a note when that panel is not open.
// Opens the Extensions view from the activity bar first when it is not shown.
(async () => {
  const read = () => [...document.querySelectorAll('[data-built-in-feature]')].map((node) => ({
    id: node.getAttribute('data-built-in-feature'),
    text: node.textContent?.trim().slice(0, 140),
  }));
  if (!read().length) {
    const open = [...document.querySelectorAll('button')].find((b) => ['익스텐션', 'Extensions'].includes(b.getAttribute('aria-label') || ''));
    open?.click();
    await new Promise((r) => setTimeout(r, 1500));
  }
  const cards = read();
  return cards.length ? cards : { open: false, note: 'Built-in features panel is not rendered' };
})()

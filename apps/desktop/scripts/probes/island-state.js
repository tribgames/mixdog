// Composer island: slot geometry, visible segments and the dock stack order.
(() => {
  const rect = (el) =>
    el
      ? (({ top, height, width }) => ({ top: Math.round(top), height: Math.round(height), width: Math.round(width) }))(
          el.getBoundingClientRect()
        )
      : null;
  const docks = [...document.querySelectorAll('.composer-region')].filter((el) => el.getClientRects().length);
  return docks.map((dock) => ({
    dock: rect(dock),
    children: [...dock.children].map((c) => c.className.toString().split(' ')[0]),
    slot: rect(dock.querySelector('[class*="composer-island-slot"], [class*="island-slot"]')),
    island: dock.querySelector('[class*="composer-island"]')?.className?.toString() || null,
    segments: [...dock.querySelectorAll('[class*="composer-island-seg"]')].map((s) => s.textContent.trim()),
    tray: rect(dock.querySelector('.queue-list, [class*="queue-tray"]')),
    composer: rect(dock.querySelector('form.composer')),
    contextBar: Boolean(dock.querySelector('.composer-context-bar')),
  }));
})();

// With the model picker open: opens its model submenu and clicks the entry whose
// text contains window.__probeModel; returns the submenu entries and the picker label.
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = () => [...document.querySelectorAll('[role="menuitem"], [role="option"], [role="menuitemradio"]')].filter((n) => n.getClientRects().length > 0);
  if (!visible().length) {
    [...document.querySelectorAll('button[aria-label="모델 선택"]')].find((b) => b.getClientRects().length > 0)?.click();
    await wait(600);
  }
  const modelRow = visible().find((n) => n.textContent?.trim().startsWith('모델'));
  if (!modelRow) return { ok: false, reason: 'picker not open' };
  modelRow.click();
  await wait(600);
  const entries = visible().map((n) => n.textContent?.trim().slice(0, 60));
  const target = window.__probeModel && visible().find((n) => n.textContent?.includes(window.__probeModel));
  if (target) {
    target.click();
    await wait(800);
  }
  const picker = [...document.querySelectorAll('button[aria-label="모델 선택"]')].find((b) => b.getClientRects().length > 0);
  return { ok: Boolean(target), entries, picker: picker?.textContent?.trim() };
})()

// Opens the model picker's model submenu and lists its entries, then closes it.
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = () =>
    [...document.querySelectorAll('[role="menuitem"], [role="option"], [role="menuitemradio"]')].filter(
      (n) => n.getClientRects().length > 0
    );
  const picker = [...document.querySelectorAll('button[aria-label="모델 선택"]')].find(
    (b) => b.getClientRects().length > 0
  );
  picker?.click();
  await wait(600);
  const modelRow = visible().find((n) => n.textContent?.trim().startsWith('모델'));
  modelRow?.click();
  await wait(600);
  const entries = visible().map((n) => n.textContent?.trim().slice(0, 60));
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await wait(200);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  return { picker: picker?.textContent?.trim(), entries };
})();

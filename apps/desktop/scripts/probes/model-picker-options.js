// Opens a new task tab, opens the composer's model picker and lists its options.
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const plus = [...document.querySelectorAll('button[aria-label="새 작업"]')].find((b) => !b.textContent?.trim());
  plus?.click();
  await wait(800);
  const picker = [...document.querySelectorAll('button[aria-label="모델 선택"]')].find((b) => b.getClientRects().length > 0);
  if (!picker) return { ok: false, reason: 'no model picker' };
  picker.click();
  await wait(600);
  const options = [...document.querySelectorAll('[role="menuitem"], [role="option"], [role="menuitemradio"]')]
    .filter((n) => n.getClientRects().length > 0)
    .map((n) => n.textContent?.trim().slice(0, 60));
  return { ok: true, picker: picker.textContent?.trim(), options };
})()

// Sends window.__probeText through the visible chat composer (no OS input) and
// waits up to 240 s for one more completed-turn status row; returns that row.
(async () => {
  const text = window.__probeText;
  const findArea = () => [...document.querySelectorAll('textarea')].find((el) => el.getClientRects().length > 0 && !el.disabled);
  // The composer is briefly absent while the page re-renders after a reload.
  for (let i = 0; i < 20 && !findArea(); i++) await new Promise((r) => setTimeout(r, 1000));
  const area = findArea();
  if (!text || !area) return { ok: false, reason: !text ? 'no __probeText' : 'no composer' };
  const done = () => document.querySelectorAll('.turn-status.complete').length;
  const before = done();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  area.focus();
  setter.call(area, text);
  area.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 300));
  area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
  const startedAt = Date.now();
  while (done() <= before && Date.now() - startedAt < 240000) await new Promise((r) => setTimeout(r, 1000));
  const rows = [...document.querySelectorAll('.turn-status.complete')].map((n) => n.textContent?.trim());
  return { ok: done() > before, ms: Date.now() - startedAt, status: rows.at(-1) };
})()

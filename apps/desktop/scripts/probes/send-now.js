// Types window.__probeText into the visible composer and presses Enter without
// waiting for the turn (a busy turn queues it as a follow-up).
(async () => {
  const text = window.__probeText;
  const findArea = () =>
    [...document.querySelectorAll('textarea')].find((el) => el.getClientRects().length > 0 && !el.disabled);
  for (let i = 0; i < 20 && !findArea(); i++) await new Promise((r) => setTimeout(r, 500));
  const area = findArea();
  if (!text || !area) return { ok: false, reason: !text ? 'no __probeText' : 'no composer' };
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  area.focus();
  setter.call(area, text);
  area.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 300));
  area.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
    })
  );
  return { ok: true };
})();

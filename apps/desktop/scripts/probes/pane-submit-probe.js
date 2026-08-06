// Live pane-submit probe (diagnosis): types into the LAST visible pane
// composer, presses Enter, and reports what the surface did with it.
//   node scripts/dom-eval.mjs --port=9342 scripts/probes/pane-submit-probe.js
(async () => {
  // The composer label is localized, so anchor on the pane chat surface.
  const areas = [...document.querySelectorAll('textarea')]
    .filter((element) => element.closest('.pane-chat-surface') && element.getClientRects().length > 0);
  const cellOf = (element) => element.closest('.pane-cell');
  const describe = (element) => {
    const cell = cellOf(element);
    const tab = cell?.querySelector('[class*="tab"][class*="active"], [aria-selected="true"]');
    return {
      focused: Boolean(cell?.className.includes('is-focused')),
      tab: tab?.textContent?.trim().slice(0, 40) || '',
      disabled: element.disabled,
    };
  };
  if (!areas.length) return { ok: false, reason: 'no visible composer' };
  // Reproduce the report: a pane the user is NOT focused on, showing an
  // EXISTING session (a draft pane takes the materialization path instead).
  const activeTabText = (element) => {
    const leaf = element.closest('.pane-leaf');
    const tab = leaf?.querySelector('[role="tab"][aria-selected="true"], .workspace-tab.is-active');
    return (tab?.textContent || leaf?.querySelector('[role="tab"]')?.textContent || '').trim();
  };
  const background = areas.filter((element) => !cellOf(element)?.className.includes('is-focused'));
  const target = background.find((element) => activeTabText(element)
      && !activeTabText(element).startsWith('New task'))
    || background[0]
    || areas[areas.length - 1];
  const text = `probe-${Date.now()}`;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  target.focus();
  setter.call(target, text);
  target.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 300));
  const beforeValue = target.value;
  target.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true,
  }));
  await new Promise((resolve) => setTimeout(resolve, 4000));
  const alerts = [...document.querySelectorAll('[role="alert"], .toast, .error-banner, .surface-error')]
    .map((node) => node.textContent?.trim())
    .filter(Boolean);
  const painted = [...document.querySelectorAll('.transcript-item, .timeline-item, [data-item-kind="user"]')]
    .map((node) => node.textContent || '')
    .filter((value) => value.includes(text)).length;
  return {
    ok: true,
    composers: areas.length,
    target: describe(target),
    sent: text,
    beforeValue,
    afterValue: target.value,
    restored: target.value.includes(text),
    painted,
    alerts,
  };
})()

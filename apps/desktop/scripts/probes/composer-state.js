// Where the page is and whether a usable composer is on screen.
(() => {
  const areas = [...document.querySelectorAll('textarea')].map((el) => ({ visible: el.getClientRects().length > 0, disabled: el.disabled, label: el.getAttribute('aria-label') }));
  const tabs = [...document.querySelectorAll('[role="tab"], .workspace-tab')].map((n) => ({ text: n.textContent?.trim().slice(0, 40), selected: n.getAttribute('aria-selected') }));
  const status = [...document.querySelectorAll('.turn-status')].map((n) => n.textContent?.trim()).slice(-3);
  return { url: location.href, areas, tabs: tabs.slice(0, 8), status };
})()

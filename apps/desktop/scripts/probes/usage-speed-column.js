// Opens Usage → statistics and reads the token table: headers, every row's
// Speed cell, and whether the table overflows its shell. Set
// globalThis.__probeRange (e.g. 'All') to switch the period first.
(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (find, ms = 15000) => {
    for (let waited = 0; waited < ms; waited += 200) {
      const found = find();
      if (found) return found;
      await wait(200);
    }
    return null;
  };
  if (!document.querySelector('.stats-table')) {
    if (!document.querySelector('.sidebar-usage-stats')) document.querySelector('.sidebar-usage-toggle')?.click();
    (await until(() => document.querySelector('.sidebar-usage-stats')))?.click();
  }
  const table = await until(() => {
    const node = document.querySelector('.stats-table');
    return node && !node.closest('[data-loading="true"]') ? node : null;
  });
  if (!table) return { error: 'stats table did not render' };
  // `?range=All` style switch: the probe file may set window.__probeRange first.
  const range = globalThis.__probeRange;
  if (range) {
    [...document.querySelectorAll('.stats-controls .stats-ranges button')]
      .find((button) => button.textContent.trim() === range)
      ?.click();
    await until(() => !document.querySelector('.stats-surface[aria-busy="true"]'));
  }
  await wait(500);
  const headers = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim());
  const speedIndex = headers.findIndex((label) => /speed|속도/i.test(label));
  const rows = [...table.querySelectorAll('tbody tr')].map((row) => ({
    kind: row.className,
    name: row.cells[0]?.textContent.trim().slice(0, 40),
    speed: speedIndex >= 0 ? row.cells[speedIndex]?.textContent.trim() : null,
    output: row.cells[4]?.textContent.trim(),
  }));
  const shell = table.closest('.usage-table-shell');
  return {
    headers,
    speedIndex,
    rows: rows.slice(0, 20),
    tableWidth: table.scrollWidth,
    shellWidth: shell?.clientWidth,
    overflows: shell ? shell.scrollWidth > shell.clientWidth : null,
  };
})();

import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

// The sidebar row markup of session-sidebar-rows.tsx: a plain row, a working
// row (spinner in the status slot) and an unread row (dot).
const row = (id) => `
  <div class="session-row" id="${id}">
    <button type="button" class="session-row-main">
      <span class="session-row-slot"></span>
      <span class="session-row-copy"><b>A session title long enough to need an ellipsis on hover</b></span>
      <span class="session-row-status">${id === 'working' ? '<svg class="session-row-spinner" width="12" height="12"></svg>' : ''}</span>
      ${id === 'unread' ? '<span class="session-row-unread-dot"></span>' : ''}
    </button>
    <div class="session-row-actions">
      <button type="button" class="session-row-action session-row-favorite"></button>
      <button type="button" class="session-row-action session-row-archive"></button>
    </div>
  </div>`;

test('the hovered archive button sits at one position on plain, working and unread rows', async (t) => {
  const styles = await build({
    stdin: {
      resolveDir: fileURLToPath(new URL('.', import.meta.url)),
      loader: 'css',
      contents: '@import "./ui/tokens.css"; @import "./styles.css"; @import "./desktop.css";',
    },
    outfile: 'session-row-actions-align.css',
    bundle: true,
    write: false,
    loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl' },
  });
  const browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 600 });
  await page.setContent(`<!doctype html><html><body>
    <aside class="session-sidebar" style="width:280px"><div class="session-list">
      ${row('plain')}${row('working')}${row('unread')}
    </div></aside></body></html>`);
  await page.addStyleTag({ content: styles.outputFiles[0].text });

  const hovered = [];
  for (const id of ['plain', 'working', 'unread']) {
    await page.hover(`#${id} .session-row-copy`);
    hovered.push(
      await page.evaluate((id) => {
        const row = document.getElementById(id);
        const rowBox = row.getBoundingClientRect();
        const archive = row.querySelector('.session-row-archive').getBoundingClientRect();
        const favorite = row.querySelector('.session-row-favorite').getBoundingClientRect();
        const copy = row.querySelector('.session-row-copy');
        const trailing = row.querySelector('.session-row-unread-dot, .session-row-status:not(:empty)');
        return {
          id,
          archiveRight: rowBox.right - archive.right,
          archiveCenterInset: rowBox.right - (archive.left + archive.right) / 2,
          titleGap:
            favorite.left -
            (copy.getBoundingClientRect().right - Number.parseFloat(getComputedStyle(copy).paddingRight)),
          copyPadding: getComputedStyle(copy).paddingRight,
          trailingOpacity: trailing ? getComputedStyle(trailing).opacity : null,
        };
      }, id)
    );
  }
  // The approved #357 frame centers the 24px archive button 20px in from the
  // row's right edge (8px inset), and the title ends before the buttons.
  for (const sample of hovered) {
    assert.equal(sample.archiveCenterInset, 20, `archive button 20px from the row edge: ${sample.id}`);
    assert.ok(sample.titleGap >= 0, `title ends before the buttons: ${sample.id}`);
  }
  const [plain, ...busy] = hovered;
  for (const sample of busy) {
    assert.equal(sample.archiveRight, plain.archiveRight, `archive button position: ${sample.id}`);
    assert.equal(sample.copyPadding, plain.copyPadding, `title clearance: ${sample.id}`);
    assert.equal(sample.trailingOpacity, '0', `trailing mark hides under the buttons: ${sample.id}`);
  }
});

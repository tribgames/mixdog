import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
import { launchPuppeteerBrowser } from '../../../../src/runtime/shared/browser-launch.mjs';
import { calculateChromeTabWidths } from './workspace-tab-layout.ts';

// Real CSS, fake data: every tab of the strip keeps its icon (a spinner, an
// attention mark, a bot face, a bubble...) at any width. Only the title drops.
const SPINNER =
  '<span class="progress-spinner-turn spin"><svg class="progress-spinner workspace-tab-status lucide" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M21 12a9 9 0 1 1-6.2-8.6"/></svg></span>';
const BUBBLE =
  '<svg class="lucide" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg>';
const BOT =
  '<span class="agent-room-face mx-chat-tab-face"><svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="#7a9"/></svg></span>';
const ATTENTION =
  '<span class="session-attention-glyph workspace-tab-attention" data-status="needs-you" role="status"><svg class="lucide" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M12 3 2 21h20Z"/></svg></span>';
const KINDS = [SPINNER, BUBBLE, BOT, BUBBLE, ATTENTION, BOT, SPINNER, BOT, BUBBLE, BUBBLE, BOT, BUBBLE, SPINNER, BOT];
const ACTIVE = 2;

function tabsMarkup(available) {
  const widths = calculateChromeTabWidths(KINDS.length, ACTIVE, available);
  return KINDS.map(
    (glyph, index) => `<div class="workspace-tab ${index === ACTIVE ? 'active' : ''}" data-tab-key="t${index}"
      style="--workspace-tab-current-width:${widths[index]}px">
      <button type="button" class="workspace-tab-main" aria-label="Session ${index + 1}" data-tooltip="Session number ${index + 1} with a long title">
        ${glyph}<span class="workspace-tab-title">Session number ${index + 1} with a long title</span>
      </button>
      <button type="button" class="workspace-tab-close"><svg width="16" height="16"><path d="M3 3l10 10M13 3 3 13" stroke="currentColor"/></svg></button>
    </div>`
  ).join('');
}

test('every session tab keeps a centred, visible icon at any strip width', async (t) => {
  const styles = await build({
    stdin: {
      resolveDir: fileURLToPath(new URL('.', import.meta.url)),
      loader: 'css',
      contents:
        '@import "./font-faces.css"; @import "./ui/tokens.css"; @import "./styles.css"; @import "./desktop.css"; @import "./agent-chat.css";',
    },
    outfile: 'narrow-tabs.css',
    bundle: true,
    write: false,
    loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl' },
  });
  const browser = await launchPuppeteerBrowser(puppeteer, {
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html><body style="margin:0">
    <div class="app-shell"><div class="topbar" style="width:100%">
      <div class="workspace-tabs-shell" style="display:flex;flex:1;min-width:0" data-focused="true" data-geometry-snap="true">
        <div class="pane-cell" style="display:flex;flex:1;min-width:0">
          <nav class="workspace-tabs" id="strip"></nav>
          <button class="workspace-tab-new" type="button"><svg width="16" height="16"><path d="M8 2v12M2 8h12" stroke="currentColor"/></svg></button>
        </div>
        <div class="workspace-tabs-trailing" style="display:flex;width:${3 * 28 + 16}px"></div>
      </div>
    </div></div></body></html>`);
  await page.addStyleTag({ content: styles.outputFiles[0].text });
  const shotDir = process.env.NARROW_TABS_SHOT_DIR;
  if (shotDir) mkdirSync(shotDir, { recursive: true });

  for (const width of [1400, 900, 600, 420]) {
    await t.test(`${width}px`, async () => {
      await page.setViewport({ width, height: 120 });
      // The run fits what the empty strip really has, like the app's own measure.
      await page.evaluate(() => {
        document.getElementById('strip').innerHTML = '';
      });
      const available = await page.evaluate(
        () =>
          document.querySelector('.pane-cell').clientWidth - document.querySelector('.workspace-tab-new').offsetWidth
      );
      await page.evaluate((html) => {
        document.getElementById('strip').innerHTML = html;
      }, tabsMarkup(available));
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      if (shotDir)
        await page.screenshot({ path: join(shotDir, `tabs-${width}.png`), clip: { x: 0, y: 0, width, height: 60 } });
      const tabs = await page.evaluate(() =>
        [...document.querySelectorAll('.workspace-tab')].map((tab) => {
          const rect = tab.getBoundingClientRect();
          const icon = tab.querySelector('.workspace-tab-main').firstElementChild;
          const iconRect = icon.getBoundingClientRect();
          const title = tab.querySelector('.workspace-tab-title');
          const style = getComputedStyle(icon);
          return {
            active: tab.classList.contains('active'),
            tabWidth: rect.width,
            iconWidth: iconRect.width,
            iconHeight: iconRect.height,
            visible: style.display !== 'none' && style.visibility !== 'hidden',
            offCentre: Math.abs(iconRect.left + iconRect.width / 2 - (rect.left + rect.width / 2)),
            insideTab: iconRect.left >= rect.left - 0.5 && iconRect.right <= rect.right + 0.5,
            titleShown: getComputedStyle(title).display !== 'none',
            plate: getComputedStyle(tab, '::before').backgroundColor,
            tooltip: tab.querySelector('.workspace-tab-main').dataset.tooltip,
          };
        })
      );
      for (const [index, tab] of tabs.entries()) {
        const label = `tab ${index + 1} (${tab.tabWidth}px)`;
        assert.ok(tab.visible && tab.iconWidth > 0 && tab.iconHeight > 0, `${label} lost its icon`);
        assert.ok(tab.insideTab, `${label} icon spills out of its cell`);
        assert.ok(tab.tooltip.includes('long title'), `${label} lost its full-title tooltip`);
        if (!tab.titleShown) assert.ok(tab.offCentre <= 1.5, `${label} icon not centred (${tab.offCentre}px)`);
      }
      if (width <= 600) {
        assert.ok(
          tabs.every((tab) => !tab.titleShown),
          'titles drop on every tab at narrow widths'
        );
        const idle = tabs.find((tab) => !tab.active).plate;
        assert.notEqual(tabs.find((tab) => tab.active).plate, idle, 'selected tab keeps its plate');
      }
      if (width >= 1400)
        assert.ok(
          tabs.every((tab) => tab.titleShown),
          'wide tabs show titles'
        );
    });
  }
});

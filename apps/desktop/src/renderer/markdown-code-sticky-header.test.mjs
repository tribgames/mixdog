// A long code block keeps its header (language + copy button) at the top of
// the visible part of the transcript while the block is partly scrolled past,
// below the status island and top fade, and the code never shows through it.
// Real Chrome against the app's own stylesheets, on the transcript's virtual
// row markup (TranscriptList.tsx), judged on geometry and rendered pixels.
import assert from 'node:assert/strict';
import test from 'node:test';
import puppeteer from 'puppeteer-core';
import { PNG } from 'pngjs';
import { installTestDom } from './test-support/test-dom.mjs';
import { appStyles, paintState } from './test-support/app-styles.mjs';
import { DEFAULT_MAIN_TRANSPARENCY, DEFAULT_TRANSPARENCY } from './skin-color';
import { SKIN_MANIFEST } from './skin-manifest';

// Dense ink on every code line, so anything showing through the header
// changes its pixels.
const CODE = Array.from({ length: 80 }, () => '█'.repeat(120)).join('\n');

const PAGE = `
  <div class="app-shell"><div class="desktop-body"><main class="main-panel">
    <div class="workspace" style="width: 800px; height: 520px; position: relative"><div class="conversation" style="height: 520px; display: flex; flex-direction: column">
      <div class="transcript-shell" style="flex: none; height: 400px; position: relative">
        <div class="transcript-scroll-fade" style="--mx-scroll-top: 999"></div>
        <div class="transcript" id="scroller" style="height: 400px; overflow-y: auto"><div class="thread">
          <div class="transcript-virtual-space" style="height: 8000px">
            <div class="transcript-virtual-row" style="transform: translateY(0)">
              <div class="transcript-virtual-row-content" data-tag="AssistantPart">
                <article class="message assistant settled"><div class="message-body"><div class="markdown">
                  <p>A release script.</p>
                  <div class="markdown-code" id="card"><header id="header"><span>bash</span><div class="markdown-code-actions"><button type="button" class="markdown-code-copy" id="copy" aria-label="Copy">c</button></div></header><pre><code>${CODE}</code></pre></div>
                  <p>Done.</p>
                </div></div></article>
              </div>
            </div>
          </div>
        </div></div>
      </div>
    </div></div>
  </main></div></div>`;

async function scrollTo(page, top) {
  await page.evaluate((top) => {
    document.getElementById('scroller').scrollTop = top;
  }, top);
  return page.evaluate(() => {
    const box = (id) => document.getElementById(id).getBoundingClientRect();
    const scroller = box('scroller');
    const header = box('header');
    const copy = box('copy');
    const hit = document.elementFromPoint(copy.left + copy.width / 2, copy.top + copy.height / 2);
    return {
      offset: header.top - scroller.top,
      cardTop: box('card').top - scroller.top,
      cardBottom: box('card').bottom - scroller.top,
      headerBottom: header.bottom - scroller.top,
      scrollTop: document.getElementById('scroller').scrollTop,
      copyHit: hit?.id === 'copy',
      // A blank point of the band: between the label and the actions.
      probe: { x: Math.round(header.left + header.width / 2), y: Math.round(header.top + header.height / 2) },
    };
  });
}

async function pixel(page, { x, y }) {
  const png = PNG.sync.read(await page.screenshot({ type: 'png', clip: { x, y, width: 1, height: 1 } }));
  return [png.data[0], png.data[1], png.data[2]].join(',');
}

test('code block header: sticks below the top chrome while the block scrolls, and is opaque', async (t) => {
  installTestDom(t, { actEnvironment: false });
  const { skinVars } = await import('./desktop-skin');
  const browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 700 });
  await page.setContent(
    `<!doctype html><html><head><style>${await appStyles()}</style></head><body>${PAGE}</body></html>`
  );
  await page.addStyleTag({
    content:
      '* { transition: none !important; } html[data-mixdog-skin] :is(.desktop-body, .workspace, .conversation, .transcript, .thread, .transcript-virtual-row, .transcript-virtual-row-content) { background: transparent !important; } html[data-mixdog-skin] body::before { background: rgb(20, 120, 200) !important; }',
  });

  const skin = SKIN_MANIFEST[0].id;
  const states = [
    { label: 'dark', state: { theme: 'dark' } },
    { label: 'light', state: { theme: 'light' } },
    ...['light', 'dark'].map((plate) => ({
      label: `skin ${plate} plate`,
      state: {
        theme: plate,
        skin,
        plate,
        vars: skinVars(
          skin,
          { outerTransparency: DEFAULT_TRANSPARENCY, mainTransparency: DEFAULT_MAIN_TRANSPARENCY, plate, accent: null },
          plate
        ),
      },
    })),
  ];
  for (const { label, state } of states) {
    await paintState(page, state);
    const rest = await scrollTo(page, 0);
    assert.ok(rest.cardTop > 44, `${label}: the block starts below the top chrome at rest`);
    const restInk = await pixel(page, rest.probe);

    for (const into of [300, 913]) {
      const stuck = await scrollTo(page, rest.cardTop + into);
      assert.ok(stuck.cardTop < 0, `${label}: the block's top is scrolled past the chat's top`);
      assert.ok(Math.abs(stuck.offset - 44) < 0.5, `${label}: the header sits 44px below the chat's top (${stuck.offset})`);
      assert.ok(stuck.copyHit, `${label}: the copy button is on top and reachable`);
      assert.equal(await pixel(page, stuck.probe), restInk, `${label}: no code shows through the header (${into}px in)`);
    }

    // Once the card's bottom passes the pinned header, the header leaves with
    // its block instead of staying at 44px: its bottom rides on the card's.
    const target = Math.round(rest.cardBottom - 30);
    const end = await scrollTo(page, target);
    assert.equal(end.scrollTop, target, `${label}: the fixture has room to scroll the card's end up`);
    assert.ok(Math.abs(end.cardBottom - 30) < 0.5, `${label}: the card's bottom is 30px below the chat's top`);
    assert.ok(end.offset < 44 - 1, `${label}: the header has left the 44px line (${end.offset})`);
    assert.ok(Math.abs(end.headerBottom - end.cardBottom) < 0.5, `${label}: the header ends on its block's bottom`);
  }
});

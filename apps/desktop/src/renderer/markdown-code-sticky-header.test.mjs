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
      scrollerTop: scroller.top,
      offset: header.top - scroller.top,
      cardTop: box('card').top - scroller.top,
      headerBottom: header.bottom - scroller.top,
      copyHit: hit?.id === 'copy',
      // A blank point of the header: between the label and the actions.
      probe: { x: Math.round(header.left + header.width / 2), y: Math.round(header.top + header.height / 2) },
    };
  });
}

async function pixel(page, { x, y }) {
  const png = PNG.sync.read(await page.screenshot({ type: 'png', clip: { x, y, width: 1, height: 1 } }));
  return [png.data[0], png.data[1], png.data[2]];
}

/** The same paint: a translucent skin plate lands one 8-bit step apart from frame to frame, and code ink showing through
    is a different colour altogether. */
const samePaint = (a, b) => a.every((channel, at) => Math.abs(channel - b[at]) <= 1);

test('code block header: scrolls away with its block, and nothing covers the code above it', async (t) => {
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
    assert.ok(rest.copyHit, `${label}: the copy button is reachable at rest`);
    const headerInk = await pixel(page, rest.probe);
    const firstLine = { x: rest.probe.x, y: Math.round(rest.scrollerTop + rest.headerBottom + 20) };
    assert.ok(
      !samePaint(await pixel(page, firstLine), headerInk),
      `${label}: the block's first line shows under its header at rest`
    );

    for (const into of [10, 300, 913]) {
      const scrolled = await scrollTo(page, rest.cardTop + into);
      assert.ok(scrolled.cardTop < 0, `${label}: the block's top is scrolled past the chat's top`);
      assert.ok(
        Math.abs(scrolled.offset - scrolled.cardTop) < 0.5,
        `${label}: the header stays on its block's top (${scrolled.offset} vs ${scrolled.cardTop})`
      );
      // Past the top fade's 32px, through the 44px a pinned band would cover, and a line's height beyond.
      const strip = PNG.sync.read(
        await page.screenshot({
          type: 'png',
          clip: { x: rest.probe.x, y: Math.round(scrolled.scrollerTop + 34), width: 1, height: 40 },
        })
      );
      const inked = Array.from({ length: strip.height }, (_, row) => [
        ...strip.data.subarray(row * 4, row * 4 + 3),
      ]).filter((paint) => !samePaint(paint, headerInk));
      assert.ok(inked.length > 0, `${label}: code shows right under the chat's top (${into}px in)`);
    }
  }
});

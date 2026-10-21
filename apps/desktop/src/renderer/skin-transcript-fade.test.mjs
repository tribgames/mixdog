// The transcript's fade into the composer, in a real Chrome against the app's
// own stylesheets, judged on rendered pixels. Without a skin the strip
// (.transcript-shell::after) fades the rows into the sheet colour over the
// last --transcript-fade. Under a skin that colour is transparent, so the strip
// takes the veil the conversation area shows (--mx-scroll-fade-surface, the
// token the top strip already uses): a plate crossing the dock edge blends
// toward the veil instead of ending on a hard edge, and the plates keep their
// backdrop blur (no mask on the shell, which would make it a backdrop root).
import assert from 'node:assert/strict';
import test from 'node:test';
import puppeteer from 'puppeteer-core';
import { PNG } from 'pngjs';
import { installTestDom } from './test-support/test-dom.mjs';
import { appStyles, paintState } from './test-support/app-styles.mjs';
import { DEFAULT_MAIN_TRANSPARENCY, DEFAULT_TRANSPARENCY } from './skin-color';
import { SKIN_MANIFEST } from './skin-manifest';

const PAGE = `
  <div class="app-shell"><div class="desktop-body"><main class="main-panel">
    <div class="workspace" style="width: 800px; height: 520px; position: relative"><div class="conversation" style="height: 520px; display: flex; flex-direction: column">
      <div class="transcript-shell" id="shell" style="flex: none; height: 300px; position: relative">
        <div class="transcript" style="height: 300px; overflow: hidden"><div class="thread">
          <div class="transcript-virtual-row-content" data-tag="AssistantPart" style="padding-top: 160px">
            <article class="message assistant settled" id="plate"><div class="message-body"><p style="height: 400px">A tall reply that crosses the dock edge.</p></div></article>
          </div>
        </div></div>
      </div>
    </div></div>
  </main></div></div>`;

/** Distance between a pixel inside the plate and the one beside it (picture +
    veil only), at rows measured up from the shell's bottom edge. */
async function gaps(page) {
  const geometry = await page.evaluate(() => {
    const shell = document.getElementById('shell').getBoundingClientRect();
    const plate = document.getElementById('plate').getBoundingClientRect();
    return { bottom: shell.bottom, inside: plate.left + plate.width / 2 + 80, outside: Math.max(2, plate.left / 2) };
  });
  const png = PNG.sync.read(
    await page.screenshot({ type: 'png', clip: { x: 0, y: geometry.bottom - 60, width: 800, height: 60 } })
  );
  const at = (x, up) => {
    const i = (png.width * (60 - up) + Math.round(x)) * 4;
    return [png.data[i], png.data[i + 1], png.data[i + 2]];
  };
  const gap = (up) => {
    const a = at(geometry.inside, up);
    const b = at(geometry.outside, up);
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  };
  return { deep: gap(40), middle: gap(12), edge: gap(1) };
}

test('transcript fade: under a skin the strip blends plates into the veil and plates keep their blur', async (t) => {
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
  // A flat picture stands in for the skin image (the app's panes are open over
  // it, as pane-layout.css does): the gap measures the plate against the veil.
  await page.addStyleTag({
    content:
      '* { transition: none !important; } html[data-mixdog-skin] :is(.desktop-body, .workspace, .conversation, .transcript, .thread, .transcript-virtual-row-content) { background: transparent !important; } html[data-mixdog-skin] body::before { background: rgb(20, 120, 200) !important; }',
  });

  const skin = SKIN_MANIFEST[0].id;
  let measured = 0;
  for (const phone of [false, true]) {
    await page.setViewport({ width: phone ? 390 : 900, height: 700 });
    for (const plate of ['light', 'dark']) {
      for (const transparency of [0, DEFAULT_TRANSPARENCY, 100]) {
        const vars = skinVars(
          skin,
          {
            outerTransparency: transparency,
            mainTransparency: transparency === DEFAULT_TRANSPARENCY ? DEFAULT_MAIN_TRANSPARENCY : transparency,
            plate,
            accent: null,
          },
          plate === 'dark' ? 'dark' : 'light'
        );
        await paintState(page, { theme: plate === 'dark' ? 'dark' : 'light', skin, plate, vars, phone });
        const label = `${phone ? 'phone ' : ''}${plate} plate @${transparency}`;
        const state = await page.evaluate(() => {
          const shell = document.getElementById('shell');
          const after = getComputedStyle(shell, '::after');
          return {
            strip: after.backgroundImage,
            veil: getComputedStyle(shell).getPropertyValue('--mx-scroll-fade-surface').trim(),
            mask: getComputedStyle(shell).maskImage,
            blur: getComputedStyle(document.getElementById('plate')).backdropFilter,
          };
        });
        assert.equal(state.mask, 'none', `${label}: no mask on the shell`);
        assert.match(state.blur, /blur\(/, `${label}: the plate keeps its backdrop blur`);
        assert.match(state.strip, /linear-gradient/, `${label}: the fade strip is painted`);
        assert.ok(state.veil.length > 0, `${label}: the strip reads the veil token`);
        const { deep, middle, edge } = await gaps(page);
        // At 0 the veil and the plate are the same opaque tint: nothing to tell apart.
        if (transparency === 0) {
          measured++;
          continue;
        }
        assert.ok(deep > 5, `${label}: the plate shows in the body of the transcript (${deep})`);
        assert.ok(
          edge <= middle + 0.5 && middle <= deep + 0.5,
          `${label}: never steeper toward the edge (${deep} ${middle} ${edge})`
        );
        // A veil with no weight (transparency at the clear end) has nothing to blend into.
        if (!/ 0%|rgba\([^)]*, 0\)/.test(state.veil) && state.veil !== 'transparent') {
          assert.ok(
            edge < deep - 0.5,
            `${label}: the plate has blended toward the veil at the dock edge (${deep} -> ${edge})`
          );
        }
        measured++;
      }
    }
  }
  assert.equal(measured, 12);

  await t.test('without a skin the strip is the sheet-coloured fade and nothing changes', async () => {
    await paintState(page, { theme: 'dark' });
    const state = await page.evaluate(() => {
      const shell = document.getElementById('shell');
      const after = getComputedStyle(shell, '::after');
      return { mask: getComputedStyle(shell).maskImage, content: after.content, image: after.backgroundImage };
    });
    assert.equal(state.mask, 'none');
    assert.equal(state.content, '""');
    assert.match(state.image, /linear-gradient/);
  });
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { openPhone as openPhoneSheet, wait } from './test-support/phone-sheet-browser.mjs';

const HARNESS = `
  import { createRoot } from 'react-dom/client';
  import { VisualizePane } from './VisualizePane';
  import { applyVisualizeEvent } from './visualize-store';
  window.mixdogDesktop = { visualizeCommand: async () => ({}), visualizePaneSource: async () => ({ kind: 'html', srcdoc: window.pageHtml, contentId: 'c1' }) };
  window.showPanel = () => {
    applyVisualizeEvent({ sessionId: 's1', state: { sessionId: 's1', active: 't1', tabs: [{ id: 't1', label: 'mockup.svg',
      revision: 0, panes: [{ kind: 'html', label: 'page.html', target: 'page.html', url: '' }] }] } });
    createRoot(document.querySelector('.workbench-side-section-body')).render(<VisualizePane sessionId="s1" active onClose={() => {}} />);
  };
`;
const openPhone = (t) => openPhoneSheet(t, HARNESS, 'phone-visualize-zoom-out');
const PAGE =
  '<body style="margin:0;background:#3a6"><div style="height:2000px;background:linear-gradient(#3a6,#d33)">page</div>';

test('phone Visualize sheet: a page pinched below 1x never scrolls into empty space and returns to 1x', async (t) => {
  const { page, touch } = await openPhone(t);
  await page.evaluate((html) => {
    window.pageHtml = html;
    window.showPanel();
  }, PAGE);
  // No relay here: the frame falls back to srcdoc after its ready timeout.
  // The page's bridge script ships inside that document and runs as it
  // parses, so the frame being revealed (its load) means it is listening.
  await page.waitForFunction(
    () => {
      const frame = document.querySelector('.visualize-pane-content iframe');
      return Boolean(frame?.srcdoc) && frame.style.visibility !== 'hidden';
    },
    { timeout: 10_000 }
  );
  const content = '.visualize-pane-content';
  const geometry = () =>
    page.$eval(content, (pane) => {
      const frame = pane.querySelector('iframe').getBoundingClientRect();
      return {
        scrollWidth: pane.scrollWidth,
        scrollHeight: pane.scrollHeight,
        clientWidth: pane.clientWidth,
        clientHeight: pane.clientHeight,
        frameWidth: frame.width,
        frameHeight: frame.height,
        layer: pane.querySelector('.visualize-zoom-layer').getAttribute('style'),
      };
    });
  const pinch = async (from, to, y) => {
    await touch('touchStart', [
      [195 - from, y],
      [195 + from, y],
    ]);
    for (let step = 1; step <= 20; step += 1) {
      const half = from + ((to - from) * step) / 20;
      await touch('touchMove', [
        [195 - half, y],
        [195 + half, y],
      ]);
      await wait(16);
    }
    await touch('touchEnd', []);
  };

  await pinch(150, 20, 500);
  // The frame's last pinch messages arrive after the fingers lift: the zoom
  // has settled once it has reached the 25% floor this pinch asks for.
  await page.waitForFunction(() => document.querySelector('.browser-zoom-percent span')?.textContent === '25%');
  const percent = await page.$eval('.browser-zoom-percent span', (element) => Number.parseInt(element.textContent, 10));
  assert.ok(percent < 100, `the pinch zoomed out (${percent}%)`);
  const small = await geometry();
  assert.ok(Math.abs(small.frameWidth - small.clientWidth) < 2, 'the scaled page fills the pane width');
  assert.ok(Math.abs(small.frameHeight - small.clientHeight) < 2, 'the scaled page fills the pane height');
  assert.equal(small.scrollWidth, small.clientWidth, 'nothing to scroll sideways past the page');
  assert.equal(small.scrollHeight, small.clientHeight, 'nothing to scroll down past the page');
  await page.$eval(content, (pane) => {
    pane.scrollTop = 1e6;
    pane.scrollLeft = 1e6;
  });
  assert.deepEqual(await page.$eval(content, (pane) => [pane.scrollLeft, pane.scrollTop]), [0, 0]);

  // Back up to 1x: the zoom layer is gone and the page fills the pane as before.
  for (let step = 0; step < 6 && (await geometry()).layer; step += 1)
    await page.$eval('[aria-label="Zoom in"]', (button) => button.click());
  const fit = await geometry();
  assert.ok(!fit.layer, 'back at 1x');
  assert.ok(Math.abs(fit.frameWidth - fit.clientWidth) < 1 && Math.abs(fit.frameHeight - fit.clientHeight) < 1);
});

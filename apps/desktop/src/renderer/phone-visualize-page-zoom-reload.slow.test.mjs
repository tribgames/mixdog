import assert from 'node:assert/strict';
import test from 'node:test';
import { openPhone as openPhoneSheet, wait } from './test-support/phone-sheet-browser.mjs';

// Pages reach their frame through the relay's /preview-frame, as on a paired
// phone. Every frame that has posted its paint report is marked
// data-painted; from `watch` on, a frame shown (not pending) before its page
// painted counts as an early promotion.
const HARNESS = `
  import { createRoot } from 'react-dom/client';
  import { VisualizePane } from './VisualizePane';
  import { applyVisualizeEvent } from './visualize-store';
  window.mixdogDesktop = {
    visualizeCommand: async () => ({}),
    visualizePaneSource: async () => ({ kind: 'html', srcdoc: window.pageHtml, contentId: window.pageId }),
  };
  window.scrolls = [];
  window.early = 0;
  window.watch = false;
  const frames = () => [...document.querySelectorAll('.visualize-pane-content iframe')];
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (data && data.__mixdogVisualize === 1 && data.type === 'scrolled') window.scrolls.push({ y: data.y, height: data.height });
    if (data && data.type === 'mixdog-preview-painted') {
      const frame = frames().find((candidate) => candidate.contentWindow === event.source);
      if (frame) frame.dataset.painted = '1';
    }
  });
  const check = () => {
    if (!window.watch) return;
    for (const frame of frames()) {
      if (!frame.classList.contains('visualize-frame-pending') && !frame.dataset.painted) window.early += 1;
    }
  };
  new MutationObserver(check).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  window.putRevision = (revision) =>
    applyVisualizeEvent({ sessionId: 's1', state: { sessionId: 's1', active: 't1', tabs: [{ id: 't1', label: 'page.html',
      revision, panes: [{ kind: 'html', label: 'page.html', target: 'page.html', url: '' }] }] } });
  window.showPanel = () => {
    window.putRevision(0);
    createRoot(document.querySelector('.workbench-side-section-body')).render(<VisualizePane sessionId="s1" active onClose={() => {}} />);
  };
`;
const PAGE_HEIGHT = 6000;
// Like the mockup the user had open: the drawn screens fit themselves to the page width on every resize.
// `latePaint` holds the page's first frames back, so it loads long before it paints.
const pageHtml = (label, { latePaint = false } = {}) => `<body style="margin:0;background:#264">
  <div id="fit" style="height:${PAGE_HEIGHT}px;background:linear-gradient(#264,#a33)">${label}</div>
  <script>
    ${latePaint ? 'var frame = window.requestAnimationFrame; window.requestAnimationFrame = function (callback) { return setTimeout(function () { frame(callback); }, 800); };' : ''}
    function fit() { document.getElementById('fit').style.width = (innerWidth - 20) + 'px'; }
    fit(); addEventListener('resize', fit);
  </script>`;

const shownFrame = '.visualize-pane-content iframe:not(.visualize-frame-pending)';

async function openPage(t) {
  const phone = await openPhoneSheet(t, HARNESS, 'phone-visualize-page-zoom-reload', { relay: true });
  await phone.page.evaluate((html) => {
    window.pageHtml = html;
    window.pageId = 'live:a';
    window.showPanel();
  }, pageHtml('first'));
  await phone.page.waitForFunction(
    (selector) => {
      const frame = document.querySelector(selector);
      return frame?.dataset.painted === '1' && frame.style.visibility !== 'hidden';
    },
    { timeout: 10_000 },
    shownFrame
  );
  return phone;
}

const scrollPage = (page, y) =>
  page.evaluate(
    (selector, top) => {
      window.scrolls = [];
      document
        .querySelector(selector)
        .contentWindow.postMessage({ __mixdogVisualize: 1, type: 'scroll-to', x: 0, y: top }, '*');
    },
    shownFrame,
    y
  );
const lastScroll = (page) => page.evaluate(() => window.scrolls.at(-1));
const settledScroll = async (page) => {
  await page.waitForFunction(() => window.scrolls.length > 0);
  await wait(300);
  return lastScroll(page);
};

test('phone Visualize: zooming a page in magnifies it at its layout width; zooming out at the end of the page stays at its end', async (t) => {
  const { page } = await openPage(t);
  await scrollPage(page, 1000);
  await page.waitForFunction(() => window.scrolls.at(-1)?.y === 1000);
  const before = await page.$eval('.visualize-pane-content', (pane) => ({
    width: pane.clientWidth,
    height: pane.clientHeight,
    frame: pane.querySelector('iframe').clientWidth,
  }));
  await page.evaluate(() => {
    window.scrolls = [];
  });
  for (let step = 0; step < 4; step += 1) {
    await page.$eval('[aria-label="Zoom in"]', (button) => button.click());
    await wait(150);
  }
  assert.equal(await page.$eval('.browser-zoom-percent span', (element) => element.textContent), '200%');
  const zoomed = await page.$eval('.visualize-pane-content', (pane) => ({
    width: pane.clientWidth,
    height: pane.clientHeight,
    scrollWidth: pane.scrollWidth,
    scrollHeight: pane.scrollHeight,
    frame: pane.querySelector('iframe').clientWidth,
    drawn: pane.querySelector('iframe').getBoundingClientRect().width,
  }));
  assert.equal(zoomed.frame, before.frame, 'the page keeps its layout width: nothing reflows');
  assert.ok(Math.abs(zoomed.drawn - 2 * zoomed.width) < 2, `drawn twice as wide (${zoomed.drawn})`);
  assert.ok(Math.abs(zoomed.scrollWidth - 2 * zoomed.width) < 2, 'the pane pans sideways over it');
  assert.equal(zoomed.scrollHeight, zoomed.height, 'up and down is the page’s own scroll');
  // 1 → 2 about the middle line: the page moves by h/2 · (1 − 1/2) of its own px.
  const expected = 1000 + before.height / 2 - before.height / 4;
  const middle = await settledScroll(page);
  assert.ok(Math.abs(middle.y - expected) < 4, `the middle of the view stays put: ${middle.y} ≈ ${expected}`);

  // At the end of the page, 200% → fit: the bigger view is clamped to the end, and stays there.
  await scrollPage(page, PAGE_HEIGHT);
  const end = await settledScroll(page);
  assert.ok(Math.abs(end.y + end.height - PAGE_HEIGHT) < 2, `at the end at 200% (${end.y} + ${end.height})`);
  await page.evaluate(() => {
    window.scrolls = [];
  });
  await page.$eval('.browser-zoom-percent', (button) => button.click());
  await page.$eval('[role="menuitemradio"]', (item) => item.click());
  assert.equal(await page.$eval('.browser-zoom-percent span', (element) => element.textContent), '100%');
  const fitted = await settledScroll(page);
  assert.ok(Math.abs(fitted.height - before.height) < 2, 'read at the fitted view');
  assert.ok(
    Math.abs(fitted.y + fitted.height - PAGE_HEIGHT) < 2,
    `still at the end of the page, not scrolled back up: ${fitted.y} + ${fitted.height}`
  );
});

test('phone Visualize: a changed page loads behind the shown one, which stays until the new page has painted, at its scroll', async (t) => {
  const { page } = await openPage(t);
  await scrollPage(page, 2400);
  await page.waitForFunction(() => window.scrolls.at(-1)?.y === 2400);
  // The file changed on the PC: new content, new revision; the new page loads at once but paints late.
  await page.evaluate(
    (html) => {
      window.pageHtml = html;
      window.pageId = 'live:b';
      window.scrolls = [];
      window.blank = 0;
      window.samples = 0;
      window.watch = true;
      window.first = document.querySelector('.visualize-pane-content iframe');
      window.sampling = setInterval(() => {
        window.samples += 1;
        const shown = document.querySelector('.visualize-pane-content iframe:not(.visualize-frame-pending)');
        if (!shown || getComputedStyle(shown).visibility === 'hidden' || !shown.dataset.painted) window.blank += 1;
      }, 16);
      window.putRevision(1);
    },
    pageHtml('second page, a little longer', { latePaint: true })
  );
  await page.waitForFunction(
    () => {
      const frames = document.querySelectorAll('.visualize-pane-content iframe');
      return frames.length === 1 && frames[0] !== window.first;
    },
    { timeout: 15_000 }
  );
  const { blank, samples, early } = await page.evaluate(() => {
    clearInterval(window.sampling);
    return { blank: window.blank, samples: window.samples, early: window.early };
  });
  assert.equal(early, 0, 'the new frame was never shown before its page painted');
  assert.ok(samples > 40, `sampled through the reload (${samples})`);
  assert.equal(blank, 0, 'a painted page was on screen the whole time');
  const restored = await settledScroll(page);
  assert.equal(restored.y, 2400, 'the new page shows where the old one was');
});

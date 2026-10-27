import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

// The phone drawer's `inert` must follow the frame's transform transition, not
// the React commit: flipping it restyles the whole sidebar. Real Chrome, real
// touch events through installEdgeSwipe, and the drawer wiring of
// use-app-shell-panels.ts (the tap's intent stamp, a transition commit, the
// stamp settled in a layout effect); nothing is stubbed.

const ENTRY = `
  import React, { startTransition, useLayoutEffect, useRef, useState } from 'react';
  import { createRoot } from 'react-dom/client';
  import { WorkbenchSidePanel } from './workbench-side-view-layout.tsx';
  import { paintDrawerIntent, settleDrawerIntent, drawerIntentOpen } from './drawer-intent.ts';
  import { installEdgeSwipe } from './touch-gestures.ts';
  const descriptors = new Map([['sessions', { id: 'sessions', label: 'Sessions', icon: () => null }]]);
  function Shell() {
    const [open, setOpen] = useState(false);
    const [motion, setMotion] = useState('instant');
    const intent = useRef(false);
    const openRef = useRef(open);
    openRef.current = open;
    // use-app-shell-panels.ts applySidebarOpen, line for line.
    window.apply = (next, nextMotion = 'animated') => {
      intent.current = next;
      if (nextMotion === 'animated') {
        paintDrawerIntent(next);
        startTransition(() => {
          setMotion(nextMotion);
          setOpen(next);
        });
        return;
      }
      setMotion(nextMotion);
      setOpen(next);
    };
    window.toggle = () => window.apply(!drawerIntentOpen(openRef.current));
    useLayoutEffect(() => {
      settleDrawerIntent(open, intent.current);
    });
    React.useEffect(
      () =>
        installEdgeSwipe(window, [
          {
            side: 'left',
            isOpen: () => openRef.current,
            setOpen: (next) => window.apply(next),
            element: () => document.querySelector('.sidebar-drawer-frame'),
            backdrop: () => document.querySelector('.sidebar-backdrop'),
          },
        ]),
      []
    );
    return React.createElement(
      React.Fragment,
      null,
      React.createElement(
        'div',
        { className: 'sidebar-drawer-frame', 'data-state': open ? 'open' : 'closed', 'data-motion': motion },
        React.createElement('nav', { className: 'activity-rail' }, React.createElement('button', { type: 'button', 'data-side-view': 'sessions' }, 'rail')),
        React.createElement(WorkbenchSidePanel, {
          side: 'left',
          open,
          motion,
          groups: [['sessions']],
          activeRoot: 'sessions',
          descriptors,
          onSelect() {},
          onMoveGroup() {},
          onMoveView() {},
          renderView: () => React.createElement('button', { id: 'inside', type: 'button' }, 'Session'),
        })
      ),
      React.createElement('div', { className: 'sidebar-backdrop', 'data-state': open ? 'open' : 'closed' }),
      React.createElement('button', {
        id: 'toggle',
        type: 'button',
        style: { position: 'fixed', right: 0, bottom: 0, width: 80, height: 80, zIndex: 1000 },
        onClick: () => window.toggle(),
      })
    );
  }
  createRoot(document.getElementById('root')).render(React.createElement(Shell));
`;

const PROBES = `
  window.frameEl = () => document.querySelector('.sidebar-drawer-frame');
  window.panelEl = () => document.querySelector('.workbench-side-panel');
  window.sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // Ordered record of the frame's transform transitions (run / end) and of
  // every change of the panel's inert attribute (a mutation record lands right
  // after the change, before the next event).
  window.log = [];
  window.flips = [];
  window.clicks = 0;
  // Every app read of the frame's animations (a forced style flush); the
  // probes' own reads are excluded.
  window.animationReads = 0;
  const readAnimations = Element.prototype.getAnimations;
  Element.prototype.getAnimations = function (...args) {
    if (!window.probing && this.classList?.contains('sidebar-drawer-frame')) window.animationReads += 1;
    return readAnimations.apply(this, args);
  };
  addEventListener('click', (event) => { if (event.target.id === 'inside') clicks += 1; }, true);
  window.watch = () => {
    window.log.length = 0;
    for (const [type, name] of [['transitionrun', 'run'], ['transitionend', 'end'], ['transitioncancel', 'cancel']]) {
      addEventListener(
        type,
        (event) => {
          if (event.target === frameEl() && event.propertyName === 'transform') log.push(name);
        },
        true
      );
    }
    // The gesture's inline end-state paint going away (its own completion).
    new MutationObserver(() => {
      if (frameEl().style.transform === '' && !log.includes('clear')) log.push('clear');
    }).observe(frameEl(), { attributes: true, attributeFilter: ['style'] });
    // Each flip also records whether a transform transition was running on the
    // frame at that moment (getAnimations() flushes style, so a transition the
    // same task just caused counts).
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.attributeName !== 'inert') continue;
        log.push(panelEl().inert ? 'inert' : 'live');
        window.probing = true;
        flips.push(
          frameEl()
            .getAnimations()
            .some((a) => a.transitionProperty === 'transform' && a.playState === 'running')
        );
        window.probing = false;
      }
    }).observe(panelEl(), { attributes: true });
  };
  window.settled = async () => {
    await sleep(700);
    log.length = 0;
    flips.length = 0;
  };
  window.state = () => ({
    inert: panelEl().inert,
    ariaHidden: panelEl().getAttribute('aria-hidden'),
    pointerEvents: getComputedStyle(panelEl()).pointerEvents,
  });
`;

async function launch(t) {
  const resolveDir = fileURLToPath(new URL('.', import.meta.url));
  const [styles, script] = await Promise.all([
    build({
      stdin: {
        resolveDir,
        loader: 'css',
        contents: '@import "./ui/tokens.css"; @import "./styles.css"; @import "./desktop.css";',
      },
      outfile: 'mobile-drawer-inert-gesture.css',
      bundle: true,
      write: false,
      loader: {
        '.woff': 'dataurl',
        '.woff2': 'dataurl',
        '.ttf': 'dataurl',
        '.svg': 'dataurl',
        '.jpg': 'dataurl',
        '.png': 'dataurl',
      },
    }),
    build({
      stdin: { resolveDir, loader: 'tsx', contents: ENTRY },
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' },
      loader: { '.svg': 'dataurl', '.png': 'dataurl', '.css': 'empty' },
    }),
  ]);
  const browser = await puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.setContent(
    '<!doctype html><html data-mixdog-mobile-tabs><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div></body></html>'
  );
  await page.addStyleTag({ content: styles.outputFiles[0].text });
  await page.addScriptTag({ content: script.outputFiles[0].text });
  await page.addScriptTag({ content: PROBES });
  await page.waitForSelector('.workbench-side-panel', { hidden: true });
  await page.evaluate(() => watch());
  await page.evaluate(() => settled());
  t.after(() => assert.deepEqual(errors, []));
  return page;
}

/** A real touch drag through the CDP input pipeline, finger lifted at the end. */
async function drag(page, fromX, toX, beforeRelease) {
  const cdp = await page.createCDPSession();
  const y = 400;
  const point = (x) => ({ x, y });
  let time = Date.now() / 1000;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(fromX)], timestamp: time });
  for (let step = 1; step <= 6; step += 1) {
    time += 0.016;
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 16)));
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [point(fromX + ((toX - fromX) * step) / 6)],
      timestamp: time,
    });
  }
  await beforeRelease?.();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [], timestamp: time + 0.008 });
}

const tap = (page) => page.touchscreen.tap(350, 800);

/** Open or close the drawer for the test with no slide left to wait for. */
async function openInstantly(page) {
  await page.evaluate(() => apply(true, 'instant'));
  await page.evaluate(() => settled());
}

/** Waits for a transform transitionend and a frame after it, then returns the log. */
async function finish(page) {
  await page.waitForFunction(() => log.includes('end'), { timeout: 4000 });
  await page.evaluate(() => sleep(50));
  return page.evaluate(() => [...log]);
}

// A release mid-travel (or a tap) starts a slide: `run` precedes the commit's
// flip, and inert follows only the slide's own transitionend (~180 ms later).
// The same transform transition runs again ~400 ms after the release, when the
// gesture drops its inline end-state paint and the class takes over (a no-op
// visually), so these assertions read the log up to the first `end`.
const SLIDE_THEN = (flip) => ['run', 'end', flip];

test('a drag released mid-travel opens the drawer and clears inert at the slide end', async (t) => {
  const page = await launch(t);
  assert.equal((await page.evaluate(() => state())).inert, true, 'the closed drawer starts inert');
  await drag(page, 4, 280);
  assert.deepEqual((await finish(page)).slice(0, 3), SLIDE_THEN('live'));
  assert.deepEqual(await page.evaluate(() => state()), { inert: false, ariaHidden: null, pointerEvents: 'auto' });
});

test('a drag released mid-travel closes the drawer and sets inert at the slide end', async (t) => {
  const page = await launch(t);
  await openInstantly(page);
  assert.equal((await page.evaluate(() => state())).inert, false);
  await drag(page, 200, 10);
  assert.deepEqual((await finish(page)).slice(0, 3), SLIDE_THEN('inert'));
  assert.deepEqual(await page.evaluate(() => state()), { inert: true, ariaHidden: 'true', pointerEvents: 'auto' });
});

test('a tap that opens the drawer clears inert at the slide end', async (t) => {
  const page = await launch(t);
  await tap(page);
  assert.deepEqual((await finish(page)).slice(0, 3), SLIDE_THEN('live'));
});

test('a tap that closes the drawer sets inert at the slide end', async (t) => {
  const page = await launch(t);
  await openInstantly(page);
  await tap(page);
  assert.deepEqual((await finish(page)).slice(0, 3), SLIDE_THEN('inert'));
});

/** No inert flip between a transform transition's start and its end/cancel. */
function assertNoFlipWhileSliding(log, flips) {
  let running = 0;
  for (const entry of log) {
    if (entry === 'run') running += 1;
    else if (entry === 'end' || entry === 'cancel') running = Math.max(0, running - 1);
    else if (entry === 'live' || entry === 'inert')
      assert.equal(running, 0, `inert flipped (${entry}) inside a running slide: ${log}`);
  }
  assert.ok(
    flips.every((during) => during === false),
    `inert flipped while a transform transition ran: ${flips}`
  );
}

const record = (page) => page.evaluate(() => ({ log: [...window.log], flips: [...window.flips] }));

// A finger that carries the sheet to its end (every real drag: the travel
// clamps) leaves the sheet stationary at release. Its inline paint equals the
// class target (07-mobile-chrome.css names the rest transforms), so the commit
// hands it over with no transition at all, and inert flips right there, not
// when the gesture's 400 ms hold ends.
test('a clamped drag-open clears inert at the commit, with no slide, and its content takes taps at once', async (t) => {
  const page = await launch(t);
  await drag(page, 4, 380);
  // Well under the gesture's hold: the drawer is stationary already.
  await page.waitForFunction(() => log.includes('live'), { timeout: 250 });
  const box = await (await page.$('#inside')).boundingBox();
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForFunction(() => clicks === 1, { timeout: 1000 });
  await page.evaluate(() => sleep(700));
  const { log, flips } = await record(page);
  assert.deepEqual(log, ['clear', 'live'], 'no transform transition ran at any point');
  assertNoFlipWhileSliding(log, flips);
  assert.deepEqual(await page.evaluate(() => state()), { inert: false, ariaHidden: null, pointerEvents: 'auto' });
});

test('a clamped drag-close sets inert at the commit, with no slide', async (t) => {
  const page = await launch(t);
  await openInstantly(page);
  await drag(page, 380, 4);
  await page.waitForFunction(() => log.includes('inert'), { timeout: 250 });
  await page.evaluate(() => sleep(700));
  const { log, flips } = await record(page);
  assert.deepEqual(log, ['clear', 'inert'], 'no transform transition ran at any point');
  assertNoFlipWhileSliding(log, flips);
});

// Mid-travel release: a real glide, then (during the hold) the class takes over.
test('a mid-travel release flips inert only after its glide, and the hold hand-off starts no slide', async (t) => {
  const page = await launch(t);
  await drag(page, 4, 280);
  await page.waitForFunction(() => log.includes('live'), { timeout: 1500 });
  await page.evaluate(() => sleep(700));
  const { log, flips } = await record(page);
  assert.deepEqual(log.slice(0, 3), ['run', 'end', 'live']);
  assert.deepEqual(
    log.filter((entry) => entry === 'run'),
    ['run'],
    'dropping the paint started no second slide'
  );
  assertNoFlipWhileSliding(log, flips);
});

// The class target differs from the paint (a programmatic reversal while the
// gesture still holds it): dropping the paint is a real slide, and inert flips
// at its end, never at its start.
test('a reversal during the hold flips inert at the end of the following slide', async (t) => {
  const page = await launch(t);
  await drag(page, 4, 280);
  await page.waitForFunction(() => log.includes('end'), { timeout: 1500 });
  await page.evaluate(() => apply(false));
  await page.evaluate(() => sleep(1000));
  const { log, flips } = await record(page);
  assert.deepEqual(log.slice(0, 2), ['run', 'end'], 'the open glide');
  assert.ok(log.indexOf('run', 2) > 0, 'the reversal slid the sheet closed');
  assert.equal(log.at(-1), 'inert');
  assertNoFlipWhileSliding(log, flips);
  assert.equal(await page.evaluate(() => frameEl().getBoundingClientRect().right <= 0), true);
  assert.equal((await page.evaluate(() => state())).inert, true);
});

test('a reversal while the open glide still runs ends inert, never flipping inside a slide', async (t) => {
  const page = await launch(t);
  await drag(page, 4, 280);
  await page.waitForFunction(() => log.includes('run'), { timeout: 1500 });
  await page.evaluate(() => apply(false));
  await page.evaluate(() => sleep(1200));
  const { log, flips } = await record(page);
  assertNoFlipWhileSliding(log, flips);
  assert.equal(log.at(-1), 'inert');
  assert.equal((await page.evaluate(() => state())).inert, true);
});
// The end paint references the sheet's rest tokens live (`var()`), so it equals
// the class target even when a token changes after the gesture bound the sheet.
test('a token changed between bind and release: the end paint still equals the class target', async (t) => {
  const page = await launch(t);
  await drag(page, 4, 380, async () => {
    // Touch moves reach the page on frame boundaries: let the last one land first.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.addStyleTag({
      content: 'html[data-mixdog-mobile-tabs] .sidebar-drawer-frame { --mx-drawer-open-transform: translateX(5%); }',
    });
  });
  await page.waitForFunction(() => log.includes('live'), { timeout: 250 });
  await page.evaluate(() => sleep(700));
  const { log, flips } = await record(page);
  assert.deepEqual(log, ['clear', 'live'], 'handing the paint to the class started no transform transition');
  assertNoFlipWhileSliding(log, flips);
  const { left, width } = await page.evaluate(() => {
    const rect = frameEl().getBoundingClientRect();
    return { left: rect.left, width: rect.width };
  });
  assert.ok(Math.abs(left - width * 0.05) < 1, `the sheet rests at the live target (left ${left}, width ${width})`);
});

test('the phone marker removed mid-gesture leaves no stale end paint', async (t) => {
  const page = await launch(t);
  await openInstantly(page);
  await drag(page, 380, 4, () =>
    page.evaluate(() => document.documentElement.removeAttribute('data-mixdog-mobile-tabs'))
  );
  await page.evaluate(() => sleep(50));
  const paint = await page.evaluate(() => frameEl().getAttribute('style'));
  assert.match(
    paint,
    /var\(--mx-drawer-closed-transform, translateX\(-100%\)\)/,
    'the live reference keeps its fallback'
  );
  assert.equal(
    await page.evaluate(() => getComputedStyle(frameEl()).getPropertyValue('--mx-drawer-closed-transform')),
    '',
    'with the marker gone the token is undeclared, so the paint resolves to the fallback'
  );
});
// An instant close (Settings opening over the drawer) runs no slide, so the
// panel never reads the frame's animations: that read flushes the style of
// everything the same commit mounted. An animated close still keeps the panel
// displayed (`data-closing`) until its slide ends.
test('an instant close reads no animations; an animated close keeps data-closing until its slide ends', async (t) => {
  const page = await launch(t);
  await page.evaluate(() => {
    window.closingMarks = [];
    new MutationObserver(() => closingMarks.push(panelEl().dataset.closing === 'true' ? 'set' : 'cleared')).observe(
      panelEl(),
      { attributes: true, attributeFilter: ['data-closing'] }
    );
  });
  await openInstantly(page);
  await page.evaluate(() => {
    animationReads = 0;
    closingMarks.length = 0;
  });
  await page.evaluate(() => apply(false, 'instant'));
  await page.waitForFunction(() => log.includes('inert'), { timeout: 1000 });
  await page.evaluate(() => sleep(100));
  assert.equal(await page.evaluate(() => animationReads), 0, 'no animation read for an instant close');
  assert.deepEqual(await page.evaluate(() => [...closingMarks]), [], 'an instant close is never marked closing');

  await openInstantly(page);
  await page.evaluate(() => {
    animationReads = 0;
    closingMarks.length = 0;
  });
  await tap(page);
  assert.deepEqual((await finish(page)).slice(0, 3), SLIDE_THEN('inert'));
  assert.ok((await page.evaluate(() => animationReads)) > 0, 'the animated close reads its slide');
  assert.deepEqual(
    await page.evaluate(() => [...closingMarks]),
    ['set', 'cleared'],
    'displayed while sliding, cleared at the end'
  );
  assert.equal(await page.evaluate(() => panelEl().hasAttribute('data-closing')), false);
});

test('no slide to wait for: an instant close and a reduced-motion tap flip inert at once', async (t) => {
  const page = await launch(t);
  await openInstantly(page);
  await page.evaluate(() => apply(false, 'instant'));
  await page.waitForFunction(() => log.length > 0, { timeout: 1000 });
  assert.deepEqual(await page.evaluate(() => [...log]), ['inert']);

  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.evaluate(() => settled());
  await tap(page);
  await page.waitForFunction(() => log.length > 0, { timeout: 1000 });
  assert.deepEqual(await page.evaluate(() => [...log]), ['live'], 'cleared with no transitionend');
  await page.evaluate(() => settled());
  await tap(page);
  await page.waitForFunction(() => log.length > 0, { timeout: 1000 });
  assert.deepEqual(await page.evaluate(() => [...log]), ['inert']);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

// Closing the phone drawer: WorkbenchSidePanel closes semantically at once
// (hidden/inert/aria-hidden) but, inside .sidebar-drawer-frame, stays
// displayed (data-closing) until the frame's own transform transition ends, so
// the content slides out with the sheet. The real component runs in headless
// Chrome inside a frame that is re-rendered exactly as the drawer does.

const ENTRY = `
  import React from 'react';
  import { flushSync } from 'react-dom';
  import { createRoot } from 'react-dom/client';
  import { WorkbenchSidePanel } from './workbench-side-view-layout.tsx';
  const descriptors = new Map([['sessions', { id: 'sessions', label: 'Sessions', icon: () => null }]]);
  const root = createRoot(document.getElementById('root'));
  window.setDrawer = (open, motion = 'animated') =>
    flushSync(() =>
      root.render(
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
        )
      )
    );
`;

const PROBES = `
  window.frameEl = () => document.querySelector('.sidebar-drawer-frame');
  window.panelEl = () => document.querySelector('.workbench-side-panel');
  window.nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  window.snap = () => {
    const frame = frameEl();
    const panel = panelEl();
    return {
      left: Math.round(frame.getBoundingClientRect().left),
      frameVisibility: getComputedStyle(frame).visibility,
      display: getComputedStyle(panel).display,
      pointerEvents: getComputedStyle(panel).pointerEvents,
      closing: panel.dataset.closing ?? null,
      hidden: panel.hidden,
      inert: panel.inert,
      ariaHidden: panel.getAttribute('aria-hidden'),
      focusInside: panel.contains(document.activeElement),
    };
  };
  // Focus the button afresh: an element that held focus before it went inert
  // keeps it until the browser's focus fixup, which says nothing about reach.
  window.tryFocus = () => {
    document.activeElement?.blur();
    const button = document.getElementById('inside');
    button.focus();
    return document.activeElement === button;
  };
  // Samples every frame from the close commit until the panel is display:none.
  window.closeAndSample = async () => {
    const samples = [];
    setDrawer(false);
    samples.push(snap());
    while (samples.at(-1).display !== 'none') {
      await nextFrame();
      samples.push(snap());
    }
    return samples;
  };
  window.settle = async () => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    await nextFrame();
  };
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
      outfile: 'mobile-drawer-close-content.css',
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
  await page.evaluate(() => {
    setDrawer(true, 'instant');
  });
  await page.evaluate(() => settle());
  t.after(() => assert.deepEqual(errors, []));
  return page;
}

test('a closing drawer keeps its content on every slide frame, then drops out of layout and focus', async (t) => {
  const page = await launch(t);
  const open = await page.evaluate(() => snap());
  assert.equal(open.display, 'flex');
  assert.equal(open.frameVisibility, 'visible');
  assert.equal(await page.evaluate(() => tryFocus()), true, 'the open drawer content takes focus');

  const samples = await page.evaluate(() => closeAndSample());
  const sliding = samples.slice(0, -1);
  assert.ok(sliding.length > 5, 'the close is animated over several frames');
  const lefts = new Set(sliding.map((sample) => sample.left));
  assert.ok(lefts.size > 5 && Math.min(...lefts) < -200, 'the frame actually slides off screen');
  for (const [index, sample] of sliding.entries()) {
    assert.equal(sample.display, 'flex', `frame ${index}: the content is displayed`);
    assert.equal(sample.closing, 'true', `frame ${index}: marked closing`);
    // Semantic closure is immediate, but `inert` waits for the slide's end
    // (flipping it restyles the whole subtree): pointer-events:none and
    // aria-hidden cover the slide, and focus has left the drawer.
    assert.deepEqual(
      [sample.hidden, sample.inert, sample.ariaHidden, sample.pointerEvents, sample.focusInside],
      [true, false, 'true', 'none', false],
      `frame ${index}: hidden, aria-hidden, pointer-events:none, focus out, not yet inert`
    );
  }
  const end = samples.at(-1);
  assert.equal(end.display, 'none', 'after the transition the panel is out of layout');
  assert.equal(end.closing, null, 'the closing mark is cleared');
  await page.evaluate(() => settle());
  const rest = await page.evaluate(() => ({ ...snap(), focusable: tryFocus() }));
  assert.deepEqual(
    [rest.display, rest.frameVisibility, rest.inert, rest.focusable],
    ['none', 'hidden', true, false],
    'the settled closed drawer is display:none, visibility:hidden, inert and not focusable'
  );
});

test('reopening mid-close keeps the content and the open state', async (t) => {
  const page = await launch(t);
  const result = await page.evaluate(async () => {
    setDrawer(false);
    for (let index = 0; index < 4; index += 1) await nextFrame();
    const midway = snap();
    setDrawer(true);
    const afterReopen = snap();
    await settle();
    return { midway, afterReopen, rest: { ...snap(), focusable: tryFocus() } };
  });
  assert.ok(result.midway.left < 0 && result.midway.left > -300, 'the reopen interrupts a slide in progress');
  assert.equal(result.midway.display, 'flex');
  assert.equal(result.midway.inert, false, 'the interrupted close never went inert');
  assert.equal(result.afterReopen.display, 'flex');
  assert.equal(result.afterReopen.closing, null, 'a reopen clears the closing mark');
  assert.equal(result.afterReopen.inert, false);
  assert.deepEqual(
    [result.rest.display, result.rest.left, result.rest.frameVisibility, result.rest.inert, result.rest.focusable],
    ['flex', 0, 'visible', false, true]
  );
});

test('an instant close has no transition to wait for', async (t) => {
  const page = await launch(t);
  const sample = await page.evaluate(() => {
    setDrawer(false, 'instant');
    return snap();
  });
  assert.equal(sample.display, 'none');
  assert.equal(sample.closing, null);
});

test('reduced motion leaves no closing mark behind', async (t) => {
  const page = await launch(t);
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  const samples = await page.evaluate(() => closeAndSample());
  assert.equal(samples.at(-1).display, 'none');
  assert.equal(samples.at(-1).closing, null);
  const rest = await page.evaluate(async () => {
    await settle();
    return { ...snap(), focusable: tryFocus() };
  });
  assert.deepEqual([rest.display, rest.frameVisibility, rest.inert, rest.focusable], ['none', 'hidden', true, false]);
});

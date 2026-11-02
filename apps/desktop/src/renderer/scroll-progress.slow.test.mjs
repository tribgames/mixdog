import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
import { launchPuppeteerBrowser } from '../../../../src/runtime/shared/browser-launch.mjs';

// The edge fades follow the scroller from scroll-progress.ts on every layout:
// no CSS scroll timeline may exist (Electron 43 renderer CHECK on a mouse-up
// over a selection, frozen Android WebView flings). In a real Chrome against
// the app's own stylesheets, on desktop and on the phone layout: nothing is
// scroll-driven, and each fade matches the ranges the former timelines used at
// the top, in the middle and at the end.

const PAGE = `
  <div class="workbench-side-panel" data-side="left" style="display:contents">
  <aside class="sidebar session-sidebar" id="rail" style="display:flex;flex-direction:column;width:300px;height:640px">
    <header class="session-panel-header" id="header" style="flex:none;height:36px"></header>
    <div class="session-sidebar-sessions" id="sessions" style="flex:1 1 0;min-height:0;display:flex;flex-direction:column">
      <div class="session-sidebar-top-fade" id="topfade"></div>
      <div class="session-sidebar-scroll" id="list" style="flex:1 1 0;min-height:0;padding:0;margin:0"></div>
    </div>
    <div class="session-sidebar-scroll session-sidebar-panels" id="panels" style="flex:1 1 0;min-height:0;padding:0;margin:0">
      <div class="schedules-pane" data-surface-active="true">
        <div class="schedules-page" style="padding:0">
          <div class="sidebar-section-toolbar" id="toolbar" style="height:30px"></div>
          <div id="panel-rows"></div>
        </div>
      </div>
    </div>
  </aside>
  </div>
  <div class="transcript-shell" id="shell" style="position:relative;height:300px;width:300px">
    <div class="transcript-scroll-fade" id="fade" aria-hidden="true"></div>
    <div class="transcript" id="transcript" style="height:300px;overflow-y:auto;padding:0"><div id="thread" style="height:1200px"></div></div>
  </div>
  <div class="slash-palette" id="palette" style="position:fixed;left:320px;top:0;width:200px;height:160px;padding:0"></div>
  <div class="session-sidebar-scroll" id="short" style="position:fixed;left:540px;top:0;width:100px;height:200px;padding:0;margin:0"></div>`;

const FILL = `
  const rows = (id, count) => {
    document.getElementById(id).innerHTML = Array.from({ length: count }, (_, i) => '<div style="height:30px">row ' + i + '</div>').join('');
  };
  rows('list', 60);
  rows('panel-rows', 60);
  rows('palette', 20);
  rows('short', 2);
`;

const SCROLLERS = ['list', 'panels', 'transcript', 'palette'];

// Everything a fade shows, read from computed style, at the given positions.
const SAMPLE = `
  window.sample = async (id, top) => {
    const el = document.getElementById(id);
    el.scrollTop = top;
    for (let i = 0; i < 4; i += 1) await new Promise((resolve) => requestAnimationFrame(resolve));
    const style = (node, pseudo) => getComputedStyle(node, pseudo);
    const fade = (node) => [style(node).getPropertyValue('--sidebar-fade-top'), style(node).getPropertyValue('--sidebar-fade-bottom')];
    const values = {
      list: { topFade: style(document.getElementById('topfade')).opacity, fade: fade(el) },
      panels: { header: style(document.getElementById('header'), '::after').opacity, fade: fade(el),
        pin: style(document.getElementById('toolbar')).boxShadow },
      transcript: { fade: style(document.getElementById('fade')).opacity },
      palette: { fade: style(el).getPropertyValue('--mx-palette-fade') },
    };
    return { top: el.scrollTop, max: el.scrollHeight - el.clientHeight, ...values[id] };
  };
  window.scrollDriven = () => {
    const timelines = document.getAnimations().filter((animation) => animation.timeline instanceof ScrollTimeline).length;
    const declared = [];
    for (const node of document.querySelectorAll('*')) {
      for (const pseudo of [null, '::before', '::after']) {
        const style = getComputedStyle(node, pseudo);
        if (style.animationTimeline !== 'auto' || style.scrollTimelineName !== 'none') declared.push((node.id || node.className) + (pseudo || ''));
      }
    }
    return { timelines, declared };
  };
`;

const numbers = (value) => (String(value).match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
const near = (actual, expected, label) => {
  const a = numbers(actual.flat?.() ?? actual);
  const b = numbers(expected.flat?.() ?? expected);
  assert.equal(a.length, b.length, `${label}: ${JSON.stringify(actual)} vs ${JSON.stringify(expected)}`);
  a.forEach((value, index) =>
    assert.ok(Math.abs(value - b[index]) < 0.05, `${label}: ${JSON.stringify(actual)} vs ${JSON.stringify(expected)}`)
  );
};

// What the former timelines produced at scroll position `top` of `max`
// (animation ranges 0-12px, 0-32px, the first/last 4%, the final 24px).
const unit = (value) => Math.min(1, Math.max(0, value));
const expectedAt = (id, top, max) => {
  const ramp = (value) => `${(20 * unit(value / 0.04) * Math.min(max, 1)).toFixed(3)}px`;
  const fade = [ramp(top / Math.max(max, 1)), ramp(1 - top / Math.max(max, 1))];
  const tail = unit(top / 12);
  if (id === 'list') return { topFade: unit(top / 12), fade };
  if (id === 'panels') return { header: unit(top / 12), fade, tail: [0, 6 * tail, 4 * tail, 0] };
  if (id === 'transcript') return { fade: unit(top / 32) };
  return { fade: `${24 * unit((max - top) / 24)}px` };
};

test('every layout: no scroll-driven animation, fades follow the scroller over the former ranges', async (t) => {
  const resolveDir = fileURLToPath(new URL('.', import.meta.url));
  const [bundle, styles] = await Promise.all([
    build({
      stdin: {
        resolveDir,
        loader: 'tsx',
        contents: `
          import { createElement, useRef } from 'react';
          import { createRoot } from 'react-dom/client';
          import { bindScrollProgress, useScrollProgress } from './scroll-progress';
          window.bindScrollProgress = bindScrollProgress;
          function Probe() {
            const ref = useRef(null);
            useScrollProgress(ref);
            return createElement('div', { ref, id: 'hooked', style: { height: '100px', overflowY: 'auto' } },
              createElement('div', { style: { height: '500px' } }));
          }
          window.mountProbe = (host) => createRoot(host).render(createElement(Probe));`,
      },
      bundle: true,
      write: false,
      logLevel: 'error',
      format: 'iife',
      outfile: 'bind.js',
      define: { 'process.env.NODE_ENV': '"production"' },
    }),
    build({
      stdin: {
        resolveDir,
        loader: 'css',
        contents: ['font-faces', 'ui/tokens', 'styles', 'desktop', 'pane-layout']
          .map((sheet) => `@import "./${sheet}.css";`)
          .join('\n'),
      },
      outfile: 'scroll-progress.css',
      bundle: true,
      write: false,
      logLevel: 'error',
      external: ['*.woff2', '*.woff', '*.ttf', '*.otf', '*.svg', '*.png', '*.jpg', '*.webp', '*.gif'],
    }),
  ]);
  const browser = await launchPuppeteerBrowser(puppeteer, {
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 700 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent(`<!doctype html><html><head></head><body style="margin:0">${PAGE}</body></html>`);
  await page.addStyleTag({ content: styles.outputFiles.find((file) => file.path.endsWith('.css')).text });
  await page.addScriptTag({ content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text });
  await page.evaluate(`${FILL}${SAMPLE}`);

  const positions = async () =>
    page.evaluate((ids) => {
      const out = {};
      for (const id of ids) {
        const el = document.getElementById(id);
        const max = el.scrollHeight - el.clientHeight;
        // top / just inside the 12px and 32px ranges / 2% / middle / 12px and 3px short of the end / end.
        out[id] = [0, 6, 20, max * 0.02, max / 2, max - 12, max - 3, max];
      }
      return out;
    }, SCROLLERS);
  const measure = async () => {
    const at = await positions();
    const result = {};
    for (const id of SCROLLERS) {
      result[id] = [];
      for (const top of at[id]) result[id].push(await page.evaluate((id, top) => window.sample(id, top), id, top));
    }
    return result;
  };
  const none = { timelines: 0, declared: [] };
  assert.deepEqual(await page.evaluate('scrollDriven()'), none, 'desktop: no scroll-driven animation');

  // The hook binds on desktop (no phone marker).
  const hooked = await page.evaluate(async () => {
    const host = document.createElement('div');
    document.body.append(host);
    window.mountProbe(host);
    const frames = async () => {
      for (let i = 0; i < 3; i += 1) await new Promise((resolve) => requestAnimationFrame(resolve));
    };
    await frames();
    const el = document.getElementById('hooked');
    el.scrollTop = 50;
    await frames();
    return [el.style.getPropertyValue('--mx-scroll-top'), el.style.getPropertyValue('--mx-scroll-max')];
  });
  assert.deepEqual(hooked, ['50', '400'], 'desktop: useScrollProgress writes the scroller position');

  await page.evaluate(() => {
    window.unbinds = [
      window.bindScrollProgress(document.getElementById('list'), ':scope > .session-sidebar-top-fade'),
      window.bindScrollProgress(document.getElementById('panels'), ':scope > .session-panel-header'),
      window.bindScrollProgress(document.getElementById('transcript'), ':scope > .transcript-scroll-fade'),
      window.bindScrollProgress(document.getElementById('palette')),
      window.bindScrollProgress(document.getElementById('short')),
    ];
  });
  const check = (layout, measured) => {
    assert.ok(measured.list.at(-1).max > 100, 'the fixture scrolls');
    for (const id of SCROLLERS) {
      for (const actual of measured[id]) {
        const expected = expectedAt(id, actual.top, actual.max);
        const label = `${layout} ${id} @${actual.top}/${actual.max}`;
        near(actual.fade, expected.fade, `${label}: fade`);
        if (id === 'list') near(actual.topFade, expected.topFade, `${label}: header fade`);
        if (id === 'panels') {
          near(actual.header, expected.header, `${label}: title band`);
          near(numbers(actual.pin).slice(-4), expected.tail, `${label}: pinned control tail ${actual.pin}`);
        }
      }
    }
  };
  check('desktop', await measure());
  assert.deepEqual(await page.evaluate('scrollDriven()'), none, 'desktop: still none after scrolling');

  await page.evaluate(() => document.documentElement.setAttribute('data-mixdog-mobile-tabs', ''));
  check('phone', await measure());
  assert.deepEqual(await page.evaluate('scrollDriven()'), none, 'phone: no scroll-driven animation');
  await page.evaluate(() => document.documentElement.removeAttribute('data-mixdog-mobile-tabs'));

  // A list that cannot scroll keeps both fades at 0; growing it (no scroll event) starts the bottom fade.
  const fades = () =>
    page.evaluate(async () => {
      for (let i = 0; i < 3; i += 1) await new Promise((resolve) => requestAnimationFrame(resolve));
      const style = getComputedStyle(document.getElementById('short'));
      return [style.getPropertyValue('--sidebar-fade-top'), style.getPropertyValue('--sidebar-fade-bottom')];
    });
  assert.deepEqual(await fades(), ['0px', '0px'], 'a list that cannot scroll has no fade');
  await page.evaluate(() => {
    document.getElementById('short').innerHTML += Array.from(
      { length: 20 },
      () => '<div style="height:30px">x</div>'
    ).join('');
  });
  assert.deepEqual(await fades(), ['0px', '20px'], 'a list that grows scrollable fades its end');

  await page.evaluate(() => {
    for (const unbind of window.unbinds) unbind();
  });
  assert.equal(
    await page.evaluate(() => document.getElementById('list').style.getPropertyValue('--mx-scroll-top')),
    '',
    'unbinding removes the scroll position properties'
  );
  assert.deepEqual(errors, []);
});

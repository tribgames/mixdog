import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
import { launchPuppeteerBrowser } from '../../../../src/runtime/shared/browser-launch.mjs';

// The edge fades ride CSS scroll timelines on desktop. The Android WebView
// (153-156) freezes a fling while any scroll timeline is alive, so the phone
// layout drops them all and follows the scroller from scroll-progress.ts
// instead. In a real Chrome against the app's own stylesheets: the phone has no
// scroll-driven animation anywhere, its fades equal what the timelines produce
// on desktop at the top, in the middle and at the end, and desktop keeps them.

const PAGE = `
  <aside class="sidebar session-sidebar" id="rail" style="display:flex;flex-direction:column;width:300px;height:640px">
    <header class="session-panel-header" id="header" style="flex:none;height:36px"></header>
    <div class="session-sidebar-sessions" id="sessions" style="flex:1 1 0;min-height:0;display:flex;flex-direction:column">
      <nav class="session-sidebar-launchers" id="launchers" style="flex:none;height:40px;padding:0"></nav>
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
      list: { launchers: style(document.getElementById('launchers'), '::after').opacity, fade: fade(el) },
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

test('phone: no scroll-driven animation, fades follow the scroller exactly as the desktop timelines', async (t) => {
  const resolveDir = fileURLToPath(new URL('.', import.meta.url));
  const [bundle, styles] = await Promise.all([
    build({
      stdin: {
        resolveDir,
        loader: 'ts',
        contents: `import { bindScrollProgress } from './scroll-progress'; window.bindScrollProgress = bindScrollProgress;`,
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
  const rest = async () =>
    page.evaluate(async () => {
      for (const id of ['list', 'panels', 'transcript', 'palette']) document.getElementById(id).scrollTop = 0;
      for (let i = 0; i < 3; i += 1) await new Promise((resolve) => requestAnimationFrame(resolve));
    });

  // Desktop: the timelines are alive and produce the reference values.
  const before = await page.evaluate('scrollDriven()');
  assert.ok(before.timelines > 0, 'desktop keeps its scroll timelines');
  assert.ok(before.declared.includes('header::after'), 'the title-band fade is timeline-driven on desktop');
  const desktop = await measure();
  assert.ok(desktop.list.at(-1).max > 100, 'the fixture scrolls');
  assert.ok(
    desktop.panels.at(-3).header > 0.9 && desktop.panels[0].header === '0',
    'the reference fades actually move'
  );
  await rest();

  // Phone: marker on, scrollers bound.
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-mixdog-mobile-tabs', '');
    window.unbinds = [
      window.bindScrollProgress(document.getElementById('list'), ':scope > .session-sidebar-launchers'),
      window.bindScrollProgress(document.getElementById('panels'), ':scope > .session-panel-header'),
      window.bindScrollProgress(document.getElementById('transcript'), ':scope > .transcript-scroll-fade'),
      window.bindScrollProgress(document.getElementById('palette')),
      window.bindScrollProgress(document.getElementById('short')),
    ];
    // The fixture's header/launchers/fade hosts live next to different scrollers.
  });
  // Panel and session list hosts: the header follows the panels, the launchers the list.
  const phoneState = await page.evaluate('scrollDriven()');
  assert.deepEqual(phoneState, { timelines: 0, declared: [] }, 'phone: no scroll-driven animation');
  const phone = await measure();
  for (const id of SCROLLERS) {
    desktop[id].forEach((expected, index) => {
      const actual = phone[id][index];
      const label = `${id} @${expected.top}`;
      assert.equal(actual.max, expected.max, `${label}: same geometry`);
      assert.equal(actual.top, expected.top, `${label}: same position`);
      near(actual.fade, expected.fade, `${label}: fade`);
      if (id === 'list') near(actual.launchers, expected.launchers, `${label}: launchers`);
      if (id === 'panels') {
        near(actual.header, expected.header, `${label}: title band`);
        near(actual.pin, expected.pin, `${label}: pinned control tail`);
      }
    });
  }
  assert.deepEqual(
    await page.evaluate('scrollDriven()'),
    { timelines: 0, declared: [] },
    'phone: still none after scrolling'
  );

  // A list that cannot scroll keeps both fades at 0; growing it (no scroll event) starts the bottom fade.
  const fades = () =>
    page.evaluate(async () => {
      for (let i = 0; i < 3; i += 1) await new Promise((resolve) => requestAnimationFrame(resolve));
      const style = getComputedStyle(document.getElementById('short'));
      return [style.getPropertyValue('--sidebar-fade-top'), style.getPropertyValue('--sidebar-fade-bottom')];
    });
  assert.deepEqual(await fades(), ['0px', '0px'], 'phone: a list that cannot scroll has no fade');
  await page.evaluate(() => {
    document.getElementById('short').innerHTML += Array.from(
      { length: 20 },
      () => '<div style="height:30px">x</div>'
    ).join('');
  });
  assert.deepEqual(await fades(), ['0px', '20px'], 'phone: a list that grows scrollable fades its end');

  // Back to desktop: the properties are gone and the timelines return.
  await page.evaluate(() => {
    for (const unbind of window.unbinds) unbind();
    document.documentElement.removeAttribute('data-mixdog-mobile-tabs');
  });
  const after = await page.evaluate('scrollDriven()');
  assert.ok(after.timelines > 0, 'desktop again: scroll timelines return');
  assert.equal(
    await page.evaluate(() => document.getElementById('list').style.getPropertyValue('--mx-scroll-top')),
    '',
    'desktop again: the scroll position properties are removed'
  );
  assert.deepEqual(errors, []);
});

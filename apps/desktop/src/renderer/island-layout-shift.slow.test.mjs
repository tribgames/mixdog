// The composer island on a real page with the app's stylesheets: a change in
// the bar or in an open panel moves nothing in the frame it lands, and what it
// displaces is eased to its new place.
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

const resolveDir = fileURLToPath(new URL('.', import.meta.url));

const PAGE = `
  import React from 'react';
  import { flushSync } from 'react-dom';
  import { createRoot } from 'react-dom/client';
  import { ComposerIsland } from './ComposerIsland.tsx';
  import { ISLAND_GLIDE_ID } from './composer-island-layout.ts';
  const h = React.createElement;
  const NOW = Date.now();
  window.__agent = (tag, overrides = {}) => ({
    tag, agent: 'worker', sessionId: 's-' + tag, ownerSessionId: 'lead', provider: 'anthropic', model: 'claude-opus-4-5',
    effort: 'medium', status: 'running', stage: 'running', startedAt: NOW - 60_000,
    turnStartedAt: new Date(NOW - 125_000).toISOString(), todo: { completed: 2, total: 5 }, ...overrides,
  });
  let rows = [];
  let revision = 1;
  const listeners = new Set();
  window.mixdogDesktop = {
    sections: {
      core: async () => false,
      snapshot: async () => ({ status: 'ready', entries: [{ section: 'agentPool', key: null, revision, value: rows }] }),
      subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    },
    invokeCapability: async () => ({ value: null }),
  };
  window.__pool = (next) => {
    rows = next;
    revision += 1;
    const entry = { section: 'agentPool', key: null, revision, value: rows };
    flushSync(() => { for (const listener of [...listeners]) listener({ kind: 'sections', changes: [{ section: 'agentPool', key: null, entry }] }); });
  };
  const segment = (id, text) => h('button', { type: 'button', className: 'composer-island-seg', 'data-probe': id }, text);
  flushSync(() => createRoot(document.getElementById('dock')).render(h(React.Fragment, null,
    h(ComposerIsland, {
      sessionId: 'lead',
      branch: () => segment('branch', 'feature/island-layout'),
      files: segment('files', '12 files'),
      onOpenAgentSession() {},
    }),
    h('form', { className: 'composer', style: { height: '96px' } }))));
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  window.__glides = () => document.getAnimations().filter((animation) => animation.id === ISLAND_GLIDE_ID);
  // Resting: nothing animates toward an end (the running pulse never ends)
  // and the island's box held for three frames.
  const moving = () => document.getAnimations().some((animation) => animation.effect?.getComputedTiming().endTime !== Infinity);
  window.__calm = async () => {
    let last = '';
    let same = 0;
    const start = performance.now();
    while (same < 3) {
      if (performance.now() - start > 5000) throw new Error('the island never came to rest');
      await frame();
      const box = document.querySelector('.composer-island').getBoundingClientRect();
      const now = moving() ? '' : [box.left, box.top, box.width, box.height].join();
      same = now && now === last ? same + 1 : 0;
      last = now;
    }
  };
  const rect = (node) => { const b = node.getBoundingClientRect(); return [b.left, b.top, b.width, b.height]; };
  // Where everything is painted: boxes with any running glide applied, and the
  // pill's frame (its own layer while it glides).
  window.__painted = () => {
    const island = document.querySelector('.composer-island');
    const out = { island: rect(island), composer: rect(document.querySelector('form.composer')) };
    const box = island.getBoundingClientRect();
    const layer = island.hasAttribute('data-glide') ? getComputedStyle(island, '::before') : null;
    out.frame = [box.left + (layer ? parseFloat(layer.left) : 0), box.right - (layer ? parseFloat(layer.right) : 0)];
    for (const node of island.querySelectorAll('.composer-island-pill > [data-probe]')) out['seg:' + node.dataset.probe] = rect(node);
    const head = island.querySelector('.composer-island-phead');
    if (head) out.head = rect(head);
    for (const row of island.querySelectorAll('.agent-pool-row')) {
      const tag = row.dataset.agentTag;
      out['row:' + tag] = rect(row);
      out['copy:' + tag] = rect(row.querySelector('.schedules-row-copy'));
      const mark = row.querySelector('.agent-todo-mark');
      if (mark) out['mark:' + tag] = rect(mark);
    }
    return out;
  };
  // Applies a change, lets its observers run, and reads it painted at the
  // glides' start and at their end.
  window.__change = async (apply) => {
    await window.__calm();
    const before = window.__painted();
    apply();
    // The island's observers (and those their changes wake) have run.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const glides = window.__glides();
    for (const glide of glides) { glide.pause(); glide.currentTime = 0; }
    const start = window.__painted();
    for (const glide of glides) glide.finish();
    await window.__calm();
    return { before, start, end: window.__painted(), glides: glides.length };
  };
`;

/** Every key of both snapshots whose box differs by more than half a pixel. */
function moved(a, b, keys = Object.keys(a)) {
  return keys
    .filter((key) => a[key] && b[key])
    .filter((key) => a[key].some((value, index) => Math.abs(value - b[key][index]) > 0.5))
    .map((key) => `${key} ${a[key].map(Math.round)} -> ${b[key].map(Math.round)}`);
}

let shared = null;
function sharedBrowser() {
  shared ??= (async () => {
    const plugins = [
      {
        name: 'worker-stub',
        setup(builder) {
          builder.onResolve({ filter: /\?worker$/ }, (args) => ({ path: args.path, namespace: 'worker-stub' }));
          builder.onLoad({ filter: /.*/, namespace: 'worker-stub' }, () => ({ contents: 'export default class {};' }));
        },
      },
    ];
    const loader = { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl' };
    const bundle = (contents, kind) =>
      build({
        stdin: { contents, resolveDir, loader: kind },
        outfile: 'island-layout-shift.out',
        bundle: true,
        write: false,
        format: 'iife',
        jsx: 'automatic',
        logLevel: 'silent',
        plugins,
        loader: { ...loader, '.jpg': 'dataurl' },
      });
    const [script, styles] = await Promise.all([
      bundle(PAGE, 'tsx'),
      bundle('@import "./ui/tokens.css"; @import "./styles.css"; @import "./desktop.css";', 'css'),
    ]);
    const browser = await puppeteer.launch({
      ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
      headless: true,
    });
    return {
      browser,
      js: script.outputFiles.find((file) => file.path.endsWith('.out')).text,
      css: styles.outputFiles.find((file) => file.path.endsWith('.out')).text,
    };
  })();
  return shared;
}
after(async () => {
  if (shared) await (await shared).browser.close();
});

const SURFACES = [
  { name: 'desktop', viewport: { width: 1280, height: 800 }, phone: false },
  { name: 'phone 360', viewport: { width: 360, height: 740, isMobile: true, hasTouch: true }, phone: true },
];

async function islandPage(t, surface) {
  const { browser, js, css } = await sharedBrowser();
  const page = await browser.newPage();
  t.after(() => page.close());
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.setViewport(surface.viewport);
  await page.setContent(
    `<!doctype html><html${surface.phone ? ' data-mixdog-mobile-tabs' : ''}><head><style>${css}
      #pane { position: fixed; inset: 0; display: flex; flex-direction: column; }
      #pane > .fill { flex: 1 1 0; min-height: 0; }
      #dock { flex: none; width: 100%; max-width: 760px; margin: 0 auto; padding: 0 12px 12px; }
    </style></head><body><section class="conversation" id="pane"><div class="fill"></div><div class="composer-region" id="dock"></div></section></body></html>`
  );
  await page.addScriptTag({ content: js });
  return page;
}

for (const surface of SURFACES) {
  test(`bar (${surface.name}): a segment arriving, leaving or gaining a digit moves no neighbour in its first frame`, async (t) => {
    const page = await islandPage(t, surface);
    const neighbours = ['seg:branch', 'seg:files', 'frame'];
    const cases = [
      ['the agents segment arrives', () => window.__pool([window.__agent('a')])],
      [
        'its count gains a digit',
        () => window.__pool(Array.from({ length: 10 }, (_, index) => window.__agent(`a${index}`))),
      ],
      ['the agents segment leaves', () => window.__pool([])],
    ];
    // A segment's place is its leading edge: the fit (compact, tight) may give
    // a segment other padding at once, never another place.
    const places = (snapshot) =>
      Object.fromEntries(Object.entries(snapshot).map(([key, box]) => [key, key === 'frame' ? box : box.slice(0, 2)]));
    for (const [label, apply] of cases) {
      const { before, start, end, glides } = await page.evaluate(
        (body) => window.__change(new Function(`return (${body})()`)),
        apply.toString()
      );
      assert.deepEqual(moved(places(before), places(start), neighbours), [], `${label}: painted where they were`);
      assert.ok(glides > 0 && moved(before, end, neighbours).length > 0, `${label}: then eased to their new place`);
      assert.deepEqual(moved(before, end, ['composer']), [], `${label}: the composer stays`);
    }
  });

  test(`agents panel (${surface.name}): rows arriving, leaving or reordering move nothing in their first frame`, async (t) => {
    const page = await islandPage(t, surface);
    await page.evaluate(() => window.__pool([window.__agent('first')]));
    await page.click('.composer-island-seg-agents');
    // The panel's height change once settled: one row's height, either way.
    const cases = [
      ['a row arrives', () => window.__pool([window.__agent('first'), window.__agent('second')]), 1],
      [
        'a running row fails and moves below the others',
        () => window.__pool([window.__agent('first', { status: 'failed', stage: 'failed' }), window.__agent('second')]),
        0,
      ],
      ['a row leaves', () => window.__pool([window.__agent('second')]), -1],
    ];
    for (const [label, apply, rowsAdded] of cases) {
      const { before, start, end, glides } = await page.evaluate(
        (body) => window.__change(new Function(`return (${body})()`)),
        apply.toString()
      );
      const kept = Object.keys(before).filter((key) => /^(island|head|row:|copy:|mark:)/.test(key) && key in end);
      assert.deepEqual(moved(before, start, kept), [], `${label}: painted where it was`);
      assert.ok(glides > 0 && moved(before, end, kept).length > 0, `${label}: then eased to its new place`);
      assert.deepEqual(moved(before, end, ['composer']), [], `${label}: the composer stays`);
      // One row's stride in the list (its height and the gap after it).
      const both = before['row:first'] && before['row:second'] ? before : end;
      const rowHeight = Math.abs(both['row:second'][1] - both['row:first'][1]);
      assert.ok(
        Math.abs(end.island[3] - before.island[3] - rowsAdded * rowHeight) <= 1,
        `${label}: the panel settles ${rowsAdded} row(s) taller: ${before.island[3]} -> ${end.island[3]}`
      );
    }
  });

  test(`agents panel (${surface.name}): a row's state, clock or list overflow moves no other row's columns`, async (t) => {
    const page = await islandPage(t, surface);
    await page.evaluate(() => window.__pool(['a', 'b', 'c'].map((tag) => window.__agent(tag))));
    await page.click('.composer-island-seg-agents');
    const cases = [
      [
        'b is queued instead of running a clock',
        `() => window.__pool([window.__agent('a'), window.__agent('b', { status: 'queued', stage: 'queued' }), window.__agent('c')])`,
        ['a', 'c'],
      ],
      [
        "a's clock passes the hour",
        `() => window.__pool([window.__agent('a', { turnStartedAt: new Date(Date.now() - 3_700_000).toISOString() }), window.__agent('b', { status: 'queued', stage: 'queued' }), window.__agent('c')])`,
        ['b', 'c'],
      ],
      [
        'the list grows past its room and scrolls',
        `() => window.__pool([window.__agent('a'), window.__agent('b', { status: 'queued', stage: 'queued' }), window.__agent('c'), ...Array.from({ length: 9 }, (_, i) => window.__agent('x' + i))])`,
        ['a', 'b', 'c'],
      ],
    ];
    for (const [label, body, tags] of cases) {
      const { before, end } = await page.evaluate(
        (source) => window.__change(new Function(`return (${source})()`)),
        body
      );
      const keys = tags.flatMap((tag) => [`copy:${tag}`, `mark:${tag}`]).filter((key) => before[key]);
      // Rows may move as a whole (the panel grows); their columns may not move within them.
      const relative = (snapshot) =>
        Object.fromEntries(
          keys.map((key) => {
            const row = snapshot[`row:${key.split(':')[1]}`];
            const box = snapshot[key];
            return [key, [box[0] - row[0], box[2], box[3]]];
          })
        );
      assert.deepEqual(moved(relative(before), relative(end)), [], `${label}: the other rows' columns stay`);
    }
  });
}

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
  // Folds or unfolds the kind line at \`index\` and reads, every frame of the
  // glide that follows, the island's box, its head's and foot's, and the rows
  // of the kinds after it.
  window.__foldFrames = async (index) => {
    await window.__calm();
    const island = document.querySelector('.composer-island');
    const fold = island.querySelectorAll('.composer-island-agent-fold')[index];
    const group = fold.closest('.composer-island-agent-group');
    const later = () => {
      const children = [...group.parentElement.children];
      const next = children.findIndex((child, at) => at > children.indexOf(group) && child.matches('.composer-island-agent-group'));
      return next < 0 ? [] : children.slice(next).flatMap((child) => [...child.querySelectorAll('.agent-pool-row')]);
    };
    const read = () => ({
      island: rect(island),
      head: rect(island.querySelector('.composer-island-phead')),
      foot: rect(island.querySelector('.composer-island-panel-foot')),
      rows: Object.fromEntries(later().map((row) => [row.dataset.agentTag, rect(row)])),
    });
    const frames = [read()];
    fold.click();
    for (let i = 0; i < 24; i += 1) {
      await frame();
      frames.push(read());
    }
    return { frames, glided: frames.some((at, i) => i > 0 && Math.abs(at.island[3] - frames[0].island[3]) > 0.5) };
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

// The real tabs of each panel family: a panel of the island's own (shells),
// one a segment carries inside the pill (git), and the Goal drawer.
const PANELS_PAGE = `
  import React from 'react';
  import { flushSync } from 'react-dom';
  import { createRoot } from 'react-dom/client';
  import { ComposerDock } from './ComposerDock.tsx';
  import { SessionGoalIsland } from './SessionGoalIsland.tsx';
  import { defaultSessionLaneStore } from './session-lane-store.ts';
  const id = 'panels';
  const cwd = '/repo/wt';
  const status = { repository: true, root: cwd, branch: 'feature/panels', detached: false, unborn: false, upstream: true,
    upstreamName: 'o/m', remote: true, ahead: 0, behind: 0, operation: '',
    files: ['a.ts', 'b.ts', 'c.ts'].map((path) => ({ path, status: 'M', additions: 11, deletions: 2 })) };
  const workspace = { projectPath: '/repo', repoCommonDir: '/repo/.git', cwd, worktreeId: null, branch: 'feature/panels',
    baseCommit: 'abc', mergeTarget: null, revision: 1, transition: { state: 'idle', txId: null } };
  window.mixdogDesktop = new Proxy({
    sections: { core: async () => false, snapshot: async () => ({ status: 'ready', entries: [{ section: 'agentPool', key: null, revision: 1, value: [] }] }), subscribe: () => () => {} },
    gitStatus: async () => status,
    gitReview: async () => ({ repository: true, root: cwd, base: 'HEAD', files: status.files.map((f) => ({ ...f, untracked: false })) }),
    invokeCapability: async (request) => request.capability === 'getBranchMenu'
      ? { value: { workspace, branches: [], occupancy: [], retainedWorktree: null } }
      : { value: { supported: true, authoritative: true, files: [], patch: '', historyTurns: 1 } },
  }, { get: (target, name) => (name in target ? target[name] : String(name).startsWith('subscribe') ? () => () => {} : async () => []) });
  const todo = { phases: [{ name: 'Plan', tasks: ['Read the files', 'Edit three files', 'Check the agents', 'Review the diff', 'Write the summary']
    .map((content, index) => ({ content, status: index === 0 ? 'completed' : index === 1 ? 'in_progress' : 'pending' })) }],
    completed: 1, abandoned: 0, total: 5 };
  const goal = { id: 'g', title: 'Polish the notes', objective: 'Polish the demo notes, keep a long watch running and report what changed once both helper agents have finished.',
    status: 'active', timeUsedMs: 76 * 60_000, startedAt: Date.now() - 76 * 60_000 };
  defaultSessionLaneStore.apply({ sessionId: id, snapshot: { sessionId: id, goal, todo,
    shellJobs: { count: 2, jobs: ['npm test', 'npm run watch'].map((command, index) => ({ taskId: 'j' + index, command, startedAt: Date.now() })) } } });
  flushSync(() => createRoot(document.getElementById('dock')).render(
    React.createElement(ComposerDock, {
      sessionId: id, reviewSessionId: id, goalSubmissionId: '', showProjectSelector: false,
      goalIsland: React.createElement(SessionGoalIsland, { snapshot: { sessionId: id, goal, todo } }),
      reviewItems: [{ kind: 'turndone', id: 'done' }], reviewActive: true, reviewBusy: false,
      reviewCwd: cwd, workspace, onOpenSessionDiff: () => {},
      children: React.createElement('form', { className: 'composer', style: { height: '96px' } }),
    })));
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  const box = (node) => { const b = node.getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height }; };
  const shown = (selector) => [...document.querySelectorAll(selector)].find((node) => node.getClientRects().length > 0);
  // The dock's floor (the input's height), then the tab opened from its
  // segment, read each frame from its first laid out one, and closed again.
  window.__openTab = async (trigger, floor) => {
    document.querySelector('form.composer').style.height = floor + 'px';
    for (let i = 0; i < 10; i += 1) await frame();
    const island = document.querySelector('.composer-island');
    const pill = box(island);
    document.querySelector(trigger).click();
    const frames = [];
    // Past the opening's rise and a glide (240 and 200ms).
    for (let i = 0; i < 24; i += 1) {
      await frame();
      // Something in the open tab updates in place, as a clock does.
      if (i === 1) shown('.composer-island :is(.composer-island-pbody, .session-goal-content)').append('');
      const at = box(island);
      // The panel's first part (its head) and its last (the foot, or the list).
      const panel = shown('.composer-island :is(.composer-island-panel, .session-goal-panel)');
      const head = box(panel.firstElementChild);
      const end = box(panel.lastElementChild);
      frames.push({ island: at, overflow: island.scrollHeight - island.clientHeight, head: head.top - at.top, end: at.bottom - end.bottom });
    }
    shown('.composer-island-close').click();
    for (let i = 0; i < 20; i += 1) await frame();
    return { pill, frames, back: box(island), room: parseFloat(island.closest('.composer-island-slot').style.getPropertyValue('--island-panel-room')) };
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
    const [script, panels, styles] = await Promise.all([
      bundle(PAGE, 'tsx'),
      bundle(PANELS_PAGE, 'tsx'),
      bundle('@import "./ui/tokens.css"; @import "./styles.css"; @import "./desktop.css";', 'css'),
    ]);
    const browser = await puppeteer.launch({
      ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
      headless: true,
    });
    return {
      browser,
      js: script.outputFiles.find((file) => file.path.endsWith('.out')).text,
      panelsJs: panels.outputFiles.find((file) => file.path.endsWith('.out')).text,
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

async function islandPage(t, surface, script = 'js') {
  const { browser, css, ...scripts } = await sharedBrowser();
  const js = scripts[script];
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

  test(`agents panel (${surface.name}): rows arriving or leaving ease from their prior frame while a failing row stays in place`, async (t) => {
    const page = await islandPage(t, surface);
    await page.evaluate(() => window.__pool([window.__agent('first')]));
    await page.click('.composer-island-seg-agents');
    // The panel's height change once settled: one row's height, either way.
    const cases = [
      ['a row arrives', () => window.__pool([window.__agent('first'), window.__agent('second')]), 1, true],
      [
        'a running row fails and stays in place',
        () => window.__pool([window.__agent('first', { status: 'failed', stage: 'failed' }), window.__agent('second')]),
        0,
        false,
      ],
      ['a row leaves', () => window.__pool([window.__agent('second')]), -1, true],
    ];
    for (const [label, apply, rowsAdded, eases] of cases) {
      const { before, start, end, glides } = await page.evaluate(
        (body) => window.__change(new Function(`return (${body})()`)),
        apply.toString()
      );
      const kept = Object.keys(before).filter((key) => /^(island|head|row:|copy:|mark:)/.test(key) && key in end);
      assert.deepEqual(moved(before, start, kept), [], `${label}: painted where it was`);
      if (eases) {
        assert.ok(glides > 0 && moved(before, end, kept).length > 0, `${label}: then eased to its new place`);
      } else {
        const rows = Object.keys(before).filter((key) => /^(island|head|row:)/.test(key) && key in end);
        assert.equal(glides, 0, `${label}: triggers no row glide`);
        assert.deepEqual(moved(before, end, rows), [], `${label}: keeps every row in place`);
      }
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

  test(`agents panel (${surface.name}): folding or unfolding a kind moves only the body's room: the foot and head ride the island's edges, the foot and the later kinds' rows never move`, async (t) => {
    const page = await islandPage(t, surface);
    await page.evaluate(() =>
      window.__pool([
        window.__agent('r1', { agent: 'reviewer' }),
        window.__agent('r2', { agent: 'reviewer' }),
        window.__agent('w1'),
        window.__agent('w2'),
        window.__agent('w3'),
      ])
    );
    await page.click('.composer-island-seg-agents');
    for (const label of ['fold', 'unfold']) {
      const { frames, glided } = await page.evaluate(() => window.__foldFrames(0));
      assert.ok(glided, `${label}: the island's height changes`);
      const [first] = frames;
      assert.ok(Object.keys(first.rows).length === 3, `${label}: the later kind's rows are read`);
      for (const [index, at] of frames.entries()) {
        const where = `${label}, frame ${index}`;
        const bottom = (box) => box[1] + box[3];
        assert.ok(Math.abs(bottom(at.foot) - bottom(at.island)) <= 0.5, `${where}: the foot off the island's bottom`);
        assert.ok(Math.abs(at.head[1] - at.island[1]) <= 0.5, `${where}: the head off the island's top`);
        assert.deepEqual(moved({ foot: first.foot }, { foot: at.foot }), [], `${where}: the foot moved`);
        assert.deepEqual(moved(first.rows, at.rows), [], `${where}: a later kind's row moved`);
      }
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

test("the island's one-line rows stand on the 32px pitch, agents' and shells' alike, and a shell's Stop (12px) or Dismiss (16px) is a mark in the strong ink", async (t) => {
  const agents = await islandPage(t, SURFACES[0]);
  await agents.evaluate(() => window.__pool(['a', 'b'].map((tag) => window.__agent(tag))));
  await agents.click('.composer-island-seg-agents');
  await agents.waitForSelector('.composer-island-panel .agent-pool-row');
  const agentRows = await agents.$$eval('.composer-island-panel .agent-pool-row', (rows) =>
    rows.map((row) => row.getBoundingClientRect().height)
  );
  assert.ok(agentRows.length === 2);
  for (const height of agentRows) assert.ok(Math.abs(height - 32) <= 0.5, `an agent row ${height}px`);
  const shells = await islandPage(t, SURFACES[0], 'panelsJs');
  await shells.waitForSelector('.composer-island-seg-shell');
  await shells.click('.composer-island-seg-shell');
  await shells.waitForSelector('.composer-island-panel .composer-island-row');
  const read = await shells.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--mx-text)';
    document.querySelector('.composer-island-panel').append(probe);
    const strong = getComputedStyle(probe).color;
    probe.remove();
    return {
      strong,
      rows: [...document.querySelectorAll('.composer-island-panel .composer-island-row')].map(
        (row) => row.getBoundingClientRect().height
      ),
      marks: [...document.querySelectorAll('.composer-island-panel .composer-island-row-actions > [data-icon]')].map(
        (button) => {
          const svg = button.querySelector('svg').getBoundingClientRect();
          return { icon: button.dataset.icon, size: [svg.width, svg.height], color: getComputedStyle(button).color };
        }
      ),
    };
  });
  assert.ok(read.rows.length === 2 && read.marks.length > 0, JSON.stringify(read));
  for (const height of read.rows) assert.ok(Math.abs(height - 32) <= 0.5, `a shell row ${height}px`);
  for (const mark of read.marks) {
    // Stop's filled square at the 12px state marks' size, so it weighs no more than the row's clock.
    const size = mark.icon === 'stop' ? 12 : 16;
    assert.deepEqual(mark.size, [size, size], "a shell mark's size");
    assert.equal(mark.color, read.strong, "a shell mark's ink at rest");
  }
});

test('each panel family opens at its final size and place, and closes back to the pill where it was', async (t) => {
  const page = await islandPage(t, SURFACES[0], 'panelsJs');
  for (const [family, trigger] of [
    ['a panel of its own (shells)', '.composer-island-seg-shell'],
    ['a panel carried in the pill (git)', '.composer-island-git-main'],
    ['the Goal drawer', '.session-goal-trigger'],
  ]) {
    await t.test(family, async () => {
      // A tall room first, then a floor so high the panel is held under its
      // content: the room the panel opens into moved while the pill rested.
      const free = await page.evaluate((selector) => window.__openTab(selector, 96), trigger);
      const natural = free.frames[0].island.height;
      const floor = 96 + free.room - natural + 40;
      const held = await page.evaluate((selector, height) => window.__openTab(selector, height), trigger, floor);
      assert.ok(
        held.frames[0].island.height < natural - 20,
        `held under its content: ${natural} -> ${held.frames[0].island.height}`
      );
      for (const [label, run] of [
        ['free', free],
        ['held', held],
      ]) {
        const [first] = run.frames;
        for (const [index, at] of run.frames.entries()) {
          const where = `${label}, frame ${index}`;
          assert.ok(at.overflow <= 0, `${where}: the island scrolls itself by ${at.overflow}px`);
          assert.ok(
            Math.abs(at.island.width - first.island.width) <= 0.5,
            `${where}: width ${first.island.width} -> ${at.island.width}`
          );
          assert.ok(
            Math.abs(at.island.height - first.island.height) <= 0.5,
            `${where}: height ${first.island.height} -> ${at.island.height}`
          );
          assert.ok(
            Math.abs(at.head - first.head) <= 0.5 && Math.abs(at.end - first.end) <= 0.5,
            `${where}: head or foot slid`
          );
        }
        assert.deepEqual(
          moved({ pill: Object.values(run.pill) }, { pill: Object.values(run.back) }),
          [],
          `${label}: the pill comes back where it was`
        );
      }
    });
  }
});

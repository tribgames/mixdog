// Records what the Node transcript scroll engine does, so the Rust one (`mixdog_tui::transcript::scroll`) is checked against it
// (tests/transcript_scroll.rs).
//
// The Node code is only read: the modules are imported from <tree>/src/tui/app, nothing is written there.
//
//   node record-scroll.mjs --tree C:/Project/mixdog --write tests/goldens/scroll.json
//   node record-scroll.mjs --tree C:/Project/mixdog --check tests/goldens/scroll.json
//
// Recorded:
//  * tuning    - every MIXDOG_TUI_SCROLL_* variable set, unset and mistyped: transcript-window.mjs is imported afresh under each
//                environment and its constants are read;
//  * wheel     - createWheelRouter over scripted wheel bursts with a fake Date.now: the rows each notch queues (the acceleration);
//  * anchors   - readingAnchorAt and captureTopEdgeAnchor over generated geometries and targets, bottomSnapRows,
//                resolveAnchorScrollOffset and transcriptSwapReturnsToTail over grids;
//  * coalesce  - accumulateDirectionalScrollDelta over delta sequences;
//  * render    - resolveRenderScrollOffset over seeded scroll states, row tables and viewports: the offset and the refs after;
//  * commit    - syncReadingAnchorAfterCommit, resetScrollWhenUnanchored and clampScrollToOverflow over seeded states;
//  * engine    - useTranscriptScroll mounted on ink with scripted sequences (scrolls, smooth glides, history paging, blocked
//                read-back replay, coalesced wheel, reset and arm): the refs and the published offsets after every step;
//  * swap      - useTranscriptSwapReset over sequences of item lists: the resets it asked for;
//  * activity  - useTranscriptActivity over states: the agent revision, the active-tool segments and the stats projection.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const tree = option('--tree');
if (!tree || (!option('--write') && !option('--check') && !args.includes('--wheel-child'))) {
  console.error('usage: record-scroll.mjs --tree <mixdog checkout> (--write <golden.json> | --check <golden.json>)');
  process.exit(2);
}

if (args.includes('--wheel-child')) {
  const router = await import(pathToFileURL(join(tree, 'src/tui/app/mouse-input/wheel-router.mjs')).href);
  const bursts = JSON.parse(process.env.RECORD_SCROLL_BURSTS);
  const rows = bursts.map((burst) => {
    const queued = [];
    const handle = router.createWheelRouter({
      dragRef: { current: { active: false } },
      slashPaletteRef: { current: { open: false, count: 0 } },
      scrollFocusRef: { current: {} },
      wheelAccelRef: { current: { dir: 0, t: 0, step: Number(process.env.MIXDOG_TUI_SCROLL_SPEED) || 3 } },
      setSlashIndex: () => {},
      queueScrollCoalesced: (queuedRows) => queued.push(queuedRows),
      passthroughCtrlWheelZoom: () => {},
      finalizeActiveDrag: () => {},
      finishWindowsMouseGesture: () => {},
      stopEdgeAutoscroll: () => {},
    });
    const realNow = Date.now;
    try {
      for (const [direction, at] of burst) {
        Date.now = () => at;
        handle({ name: direction > 0 ? 'wheelup' : 'wheeldown', sequence: '' });
      }
    } finally {
      Date.now = realNow;
    }
    return queued;
  });
  process.stdout.write(JSON.stringify(rows));
  process.exit(0);
}

const sources = [];
const sourceUrl = (path) => {
  const file = join(tree, path);
  if (!sources.some((source) => source.path === path)) {
    sources.push({ path, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') });
  }
  return pathToFileURL(file).href;
};
const load = (path, query = '') => import(sourceUrl(path) + query);
// React and Ink resolve from the tree's own node_modules.
const treeImport = (name) => import(pathToFileURL(join(tree, 'node_modules', name)).href).catch(() => import(name));

const windowPath = 'src/tui/app/transcript-window.mjs';
const { resolveAnchorScrollOffset, transcriptSwapReturnsToTail, accumulateDirectionalScrollDelta } = await load(windowPath);
const { readingAnchorAt, bottomSnapRows } = await load('src/tui/app/transcript-scroll-anchor.mjs');
const { captureTopEdgeAnchor, resolveRenderScrollOffset } = await load('src/tui/app/transcript-anchor-lock.mjs');
const { syncReadingAnchorAfterCommit, resetScrollWhenUnanchored, clampScrollToOverflow } = await load(
  'src/tui/app/transcript-anchor-sync.mjs'
);
const { useTranscriptScroll } = await load('src/tui/app/use-transcript-scroll.mjs');
const { useTranscriptSwapReset } = await load('src/tui/app/use-transcript-swap-reset.mjs');
const { useTranscriptActivity } = await load('src/tui/app/use-transcript-activity.mjs');
await load('src/tui/app/use-transcript-follow.mjs');
await load('src/tui/app/use-transcript-scroll-state.mjs');
const React = (await treeImport('react/index.js')).default;
const { Text, render } = await treeImport('ink/build/index.js');

// A seeded generator keeps the corpus stable across runs.
let seed = 0x5c011;
const random = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (lo, hi) => lo + Math.floor(random() * (hi - lo + 1));
const pick = (list) => list[int(0, list.length - 1)];
const chance = (p) => random() < p;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── tuning ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
const TUNING_ENV = [
  {},
  { MIXDOG_TUI_SCROLL_SPEED: '5' },
  { MIXDOG_TUI_SCROLL_SPEED: '5', MIXDOG_TUI_SCROLL_SPEED_MAX: '4' },
  { MIXDOG_TUI_SCROLL_SPEED: '2', MIXDOG_TUI_SCROLL_SPEED_MAX: '40' },
  { MIXDOG_TUI_SCROLL_SPEED_MAX: '7' },
  { MIXDOG_TUI_SCROLL_SPEED: '0' },
  { MIXDOG_TUI_SCROLL_SPEED: '-3', MIXDOG_TUI_SCROLL_SPEED_MAX: 'abc' },
  { MIXDOG_TUI_SCROLL_SPEED: ' 7 ', MIXDOG_TUI_SCROLL_COALESCE_MS: '2.9' },
  { MIXDOG_TUI_SCROLL_SPEED: '0x10', MIXDOG_TUI_SCROLL_ACCEL_IDLE_MS: '1e2' },
  { MIXDOG_TUI_SCROLL_COALESCE_MS: '33', MIXDOG_TUI_SCROLL_ACCEL_IDLE_MS: '500' },
  { MIXDOG_TUI_SCROLL_COALESCE_MS: '', MIXDOG_TUI_SCROLL_ACCEL_IDLE_MS: '0' },
  { MIXDOG_TUI_SCROLL_ACCELERATION: '0' },
  { MIXDOG_TUI_SCROLL_ACCELERATION: ' OFF ' },
  { MIXDOG_TUI_SCROLL_ACCELERATION: 'No' },
  { MIXDOG_TUI_SCROLL_ACCELERATION: 'false' },
  { MIXDOG_TUI_SCROLL_ACCELERATION: '1' },
  { MIXDOG_TUI_SCROLL_ACCELERATION: 'maybe' },
  { MIXDOG_TUI_SCROLL_ACCELERATION: '' },
];
const SCROLL_VARS = [
  'MIXDOG_TUI_SCROLL_SPEED',
  'MIXDOG_TUI_SCROLL_SPEED_MAX',
  'MIXDOG_TUI_SCROLL_ACCELERATION',
  'MIXDOG_TUI_SCROLL_ACCEL_IDLE_MS',
  'MIXDOG_TUI_SCROLL_COALESCE_MS',
];
let importSerial = 0;
const withEnv = async (env, run) => {
  const saved = Object.fromEntries(SCROLL_VARS.map((name) => [name, process.env[name]]));
  for (const name of SCROLL_VARS) delete process.env[name];
  Object.assign(process.env, env);
  try {
    importSerial += 1;
    return await run(importSerial);
  } finally {
    for (const name of SCROLL_VARS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
};
const tuningCases = [];
for (const env of TUNING_ENV) {
  const values = await withEnv(env, async (serial) => {
    const mod = await load(windowPath, `?tuning=${serial}`);
    return {
      coalesceMs: mod.SCROLL_COALESCE_MS,
      stepRows: mod.WHEEL_STEP_ROWS,
      accelEnabled: mod.WHEEL_ACCEL_ENABLED,
      stepMaxRows: mod.WHEEL_STEP_MAX_ROWS,
      accelIdleMs: mod.WHEEL_ACCEL_IDLE_MS,
    };
  });
  tuningCases.push({ env, values });
}

// ── wheel ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Bursts of notches at fake times: [direction, atMs] (1 = wheel up). The router reads the tuning of the transcript-window module
// it imports once per process, so each environment runs in a child process of this file (--wheel-child).
const WHEEL_BURSTS = [
  [[1, 0], [1, 20], [1, 40], [1, 60], [1, 80], [1, 100], [1, 120]],
  [[1, 0], [1, 100], [1, 251], [1, 300], [-1, 310], [-1, 320], [1, 330]],
  [[-1, 5], [-1, 6], [-1, 7], [-1, 8], [-1, 9], [-1, 500], [-1, 501]],
  [[1, 1000], [1, 1150], [1, 1301], [1, 1451], [1, 1452], [-1, 1453]],
];
sourceUrl('src/tui/app/mouse-input/wheel-router.mjs');
const wheelCases = [];
for (const env of [{}, { MIXDOG_TUI_SCROLL_SPEED: '2' }, { MIXDOG_TUI_SCROLL_SPEED: '4', MIXDOG_TUI_SCROLL_SPEED_MAX: '10' }, { MIXDOG_TUI_SCROLL_ACCELERATION: '0' }, { MIXDOG_TUI_SCROLL_ACCEL_IDLE_MS: '30' }]) {
  const childEnv = { ...process.env, RECORD_SCROLL_BURSTS: JSON.stringify(WHEEL_BURSTS) };
  for (const name of SCROLL_VARS) delete childEnv[name];
  Object.assign(childEnv, env);
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--tree', tree, '--wheel-child'], { env: childEnv, encoding: 'utf8' });
  if (child.status !== 0) throw new Error(`wheel child failed: ${String(child.stderr).split(String.fromCharCode(10)).slice(0, 3).join(' | ')}`);
  wheelCases.push({ env, bursts: WHEEL_BURSTS, rows: JSON.parse(child.stdout) });
}

// ── anchors ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
const geometryOf = (heights, ids, view) => {
  const prefix = [0];
  for (const height of heights) prefix.push(prefix.at(-1) + height);
  return { prefixRows: prefix, ids, totalRows: prefix.at(-1), viewRows: view };
};
const itemsOf = (ids) => ids.map((id) => ({ id }));
const anchorCases = [];
const addAnchor = (geom, target) => {
  const items = itemsOf(geom.ids);
  const expected = readingAnchorAt({ ...geom, items }, target);
  const captured = captureTopEdgeAnchor({ ...geom, items, offset: target });
  if (JSON.stringify(expected) !== JSON.stringify(captured)) throw new Error('captureTopEdgeAnchor differs from readingAnchorAt');
  anchorCases.push({ prefixRows: geom.prefixRows, ids: geom.ids, totalRows: geom.totalRows, viewRows: geom.viewRows, target, expected });
};
{
  const base = geometryOf([2, 3, 4], ['a', 'b', 'c'], 3);
  for (const target of [0, 1, 1.5, 2, -4, 99, 3, 5, 6]) addAnchor(base, target);
  addAnchor({ ...base, prefixRows: null }, 0);
  addAnchor({ ...base, prefixRows: [0] }, 0);
  addAnchor({ ...base, ids: [] }, 0);
  addAnchor({ ...base, ids: [0] }, 99);
  addAnchor({ ...base, ids: ['a', null, 'c'] }, 4);
  addAnchor({ ...base, viewRows: 0 }, 1);
  addAnchor(geometryOf([0, 2], ['a', 'b'], 1), 1);
  for (let round = 0; round < 60; round += 1) {
    const count = int(1, 9);
    const heights = Array.from({ length: count }, () => (chance(0.1) ? 0 : int(1, 9)));
    const ids = Array.from({ length: count }, (_, index) => (chance(0.05) ? null : `i${index}`));
    const geom = geometryOf(heights, ids, int(1, 14));
    addAnchor(geom, pick([0, 1, 2, 3, int(0, geom.totalRows + 3), int(0, geom.totalRows) + 0.5]));
  }
}
const resolveCases = [];
for (let round = 0; round < 80; round += 1) {
  const count = int(1, 8);
  const heights = Array.from({ length: count }, () => int(1, 9));
  const ids = Array.from({ length: count }, (_, index) => `i${index}`);
  const geom = geometryOf(heights, ids, int(1, 12));
  const view = geom.viewRows;
  const maxRows = Math.max(0, geom.totalRows - view);
  const anchorId = chance(0.12) ? 'gone' : chance(0.05) ? null : pick(ids);
  const anchor = { id: anchorId, offset: chance(0.2) ? int(0, 6) + 0.5 : int(0, 6) };
  const duplicated = chance(0.15) ? [...ids, ids[0]] : ids;
  const prefixRows = chance(0.08) ? null : chance(0.08) ? [0] : geom.prefixRows;
  const expected = resolveAnchorScrollOffset({ anchor, items: itemsOf(duplicated), curPrefix: prefixRows, totalRows: geom.totalRows, viewRows: view, maxRows });
  resolveCases.push({ anchor, ids: duplicated, prefixRows, totalRows: geom.totalRows, viewRows: view, maxRows, expected });
}
const snapCases = [1, 2, 5, 9, 10, 11, 14, 15, 16, 20, 30, 40, 55, 56, 60, 100, 500].map((viewRows) => ({ viewRows, expected: bottomSnapRows(viewRows) }));
const swapCases = [];
for (const count of [0, 1, 3, 5]) {
  for (const previousCount of [0, 1, 3, 5]) {
    for (const firstId of [null, 'a', 'b']) {
      for (const previousFirstId of [null, 'a', 'b']) {
        swapCases.push({ count, previousCount, firstId, previousFirstId, expected: transcriptSwapReturnsToTail({ count, previousCount, firstId, previousFirstId }) });
      }
    }
  }
}

// ── coalesce ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const coalesceCases = [[2, 2, 3], [2, -1], [-3, -2, 4, 4, -1], [0, 2, 0, -2], [1, 1, -1, -1, 1], [5, 0, 0]].map((deltas) => {
  const state = { pendingRows: 0, direction: 0, timer: null };
  const steps = deltas.map((delta) => {
    const reversed = accumulateDirectionalScrollDelta(state, delta);
    return { reversed, pendingRows: state.pendingRows, direction: state.direction };
  });
  return { deltas, steps };
});

// ── render and commit ────────────────────────────────────────────────────────────────────────────────────────────────────
const stateOf = (refs, offset) => ({
  target: refs.scrollTargetRef.current,
  position: refs.scrollPositionRef.current,
  following: refs.followingRef.current,
  anchor: refs.anchorRef ? refs.anchorRef.current : refs.transcriptAnchorRef.current,
  dirty: refs.anchorDirtyRef ? refs.anchorDirtyRef.current : refs.transcriptAnchorDirtyRef.current,
  offset: offset.current,
});
const randomTable = () => {
  const count = int(0, 7);
  const heights = Array.from({ length: count }, () => int(1, 8));
  const ids = Array.from({ length: count }, (_, index) => `i${index}`);
  return geometryOf(heights, ids, int(1, 12));
};
const perturbed = (geom) => {
  const heights = geom.prefixRows.slice(1).map((end, index) => end - geom.prefixRows[index]);
  const next = heights.map((height) => (chance(0.3) ? Math.max(1, height + int(-2, 4)) : height));
  if (chance(0.3)) next.push(int(1, 6));
  const ids = next.map((_, index) => geom.ids[index] ?? `n${index}`);
  return geometryOf(next, ids, geom.viewRows);
};
const anchorFor = (geom) => {
  const roll = random();
  if (roll < 0.25) return null;
  if (roll < 0.4) return { id: 'gone', offset: int(0, 3) };
  if (!geom.ids.length) return null;
  return { id: pick(geom.ids), offset: int(0, 4) };
};
const renderCases = [];
for (let round = 0; round < 160; round += 1) {
  const previous = randomTable();
  const current = previous.prefixRows.length > 1 && chance(0.85) ? perturbed(previous) : randomTable();
  const viewRows = chance(0.7) ? previous.viewRows : int(1, 12);
  const floatingPanelRows = chance(0.8) ? 0 : int(1, 6);
  const maxTarget = Math.max(0, previous.totalRows - previous.viewRows);
  const spec = {
    ids: current.ids,
    rowIndex: { totalRows: current.totalRows, prefixRows: chance(0.05) ? null : current.prefixRows },
    viewRows,
    floatingPanelRows,
    scrollOffset: int(0, maxTarget + 2),
    refs: {
      target: chance(0.3) ? 0 : chance(0.15) ? int(0, maxTarget) + 0.5 : int(0, maxTarget),
      position: int(0, maxTarget),
      following: chance(0.3),
      anchor: anchorFor(previous),
      dirty: chance(0.2),
      geom: chance(0.05)
        ? null
        : { prefixRows: previous.prefixRows, ids: previous.ids, totalRows: previous.totalRows, viewRows: previous.viewRows, renderOffset: int(0, maxTarget) },
      prevViewport: chance(0.2) ? null : { contentHeight: chance(0.6) ? previous.viewRows : int(1, 12), floatingPanelRows: chance(0.8) ? 0 : int(1, 6) },
    },
  };
  const refs = {
    scrollTargetRef: { current: spec.refs.target },
    scrollPositionRef: { current: spec.refs.position },
    followingRef: { current: spec.refs.following },
    anchorRef: { current: spec.refs.anchor },
    anchorDirtyRef: { current: spec.refs.dirty },
    geomRef: { current: spec.refs.geom ? { ...spec.refs.geom, items: itemsOf(spec.refs.geom.ids) } : null },
    prevViewportRef: { current: spec.refs.prevViewport },
  };
  const offset = resolveRenderScrollOffset({
    scrollOffset: spec.scrollOffset,
    items: itemsOf(spec.ids),
    rowIndex: spec.rowIndex,
    viewRows: spec.viewRows,
    floatingPanelRows: spec.floatingPanelRows,
    ...refs,
  });
  renderCases.push({ ...spec, expected: { ...stateOf(refs, { current: offset }), prevViewport: refs.prevViewportRef.current } });
}

const commitCases = [];
const syncRefs = (spec) => ({
  transcriptAnchorRef: { current: spec.refs.anchor },
  transcriptAnchorDirtyRef: { current: spec.refs.dirty },
  scrollTargetRef: { current: spec.refs.target },
  scrollPositionRef: { current: spec.refs.position },
  followingRef: { current: spec.refs.following },
});
for (let round = 0; round < 240; round += 1) {
  const previous = randomTable();
  const current = previous.prefixRows.length > 1 && chance(0.85) ? perturbed(previous) : randomTable();
  const maxRows = Math.max(0, current.totalRows - current.viewRows);
  const kind = pick(['commit', 'commit', 'commit', 'unanchored', 'clamp']);
  const spec = {
    kind,
    frame: {
      dragActive: chance(0.08),
      totalRows: current.totalRows,
      previousTotalRows: chance(0.1) ? 0 : previous.totalRows,
      prefixRows: chance(0.05) ? null : current.prefixRows,
      ids: current.ids,
      viewRows: chance(0.9) ? current.viewRows : int(0, 10),
      maxRows: chance(0.85) ? maxRows : int(0, maxRows + 4),
    },
    scrollOffset: int(0, maxRows + 3),
    refs: {
      target: chance(0.3) ? 0 : chance(0.1) ? int(0, maxRows) + 0.5 : int(0, maxRows + (chance(0.2) ? 4 : 0)),
      position: int(0, maxRows + 2),
      following: chance(0.3),
      anchor: anchorFor(previous),
      dirty: chance(0.2),
    },
  };
  const refs = syncRefs(spec);
  const offset = { current: spec.scrollOffset };
  const setScrollOffset = (value) => {
    offset.current = value;
  };
  const stopSmoothScroll = () => {};
  const f = spec.frame;
  if (kind === 'commit') {
    syncReadingAnchorAfterCommit({
      refs,
      dragActive: f.dragActive,
      totalRows: f.totalRows,
      previousTotalRows: f.previousTotalRows,
      rowIndex: { prefixRows: f.prefixRows },
      items: itemsOf(f.ids),
      viewRows: f.viewRows,
      maxRows: f.maxRows,
      scrollOffset: spec.scrollOffset,
      setScrollOffset,
      stopSmoothScroll,
    });
  } else if (kind === 'unanchored') {
    resetScrollWhenUnanchored(refs, { scrollOffset: spec.scrollOffset, setScrollOffset, stopSmoothScroll });
  } else {
    clampScrollToOverflow(refs, { maxRows: f.maxRows, scrollOffset: spec.scrollOffset, setScrollOffset, stopSmoothScroll });
  }
  commitCases.push({ ...spec, expected: stateOf(refs, offset) });
}

// ── engine ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
const VIEW_ROWS = 10;
const COLUMNS = 40;
const STATUSLINE_BAND_ROWS = 2;
const engineGeometry = (heights, view) => {
  const geom = geometryOf(heights, heights.map((_, index) => `i${index}`), view);
  return { ...geom, items: itemsOf(geom.ids) };
};
const ENGINE_SCENARIOS = [
  {
    name: 'manual scroll, snap band and glide',
    heights: Array(10).fill(10),
    steps: [
      { op: 'scroll', rows: 3 },
      { op: 'scroll', rows: -1 },
      { op: 'scroll', rows: 4, smooth: true },
      { op: 'settle', ms: 700 },
      { op: 'reset' },
      { op: 'scroll', rows: 200 },
      { op: 'scroll', rows: -200 },
      { op: 'scroll', rows: -1 },
    ],
  },
  {
    name: 'blocked read-back is replayed',
    heights: Array(10).fill(10),
    steps: [{ op: 'max', rows: 0 }, { op: 'scroll', rows: 5 }, { op: 'scroll', rows: 2 }, { op: 'max', rows: 90 }, { op: 'scroll', rows: -2 }],
  },
  {
    name: 'a downward scroll cancels a blocked intent',
    heights: Array(10).fill(10),
    steps: [{ op: 'max', rows: 0 }, { op: 'scroll', rows: 5 }, { op: 'scroll', rows: -1 }, { op: 'max', rows: 90 }],
  },
  {
    name: 'history paging at both edges',
    heights: Array(10).fill(10),
    steps: [
      { op: 'history', before: true, after: false },
      { op: 'target', value: 90 },
      { op: 'scroll', rows: 1 },
      { op: 'history', before: false, after: true },
      { op: 'target', value: 0 },
      { op: 'scroll', rows: -1 },
      { op: 'history', before: true, after: true, restores: false },
      { op: 'target', value: 90 },
      { op: 'scroll', rows: 3 },
      { op: 'target', value: 0 },
      { op: 'scroll', rows: -3 },
      { op: 'history', before: false, after: false },
      { op: 'scroll', rows: 3 },
    ],
  },
  {
    name: 'uneven heights and fractional deltas',
    heights: [3, 1, 7, 2, 9, 4, 4, 6, 1, 12],
    steps: [{ op: 'scroll', rows: 2.5 }, { op: 'scroll', rows: 11 }, { op: 'scroll', rows: -4.5 }, { op: 'scroll', rows: 30, smooth: true }, { op: 'settle', ms: 700 }, { op: 'arm' }, { op: 'scroll', rows: 9 }],
  },
  {
    name: 'a short transcript with a tall viewport',
    heights: [3, 3],
    view: 12,
    steps: [{ op: 'scroll', rows: 3 }, { op: 'scroll', rows: -3 }, { op: 'reset' }, { op: 'arm' }],
  },
  {
    name: 'coalesced wheel',
    heights: Array(10).fill(10),
    steps: [{ op: 'queue', rows: 2 }, { op: 'queue', rows: 2 }, { op: 'queue', rows: 3 }, { op: 'settle', ms: 80 }, { op: 'queue', rows: 4 }, { op: 'queue', rows: -1 }, { op: 'settle', ms: 80 }, { op: 'queue', rows: -2 }, { op: 'queue', rows: -3 }, { op: 'queue', rows: 5 }, { op: 'settle', ms: 80 }],
  },
];

const mountHarness = (render_, element) => {
  const stdout = new PassThrough();
  stdout.columns = COLUMNS;
  stdout.rows = VIEW_ROWS + STATUSLINE_BAND_ROWS;
  stdout.on('data', () => {});
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  const view = render_(element(), { stdout, stdin, stderr: stdout, debug: true, exitOnCtrlC: false, patchConsole: false });
  return {
    view,
    rerender: () => view.rerender(element()),
    close: () => {
      view.unmount();
      stdin.end();
      stdout.end();
    },
  };
};

const engineCases = [];
for (const scenario of ENGINE_SCENARIOS) {
  const view = scenario.view ?? VIEW_ROWS;
  const geom = engineGeometry(scenario.heights, view);
  const maxRows = Math.max(0, geom.totalRows - view);
  const refs = {
    scrollPositionRef: { current: 0 },
    scrollTargetRef: { current: 0 },
    maxScrollRowsRef: { current: maxRows },
    transcriptBottomSlackRowsRef: { current: 0 },
    followingRef: { current: true },
    transcriptAnchorRef: { current: null },
    transcriptAnchorDirtyRef: { current: false },
    transcriptGeomRef: { current: geom },
    dragRef: { current: { active: false, region: null, rect: null } },
    frameRowsRef: { current: view + STATUSLINE_BAND_ROWS },
    transcriptViewportRef: { current: { top: 0, bottom: view - 1 } },
    selectionLayoutRef: { current: null },
    selectionTextRef: { current: '' },
  };
  const store = { state: {}, olderRestores: 0, newerRestores: 0, restores: true };
  store.getState = () => store.state;
  store.restoreOlderTranscript = () => {
    store.olderRestores += 1;
    return store.restores;
  };
  store.restoreNewerTranscript = () => {
    store.newerRestores += 1;
    return store.restores;
  };
  store.setRenderSelection = () => {};
  store.getRenderSelectionRows = () => [];
  store.getRenderSelectionText = () => '';
  store.getWordRectAt = () => null;
  store.getLineRectAt = () => null;
  const control = { offsets: [] };
  function Harness() {
    const [scrollOffset, setScrollOffset] = React.useState(0);
    const [publish] = React.useState(() => (value) => {
      control.offsets.push(value);
      setScrollOffset(value);
    });
    control.api = useTranscriptScroll({ store, frameColumns: COLUMNS, statuslineBandRows: STATUSLINE_BAND_ROWS, setScrollOffset: publish, ...refs });
    return React.createElement(Text, null, `offset ${scrollOffset}`);
  }
  const mounted = mountHarness(render, () => React.createElement(Harness));
  await delay(60);
  const snapshot = () => ({
    target: refs.scrollTargetRef.current,
    position: refs.scrollPositionRef.current,
    following: refs.followingRef.current,
    anchor: refs.transcriptAnchorRef.current,
    dirty: refs.transcriptAnchorDirtyRef.current,
    offset: control.offsets.length ? control.offsets.at(-1) : 0,
    olderRestores: store.olderRestores,
    newerRestores: store.newerRestores,
  });
  const steps = [];
  for (const step of scenario.steps) {
    if (step.op === 'scroll') control.api.scrollTranscriptRows(step.rows, step.smooth ? { smooth: true } : {});
    else if (step.op === 'queue') control.api.queueScrollCoalesced(step.rows);
    else if (step.op === 'settle') await delay(step.ms);
    else if (step.op === 'reset') control.api.resetTranscriptScroll();
    else if (step.op === 'arm') control.api.armTranscriptFollow();
    else if (step.op === 'max') {
      refs.maxScrollRowsRef.current = step.rows;
      mounted.rerender();
      await delay(60);
    } else if (step.op === 'history') {
      store.state = { transcriptHistoryBefore: step.before, transcriptHistoryAfter: step.after };
      store.restores = step.restores !== false;
    } else if (step.op === 'target') {
      refs.scrollTargetRef.current = step.value;
    } else throw new Error(`unknown engine step ${step.op}`);
    // Steps that settle on a timer are compared at the end of it; the others right away.
    steps.push(snapshot());
  }
  mounted.close();
  engineCases.push({ name: scenario.name, heights: scenario.heights, view, maxRows, steps: scenario.steps, expected: steps });
}

// ── swap ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const SWAP_SEQUENCES = [
  [['a', 'b'], ['a', 'b', 'c'], ['a', 'b', 'c', 'd']],
  [['a', 'b', 'c'], ['b', 'c'], ['b', 'c', 'x']],
  [['a'], [], ['z'], ['z', 'y']],
  [[], [], ['a']],
  [['a', 'b'], ['q', 'b', 'c', 'd'], ['q', 'b', 'c', 'd', 'e']],
  [[null, 'b'], ['a', 'b'], [null, 'b']],
];
const swapSequences = [];
for (const lists of SWAP_SEQUENCES) {
  const resets = [];
  let current = lists[0];
  const lastItemsCountRef = { current: 0 };
  const lastFirstItemIdRef = { current: null };
  function SwapHarness() {
    useTranscriptSwapReset({ items: current.map((id) => ({ id })), lastItemsCountRef, lastFirstItemIdRef, resetTranscriptScroll: () => resets.push(step) });
    return React.createElement(Text, null, 'swap');
  }
  let step = 0;
  const mounted = mountHarness(render, () => React.createElement(SwapHarness));
  await delay(30);
  const after = [{ resets: [...resets] }];
  for (step = 1; step < lists.length; step += 1) {
    current = lists[step];
    mounted.rerender();
    await delay(30);
    after.push({ resets: [...resets] });
  }
  mounted.close();
  swapSequences.push({ lists, expected: after });
}

// ── activity ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const STATS = {
  currentContextSource: 'engine',
  currentEstimatedContextTokens: 11,
  currentContextTokens: 12,
  contextTokens: 13,
  latestPromptTokens: 14,
  latestInputTokens: 15,
  latestCachedTokens: 16,
  latestCacheWriteTokens: 17,
  inputTokens: 18,
  cachedTokens: 19,
  cacheWriteTokens: 20,
  promptTokens: 21,
  turns: 22,
};
const tool = (extra) => ({ kind: 'tool', ...extra });
const ACTIVITY_STATES = [
  { agentWorkers: [{ tag: 'a', status: 'running', stage: 'edit', sessionId: 's1', extra: 'ignored' }], agentJobs: [{ task_id: 'j1', status: 'queued', tag: 'a', sessionId: 's1', startedAt: 1, finishedAt: 0, error: '' }], items: [], stats: { ...STATS, notPublished: 99 } },
  { agentWorkers: [], agentJobs: [], items: [], stats: STATS, activeToolSummary: '2:1000:0:0:1:2000' },
  { agentWorkers: [], agentJobs: [], items: [], stats: STATS, activeToolSummary: '' },
  { agentWorkers: [], agentJobs: [], items: [], stats: STATS, activeToolSummary: null },
  { agentWorkers: [], agentJobs: [], items: [tool({ aggregate: true, count: 3, completedCount: 0, startedAt: 500, categories: { s: { category: 'Shell', count: 2 }, w: { category: 'Web Research', count: 1 } } }), tool({ aggregate: true, count: 1, completedCount: 1, startedAt: 100, categories: { s: { category: 'Shell', count: 1 } } })], stats: STATS },
  { items: [tool({ name: 'bash', args: { command: 'ls' }, count: 1, completedCount: 0, startedAt: 40 }), tool({ name: 'web_search', args: {}, count: 2, startedAt: 30 }), tool({ name: 'agent', args: {}, startedAt: 90 }), tool({ name: 'read', args: {}, startedAt: 10 })] },
  { items: [tool({ name: 'bash', args: {}, count: 2, completedCount: 1, startedAt: 70 }), tool({ name: 'bash', args: {}, count: 1, result: 'done', startedAt: 20 }), tool({ name: 'bash', args: {}, count: 1, completedCount: 1, startedAt: 5 })] },
  { items: [tool({ aggregate: true, count: 2, completedCount: 1, result: 'partial', startedAt: 60, categories: { a: { category: 'Agent' }, b: { category: 'Agent', count: 3 }, c: { category: 'Read', count: 9 }, d: null } }), { kind: 'assistant', text: 'x' }] },
  { items: [tool({ name: 'bash', args: {}, count: 0, startedAt: 0 }), tool({ aggregate: true, name: 'bash', count: 1, startedAt: 12 })] },
  { agentWorkers: Array.from({ length: 25 }, (_, index) => ({ tag: `t${index}`, status: 'idle', stage: null, sessionId: `s${index}` })), agentJobs: Array.from({ length: 22 }, (_, index) => ({ task_id: `j${index}`, status: 'done', error: 'e"\\' })) },
  {},
];
const activityCases = [];
for (const state of ACTIVITY_STATES) {
  const control = {};
  function ActivityHarness() {
    control.api = useTranscriptActivity({ state });
    return React.createElement(Text, null, 'ready');
  }
  const mounted = mountHarness(render, () => React.createElement(ActivityHarness));
  await delay(20);
  const { agentRevision, activeTools, statuslineStats } = control.api;
  mounted.close();
  activityCases.push({ state, expected: { agentRevision, activeTools, statuslineStats } });
}

// ── golden ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
const golden = {
  format: 1,
  sources,
  tuning: tuningCases,
  wheel: wheelCases,
  anchors: anchorCases,
  resolve: resolveCases,
  snap: snapCases,
  swapReturns: swapCases,
  coalesce: coalesceCases,
  render: renderCases,
  commit: commitCases,
  engine: engineCases,
  swap: swapSequences,
  activity: activityCases,
};
const text = `${JSON.stringify(golden)}\n`;

const write = option('--write');
const check = option('--check');
if (write) {
  writeFileSync(write, text);
  console.error(
    `wrote ${write}: ${tuningCases.length} tuning, ${wheelCases.length} wheel, ${anchorCases.length} anchors, ${renderCases.length} render, ${commitCases.length} commit, ${engineCases.length} engine, ${swapSequences.length} swap, ${activityCases.length} activity`
  );
}
if (check) {
  const recorded = readFileSync(check, 'utf8');
  if (recorded !== text) {
    console.error(`${check} is not what the Node code records now`);
    process.exit(1);
  }
  console.error(`${check} matches`);
}
process.exit(0);

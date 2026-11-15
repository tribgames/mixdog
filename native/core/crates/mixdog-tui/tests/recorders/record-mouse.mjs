// Records what the Node mouse and selection code does, so the Rust one (`mixdog_tui::mouse`) is checked against it
// (tests/mouse.rs).
//
// The Node code is only read: the modules are imported from <tree>/src/tui/app, nothing is written there.
//
//   node record-mouse.mjs --tree C:/Project/mixdog --write tests/goldens/mouse.json
//   node record-mouse.mjs --tree C:/Project/mixdog --check tests/goldens/mouse.json
//
// Recorded: scripted mouse report sequences fed to the real hooks (useTranscriptScroll with the selection paint, stitch, geometry
// and focus hooks it composes, useMouseInput, useCopySelection) mounted on ink, over a fake rendered frame (a 40 column, 16 row
// screen: a 10 row transcript viewport over a 40 row transcript, a prompt box, a 2 row statusline band) and a fake clock:
//  * what each report does to the drag (region, anchor, last cell, anchor span, the clipped rect),
//  * every rect handed to the renderer (`setRenderSelection`), the scroll target, the remembered selection text, the stitched text,
//  * the prompt engine calls, the palette index steps, the zoom passthrough writes, the repaints, the copied text and the hints.
// Time is a fake: Date.now() and the timers the code arms (paint trailing timer, edge autoscroll interval, wheel coalescer, the
// stitch harvest) are driven by the script. Every time is at least 1000 (the Node code starts its paint clock at 0).
// A frame is simulated by the `advance` step: it fires what is due, then lets the deferred text capture run.

import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { register } from 'node:module';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const tree = option('--tree');
if (!tree || (!option('--write') && !option('--check'))) {
  console.error('usage: record-mouse.mjs --tree <mixdog checkout> (--write <golden.json> | --check <golden.json>)');
  process.exit(2);
}

// The clipboard module spawns the platform's clipboard helper: replace it, for the copy hook only, by a recorder.
register(
  `data:text/javascript,${encodeURIComponent(`
    export async function resolve(specifier, context, next) {
      if (specifier.endsWith('/clipboard.mjs') && context.parentURL?.endsWith('/use-copy-selection.mjs')) {
        return {
          url: 'data:text/javascript,' + encodeURIComponent(
            'export const copyToClipboard = (text) => { (globalThis.__clip ||= []).push(text); ' +
            'return globalThis.__clipFail ? Promise.reject(new Error(globalThis.__clipFail)) : Promise.resolve(); };'
          ),
          shortCircuit: true,
        };
      }
      return next(specifier, context);
    }
  `)}`,
  import.meta.url
);

const sources = [];
const sourceUrl = (path, query = '') => {
  const file = join(tree, path);
  if (!sources.some((source) => source.path === path)) {
    sources.push({ path, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') });
  }
  return pathToFileURL(file).href + query;
};
const load = (path, query = '') => import(sourceUrl(path, query));
const treeImport = (name) => import(pathToFileURL(join(tree, 'node_modules', name)).href).catch(() => import(name));

const { useTranscriptScroll } = await load('src/tui/app/use-transcript-scroll.mjs');
const { useCopySelection } = await load('src/tui/app/use-copy-selection.mjs');
delete process.env.WT_SESSION;
const { useMouseInput } = await load('src/tui/app/use-mouse-input.mjs');
process.env.WT_SESSION = 'recorded-wt-session';
const { useMouseInput: useMouseInputWt } = await load('src/tui/app/use-mouse-input.mjs', '?wt');
delete process.env.WT_SESSION;
for (const file of [
  'mouse-input/button-gestures.mjs',
  'mouse-input/edge-autoscroll.mjs',
  'mouse-input/geometry.mjs',
  'mouse-input/wheel-router.mjs',
  'mouse-input/sgr-buttons.mjs',
  'use-selection-focus.mjs',
  'use-selection-geometry.mjs',
  'use-selection-paint.mjs',
  'use-selection-paint/paint-queue.mjs',
  'use-selection-paint/selection-clip.mjs',
  'use-selection-stitch.mjs',
  'use-interaction-refs.mjs',
]) {
  await load(`src/tui/app/${file}`);
}
const React = (await treeImport('react/index.js')).default;
const { Text, render } = await treeImport('ink/build/index.js');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const COLUMNS = 40;
const VIEW_ROWS = 10;
const FRAME_ROWS = 16;
const STATUSLINE_BAND_ROWS = 2;
const TOTAL_ROWS = 40;
const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'omega'];
const STATUS_ROWS = { 14: 'model gpt-x ctx 12% idle', 15: 'branch main +3 -1 done' };
const contentLine = (index) => (index % 11 === 5 ? '' : `l${index} ${WORDS[index % 5]} ${WORDS[(index + 2) % 5]}-${index * 7} end`);
const contentSoftWrap = (index) => index % 7 === 3 && contentLine(index) !== '';

// ── the fake clock ───────────────────────────────────────────────────────────────────────────────────────────────────────
const clock = { now: 1000, timers: [], serial: 0 };
const realTimers = { setTimeout, clearTimeout, setInterval, clearInterval, now: Date.now };
const fakeHandle = (timer) => ({ timer, unref() { return this; }, ref() { return this; } });
const installFakes = () => {
  globalThis.setTimeout = (fn, ms = 0) => {
    const timer = { fn, at: clock.now + Math.max(0, Number(ms) || 0), serial: clock.serial++, every: 0, live: true };
    clock.timers.push(timer);
    return fakeHandle(timer);
  };
  globalThis.setInterval = (fn, ms = 0) => {
    const every = Math.max(1, Number(ms) || 1);
    const timer = { fn, at: clock.now + every, serial: clock.serial++, every, live: true };
    clock.timers.push(timer);
    return fakeHandle(timer);
  };
  const clear = (handle) => {
    if (handle?.timer) handle.timer.live = false;
  };
  globalThis.clearTimeout = clear;
  globalThis.clearInterval = clear;
  Date.now = () => clock.now;
};
const removeFakes = () => {
  globalThis.setTimeout = realTimers.setTimeout;
  globalThis.clearTimeout = realTimers.clearTimeout;
  globalThis.setInterval = realTimers.setInterval;
  globalThis.clearInterval = realTimers.clearInterval;
  Date.now = realTimers.now;
};
// Fires, in order, every live timer due at or before `until`; a timer a firing arms and that is due too fires in the same pass.
// After every distinct due time the deferred text capture is let run (the renderer's acknowledgement of a frame).
const settleCapture = async () => {
  removeFakes();
  for (let round = 0; round < 3; round += 1) await new Promise((resolve) => setImmediate(resolve));
  installFakes();
};
const fire = async (until) => {
  for (;;) {
    clock.timers = clock.timers.filter((timer) => timer.live);
    const due = clock.timers.filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at || a.serial - b.serial);
    if (!due.length) break;
    const at = due[0].at;
    clock.now = Math.max(clock.now, at);
    for (const timer of due.filter((candidate) => candidate.at === at)) {
      if (!timer.live) continue;
      if (timer.every) timer.at += timer.every;
      else timer.live = false;
      timer.fn();
    }
    // A zero timer armed by what just fired is due at the same time: fire it before the frame.
    await fireSameTime(at);
    await settleCapture();
  }
  clock.now = Math.max(clock.now, until);
};
const fireSameTime = async (at) => {
  for (;;) {
    clock.timers = clock.timers.filter((timer) => timer.live);
    const due = clock.timers.filter((timer) => timer.at <= at && !timer.every).sort((a, b) => a.serial - b.serial);
    if (!due.length) return;
    for (const timer of due) {
      if (!timer.live) continue;
      timer.live = false;
      timer.fn();
    }
  }
};

// ── the fake frame ───────────────────────────────────────────────────────────────────────────────────────────────────────
const strip = (rect) => {
  if (!rect) return null;
  const out = { mode: rect.mode, x1: rect.x1, y1: rect.y1, x2: rect.x2, y2: rect.y2 };
  if (rect.clipY1 !== undefined) out.clipY1 = rect.clipY1;
  if (rect.clipY2 !== undefined) out.clipY2 = rect.clipY2;
  if (rect.captureText !== undefined) out.captureText = rect.captureText;
  return out;
};
const point = (p) => (p ? { x: p.x, y: p.y } : null);

const SCENARIOS = [];
const scenario = (name, spec, steps) => SCENARIOS.push({ name, wt: false, target: 0, promptBox: null, ...spec, steps });
const down = (t, x, y, b = 0) => ({ op: 'mouse', t, b, x, y });
const move = (t, x, y, b = 0) => ({ op: 'mouse', t, b: b | 32, x, y });
const up = (t, x, y, b = 0) => ({ op: 'mouse', t, b, x, y, a: 'release' });
const wheel = (t, dir, ctrl = false) => ({ op: 'wheel', t, dir, ctrl });
const advance = (t) => ({ op: 'advance', t });
const copy = (t) => ({ op: 'copy', t });
const focus = (t, step) => ({ op: 'focus', t, move: step });
const PROMPT_BOX = { top: 11, left: 2, height: 3, contentWidth: 30 };

scenario('transcript drag, throttled motion, release and copy', {}, [
  down(1000, 2, 3),
  move(1005, 8, 5),
  move(1010, 12, 6),
  advance(1011),
  advance(1040),
  up(1041, 12, 6),
  advance(1042),
  copy(1050),
  advance(1051),
]);
scenario('a release on the press cell clears and a plain click clears too', {}, [
  down(1000, 4, 2),
  up(1001, 4, 2),
  advance(1002),
  down(1100, 4, 2),
  move(1110, 9, 4),
  up(1111, 9, 4),
  advance(1112),
  down(1200, 20, 12),
  advance(1201),
]);
scenario('drag below the viewport autoscrolls toward newer rows until the clamp', { target: 10 }, [
  down(1000, 2, 5),
  move(1010, 7, 12),
  advance(1020),
  advance(1060),
  advance(1110),
  advance(1160),
  advance(1210),
  advance(1260),
  advance(1310),
  up(1311, 7, 12),
  advance(1312),
]);
scenario('drag above the viewport autoscrolls toward older rows, then back inside stops it', { target: 4 }, [
  down(1000, 6, 3),
  move(1010, 9, 0),
  advance(1011),
  advance(1060),
  advance(1110),
  move(1111, 9, 5),
  advance(1112),
  advance(1200),
  up(1201, 9, 5),
  advance(1202),
]);
scenario('wheel scrolls with the selection and the stitch keeps rows that scrolled out of view', {}, [
  down(1000, 3, 4),
  move(1010, 10, 9),
  up(1011, 10, 9),
  advance(1012),
  wheel(1100, 1),
  advance(1101),
  wheel(1200, 1),
  advance(1201),
  wheel(1300, 1),
  advance(1301),
  wheel(1400, 1),
  advance(1401),
  wheel(1500, -1),
  advance(1501),
  copy(1510),
  advance(1511),
]);
scenario('wheel while dragging rebuilds the rect from the anchor', {}, [
  down(1000, 3, 6),
  move(1010, 12, 8),
  advance(1011),
  wheel(1020, 1),
  advance(1021),
  wheel(1030, 1),
  advance(1031),
  up(1032, 12, 8),
  advance(1033),
  copy(1040),
]);
scenario('double click selects a word, triple click a line, a drag extends by span', {}, [
  down(1000, 6, 2),
  up(1001, 6, 2),
  advance(1002),
  down(1100, 7, 2),
  up(1101, 7, 2),
  advance(1102),
  move(1110, 20, 4),
  advance(1111),
  up(1112, 20, 4),
  advance(1113),
  down(1200, 7, 2),
  up(1201, 7, 2),
  advance(1202),
  down(1260, 7, 2),
  up(1261, 7, 2),
  advance(1262),
  down(1300, 7, 2),
  advance(1301),
  move(1310, 3, 0),
  advance(1311),
  up(1312, 3, 0),
  advance(1313),
  right(1400, 12, 6),
  advance(1401),
  copy(1410),
]);
function right(t, x, y) {
  return { op: 'mouse', t, b: 2, x, y };
}
scenario('right press and ctrl or shift press extend a character selection', {}, [
  right(1000, 4, 4),
  down(1100, 2, 1),
  move(1110, 5, 2),
  up(1111, 5, 2),
  advance(1112),
  right(1200, 11, 5),
  advance(1201),
  down(1300, 20, 8, 16),
  advance(1301),
  up(1302, 20, 8),
  advance(1303),
  down(1400, 1, 1, 4),
  advance(1401),
  up(1402, 1, 1),
  advance(1403),
  copy(1410),
]);
scenario('status band selections never scroll and clamp to the band', {}, [
  down(1000, 1, 14),
  move(1010, 9, 15),
  move(1020, 30, 20),
  advance(1030),
  up(1031, 30, 20),
  advance(1032),
  right(1100, 12, 14),
  advance(1101),
  copy(1110),
  down(1200, 3, 15),
  up(1201, 3, 15),
  down(1300, 3, 15),
  up(1301, 3, 15),
  advance(1302),
]);
scenario('prompt box presses anchor, drag, extend and multi-click through the prompt engine', { promptBox: PROMPT_BOX }, [
  down(1000, 5, 12),
  move(1010, 8, 13),
  move(1020, 40, 20),
  up(1021, 8, 13),
  down(1100, 5, 12),
  up(1101, 5, 12),
  down(1200, 5, 12),
  up(1201, 5, 12),
  down(1300, 5, 12),
  up(1301, 5, 12),
  { op: 'promptSel', has: true },
  right(1400, 10, 12),
  down(1500, 9, 11, 4),
  up(1501, 9, 11),
  { op: 'promptSel', has: false },
  right(1600, 10, 12),
  down(1700, 20, 3),
  advance(1701),
]);
scenario('wheel routing: palette, overlay, accelerated scroll and ctrl zoom passthrough', {}, [
  wheel(1000, 1),
  wheel(1050, 1),
  wheel(1100, 1),
  advance(1200),
  wheel(1500, -1),
  advance(1501),
  { op: 'palette', open: true, count: 5 },
  wheel(1600, 1),
  wheel(1610, -1),
  wheel(1620, -1),
  { op: 'palette', open: false, count: 5 },
  { op: 'overlay', btw: true },
  wheel(1700, 1),
  { op: 'overlay', btw: false },
  wheel(1800, 1, true),
  down(1900, 2, 2),
  move(1910, 6, 3),
  wheel(1920, 1, true),
  advance(1921),
  up(1930, 6, 3),
  advance(1931),
]);
scenario('keyboard focus moves on a released selection', {}, [
  down(1000, 2, 3),
  move(1010, 6, 4),
  up(1011, 6, 4),
  advance(1012),
  focus(1020, 'left'),
  focus(1021, 'right'),
  focus(1022, 'lineStart'),
  focus(1023, 'lineEnd'),
  focus(1024, 'down'),
  focus(1025, 'up'),
  focus(1026, 'up'),
  advance(1027),
  focus(1030, 'down'),
  focus(1031, 'down'),
  focus(1032, 'down'),
  focus(1033, 'down'),
  focus(1034, 'down'),
  focus(1035, 'down'),
  focus(1036, 'down'),
  focus(1037, 'down'),
  advance(1038),
  focus(1040, 'bogus'),
  down(1100, 4, 4),
  advance(1101),
  focus(1102, 'left'),
]);
scenario('keyboard focus past the top edge scrolls one row', { target: 3 }, [
  down(1000, 2, 1),
  move(1010, 6, 0),
  up(1011, 6, 0),
  advance(1012),
  focus(1020, 'up'),
  focus(1021, 'up'),
  advance(1022),
  copy(1030),
]);
scenario('windows terminal drops shift events and repaints after a gesture', { wt: true }, [
  down(1000, 2, 3),
  down(1001, 4, 3, 4),
  move(1010, 8, 5),
  up(1011, 8, 5),
  advance(1012),
  down(1100, 2, 3, 4),
  right(1200, 11, 5),
  down(1300, 20, 12),
  advance(1301),
]);
scenario('a keystroke settles a drag whose release never arrived', {}, [
  { op: 'settle', t: 1000 },
  down(1001, 2, 3),
  move(1010, 6, 6),
  { op: 'settle', t: 1011 },
  advance(1012),
  copy(1020),
]);
scenario('copy retries while nothing is selected, then says so; a failing clipboard says why', {}, [
  copy(1000),
  advance(1000),
  advance(1024),
  advance(1048),
  advance(1072),
  advance(1096),
  { op: 'clipboard', fail: 'denied' },
  down(1200, 2, 3),
  move(1210, 9, 3),
  up(1211, 9, 3),
  advance(1212),
  copy(1220),
  { op: 'clipboard', fail: null },
  copy(1230),
]);

// ── the harness ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const geometryOf = (heights, ids, view) => {
  const prefix = [0];
  for (const height of heights) prefix.push(prefix.at(-1) + height);
  return { prefixRows: prefix, ids, totalRows: prefix.at(-1), viewRows: view };
};

const cases = [];
for (const spec of SCENARIOS) {
  const geom = { ...geometryOf([10, 10, 10, 10], ['i0', 'i1', 'i2', 'i3'], VIEW_ROWS), items: ['i0', 'i1', 'i2', 'i3'].map((id) => ({ id })) };
  const refs = {
    scrollPositionRef: { current: spec.target },
    scrollTargetRef: { current: spec.target },
    maxScrollRowsRef: { current: geom.totalRows - VIEW_ROWS },
    transcriptBottomSlackRowsRef: { current: 0 },
    followingRef: { current: spec.target === 0 },
    transcriptAnchorRef: { current: null },
    transcriptAnchorDirtyRef: { current: false },
    transcriptGeomRef: { current: geom },
    dragRef: { current: { anchor: null, anchorScroll: 0, last: null, active: false, rect: null, region: null, anchorSpan: null } },
    frameRowsRef: { current: FRAME_ROWS },
    transcriptViewportRef: { current: { top: 0, bottom: VIEW_ROWS - 1 } },
    selectionLayoutRef: { current: null },
    selectionTextRef: { current: '' },
  };
  const lastClickRef = { current: { x: -1, y: -1, t: 0, count: 0 } };
  const log = { render: [], prompt: [], slash: [], hints: [], writes: [], repaints: 0, offsets: [] };
  const screenLine = (y) => {
    const idx = TOTAL_ROWS - VIEW_ROWS - refs.scrollTargetRef.current + y;
    const text = y >= 0 && y < VIEW_ROWS ? contentLine(idx) : STATUS_ROWS[y] || '';
    return text.padEnd(COLUMNS, ' ').slice(0, COLUMNS);
  };
  const screenSoftWrap = (y) => y >= 0 && y < VIEW_ROWS && contentSoftWrap(TOTAL_ROWS - VIEW_ROWS - refs.scrollTargetRef.current + y);
  const store = {
    current: null,
    cachedText: null,
    getState: () => ({}),
    restoreOlderTranscript: () => false,
    restoreNewerTranscript: () => false,
    forceRenderRepaint: () => {
      log.repaints += 1;
    },
    setRenderSelection(rect) {
      store.current = rect || null;
      log.render.push(strip(rect));
    },
    getRenderSelectionRows() {
      const rect = store.current;
      if (!rect) return null;
      const backwards = rect.y1 > rect.y2 || (rect.y1 === rect.y2 && rect.x1 > rect.x2);
      const start = backwards ? { x: rect.x2, y: rect.y2 } : { x: rect.x1, y: rect.y1 };
      const end = backwards ? { x: rect.x1, y: rect.y1 } : { x: rect.x2, y: rect.y2 };
      const clip1 = rect.clipY1 ?? 0;
      const clip2 = rect.clipY2 ?? FRAME_ROWS - 1;
      const y1 = Math.max(clip1, 0, start.y);
      const y2 = Math.min(FRAME_ROWS - 1, clip2, end.y);
      const lineMode = y1 !== y2;
      const rows = [];
      for (let y = y1; y <= y2; y += 1) {
        const rx1 = lineMode ? (y === start.y ? start.x : 0) : Math.min(start.x, end.x);
        const rx2 = lineMode ? (y === end.y ? end.x : COLUMNS - 1) : Math.max(start.x, end.x);
        const x1 = Math.max(0, Math.min(rx1, rx2));
        const x2 = Math.min(COLUMNS - 1, Math.max(rx1, rx2));
        const raw = screenLine(y).slice(x1, x2 + 1);
        const trimmed = raw.trimEnd();
        const nextContinues = y < y2 && screenSoftWrap(y + 1);
        rows.push({ y, text: nextContinues && trimmed.length < raw.length ? `${trimmed} ` : trimmed, sw: screenSoftWrap(y) });
      }
      while (rows.length && !rows[0].text.trim()) rows.shift();
      while (rows.length && !rows.at(-1).text.trim()) rows.pop();
      return rows;
    },
    getRenderSelectionText() {
      const rect = store.current;
      if (!rect) return null;
      if (rect.captureText === false) return store.cachedText;
      const logical = [];
      for (const row of store.getRenderSelectionRows()) {
        if (row.sw && logical.length) logical[logical.length - 1] += row.text;
        else logical.push(row.text);
      }
      store.cachedText = logical.map((line) => line.replace(/\s+$/u, '')).join('\n');
      return store.cachedText;
    },
    getWordRectAt(x, y) {
      const line = screenLine(y);
      if (x < 0 || x >= COLUMNS || line[x] === ' ') return null;
      let x1 = x;
      let x2 = x;
      while (x1 > 0 && line[x1 - 1] !== ' ') x1 -= 1;
      while (x2 < COLUMNS - 1 && line[x2 + 1] !== ' ') x2 += 1;
      return { x1, y1: y, x2, y2: y };
    },
    getLineRectAt(y) {
      const line = screenLine(y).trimEnd();
      return line ? { x1: 0, y1: y, x2: line.length - 1, y2: y } : null;
    },
  };
  const prompt = { has: false };
  const promptCtl = {
    clear: () => log.prompt.push(['clear']),
    hasSelection: () => prompt.has,
    offsetAtCell: (row, col) => row * 100 + col,
    anchorAt: (offset) => log.prompt.push(['anchorAt', offset]),
    extendTo: (offset, final) => log.prompt.push(['extendTo', offset, Boolean(final)]),
    selectWordAt: (offset) => log.prompt.push(['selectWordAt', offset]),
    selectLineAt: (offset) => log.prompt.push(['selectLineAt', offset]),
  };
  const slashPaletteRef = { current: { open: false, count: 0 } };
  const scrollFocusRef = { current: {} };
  const inkInput = new EventEmitter();
  const stdout = { columns: COLUMNS, write: (text) => log.writes.push(text) };
  const control = { slashIndex: 2 };
  // The hook re-subscribes when any of these change identity, which stops the edge autoscroll: they are stable, as in the app.
  const promptMouseSelectionRef = { current: spec.promptBox ? promptCtl : null };
  const promptBoxRectRef = { current: spec.promptBox };
  const setSlashIndex = (update) => {
    control.slashIndex = update(control.slashIndex);
    log.slash.push(control.slashIndex);
  };
  const setMeasuredRowsVersion = () => {};
  const mouseHook = spec.wt ? useMouseInputWt : useMouseInput;
  function Harness() {
    const [scrollOffset, setScrollOffset] = React.useState(0);
    const [publish] = React.useState(() => (value) => {
      log.offsets.push(value);
      setScrollOffset(value);
    });
    const scroll = useTranscriptScroll({
      store,
      frameColumns: COLUMNS,
      statuslineBandRows: STATUSLINE_BAND_ROWS,
      setScrollOffset: publish,
      ...refs,
    });
    const mouse = mouseHook({
      inkInput,
      isRawModeSupported: true,
      store,
      stdout,
      frameColumns: COLUMNS,
      statuslineBandRows: STATUSLINE_BAND_ROWS,
      dragRef: refs.dragRef,
      lastClickRef,
      slashPaletteRef,
      scrollFocusRef,
      promptMouseSelectionRef,
      frameRowsRef: refs.frameRowsRef,
      promptBoxRectRef,
      transcriptViewportRef: refs.transcriptViewportRef,
      scrollTargetRef: refs.scrollTargetRef,
      stopSmoothScroll: scroll.stopSmoothScroll,
      applySelectionRect: scroll.applySelectionRect,
      applySelectionRectThrottled: scroll.applySelectionRectThrottled,
      selectionPointAtCurrentScroll: scroll.selectionPointAtCurrentScroll,
      buildSpanRect: scroll.buildSpanRect,
      queueScrollCoalesced: scroll.queueScrollCoalesced,
      setSlashIndex,
      setMeasuredRowsVersion,
      clearStitchBuffer: scroll.clearStitchBuffer,
    });
    const copier = useCopySelection({
      store,
      selectionTextRef: refs.selectionTextRef,
      getStitchedSelectionText: scroll.getStitchedSelectionText,
      showSelectionCopyHint: (message, tone) => log.hints.push([message, tone]),
    });
    control.scroll = scroll;
    control.mouse = mouse;
    control.copy = copier.copySelection;
    return React.createElement(Text, null, `offset ${scrollOffset}`);
  }
  const outStream = new PassThrough();
  outStream.columns = COLUMNS;
  outStream.rows = FRAME_ROWS;
  outStream.on('data', () => {});
  const inStream = new PassThrough();
  inStream.isTTY = true;
  inStream.setRawMode = () => {};
  inStream.ref = () => {};
  inStream.unref = () => {};
  const view = render(React.createElement(Harness), { stdout: outStream, stdin: inStream, stderr: outStream, debug: true, exitOnCtrlC: false, patchConsole: false });
  await delay(60);
  globalThis.__clip = [];
  globalThis.__clipFail = null;
  clock.now = 1000;
  clock.timers = [];
  installFakes();

  const snapshot = (step) => {
    const drag = refs.dragRef.current;
    const stitched = control.scroll.getStitchedSelectionText();
    const out = {
      drag: {
        active: drag.active,
        region: drag.region,
        anchor: point(drag.anchor),
        anchorScroll: drag.anchorScroll,
        last: point(drag.last),
        rect: strip(drag.rect),
        anchorSpan: drag.anchorSpan ? { lo: point(drag.anchorSpan.lo), hi: point(drag.anchorSpan.hi), kind: drag.anchorSpan.kind } : null,
      },
      lastClick: lastClickRef.current.t === 0 ? null : { x: lastClickRef.current.x, y: lastClickRef.current.y, t: lastClickRef.current.t, count: lastClickRef.current.count },
      target: refs.scrollTargetRef.current,
      selectionText: refs.selectionTextRef.current,
      stitched: { text: stitched.text, complete: stitched.complete },
      render: log.render.splice(0),
      prompt: log.prompt.splice(0),
      slash: log.slash.splice(0),
      hints: log.hints.splice(0),
      clipboard: globalThis.__clip.splice(0),
      zoom: log.writes.splice(0).filter((text) => text.includes('?1000l')).length,
      repaints: log.repaints,
    };
    log.repaints = 0;
    return { step, ...out };
  };

  const results = [];
  for (const step of spec.steps) {
    if (step.t !== undefined && step.op !== 'advance') clock.now = Math.max(clock.now, step.t);
    if (step.op === 'mouse') {
      inkInput.emit('mouse', { kind: 'mouse', button: step.b, action: step.a === 'release' ? 'release' : 'press', col: step.x + 1, row: step.y + 1 });
    } else if (step.op === 'wheel') {
      const button = (step.dir > 0 ? 64 : 65) + (step.ctrl ? 16 : 0);
      inkInput.emit('mouse', { kind: 'key', name: step.dir > 0 ? 'wheelup' : 'wheeldown', sequence: `\x1b[<${button};1;1M` });
    } else if (step.op === 'advance') {
      await fire(step.t);
      await settleCapture();
    } else if (step.op === 'copy') {
      control.copy();
      for (let round = 0; round < 4; round += 1) await Promise.resolve();
    } else if (step.op === 'focus') {
      const consumed = control.scroll.moveSelectionFocus(step.move);
      log.prompt.push(['focus', step.move, consumed]);
    } else if (step.op === 'settle') {
      log.prompt.push(['settle', control.mouse.settleStuckDrag()]);
    } else if (step.op === 'palette') {
      slashPaletteRef.current = { open: step.open, count: step.count };
    } else if (step.op === 'overlay') {
      scrollFocusRef.current = step.btw ? { btwPanel: true } : {};
    } else if (step.op === 'promptSel') {
      prompt.has = step.has;
    } else if (step.op === 'clipboard') {
      globalThis.__clipFail = step.fail;
    } else {
      throw new Error(`unknown step ${step.op}`);
    }
    results.push(snapshot(step));
  }
  removeFakes();
  view.unmount();
  inStream.end();
  outStream.end();
  cases.push({ name: spec.name, wt: spec.wt, target: spec.target, promptBox: spec.promptBox, steps: results });
}

// ── golden ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
const golden = {
  format: 1,
  sources,
  frame: { columns: COLUMNS, viewRows: VIEW_ROWS, frameRows: FRAME_ROWS, statuslineBandRows: STATUSLINE_BAND_ROWS, totalRows: TOTAL_ROWS },
  cases,
};
const text = `${JSON.stringify(golden)}\n`;

const write = option('--write');
const check = option('--check');
if (write) {
  writeFileSync(write, text);
  console.error(`wrote ${write}: ${cases.length} scenarios, ${cases.reduce((sum, c) => sum + c.steps.length, 0)} steps`);
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

// Records what the Node transcript window arithmetic does, so the Rust one (`mixdog_tui::transcript::window`) is checked against
// it (tests/transcript_window.rs).
//
// The Node code is only read: the modules are imported from <tree>/src/tui/app, nothing is written there.
//
//   node record-window.mjs --tree C:/Project/mixdog --write tests/goldens/window.json
//   node record-window.mjs --tree C:/Project/mixdog --check tests/goldens/window.json
//
// Recorded (heights are inputs: the Rust window takes them from the widgets that render the items, so the Node row estimate,
// which approximated those heights, is not compared):
//  * windows   - transcriptRenderWindow over generated row tables (all one-row, mixed 1..4, with zero-row items, tall items)
//                of 0..500 items, crossed by viewport heights (including 0 and a missing one) and scroll offsets (fractional,
//                negative, past the end, missing): start, end, spacer, total, max scroll and effective offset;
//  * anchors   - resolveAnchorScrollOffset over anchors that exist, are gone or are missing;
//  * swaps     - transcriptSwapReturnsToTail over counts and head ids;
//  * selection - selectionRectIsDegenerate, selectionRectsEqual, shiftSelectionRectY, compareCellOrder,
//                transcriptViewportRowRange and statusBandRowRange.
//
// The window tunables are read from the environment when the module loads, so the recording unsets them first.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const tree = option('--tree');
if (!tree || (!option('--write') && !option('--check'))) {
  console.error('usage: record-window.mjs --tree <mixdog checkout> (--write <golden.json> | --check <golden.json>)');
  process.exit(2);
}
for (const name of [
  'MIXDOG_TUI_TRANSCRIPT_WINDOW_MIN_ITEMS',
  'MIXDOG_TUI_TRANSCRIPT_OVERSCAN_ROWS',
  'MIXDOG_TUI_TRANSCRIPT_WINDOW_ITEMS',
  'MIXDOG_TUI_TRANSCRIPT_TAIL_OVERSCAN_ROWS',
  'MIXDOG_TUI_TRANSCRIPT_WINDOW_TAIL_ITEMS',
]) {
  delete process.env[name];
}

const sources = [];
const load = async (path) => {
  const file = join(tree, path);
  sources.push({ path, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') });
  return import(pathToFileURL(file).href);
};

const window = await load('src/tui/app/transcript-window.mjs');

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = rng(0x77a1d0c5);
const between = (low, high) => low + Math.floor(random() * (high - low + 1));

// JSON has no NaN: a missing number is recorded as null and read back as NaN or absent.
const orNaN = (value) => (value === null ? Number.NaN : value);

function rowTable(count, kind) {
  const rows = [];
  for (let index = 0; index < count; index++) {
    if (kind === 'ones') rows.push(1);
    else if (kind === 'mixed') rows.push(between(1, 4));
    else if (kind === 'zeros') rows.push(random() < 0.25 ? 0 : between(1, 3));
    else rows.push(random() < 0.1 ? between(20, 60) : between(1, 3));
  }
  return rows;
}

function rowIndexOf(rows) {
  const prefixRows = [0];
  for (const row of rows) prefixRows.push(prefixRows[prefixRows.length - 1] + row);
  return { rows, prefixRows, totalRows: prefixRows[prefixRows.length - 1] };
}

const itemsOf = (count) => Array.from({ length: count }, (_, index) => ({ id: `i${index}`, kind: 'user' }));

const VIEWS = [1, 6, 24, 50, 0, null];
const OFFSETS = [0, 1, 2.5, 7, 40, 130, 5000, -3, null];

function windowCases() {
  const tables = [];
  for (const count of [0, 1, 3, 12, 13, 30, 60, 200, 500]) {
    for (const kind of ['ones', 'mixed', 'zeros', 'tall']) {
      const rows = rowTable(count, kind);
      const index = rowIndexOf(rows);
      const items = itemsOf(count);
      const cases = [];
      for (const view of VIEWS) {
        for (const offset of OFFSETS) {
          const result = window.transcriptRenderWindow(items, {
            scrollOffset: orNaN(offset),
            viewportHeight: orNaN(view),
            rowIndex: index,
          });
          cases.push({
            view,
            offset,
            out: [
              result.startIndex,
              result.endIndex,
              result.bottomSpacerRows,
              result.totalRows,
              result.maxScrollRows,
              result.effectiveScrollOffset,
            ],
          });
        }
      }
      tables.push({ kind, rows, cases });
    }
  }
  return tables;
}

function anchorCases() {
  const cases = [];
  for (const count of [0, 1, 5, 40]) {
    const rows = rowTable(count, 'mixed');
    const index = rowIndexOf(rows);
    const items = itemsOf(count);
    const anchors = [null, { id: 'gone', offset: 0 }, { id: 'i0', offset: 0 }, { id: `i${Math.max(0, count - 1)}`, offset: 1 }];
    if (count > 2) anchors.push({ id: `i${Math.floor(count / 2)}`, offset: 2 });
    for (const anchor of anchors) {
      for (const view of [1, 6, 24]) {
        for (const maxRows of [0, 3, 1000]) {
          const out = window.resolveAnchorScrollOffset({
            anchor,
            items,
            curPrefix: index.prefixRows,
            totalRows: index.totalRows,
            viewRows: view,
            maxRows,
          });
          cases.push({ count, rows, totalRows: index.totalRows, anchor, view, maxRows, out });
        }
      }
    }
  }
  // A prefix table shorter than the items: the anchored item is past the table.
  const items = itemsOf(4);
  cases.push({
    count: 4,
    rows: [2, 2],
    totalRows: 8,
    anchor: { id: 'i3', offset: 0 },
    view: 4,
    maxRows: 100,
    out: window.resolveAnchorScrollOffset({
      anchor: { id: 'i3', offset: 0 },
      items,
      curPrefix: [0, 2, 4],
      totalRows: 8,
      viewRows: 4,
      maxRows: 100,
    }),
  });
  return cases;
}

function swapCases() {
  const cases = [];
  const ids = [null, 'a', 'b'];
  for (const count of [0, 1, 5]) {
    for (const previousCount of [0, 1, 5, 9]) {
      for (const firstId of ids) {
        for (const previousFirstId of ids) {
          cases.push({
            count,
            previousCount,
            firstId,
            previousFirstId,
            out: window.transcriptSwapReturnsToTail({ count, previousCount, firstId, previousFirstId }),
          });
        }
      }
    }
  }
  return cases;
}

function selectionCases() {
  const rect = (x1, y1, x2, y2, extra = {}) => ({ mode: 'stream', x1, y1, x2, y2, ...extra });
  const rects = [rect(3, 4, 3, 4), rect(3, 4, 4, 4), rect(3, 4, 3, 5), rect(0, 0, 0, 0), rect(1, 2, 3, 4, { clipY1: 1, clipY2: 9, captureText: true })];
  return {
    degenerate: rects.map((r) => ({ rect: r, out: window.selectionRectIsDegenerate(r) })),
    equal: rects.flatMap((a) => rects.map((b) => ({ a, b, out: window.selectionRectsEqual(a, b) }))),
    shift: [0, 1, -1, 2.4, 2.5, -2.5, -0.5, 0.2, 7].flatMap((delta) =>
      rects.map((r) => ({ rect: r, delta, out: window.shiftSelectionRectY(r, delta) }))
    ),
    shiftNone: [0, 3].map((delta) => ({ delta, out: window.shiftSelectionRectY(null, delta) })),
    compare: [
      [{ x: 5, y: 1 }, { x: 0, y: 2 }],
      [{ x: 0, y: 3 }, { x: 9, y: 2 }],
      [{ x: 4, y: 2 }, { x: 9, y: 2 }],
      [{ x: 4, y: 2 }, { x: 4, y: 2 }],
      [{ x: 9, y: 2 }, { x: 4, y: 2 }],
    ].map(([a, b]) => ({ a, b, out: window.compareCellOrder(a, b) })),
    viewport: [
      [2, 9],
      [-4, 3],
      [7, 2],
      [0, 0],
      [5, 0],
      [null, null],
      [3, null],
    ].map(([top, bottom]) => ({
      top,
      bottom,
      out: window.transcriptViewportRowRange(top === null && bottom === null ? undefined : { top: top ?? undefined, bottom: bottom ?? undefined }),
    })),
    band: [
      [24, 2],
      [0, 2],
      [3, 8],
      [1, 2],
      [40, 3],
      [-5, 2],
    ].map(([frameRows, band]) => ({ frameRows, band, out: window.statusBandRowRange(frameRows, band) })),
  };
}

const golden = {
  format: 1,
  sources,
  windows: windowCases(),
  anchors: anchorCases(),
  swaps: swapCases(),
  selection: selectionCases(),
};
const text = `${JSON.stringify(golden)}\n`;

const write = option('--write');
const check = option('--check');
if (write) {
  writeFileSync(write, text);
  console.error(`wrote ${write}: ${golden.windows.length} row tables, ${golden.anchors.length} anchor cases`);
}
if (check) {
  const recorded = readFileSync(check, 'utf8');
  if (recorded !== text) {
    console.error(`${check} is not what the Node code records now`);
    process.exit(1);
  }
  console.error(`${check} matches`);
}

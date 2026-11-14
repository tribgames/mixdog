// Records what the Ink fork's selection code does over a corpus of fixed frames, so the Rust selection
// (`mixdog_term::selection`) and the Ink frame parser of the VT test grid are checked against it (tests/selection_twin.rs).
//
// The Node code is only read: the modules are imported from <tree>/node_modules/ink/build, nothing is written there.
//
//   node record-selection.mjs --tree C:/Project/mixdog --write tests/goldens/selection.json
//   node record-selection.mjs --tree C:/Project/mixdog --check tests/goldens/selection.json
//
// Each case is a React tree of Box and Text mounted on the fork's Ink instance with a fake stdout in debug mode (every
// render writes the whole frame), with FORCE_COLOR=3 and the ambiguous-width policy on. For every case it records
//   * the frame as Ink serialised it, and the per-row word-wrap continuation flags (read back through a block selection
//     of the whole screen: `getSelectionRows()` carries them);
//   * `getWordRectAt` on every cell of the screen and on a few cells outside it, and `getLineRectAt` on every row and
//     on rows outside it;
//   * a list of selection rectangles: after `setSelection(null)` (so the text cached from an earlier rectangle cannot
//     leak in) each rectangle is set, and `getSelectionText()`, `getSelectionRows()` and the frame written with the
//     highlight in it are recorded;
//   * for the cases flagged `levels`, the same frame at FORCE_COLOR=1 and 2 (a child run of this script), so the
//     colour downgrade of the Rust writer is held to chalk's.

import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const tree = option('--tree');
const framesOnly = args.includes('--frames-only');
if (!tree || (!framesOnly && !option('--write') && !option('--check'))) {
  console.error('usage: record-selection.mjs --tree <mixdog checkout> (--write <golden.json> | --check <golden.json>)');
  process.exit(2);
}

// chalk reads these when it is imported.
delete process.env.NO_COLOR;
process.env.FORCE_COLOR ??= '3';
if (!framesOnly) process.env.FORCE_COLOR = '3';
process.env.MIXDOG_TUI_AMBIGUOUS_WIDE = '1';

const inkBuild = join(tree, 'node_modules', 'ink', 'build');
const load = (url) => import(pathToFileURL(url).href);
const { render, Box, Text } = await load(join(inkBuild, 'index.js'));
const React = (await load(join(tree, 'node_modules', 'react', 'index.js'))).default;
const h = React.createElement;

const box = (props, ...children) => ({ t: 'box', p: props, c: children });
const text = (content, props) => ({ t: 'text', p: props, c: [content] });
const rich = (props, ...children) => ({ t: 'text', p: props, c: children });
const build = (node) => (typeof node === 'string' ? node : h(node.t === 'box' ? Box : Text, node.p ?? {}, ...(node.c ?? []).map(build)));

const CASES = [
  {
    name: 'ascii-lines',
    width: 26,
    height: 7,
    levels: false,
    tree: [
      text('hello world'),
      text('  indented, trailing   '),
      box({ height: 1 }),
      text('path/to/file-name.rs:42'),
      text('colored', { color: '#ff8800' }),
      text('bg', { backgroundColor: '#102030', color: 'white' }),
    ],
  },
  {
    name: 'cjk-and-emoji',
    width: 24,
    height: 7,
    levels: false,
    tree: [
      text('日本語のテキスト'),
      text('mixed ab日本cd'),
      text('emoji 😀 ok'),
      text('👨‍👩‍👧 family'),
      text('한글 テスト'),
      text('flag 🇯🇵 and é combining'),
    ],
  },
  {
    name: 'borders',
    width: 30,
    height: 9,
    levels: true,
    tree: [
      box({ borderStyle: 'round', width: 22, height: 5 }, text('boxed 日本')),
      box({ borderStyle: 'round', borderColor: '#00ff88', width: 14, height: 3 }, text('inner')),
    ],
  },
  {
    name: 'soft-wrap',
    width: 20,
    height: 8,
    levels: false,
    tree: [
      box({ width: 16, flexDirection: 'column' }, text('alpha beta gamma delta epsilon zeta eta'), text('tail line')),
      box({ width: 10 }, text('truncated line here', { wrap: 'truncate-end' })),
      box({ width: 12 }, text('日本語 テキスト と ascii words', {})),
    ],
  },
  {
    name: 'styled',
    width: 40,
    height: 5,
    levels: true,
    tree: [
      rich(
        {},
        rich({ bold: true }, 'bold'),
        ' ',
        rich({ dimColor: true }, 'dim'),
        ' ',
        rich({ italic: true }, 'italic'),
        ' ',
        rich({ underline: true }, 'under'),
        ' ',
        rich({ inverse: true }, 'inv'),
        ' ',
        rich({ strikethrough: true }, 'strike'),
      ),
      rich({}, rich({ color: '#ff8800' }, 'orange'), ' ', rich({ color: 'red', bold: true }, 'red'), ' ', rich({ backgroundColor: '#336699', color: '#ffffff' }, 'on blue')),
      text('see \u001b]8;;http://example.com/a\u0007link text\u001b]8;;\u0007 after'),
      rich({ color: 'rgb(10,200,30)' }, 'green ', rich({ color: 'rgb(255,0,200)' }, 'pink')),
    ],
  },
  {
    name: 'padded-background',
    width: 24,
    height: 4,
    levels: true,
    tree: [
      box({ backgroundColor: '#203040', width: 18, height: 3, paddingLeft: 2 }, text('padded', { color: '#ffee88' })),
      text('after'),
    ],
  },
  {
    name: 'ambiguous-width',
    width: 28,
    height: 4,
    levels: false,
    tree: [text('① ② ⑩ → ↔ ⇒ x'), text('←↑→↓ markers ↻ 12%'), text('日本 ① 語'), text('end')],
  },
  {
    name: 'code-colors',
    width: 36,
    height: 5,
    levels: true,
    tree: [
      rich({}, rich({ color: '#c678dd' }, 'const'), ' x ', rich({ color: '#56b6c2' }, '='), ' ', rich({ color: '#d19a66' }, '1'), '; ', rich({ color: '#7f848e', italic: true }, '// note')),
      rich({}, rich({ color: '#e06c75' }, 'fn'), ' main() {'),
      rich({}, '    ', rich({ color: '#98c379' }, '"日本語 string"')),
      text('}'),
    ],
  },
];

// A small deterministic generator for the rectangles that are not written by hand.
function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function rectangles(width, height, index) {
  const w = width - 1;
  const hh = height - 1;
  const fixed = [
    ['block', 0, 0, w, hh],
    ['linear', 0, 0, w, hh],
    ['linear', w, hh, 0, 0],
    ['linear', 5, 0, 3, hh],
    ['block', 2, 1, width - 4, height - 2],
    ['block', width - 2, height - 2, 1, 1],
    ['linear', 4, 1, 4, 1],
    ['linear', 2, 2, width - 2, 2],
    ['block', -3, -1, width + 4, height + 2],
    ['linear', 1, hh, w, hh],
    ['linear', 0, 1, 0, 2],
  ].map(([mode, x1, y1, x2, y2]) => ({ mode, x1, y1, x2, y2 }));
  const extra = [
    { mode: 'linear', x1: 0, y1: 0, x2: w, y2: hh, clipY1: 1, clipY2: Math.max(1, height - 2) },
    { mode: 'block', x1: 0, y1: 0, x2: w, y2: hh, captureText: false },
    { mode: 'linear', x1: 1, y1: 0, x2: w - 1, y2: hh, selectionBackground: 'rgb(10, 20, 30)' },
    { mode: 'block', x1: 3, y1: 0, x2: 9, y2: hh, selectionBackground: 'not a colour' },
  ];
  const next = lcg(1000 + index);
  const pick = (limit) => Math.floor(next() * limit);
  const random = [];
  for (let n = 0; n < 8; n++) {
    random.push({
      mode: next() < 0.5 ? 'linear' : 'block',
      x1: pick(width),
      y1: pick(height),
      x2: pick(width),
      y2: pick(height),
    });
  }
  return [...fixed, ...extra, ...random];
}

class FakeStdout extends EventEmitter {
  constructor(columns, rows) {
    super();
    this.columns = columns;
    this.rows = rows;
    this.isTTY = false;
    this.writes = [];
  }
  write(chunk) {
    this.writes.push(String(chunk));
    return true;
  }
}

class FakeStdin extends EventEmitter {
  constructor() {
    super();
    this.isTTY = false;
  }
  setEncoding() {}
  setRawMode() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
  read() {
    return null;
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function mount(item) {
  const stdout = new FakeStdout(item.width, item.height);
  const handle = render(
    h(Box, { flexDirection: 'column', width: item.width, height: item.height }, ...item.tree.map(build)),
    { stdout, stdin: new FakeStdin(), debug: true, patchConsole: false, exitOnCtrlC: false },
  );
  await tick();
  return { stdout, handle };
}

const lastFrame = (stdout) => stdout.writes[stdout.writes.length - 1] ?? '';

if (framesOnly) {
  const frames = {};
  for (const item of CASES.filter((c) => c.levels)) {
    const { stdout, handle } = await mount(item);
    frames[item.name] = lastFrame(stdout);
    handle.unmount();
  }
  process.stdout.write(JSON.stringify(frames));
  process.exit(0);
}

function levelFrames(level) {
  const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--tree', tree, '--frames-only'], {
    // On Windows chalk raises FORCE_COLOR=1 or 2 to its truecolor level; TERM=dumb makes it return the forced level.
    env: { ...process.env, FORCE_COLOR: String(level), TERM: 'dumb' },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.status !== 0) throw new Error(`level ${level} run failed: ${run.stderr}`);
  return JSON.parse(run.stdout);
}
const atLevel = { 1: levelFrames(1), 2: levelFrames(2) };

const cases = [];
for (const [index, item] of CASES.entries()) {
  const { stdout, handle } = await mount(item);
  const frame = lastFrame(stdout);

  // Word-wrap continuation flags: a block selection of the whole screen returns them with its rows.
  handle.setSelection({ mode: 'block', x1: 0, y1: 0, x2: item.width - 1, y2: item.height - 1 });
  await tick();
  const softWrap = new Array(item.height).fill(false);
  for (const row of handle.getSelectionRows() ?? []) softWrap[row.y] = row.sw === true;
  handle.setSelection(null);
  await tick();

  const words = [];
  for (let y = 0; y < item.height; y++) {
    const spans = [];
    const at = [];
    for (let x = 0; x < item.width; x++) {
      const rect = handle.getWordRectAt(x, y);
      if (!rect) {
        at.push(-1);
        continue;
      }
      const key = `${rect.x1},${rect.x2}`;
      let found = spans.findIndex((s) => `${s[0]},${s[1]}` === key);
      if (found < 0) {
        spans.push([rect.x1, rect.x2]);
        found = spans.length - 1;
      }
      if (rect.y1 !== y || rect.y2 !== y) throw new Error('a word rect left its row');
      at.push(found);
    }
    words.push({ y, spans, at });
  }
  const probes = [
    [item.width + 2, 0],
    [-1, 0],
    [0, item.height + 3],
    [3, -2],
  ].map(([x, y]) => [x, y, handle.getWordRectAt(x, y)]);
  const lines = [];
  for (let y = -2; y < item.height + 2; y++) {
    const rect = handle.getLineRectAt(y);
    lines.push({ y, x2: rect ? rect.x2 : null });
  }

  const selections = [];
  for (const rect of rectangles(item.width, item.height, index)) {
    handle.setSelection(null);
    await tick();
    handle.setSelection(rect);
    await tick();
    selections.push({
      rect,
      text: handle.getSelectionText() ?? null,
      rows: handle.getSelectionRows() ?? null,
      frame: lastFrame(stdout),
    });
  }
  handle.unmount();

  const entry = { name: item.name, width: item.width, height: item.height, frame, softWrap, words, probes, lines, selections };
  if (item.levels) entry.levels = { 1: atLevel[1][item.name], 2: atLevel[2][item.name] };
  cases.push(entry);
}

const recording = JSON.stringify({ format: 1, ambiguousWide: true, cases }, null, 1) + '\n';
const writeTo = option('--write');
if (writeTo) {
  writeFileSync(writeTo, recording);
  console.log(`wrote ${writeTo} (${cases.length} cases, ${cases.reduce((n, c) => n + c.selections.length, 0)} selections)`);
} else {
  const checkAgainst = option('--check');
  const golden = readFileSync(checkAgainst, 'utf8');
  if (golden !== recording) {
    console.error(`record-selection: ${checkAgainst} differs from what the Node code records now`);
    process.exit(1);
  }
  console.log(`record-selection: ${checkAgainst} matches (${cases.length} cases)`);
}

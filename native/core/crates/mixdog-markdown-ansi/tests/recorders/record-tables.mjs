#!/usr/bin/env node
// Records (or checks) the table-layout and row-measurement golden of the mixdog-markdown-ansi crate from the Node
// product's own code.
//
//   node record-tables.mjs --tree <mixdog checkout> --write <goldens/tables.json>
//   node record-tables.mjs --tree <mixdog checkout> --check <goldens/tables.json>
//
// Tables: the table blocks of the corpus documents (tests/corpus/docs.json, edge.json, strings.json, each table lexed from
// its own raw text) and a set of generated tables (1-12 columns, every alignment, CJK and emoji cells, inline code, links
// and emphasis in cells, empty cells, long cells that force wrapping and the vertical fallback; the generator is seeded, and
// the generated texts are stored in the golden so the Rust twin reads the same inputs). Each table is laid out by
// `buildTableRender(token, width)` of src/tui/markdown/table-layout.mjs at the widths 10..200 step 5 under the first and
// the last theme of `listThemes()`; what is recorded is the digest (first 16 hex digits of the SHA-256) of the lines joined
// by U+0000, whether the layout is the vertical fallback, and `measureMarkdownTableRows`. A few lines are kept in full.
//
// Measurement: `measureMarkdownRenderedRows(text, columns, { trimPartialFences })` of src/tui/markdown/measure-rendered-rows.mjs
// over every corpus document whole, and over streaming prefixes of each (the cuts are stored: UTF-16 offsets that never split
// a surrogate pair, the ends of the first lines of the document and a few offsets inside lines), and `wrappedLineRows` over
// lines of the corpus at fixed widths. The streaming measurement (`measureStreamingMarkdownRenderedRows`) rides on the
// streaming split, which the stream twin pins; here only the rows of the pieces it adds are recorded.
//
// The display-width policy is fixed off (MIXDOG_TUI_AMBIGUOUS_WIDE=0) before the tree is imported.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.MIXDOG_TUI_AMBIGUOUS_WIDE = '0';

const here = path.dirname(fileURLToPath(import.meta.url));
const corpusDir = path.join(here, '..', 'corpus');
const WIDTHS = [];
for (let w = 10; w <= 200; w += 5) WIDTHS.push(w);
const SAMPLE_WIDTHS = [20, 60];
const SAMPLED = 12;
const MAX_TABLE_RAW = 4000;
const MAX_CORPUS_TABLES = 80;
const MEASURE_COLUMNS = [20, 40, 80, 200];
const PREFIX_COLUMNS = [40, 100];
const PREFIX_SCAN = 6000;
const PREFIX_CUTS = 40;
const WRAP_WIDTHS = [1, 3, 8, 20, 77];
const WRAP_LINES = 300;
const WRAP_LINE_MAX = 200;

function parseArgs(argv) {
  const out = { tree: '', check: '', write: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--tree') out.tree = argv[++i] ?? '';
    else if (a === '--check') out.check = argv[++i] ?? '';
    else if (a === '--write') out.write = argv[++i] ?? '';
    else throw new Error(`unknown argument ${a}`);
  }
  if (!out.tree) throw new Error('--tree <checkout> is required');
  if (!out.check && !out.write) throw new Error('--check <golden> or --write <golden> is required');
  if (out.check && out.write) throw new Error('--check and --write are exclusive');
  return out;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function digest(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

function firstDifference(a, b, where) {
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
    return a === b ? '' : `${where}`;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const d = firstDifference(a[key], b[key], `${where}.${key}`);
    if (d) return d;
  }
  return '';
}

// A seeded generator (mulberry32): the same tables on every run.
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

const POOL = [
  'a',
  'name',
  'value',
  'alpha beta gamma',
  'a considerably longer cell with many separate words that must wrap when the column is narrow',
  'supercalifragilisticexpialidocious_identifier_without_spaces',
  '`inline code`',
  '`code with spaces inside`',
  '[docs](https://example.com/a/very/long/path/to/the/docs)',
  '[x](https://x.dev)',
  '**bold text**',
  '*emphasis*',
  '~~gone~~',
  '**bold** and *em* and `code`',
  '日本語のテキスト',
  '日本語 テキスト 混在 mixed',
  '\u{1f642} smile',
  '\u{1f44d}\u{1f3fd} thumbs up',
  '\u{1f468}‍\u{1f469}‍\u{1f467} family',
  'café naïve',
  'a \\| b',
  '1,234.56',
  '42',
  '',
  '',
  'x',
  'ok',
  'a↔b',
  'line<br>break',
  '&amp; &lt;tag&gt;',
];

function generateTables() {
  const random = rng(20261115);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const aligns = ['---', ':--', ':-:', '--:'];
  const out = [];
  for (let cols = 1; cols <= 12; cols += 1) {
    for (let variant = 0; variant < 5; variant += 1) {
      const rows = variant === 0 ? 0 : 1 + Math.floor(random() * (variant === 4 ? 6 : 3));
      const header = Array.from({ length: cols }, (_, c) => (random() < 0.15 ? '' : pick(POOL.slice(0, 20)) || `h${c}`));
      const align = Array.from({ length: cols }, () => (variant === 1 ? '---' : pick(aligns)));
      const lines = [`| ${header.join(' | ')} |`, `| ${align.join(' | ')} |`];
      for (let r = 0; r < rows; r += 1) {
        lines.push(`| ${Array.from({ length: cols }, () => pick(POOL)).join(' | ')} |`);
      }
      out.push({ id: `gen-${cols}-${variant}`, raw: `${lines.join('\n')}\n` });
    }
  }
  return out;
}

async function record(tree) {
  const toUrl = (rel) => pathToFileURL(path.join(tree, rel)).href;
  const theme = await import(toUrl('src/tui/theme.mjs'));
  const render = await import(toUrl('src/tui/markdown/render-ansi.mjs'));
  const layout = await import(toUrl('src/tui/markdown/table-layout.mjs'));
  const measure = await import(toUrl('src/tui/markdown/measure-rendered-rows.mjs'));
  const strings = readJson(path.join(corpusDir, 'strings.json'));
  const edge = readJson(path.join(corpusDir, 'edge.json'));
  const docs = readJson(path.join(corpusDir, 'docs.json'));

  const ids = theme.listThemes().map((entry) => entry.id);
  const themes = [ids[0], ids[ids.length - 1]];

  // The tables: of the corpus (each table block's raw text, once) and generated.
  const tables = [];
  const seen = new Set();
  for (const [group, list] of [['strings', strings], ['edge', edge], ['docs', docs]]) {
    for (const entry of list) {
      if (!/\|/.test(entry.text)) continue;
      let index = 0;
      for (const segment of render.renderTokenAnsiSegments(entry.text, { width: 80 })) {
        if (segment.type !== 'table') continue;
        const raw = segment.token.raw;
        index += 1;
        if (raw.length > MAX_TABLE_RAW || seen.has(raw) || tables.length >= MAX_CORPUS_TABLES) continue;
        seen.add(raw);
        tables.push({ id: `${group}-${entry.id}-${index}`, raw });
      }
    }
  }
  const corpusTables = tables.length;
  tables.push(...generateTables());

  const tokenOf = (raw) => {
    const segment = render.renderTokenAnsiSegments(raw, { width: 80 }).find((s) => s.type === 'table');
    if (!segment) throw new Error(`no table in ${JSON.stringify(raw.slice(0, 60))}`);
    return segment.token;
  };
  const tableEntries = tables.map((entry, at) => ({ id: entry.id, raw: entry.raw, themes: [], vertical: '', rows: [], sample: {} , gen: at >= corpusTables }));
  for (const [themeAt, id] of themes.entries()) {
    theme.setThemeSetting(id, { persist: false });
    tableEntries.forEach((entry) => {
      const token = tokenOf(entry.raw);
      let digests = '';
      let vertical = '';
      const rows = [];
      for (const width of WIDTHS) {
        const built = layout.buildTableRender(token, width);
        digests += digest(built.lines.join('\u0000'));
        vertical += built.useVerticalFormat ? '1' : '0';
        const measured = layout.measureMarkdownTableRows(token, width);
        if (measured !== built.lines.length) throw new Error(`${entry.id}: measure differs from the lines at ${width}`);
        rows.push(measured);
      }
      entry.themes.push(digests);
      if (themeAt === 0) {
        entry.vertical = vertical;
        entry.rows = rows;
        if (entry.gen && entry.id.endsWith('-4') && Number(entry.id.split('-')[1]) <= SAMPLED) {
          for (const width of SAMPLE_WIDTHS) entry.sample[`w${width}`] = layout.buildTableRender(token, width).lines;
        }
      }
    });
  }
  tableEntries.forEach((entry) => {
    delete entry.gen;
    if (!Object.keys(entry.sample).length) delete entry.sample;
  });

  // The measurement of whole documents and of streaming prefixes.
  const groups = [['strings', strings], ['edge', edge], ['docs', docs]];
  const measured = [];
  for (const [group, list] of groups) {
    for (const entry of list) {
      const text = entry.text;
      const whole = [];
      for (const columns of MEASURE_COLUMNS) whole.push(measure.measureMarkdownRenderedRows(text, columns));
      const cuts = prefixCuts(text);
      const prefixes = [];
      for (const cut of cuts) {
        const part = text.slice(0, cut);
        for (const columns of PREFIX_COLUMNS) {
          prefixes.push(measure.measureMarkdownRenderedRows(part, columns));
          prefixes.push(measure.measureMarkdownRenderedRows(part, columns, { trimPartialFences: true }));
        }
      }
      measured.push({ group, id: entry.id, whole, cuts, prefixes });
    }
  }

  // `wrappedLineRows` over corpus lines.
  const wrapLines = [];
  for (const entry of [...strings, ...edge, ...docs]) {
    for (const line of entry.text.split('\n')) {
      if (line.length > 0 && line.length <= WRAP_LINE_MAX && wrapLines.length < WRAP_LINES && !wrapLines.includes(line)) wrapLines.push(line);
    }
  }
  const wrapped = wrapLines.map((line) => WRAP_WIDTHS.map((width) => measure.wrappedLineRows(line, width)));

  return {
    widths: WIDTHS,
    themes,
    tables: tableEntries,
    measureColumns: MEASURE_COLUMNS,
    prefixColumns: PREFIX_COLUMNS,
    measured,
    wrapWidths: WRAP_WIDTHS,
    wrapLines,
    wrapped,
  };
}

// UTF-16 offsets that cut a text into prefixes: the ends of its first lines (evenly thinned to PREFIX_CUTS), a few inside
// lines, and the whole text; an offset that would split a surrogate pair is moved back by one.
function prefixCuts(text) {
  const head = text.slice(0, PREFIX_SCAN);
  const ends = [];
  for (let i = head.indexOf('\n'); i >= 0; i = head.indexOf('\n', i + 1)) ends.push(i + 1);
  const picked = new Set();
  const stride = Math.max(1, Math.ceil(ends.length / (PREFIX_CUTS - 8)));
  for (let i = 0; i < ends.length; i += stride) picked.add(ends[i]);
  for (let k = 1; k <= 6; k += 1) picked.add(Math.floor((head.length * k) / 7));
  picked.add(text.length);
  const cuts = [];
  for (let cut of picked) {
    const high = text.charCodeAt(cut - 1);
    if (cut > 0 && cut < text.length && high >= 0xd800 && high <= 0xdbff) cut -= 1;
    if (cut > 0 && !cuts.includes(cut)) cuts.push(cut);
  }
  return cuts.sort((a, b) => a - b);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tree = path.resolve(args.tree);
  const recorded = await record(tree);
  if (args.write) {
    fs.writeFileSync(args.write, `${JSON.stringify(recorded)}\n`);
    console.log(`wrote ${args.write}`);
    return;
  }
  const golden = readJson(args.check);
  const diff = firstDifference(golden, JSON.parse(JSON.stringify(recorded)), 'golden');
  if (diff) {
    console.error(`tables golden differs from the tree's table layout at ${diff}`);
    process.exit(1);
  }
  console.log('tables golden matches');
}

main().catch((error) => {
  console.error(error?.stack ?? String(error));
  process.exit(1);
});

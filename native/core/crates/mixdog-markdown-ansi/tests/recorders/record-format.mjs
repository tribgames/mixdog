#!/usr/bin/env node
// Records (or checks) the formatter golden of the mixdog-markdown-ansi crate from the Node product's own renderer.
//
//   node record-format.mjs --tree <mixdog checkout> --write <goldens/format.json>
//   node record-format.mjs --tree <mixdog checkout> --check <goldens/format.json>
//
// What is rendered is `renderTokenAnsiSegments(text, { width })` of the tree's src/tui/markdown/render-ansi.mjs (marked
// lexer, `formatToken`, the segment trim): the ANSI of every block, a table block as the marker TABLE (the table layout is
// another module). The inputs are the files of ../corpus (the lexer twin's): strings.json, edge.json and docs.json.
//
// Every input is rendered at the widths 20, 40, 80, 120 and 200 under three themes (the first, the middle and the last of
// `listThemes()`); the 20 shortest documents are rendered under all fifteen. The display-width policy is fixed off
// (MIXDOG_TUI_AMBIGUOUS_WIDE=0) before the tree is imported, so the recording does not depend on the machine's terminal.
//
// A rendering is recorded as the first 16 hex digits of the SHA-256 of its segments joined by U+0000. The edge inputs also
// keep the segments themselves under the first theme at widths 20 and 80, so a difference reads. The recording also holds
// the answers of the exported helpers: `looksLikeUnifiedDiff` over every string and edge input, and `colorizeDiffLine` over
// a fixed list of diff lines.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.MIXDOG_TUI_AMBIGUOUS_WIDE = '0';

const here = path.dirname(fileURLToPath(import.meta.url));
const corpusDir = path.join(here, '..', 'corpus');
const WIDTHS = [20, 40, 80, 120, 200];
const FULL_WIDTHS = [20, 80];
const SUBSET = 20;
const TABLE = '\u0002table';

const DIFF_LINES = [
  '--- a/file.mjs',
  '+++ b/file.mjs',
  '---',
  '+++',
  '--- ',
  'diff --git a/x b/x',
  'index 3f2a..9c1d 100644',
  'index zzz',
  'new file mode 100644',
  'deleted file mode 100644',
  'rename from a',
  'similarity index 90%',
  'old mode 100644',
  'new mode 100755',
  '@@ -1,3 +1,4 @@ function f()',
  '@@',
  '+added line',
  '-removed line',
  '+',
  '-',
  ' context line',
  '',
  '\\ No newline at end of file',
  ' src/a.mjs | 12 +++++-----',
  ' src/b.mjs | 3 ++-',
  ' image.png | Bin 0 -> 10 bytes',
  ' docs/long name.md | 120 ++++++++++++++++++++++',
  ' 3 files changed, 14 insertions(+), 7 deletions(-)',
  ' 1 file changed, 1 insertion(+)',
  ' 2 files changed, 2 deletions(-)',
  'plain text | not a stat',
];

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

function segmentsOf(render, text, width) {
  return render.renderTokenAnsiSegments(text, { width }).map((segment) => (segment.type === 'table' ? TABLE : segment.ansi));
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

async function record(tree) {
  const toUrl = (rel) => pathToFileURL(path.join(tree, rel)).href;
  const theme = await import(toUrl('src/tui/theme.mjs'));
  const render = await import(toUrl('src/tui/markdown/render-ansi.mjs'));
  const format = await import(toUrl('src/tui/markdown/format-token.mjs'));
  const strings = readJson(path.join(corpusDir, 'strings.json'));
  const edge = readJson(path.join(corpusDir, 'edge.json'));
  const docs = readJson(path.join(corpusDir, 'docs.json'));

  const ids = theme.listThemes().map((entry) => entry.id);
  const themes3 = [ids[0], ids[Math.floor(ids.length / 2)], ids[ids.length - 1]];
  const subset = [...docs].sort((x, y) => x.text.length - y.text.length || (x.id < y.id ? -1 : 1)).slice(0, SUBSET).map((d) => d.id);
  const groups = { strings, edge, docs };
  const subsetIds = new Set(subset);

  // The digests of an input at every width, under the theme now active.
  const row = (text) => WIDTHS.map((width) => digest(segmentsOf(render, text, width).join('\u0000'))).join('');

  const out = {
    widths: WIDTHS,
    themes: themes3,
    allThemes: ids,
    subset,
    entries: { strings: [], edge: [], docs: [] },
    full: [],
    unified: '',
    diffLines: [],
  };
  for (const name of Object.keys(groups)) {
    out.entries[name] = groups[name].map((entry) => ({ id: entry.id, themes: [], all: {} }));
  }
  for (const id of ids) {
    theme.setThemeSetting(id, { persist: false });
    const inThree = themes3.includes(id);
    for (const name of Object.keys(groups)) {
      groups[name].forEach((entry, at) => {
        const target = out.entries[name][at];
        if (inThree) target.themes.push(row(entry.text));
        if (name === 'docs' && subsetIds.has(entry.id)) target.all[id] = inThree ? target.themes[target.themes.length - 1] : row(entry.text);
      });
    }
    if (id === themes3[0]) {
      for (const entry of edge) {
        const full = { id: entry.id };
        for (const width of FULL_WIDTHS) full[`w${width}`] = segmentsOf(render, entry.text, width);
        out.full.push(full);
      }
      out.unified = [...strings, ...edge].map((entry) => (format.looksLikeUnifiedDiff(entry.text) ? '1' : '0')).join('');
      const colors = format.extraColorizers();
      out.diffLines = DIFF_LINES.map((line) => ({ line, out: format.colorizeDiffLine(line, colors) }));
    }
  }
  for (const name of Object.keys(groups)) {
    if (name !== 'docs') out.entries[name].forEach((entry) => delete entry.all);
    else out.entries.docs.forEach((entry) => { if (!subsetIds.has(entry.id)) delete entry.all; });
  }
  return out;
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
    console.error(`format golden differs from the tree's renderer at ${diff}`);
    process.exit(1);
  }
  console.log('format golden matches');
}

main().catch((error) => {
  console.error(error?.stack ?? String(error));
  process.exit(1);
});

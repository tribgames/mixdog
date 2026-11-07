#!/usr/bin/env node
// Parity goldens for the `read` tool's legacy `path` spelling. Each case is the args a model sends,
// the outcome of Node's `guardRead` (via `validateBuiltinArgs`: a refusal, or the args it leaves
// for the executor) and what Node's `read` returned over the shared workspace of `batch_cases.json`.
//
//   node record_legacy_read.mjs --tree <Node product tree with node_modules>
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const tree = resolve(argv[argv.indexOf('--tree') + 1]);
const here = dirname(fileURLToPath(import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'mixdog-legacy-read-golden-'));
// Every dir Mixdog reads or backs up into is a temp one, set before any Mixdog module loads.
process.env.MIXDOG_DATA_DIR = join(work, 'data');
process.env.MIXDOG_HOME = join(work, 'home');
process.env.HOME = join(work, 'home');
process.env.USERPROFILE = join(work, 'home');
process.env.APPDATA = join(work, 'appdata');
process.env.LOCALAPPDATA = join(work, 'localappdata');
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
const importFrom = (rel) => import(pathToFileURL(join(tree, rel)).href);
const { executeBuiltinTool } = await importFrom('src/runtime/agent/orchestrator/tools/builtin.mjs');
const { validateBuiltinArgs } = await importFrom('src/runtime/agent/orchestrator/tools/builtin/arg-guard.mjs');
// Set after the modules load: the product tree is looked up under MIXDOG_ROOT while they initialize.
process.env.MIXDOG_ROOT = join(work, 'root');
process.env.MIXDOG_RUNTIME_ROOT = join(work, 'runtime');

// The workspace is the one `record_batch.mjs` recorded (its recipes), minus the images and the huge files.
const recipes = JSON.parse(readFileSync(join(here, 'batch_cases.json'), 'utf8')).files;
const rowsText = ([count, width], accent) =>
  Array.from({ length: count }, (_, i) => {
    const s = `row-${i + 1}${accent ? (i % 2 ? ' é' : ' ü') : ''}`;
    return width > s.length ? s + '.'.repeat(width - s.length) : s;
  }).join('\n') + '\n';
const encode = (text, enc) => {
  if (!enc) return Buffer.from(text, 'utf8');
  const body = Buffer.from(text, 'utf16le');
  if (enc === 'utf16le') return Buffer.concat([Buffer.from([0xff, 0xfe]), body]);
  return Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(body).swap16()]);
};
const fileBytes = (f) => {
  if (f.hex !== undefined) return Buffer.from(f.hex, 'hex');
  const base = f.rows ? rowsText(f.rows, f.accent) : f.text;
  const bytes = encode(f.repeat ? base.repeat(f.repeat) : base, f.enc);
  return f.nulTail ? Buffer.concat([bytes, Buffer.from([0])]) : bytes;
};
// Files this recording adds to the shared recipes.
const EXTRA = {
  'hello.txt': { text: 'hello from the real-turn harness\n' },
  'sym.mjs': {
    text: "import x from './x.mjs';\n\nexport function alpha() {\n  return 1;\n}\n\nconst beta = () => 2;\n\nexport class Gamma {}\n",
  },
  'doc.md': { text: '# Title\n\nbody\n\n## Part\n\nmore\n' },
  // Over the 10 MiB buffered cap: the glance modes read these by stream.
  'huge-cr.txt': { text: 'x\ry\r\nz\n', repeat: 1500000, huge: true },
  'huge-sym.txt': { text: '# Title\nfn main() {}\n\nplain\n', repeat: 400000, huge: true },
};
const files = {};
for (const [rel, f] of Object.entries({ ...recipes, ...EXTRA })) {
  if (f.png) continue;
  files[rel] = f;
}

const ws = join(work, 'ws');
for (const [rel, f] of Object.entries(files)) {
  mkdirSync(dirname(join(ws, rel)), { recursive: true });
  writeFileSync(join(ws, rel), fileBytes(f));
}
Object.keys(files).forEach((rel, n) => {
  const at = new Date(1700000000000 + n * 1000);
  utimesSync(join(ws, rel), at, at);
});
const wsText = ws.replace(/\\/g, '/');
const scrub = (s) => (typeof s === 'string' ? s.split(wsText).join('<WS>').split(ws).join('<WS>') : s);

const P = (path, extra = {}) => ({ path, ...extra });
const CASES = {
  // A string path.
  'harness-hello': P('hello.txt'),
  'string-plain': P('a.txt'),
  'string-window': P('lines.txt', { offset: 10, limit: 5 }),
  'string-offset-only': P('lines.txt', { offset: 115 }),
  'string-offset-zero': P('lines.txt', { offset: 0, limit: 3 }),
  'string-limit-only': P('lines.txt', { limit: 4 }),
  'string-limit-zero': P('lines.txt', { limit: 0 }),
  'string-offset-limit-zero': P('lines.txt', { offset: 100, limit: 0 }),
  'string-past-end': P('a.txt', { offset: 10 }),
  'string-full': P('a.txt', { full: true }),
  'string-full-wide': P('wide.txt', { full: true }),
  'string-full-lines': P('lines.txt', { full: true }),
  'string-full-with-limit': P('lines.txt', { full: true, limit: 3 }),
  'string-capped': P('wide.txt'),
  'string-capped-limit': P('wide.txt', { limit: 100000 }),
  'string-long-default': P('long.txt'),
  'string-empty-file': P('empty.txt'),
  'string-crlf': P('crlf.txt'),
  'string-no-final-newline': P('nonl.txt'),
  'string-utf16': P('le.txt'),
  'string-missing': P('nope.txt'),
  'string-dir': P('sub'),
  'string-binary': P('bin.dat'),
  'string-glob': P('many/*.txt'),
  'string-glob-limit': P('many/*.txt', { limit: 1 }),
  'string-url': P('https://example.com/x'),
  'string-blank': P(''),
  'string-padded': P('  a.txt  '),
  'string-offset-string': P('lines.txt', { offset: '5', limit: '2' }),
  'string-offset-echo': P('lines.txt', { offset: '5 usepath?lines.txt', limit: 2 }),
  'string-offset-echo-other': P('lines.txt', { offset: '5 usepath?other.txt', limit: 2 }),
  'string-offset-range': P('lines.txt', { offset: '1,40' }),
  'string-limit-range': P('lines.txt', { limit: '1-40' }),
  'string-offset-float': P('lines.txt', { offset: 1.5 }),
  'string-offset-text': P('lines.txt', { offset: 'soon' }),
  'string-offset-bool': P('lines.txt', { offset: true }),
  'string-limit-negative': P('lines.txt', { limit: -1 }),
  'string-limit-clamped': P('lines.txt', { limit: 200000 }),
  'string-offset-clamped': P('lines.txt', { offset: 1e300 }),
  'string-nulls': P('a.txt', { offset: null, limit: null }),
  // Negative offsets read the tail.
  'negative-offset': P('lines.txt', { offset: -5 }),
  'negative-offset-string': P('lines.txt', { offset: '-3' }),
  'negative-offset-limit': P('lines.txt', { offset: -4, limit: 2 }),
  'negative-offset-mode': P('lines.txt', { offset: -4, mode: 'head' }),
  'negative-offset-n': P('lines.txt', { offset: -4, n: 2 }),
  'negative-offset-huge': P('long.txt', { offset: -500000 }),
  // line / context.
  'line-only': P('lines.txt', { line: 50 }),
  'line-context': P('lines.txt', { line: 50, context: 2 }),
  'line-context-zero': P('lines.txt', { line: 3, context: 0 }),
  'line-string': P('lines.txt', { line: '7', context: '1' }),
  'line-near-start': P('lines.txt', { line: 2, context: 5 }),
  'context-only': P('lines.txt', { context: 3 }),
  'line-range-string': P('lines.txt', { line: '3-5' }),
  'line-zero': P('lines.txt', { line: 0 }),
  'line-float': P('lines.txt', { line: 2.5 }),
  'line-text': P('lines.txt', { line: 'x' }),
  'context-range-string': P('lines.txt', { line: 5, context: '1,2' }),
  'context-negative': P('lines.txt', { line: 5, context: -1 }),
  'context-float': P('lines.txt', { line: 5, context: 1.5 }),
  'line-with-offset': P('lines.txt', { line: 5, context: 1, offset: 2, limit: 2 }),
  'line-with-limit-only': P('lines.txt', { line: 5, limit: 2 }),
  // A path:line coordinate.
  'coordinate-colon': P('lines.txt:5-7'),
  'coordinate-single': P('lines.txt:5'),
  'coordinate-hash': P('lines.txt#L5-L6'),
  'coordinate-inverted': P('lines.txt:9-3'),
  'coordinate-with-offset': P('lines.txt:5-7', { offset: 1, limit: 2 }),
  'coordinate-missing-file': P('nope.txt:5'),
  // Modes.
  'mode-full': P('a.txt', { mode: 'full' }),
  'mode-full-lines': P('lines.txt', { mode: 'full' }),
  'mode-head': P('lines.txt', { mode: 'head' }),
  'mode-head-n': P('lines.txt', { mode: 'head', n: 3 }),
  'mode-head-n-string': P('lines.txt', { mode: 'head', n: '2' }),
  'mode-head-n-zero': P('lines.txt', { mode: 'head', n: 0 }),
  'mode-head-n-huge': P('long.txt', { mode: 'head', n: 5000 }),
  'mode-head-n-negative': P('lines.txt', { mode: 'head', n: -1 }),
  'mode-head-n-text': P('lines.txt', { mode: 'head', n: 'x' }),
  'mode-head-n-float': P('lines.txt', { mode: 'head', n: 2.5 }),
  'mode-tail': P('lines.txt', { mode: 'tail' }),
  'mode-tail-n': P('lines.txt', { mode: 'tail', n: 3 }),
  'mode-tail-n-over-file': P('a.txt', { mode: 'tail', n: 50 }),
  'mode-tail-no-final-newline': P('nonl.txt', { mode: 'tail', n: 1 }),
  'mode-tail-crlf': P('crlf.txt', { mode: 'tail', n: 1 }),
  'mode-count': P('lines.txt', { mode: 'count' }),
  'mode-count-text': P('doc.md', { mode: 'count' }),
  'mode-count-empty': P('empty.txt', { mode: 'count' }),
  'mode-count-no-final-newline': P('nonl.txt', { mode: 'count' }),
  'mode-count-utf16': P('le.txt', { mode: 'count' }),
  'mode-count-binary': P('bin.dat', { mode: 'count' }),
  'mode-summary': P('sym.mjs', { mode: 'summary' }),
  'mode-summary-md': P('doc.md', { mode: 'summary' }),
  'mode-summary-n': P('sym.mjs', { mode: 'summary', n: 2 }),
  'mode-summary-limit': P('sym.mjs', { mode: 'summary', limit: 1 }),
  'mode-summary-plain': P('a.txt', { mode: 'summary' }),
  'mode-summary-utf16': P('le.txt', { mode: 'summary' }),
  'mode-summary-binary': P('bin.dat', { mode: 'summary' }),
  'mode-hex': P('a.txt', { mode: 'hex' }),
  'mode-hex-binary': P('bin.dat', { mode: 'hex' }),
  'mode-hex-n': P('a.txt', { mode: 'hex', n: 16 }),
  'mode-hex-n-small': P('a.txt', { mode: 'hex', n: 4 }),
  'mode-hex-offset': P('a.txt', { mode: 'hex', n: 16, offset: 3 }),
  'mode-hex-past-end': P('a.txt', { mode: 'hex', offset: 500 }),
  'mode-hex-utf16': P('le.txt', { mode: 'hex' }),
  'mode-head-with-window': P('lines.txt', { mode: 'head', offset: 2, limit: 2 }),
  'mode-tail-with-limit': P('lines.txt', { mode: 'tail', limit: 2 }),
  'mode-summary-with-offset': P('sym.mjs', { mode: 'summary', offset: 1 }),
  'mode-count-with-window': P('lines.txt', { mode: 'count', offset: 2, limit: 2 }),
  'mode-hex-with-window': P('a.txt', { mode: 'hex', offset: 2, limit: 2 }),
  'mode-head-coordinate': P('lines.txt:5', { mode: 'head' }),
  'mode-unknown': P('a.txt', { mode: 'bogus' }),
  'mode-head-missing': P('nope.txt', { mode: 'head' }),
  'mode-tail-missing': P('nope.txt', { mode: 'tail' }),
  'mode-count-missing': P('nope.txt', { mode: 'count' }),
  'mode-summary-missing': P('nope.txt', { mode: 'summary' }),
  'mode-hex-missing': P('nope.txt', { mode: 'hex' }),
  'mode-head-dir': P('sub', { mode: 'head' }),
  'mode-head-binary': P('bin.dat', { mode: 'head' }),
  'mode-tail-binary': P('bin.dat', { mode: 'tail' }),
  'mode-head-utf16': P('le.txt', { mode: 'head' }),
  'mode-tail-utf16-be': P('be.txt', { mode: 'tail', n: 1 }),
  'mode-head-latin1': P('latin1.txt', { mode: 'head' }),
  'mode-head-bom8': P('bom8.txt', { mode: 'head' }),
  'mode-head-glob': P('many/*.txt', { mode: 'head', n: 1 }),
  'mode-head-wide': P('wide.txt', { mode: 'head', n: 200 }),
  'mode-head-big': P('big8.txt', { mode: 'head', n: 3 }),
  'mode-tail-big': P('big8.txt', { mode: 'tail', n: 3 }),
  'mode-count-big': P('big8.txt', { mode: 'count' }),
  'mode-summary-big': P('big8.txt', { mode: 'summary', n: 2 }),
  'mode-hex-big': P('big8.txt', { mode: 'hex', offset: 100000 }),
  'mode-head-big16': P('big16.txt', { mode: 'head', n: 2 }),
  'mode-count-big16': P('big16.txt', { mode: 'count' }),
  'mode-head-nul-tail': P('big-nul-tail.dat', { mode: 'head' }),
  // Other path types.
  'path-number': P(5),
  'path-bool': P(true),
  'path-object': P({ path: 'a.txt' }),
  'path-empty-array': P([]),
  'path-blank-array': P(['', '  ']),
  'path-array-of-number': P([5]),
  'path-array-of-null': P([null, 'a.txt']),
  'path-missing': {},
  'path-null': { path: null },
  'path-only-limit': { limit: 5 },
  'path-and-file-path': { path: 'a.txt', file_path: 'a.txt' },
  // Arrays and regions.
  'array-two': P(['a.txt', 'b.txt']),
  'array-one': P(['a.txt']),
  'array-repeat': P(['a.txt', 'a.txt']),
  'array-window': P(['lines.txt', 'a.txt'], { offset: 5, limit: 2 }),
  'array-limit-only': P(['lines.txt', 'a.txt'], { limit: 2 }),
  'array-full': P(['a.txt', 'b.txt'], { full: true }),
  'array-missing-entry': P(['a.txt', 'nope.txt']),
  'array-dir-entry': P(['a.txt', 'sub']),
  'array-binary-entry': P(['a.txt', 'bin.dat']),
  'array-nested': P([['a.txt', 'b.txt']]),
  'array-padded': P([' a.txt ', '', 'b.txt']),
  'array-json-string': P('["a.txt","b.txt"]'),
  'array-json-one': P('["a.txt"]'),
  'array-json-object-string': P('{"path":"lines.txt","offset":2,"limit":2}'),
  'array-over-limit': P(Array.from({ length: 12 }, (_, i) => `many/f${String(i + 1).padStart(2, '0')}.txt`)),
  'array-glob-entry': P(['many/*.txt', 'a.txt'], { limit: 1 }),
  'region-windows': P([{ path: 'lines.txt', offset: 2, limit: 3 }, { path: 'a.txt', offset: 2 }]),
  'region-and-string': P([{ path: 'lines.txt', offset: 2, limit: 3 }, 'a.txt']),
  'region-top-defaults': P([{ path: 'lines.txt', offset: 2 }, { path: 'a.txt' }], { limit: 1 }),
  'region-top-offset': P([{ path: 'lines.txt', limit: 2 }], { offset: 4 }),
  'region-overlap': P([{ path: 'lines.txt', offset: 2, limit: 5 }, { path: 'lines.txt', offset: 4, limit: 5 }]),
  'region-adjacent': P([{ path: 'lines.txt', offset: 1, limit: 2 }, { path: 'lines.txt', offset: 3, limit: 2 }]),
  'region-gap-near': P([{ path: 'long.txt', offset: 1, limit: 2 }, { path: 'long.txt', offset: 100, limit: 2 }]),
  'region-gap-far': P([{ path: 'long.txt', offset: 1, limit: 2 }, { path: 'long.txt', offset: 700, limit: 2 }]),
  'region-repeat': P([{ path: 'lines.txt', offset: 2, limit: 3 }, { path: 'lines.txt', offset: 2, limit: 3 }]),
  'region-line-context': P([{ path: 'lines.txt', line: 20, context: 1 }]),
  'region-line-context-bad': P([{ path: 'lines.txt', context: 1 }]),
  'region-line-bad': P([{ path: 'lines.txt', line: 0 }]),
  'region-negative-offset': P([{ path: 'lines.txt', offset: -2 }]),
  'region-negative-offset-mode': P([{ path: 'lines.txt', offset: -2, mode: 'head' }]),
  'region-offset-text': P([{ path: 'lines.txt', offset: 'x' }]),
  'region-offset-range': P([{ path: 'lines.txt', offset: '1-3' }]),
  'region-limit-zero': P([{ path: 'lines.txt', offset: 3, limit: 0 }]),
  'region-limit-negative': P([{ path: 'lines.txt', limit: -2 }]),
  'region-file-path-alias': P([{ file_path: 'lines.txt', offset: 3, limit: 2 }]),
  'region-file-path-alias-two': P([{ file_path: 'lines.txt', offset: 3, limit: 2 }, { path: 'a.txt' }]),
  'region-empty-path': P([{ offset: 1 }]),
  'region-number-entry': P([{ path: 'a.txt' }, 5]),
  'region-null-entry-dropped': P([null, { path: 'a.txt' }]),
  'region-array-entry': P([{ path: 'a.txt' }, ['b.txt']]),
  'region-mode-head': P([{ path: 'lines.txt', mode: 'head', n: 2 }, { path: 'a.txt' }]),
  'region-mode-count': P([{ path: 'lines.txt', mode: 'count' }, { path: 'a.txt', mode: 'tail', n: 1 }]),
  'region-mode-hex': P([{ path: 'a.txt', mode: 'hex', n: 16 }]),
  'region-mode-summary': P([{ path: 'sym.mjs', mode: 'summary' }]),
  'region-full': P([{ path: 'wide.txt', full: true }, { path: 'a.txt' }]),
  'region-mode-top': P([{ path: 'lines.txt' }, { path: 'a.txt' }], { mode: 'head' }),
  'array-mode-head': P(['lines.txt', 'a.txt'], { mode: 'head', n: 2 }),
  'array-mode-tail': P(['lines.txt', 'a.txt'], { mode: 'tail', n: 1 }),
  'array-mode-count': P(['lines.txt', 'a.txt'], { mode: 'count' }),
  'array-mode-summary': P(['sym.mjs', 'doc.md'], { mode: 'summary' }),
  'array-mode-hex': P(['a.txt', 'b.txt'], { mode: 'hex', n: 16 }),
  'array-mode-full': P(['a.txt', 'b.txt'], { mode: 'full' }),
  'array-mode-with-window': P(['lines.txt', 'a.txt'], { mode: 'head', offset: 2, limit: 1 }),
  'array-mode-missing': P(['a.txt', 'nope.txt'], { mode: 'count' }),
  'array-mode-repeat': P(['a.txt', 'a.txt'], { mode: 'count' }),
  // Compact tuples and parallel window arrays.
  'tuple-one': P([['lines.txt', 2, 3]]),
  'tuple-two': P([['lines.txt', 2, 3], ['a.txt', 1]]),
  'tuple-direct': P(['lines.txt', 2, 3]),
  'tuple-string-numbers': P([['lines.txt', '2', '3']]),
  'tuple-mixed': P([['lines.txt', 2], 'a.txt']),
  'zip-arrays': P(['lines.txt', 'a.txt'], { offset: [1, 0], limit: [2, 1] }),
  'zip-arrays-string': P(['lines.txt', 'a.txt'], { offset: '[1, 0]', limit: '[2, 1]' }),
  'zip-single-path': P('lines.txt', { offset: '[0, 100]', limit: '[2, 2]' }),
  'zip-one-window-for-all': P(['lines.txt', 'a.txt'], { limit: [2] }),
  'zip-more-windows-than-paths': P(['lines.txt'], { offset: [1, 5, 9], limit: [1] }),
  'zip-fewer-windows': P(['lines.txt', 'a.txt', 'b.txt'], { offset: [1] }),
  'zip-null-entries': P(['lines.txt', 'a.txt'], { offset: [null, 1] }),
  // A string joining several existing paths is those paths.
  'joined-two': P('a.txt b.txt'),
  'joined-comma': P('a.txt,b.txt'),
  'joined-missing-piece': P('a.txt, nope.txt'),
  'joined-dot': P('. a.txt'),
  'joined-over-limit': P(Array.from({ length: 12 }, (_, i) => `many/f${String(i + 1).padStart(2, '0')}.txt`).join(' ')),
  'joined-public': { file_path: 'a.txt b.txt' },
  // reject_partial refuses a batch that delivered nothing for an entry.
  'reject-partial-missing': P(['a.txt', 'nope.txt'], { reject_partial: true }),
  'reject-partial-delivered': P(['a.txt', 'b.txt'], { reject_partial: true }),
  'reject-partial-region': P([{ path: 'a.txt' }, { path: 'nope.txt' }], { reject_partial: true }),
  'reject-partial-public': { file_path: ['a.txt', 'nope.txt'], reject_partial: true },
  // The public form with null for what was not sent.
  'public-null-offset': { file_path: 'lines.txt', offset: null, limit: null },
  'public-null-array': { file_path: ['a.txt', 'b.txt'], offset: null, limit: null },
  'public-null-path': { file_path: 'a.txt', path: null },
  'public-missing-similar': { file_path: 'a.md' },
  // Path strings refused before any stat.
  'guard-unc': P('\\\\server\\share\\x'),
  'guard-unc-slash': P('//server/share/x'),
  'guard-device-namespace': P('\\\\.\\PhysicalDrive0'),
  'guard-dev-zero': P('/dev/zero'),
  'guard-reserved-name': P('NUL'),
  'guard-reserved-name-ext': P('nul.txt'),
  'guard-trailing-dot': P('a.txt.'),
  'guard-ads': P('a.txt:stream'),
  'guard-glance-ads': P('a.txt:stream', { mode: 'head' }),
  'guard-public-unc': { file_path: '\\\\server\\share\\x' },
  // Host spellings of an absolute path.
  'spelling-posix-drive': P('<WSPOSIX>/a.txt'),
  'spelling-cygdrive': P('<WSCYG>/a.txt'),
  'spelling-mnt': P('<WSMNT>/a.txt'),
  // A missing file with a near name.
  'mode-head-similar': P('a.md', { mode: 'head' }),
  'mode-summary-similar': P('a.md', { mode: 'summary' }),
  'string-missing-similar': P('a.md'),
  // No window over the output cap.
  'big-unwindowed': P('big8.txt', { mode: 'full' }),
  'big-unwindowed-full-false': P('big8.txt', { mode: 'full', n: 1 }),
  'wide-unwindowed': P('wide.txt', { mode: 'full' }),
  'big16-unwindowed': P('big16.txt', { mode: 'full' }),
  'big-full': P('big8.txt', { full: true }),
  'big-batch-unwindowed': P([{ path: 'big8.txt', mode: 'full' }]),
  // Entries in a batch with a mode, full, or no path.
  'batch-entry-mode-glob': P(['many/*.txt', 'a.txt'], { mode: 'head', n: 1 }),
  'batch-entry-full-big': P(['big8.txt', 'a.txt'], { full: true }),
  'batch-entry-no-path-string': P(['a.txt', { offset: 1 }]),  // The glance modes over files past 10 MiB.
  'huge-head': P('huge.txt', { mode: 'head', n: 3 }),
  'huge-head-default': P('huge.txt', { mode: 'head' }),
  'huge-head-cr': P('huge-cr.txt', { mode: 'head', n: 4 }),
  'huge-head-utf16': P('huge16.txt', { mode: 'head' }),
  'huge-head-binary': P('huge-nul.dat', { mode: 'head' }),
  'huge-tail': P('huge.txt', { mode: 'tail', n: 3 }),
  'huge-tail-default': P('huge.txt', { mode: 'tail' }),
  'huge-tail-cr': P('huge-cr.txt', { mode: 'tail', n: 3 }),
  'huge-tail-big-n': P('huge.txt', { mode: 'tail', n: 2000 }),
  'huge-tail-utf16': P('huge16.txt', { mode: 'tail' }),
  'huge-tail-binary': P('huge-nul.dat', { mode: 'tail' }),
  'huge-count': P('huge.txt', { mode: 'count' }),
  'huge-count-cr': P('huge-cr.txt', { mode: 'count' }),
  'huge-count-utf16': P('huge16.txt', { mode: 'count' }),
  'huge-count-binary': P('huge-nul.dat', { mode: 'count' }),
  'huge-summary': P('huge.txt', { mode: 'summary' }),
  'huge-summary-symbols': P('huge-sym.txt', { mode: 'summary' }),
  'huge-summary-n': P('huge-sym.txt', { mode: 'summary', n: 3 }),
  'huge-summary-utf16': P('huge16.txt', { mode: 'summary' }),
  'huge-summary-binary': P('huge-nul.dat', { mode: 'summary' }),
  'huge-hex': P('huge.txt', { mode: 'hex', offset: 10485760 }),
  'huge-hex-default': P('huge.txt', { mode: 'hex' }),
  'huge-hex-binary': P('huge-nul.dat', { mode: 'hex', offset: 10500000, n: 32 }),
  'huge-batch-head': P(['huge.txt', 'a.txt'], { mode: 'head', n: 2 }),  // A missing file under the roots Node redacts in its messages.
  'redact-home-head': P('<TESTHOME>/x.txt', { mode: 'head' }),
  'redact-data-tail': P('<TESTDATA>/nodir/x.txt', { mode: 'tail' }),
  'redact-root-count': P('<TESTROOT>/x.txt', { mode: 'count' }),
  'redact-runtime-hex': P('<TESTRUNTIME>/x.txt', { mode: 'hex' }),
  'redact-home-summary': P('<TESTHOME>/x.txt', { mode: 'summary' }),
  // Both spellings and the public form next to a legacy key.
  'public-with-legacy-offset-base': { file_path: 'lines.txt', offset: 3, limit: 2 },
  'public-array': { file_path: ['a.txt', 'b.txt'] },
};

// Host-dependent spellings and guards: replayed only where Node was recorded to behave this way.
const WINDOWS_ONLY = new Set(['guard-reserved-name', 'guard-trailing-dot', 'guard-ads', 'guard-glance-ads', 'spelling-posix-drive', 'spelling-cygdrive', 'spelling-mnt']);
const drive = ws[0].toLowerCase();
const fwdOf = (p) => p.replace(/\\/g, '/');
const TOKENS = {
  '<TESTHOME>': fwdOf(process.env.HOME),
  '<TESTDATA>': fwdOf(process.env.MIXDOG_DATA_DIR),
  '<TESTROOT>': fwdOf(process.env.MIXDOG_ROOT),
  '<TESTRUNTIME>': fwdOf(process.env.MIXDOG_RUNTIME_ROOT), '<WSPOSIX>': `/${drive}${wsText.slice(2)}`, '<WSCYG>': `/cygdrive/${drive}${wsText.slice(2)}`, '<WSMNT>': `/mnt/${drive}${wsText.slice(2)}` };
// The reverse of `withTokens`, in one pass over the longest value first: `/cygdrive/c/x` and `/mnt/c/x`
// hold `/c/x`, so a value matched on its own would nest a token inside another's spelling.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const tokenize = (s, encode) => {
  const byValue = new Map(Object.entries(TOKENS).map(([k, v]) => [encode(v), k]));
  const longestFirst = [...byValue.keys()].sort((a, b) => b.length - a.length);
  return s.replace(new RegExp(longestFirst.map(escapeRe).join('|'), 'g'), (m) => byValue.get(m));
};
const jsonText = (v) => JSON.stringify(v).slice(1, -1);
const withTokens = (input) => JSON.parse(Object.entries(TOKENS).reduce((s, [k, v]) => s.split(k).join(JSON.stringify(v).slice(1, -1)), JSON.stringify(input)));
const recorded = [];
for (const [name, input] of Object.entries(CASES)) {
  const probe = withTokens(input);
  const refusal = validateBuiltinArgs('read', probe);
  const guard = refusal
    ? { error: scrub(refusal) }
    : {
        args: JSON.parse(tokenize(JSON.stringify(probe), jsonText)),
        limitDefaulted: Object.getOwnPropertyDescriptor(probe, '_readLimitDefaulted')?.value === true,
      };
  const raw = await executeBuiltinTool('read', withTokens(input), ws, {});
  recorded.push({ name, input, ...(WINDOWS_ONLY.has(name) ? { windowsOnly: true } : {}), guard, result: { text: scrub(typeof raw === 'string' ? raw : JSON.stringify(raw)) } });
}
// `normalizeErrorMessage` over messages that hold paths of every kind, with and without a working directory.
const { normalizeErrorMessage } = await importFrom('src/runtime/agent/orchestrator/tools/builtin/path-diagnostics.mjs');
const { normalizeInputPath } = await importFrom('src/runtime/agent/orchestrator/tools/builtin/path-utils.mjs');
const MESSAGES = [
  `ENOENT: no such file or directory, stat '${wsText}/a.txt'`,
  `ENOENT: no such file or directory, stat '${ws}\\sub\\a.txt'`,
  `ENOENT: no such file or directory, stat '${TOKENS['<TESTHOME>']}/x'`,
  `ENOENT: open "${TOKENS['<TESTDATA>']}/y/z"`,
  `EACCES: stat '${TOKENS['<TESTROOT>']}/pkg/index.mjs'`,
  `EACCES: stat '${TOKENS['<TESTRUNTIME>']}'`,
  `stat '${wsText}/../outside/a.txt'`,
  `at run (file:///${wsText}/a.mjs:3:4)`,
  `at load (file:///C:/Windows/x.js)`,
  `at load (file:///usr/lib/x.js)`,
  `at ${TOKENS['<TESTHOME>']}/x unquoted`,
  `stat '/just/an/absolute/path'`,
  `stat 'relative/path'`,
  `a "C:\\Users\\nobody\\f" and 'D:/other/g'`,
];
const untoken = (s) => tokenize(s, (v) => v);
const messages = [];
for (const input of MESSAGES) {
  for (const cwd of [undefined, ws]) {
    messages.push({ input: untoken(scrub(input)), withCwd: cwd !== undefined, output: untoken(scrub(normalizeErrorMessage(input, cwd))) });
  }
}
// `normalizeInputPath` on the spellings of a drive, as a Windows host and (platform stubbed) as WSL.
const SPELLINGS = ['/c/x/y', '/cygdrive/c/x', '/mnt/c/x/y', '//host/share/x', '/C:/x/y', '/C:\\x', 'C:\\Users\\x', 'c:/a/b', 'C:', 'D:\\', ' plain/rel ', 'a\u0001b', '/usr/local/x', 'https://h/p'];
const spellings = SPELLINGS.map((input) => ({ host: 'windows', input, output: normalizeInputPath(input) }));
const realPlatform = process.platform;
Object.defineProperty(process, 'platform', { value: 'linux' });
process.env.WSL_DISTRO_NAME = 'Recorded';
for (const input of SPELLINGS) spellings.push({ host: 'wsl', input, output: normalizeInputPath(input) });
delete process.env.WSL_DISTRO_NAME;
Object.defineProperty(process, 'platform', { value: realPlatform });const out = join(here, 'legacy_read_cases.json');
writeFileSync(out, `${JSON.stringify({ extraFiles: EXTRA, cases: recorded, messages, spellings }, null, 1)}\n`);
rmSync(work, { recursive: true, force: true });
console.log(`recorded ${recorded.length} cases -> ${out}`);

// Records what wrap-ansi 10.0.2, slice-ansi 9.0.0, cli-truncate 6.0.0, the Ink fork's wrap-text / measure-text /
// sanitize-ansi (node_modules/ink/build), @alcalzone/ansi-tokenize 0.3.0, src/tui/markdown/ansi-line-wrap.mjs and the SGR
// parser of src/tui/components/AnsiText.jsx answer over the corpus of tests/wrap_twin.rs, as tests/goldens/wrap.json.
//
//   node record-wrap.mjs [--tree C:/Project/mixdog] [--out <file>] [--check <golden>]
//
// --tree is the checkout whose src and node_modules are the reference (read only). Without --check the recording is
// written to --out (default: tests/goldens/wrap.json); with --check it is compared with that golden and the exit code says
// whether they agree. The recording keeps no machine facts: the same tree gives the same bytes.
//
// The Ink fork reads the display-width policy once, when it loads, so the policy-dependent answers (wrapText in every
// mode, hardWrapAnsiLines, sliceTextByDisplayWidth, measureText) are recorded by two child processes of this script, one
// with MIXDOG_TUI_AMBIGUOUS_WIDE=1 and one with 0; everything else is recorded once, by the child of the first.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const WIDTHS = [1, 2, 3, 10, 20, 40, 80, 120, 200];
const WRAP_OPTIONS = [];
for (const hard of [false, true]) for (const wordWrap of [true, false]) for (const trim of [true, false]) WRAP_OPTIONS.push({ hard, wordWrap, trim });
const TRUNCATE_VARIANTS = [];
for (const position of ['start', 'middle', 'end']) {
  TRUNCATE_VARIANTS.push({ position });
  TRUNCATE_VARIANTS.push({ position, space: true });
  TRUNCATE_VARIANTS.push({ position, preferTruncationOnSpace: true });
}
const WRAP_MODES = ['wrap', 'hard', 'truncate-end', 'truncate-middle', 'truncate-start'];
// slice-ansi(text, start, end) for a width w; null is "to the end".
const sliceRanges = (w) => [[0, w], [Math.floor(w / 2), null], [1, w + 1]];

function parseArgs(argv) {
  const args = { tree: 'C:/Project/mixdog', out: path.join(here, '..', 'goldens', 'wrap.json'), check: null, child: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--tree') args.tree = argv[++i];
    else if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i] === '--check') args.check = argv[++i];
    else if (argv[i] === '--child') args.child = true;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return args;
}

// A seeded generator (mulberry32): the corpus is the same on every run.
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ESC = '\x1b';
const sgr = (...codes) => `${ESC}[${codes.join(';')}m`;
const link = (url, text, params = '') => `${ESC}]8;${params};${url}\x07${text}${ESC}]8;;\x07`;

function buildCorpus() {
  const corpus = [];
  const add = (s) => { if (!corpus.includes(s)) corpus.push(s); };

  // Plain text: spaces, words, long words, tabs, line breaks.
  for (const s of [
    '', ' ', 'a', '   ', 'hello world', 'the quick brown fox jumps over the lazy dog',
    'The quick brown fox jumps over the lazy dog while the five boxing wizards jump quickly over a lazy frog.',
    'abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz',
    'a  b   c    d', '  leading spaces', 'trailing spaces   ', '  both  ', 'one two  three   four',
    'a\tb\tc', '12345678\tx', '1234567\tx', '\tindented', 'tab\tat\tevery\tword boundary of a longer line',
    'line one\nline two is a little longer\n\nline four', 'crlf\r\nbreaks\r\nhere', 'trailing break\n', '\n\nleading breaks',
    'https://example.com/a/very/long/path/that/has/no/spaces/at/all?query=value&other=value#fragment',
    'word '.repeat(30),
  ]) add(s);

  // Wide characters, clusters and combining marks at break points.
  for (const s of [
    '日本語のテキストを折り返す', 'abc日本def語ghi', '日本語 日本語 日本語 日本語', '한글 텍스트 줄바꿈 테스트입니다',
    '🙂🙂🙂🙂🙂 emoji wrap 👍🏽 test 🇯🇵🇰🇷', '👨‍👩‍👧‍👦 family 👩‍💻 coder', '1️⃣2️⃣3️⃣ keycaps', 'e\u0301e\u0301e\u0301e\u0301 combining',
    'ｱｲｳｴｵ halfwidth ﾊﾝｶｸ', 'ＡＢＣ fullwidth ＤＥＦ', 'zero\u200bwidth\u200bspace', 'soft\u00adhyphen',
    '① ② ③ ④ ⑤ circled', '①②③④⑤⑥⑦⑧⑨⑩', '← ↑ → ↓ ↔ ⇒ ↻ 12%', '└── │ ─── ⎿ box', '↔️ ok ✂️ scissors',
  ]) add(s);

  // Styled text: nested SGR, resets, colours, links across wraps.
  const red = (t) => `${sgr(31)}${t}${sgr(39)}`;
  for (const s of [
    red('red text that is long enough to wrap around the line'),
    `${sgr(1)}bold ${sgr(31)}bold red${sgr(22)} just red${sgr(39)} plain text after`,
    `${sgr(1, 31)}combined ${sgr(0)}reset then plain words here`,
    `${sgr(48, 2, 10, 20, 30)}${sgr(38, 5, 196)}256 and truecolor ${sgr(49)}background off${sgr(39)}`,
    `${ESC}[38:2::1:2:3mcolon rgb text${sgr(39)} ${ESC}[38:5:9mcolon indexed${sgr(39)}`,
    `${ESC}[58;5;4m${sgr(4)}underline colour${sgr(24)}${ESC}[59m after`,
    `${sgr(1, 2, 3, 4, 7, 9)}all modifiers on${sgr(22, 23, 24, 27, 29)} all off`,
    `${sgr(3)}italic ${sgr(1)}bold italic${sgr(23)} bold${sgr(22)} none`,
    `see ${link('https://example.com/a?b=c', 'this is the linked text that spans several wrapped lines')} and more text`,
    `${link('https://example.com/x', 'id link', 'id=abc')} then ${link('https://example.org/y', 'second link')}`,
    `${ESC}]8;;https://example.com/st${ESC}\\ST-terminated link text that wraps${ESC}]8;;${ESC}\\ done`,
    `${sgr(32)}${link('https://example.com/z', 'green link text across wraps')}${sgr(39)}`,
    `${link('https://example.com/semi;colon', 'url with a semicolon in it for wrapping')}`,
    `${ESC}]8;;http://u\x07`,
    `${ESC}]0;window title\x07text after a title sequence that is long enough to wrap`,
    `cursor ${ESC}[2Kmoves ${ESC}[?25hand modes ${ESC}[1;2Hmixed with text`,
    `${sgr(31)}`, `${sgr(0)}`, `${ESC}[m`, `${sgr(31)}${sgr(39)}`, `x${sgr(31)}`, `${sgr(31)}x`,
    `a lone ${ESC} escape and ${ESC}[ broken ${ESC}[1; sequence`,
    '\x9b31mc1 red\x9b0m and plain text that wraps', 'a\x9b',
    `${sgr(31)}日本語${sgr(39)} styled ${sgr(32)}🙂🙂${sgr(39)} wide`,
    `${sgr(31)}①②③④⑤${sgr(39)} circled ${sgr(1)}←↑→↓${sgr(22)}`,
    `  ${sgr(31)}  styled leading spaces${sgr(39)}  `,
    `${sgr(31)}tab\tin\tstyle${sgr(39)}`,
    `${sgr(1)}${'verylongword'.repeat(8)}${sgr(22)}`,
    `${red('red ')}${sgr(34)}blue ${sgr(1)}bold blue${sgr(22)}${sgr(39)}\n${sgr(32)}second${sgr(39)} line`,
    `${sgr(31)}open style across\nline breaks and more${sgr(39)}`,
    `${link('https://example.com/multi', 'link across\nline breaks')}`,
    `e${sgr(31)}\u0301x`, `${sgr(1)}ab${sgr(22)}${sgr(31)}cdef${sgr(39)}`,
  ]) add(s);

  // Seeded random mixes of the pieces above.
  const random = seeded(20241103);
  const pieces = [
    ...'abcdefghijklmnopqrstuvwxyz ABCXYZ0123456789.,;:!?-_/()'.split(''), ' ', ' ', ' ', ' ',
    '日', '本', '語', '한', 'ｶ', 'ﾞ', 'Ａ', 'é', 'e\u0301', '\u200b', '🙂', '👍🏽', '👨‍👩‍👧', '🇯🇵', '❤️', '←', '↔', '①', 'ⓐ', '└', '─',
    sgr(31), sgr(39), sgr(1), sgr(22), sgr(0), sgr(38, 5, 9), sgr(48, 2, 1, 2, 3), sgr(4), sgr(24),
    `${ESC}]8;;http://u\x07`, `${ESC}]8;;\x07`, '\t', '\n', 'word', 'longer-word', 'x',
  ];
  for (let i = 0; i < 40; i++) {
    const length = 4 + Math.floor(random() * 36);
    let s = '';
    for (let j = 0; j < length; j++) s += pieces[Math.floor(random() * pieces.length)];
    add(s);
  }
  return corpus;
}

// The SGR parser of AnsiText.jsx, evaluated on its own source with a stub theme (it needs React and ink for the rest).
// The component maps colours through the theme; the stub gives each theme key its own name, and the twin maps the
// colours the Rust parser returns to the same names.
function loadSpanParser(tree) {
  const source = fs.readFileSync(path.join(tree, 'src/tui/components/AnsiText.jsx'), 'utf8');
  const from = source.indexOf('const ANSI_RE');
  const to = source.indexOf('export function AnsiText');
  if (from < 0 || to < 0) throw new Error('AnsiText.jsx no longer has the parser the recorder extracts');
  const theme = { subtle: 'S', error: 'E', success: 'G', warning: 'W', code: 'C', text: 'T', statusText: 'X' };
  return new Function('theme', `${source.slice(from, to)}\nreturn parseAnsi;`)(theme);
}

// The parser keeps one span per stretch between SGR sequences; the twin compares lines of runs, so the spans are cut at
// line breaks (a break starts a new line, empty runs are dropped), as the Rust parser returns them.
function spanLines(spans) {
  const lines = [[]];
  for (const span of spans) {
    const style = [span.style.color, span.style.backgroundColor ?? null, span.style.bold, span.style.dimColor, span.style.italic, span.style.underline, span.style.inverse];
    span.text.split('\n').forEach((part, at) => {
      if (at > 0) lines.push([]);
      if (part.length > 0) lines[lines.length - 1].push([part, ...style]);
    });
  }
  return lines;
}

// Text the Rust parser reads differently on purpose: it also handles OSC 8 links and strikethrough (9, 29), which the
// component leaves alone. Those rows are recorded without spans.
const SPANS_DIFFER = /\x1b\]|\x1b\[(?:[0-9;]*;)?(?:9|29)(?:;[0-9;]*)?m/;

function tokenRows(tokens) {
  return tokens.map((token) => (token.type === 'char' ? ['c', token.value, token.fullWidth] : token.type === 'ansi' ? ['a', token.code, token.endCode] : ['o', token.code]));
}

async function recordChild(tree, policy) {
  const modules = path.join(tree, 'node_modules');
  const load = async (file) => import(pathToFileURL(file).href);
  const wrapAnsi = (await load(path.join(modules, 'wrap-ansi/index.js'))).default;
  const sliceAnsi = (await load(path.join(modules, 'slice-ansi/index.js'))).default;
  const cliTruncate = (await load(path.join(modules, 'cli-truncate/index.js'))).default;
  const ink = path.join(modules, 'ink/build');
  const wrapTextModule = await load(path.join(ink, 'wrap-text.js'));
  const wrapText = wrapTextModule.default;
  const measureText = (await load(path.join(ink, 'measure-text.js'))).default;
  const sanitizeAnsi = (await load(path.join(ink, 'sanitize-ansi.js'))).default;
  const alcalzone = await load(path.join(modules, '@alcalzone/ansi-tokenize/build/index.js'));
  const lineWrap = await load(path.join(tree, 'src/tui/markdown/ansi-line-wrap.mjs'));
  const parseAnsi = loadSpanParser(tree);
  const wide = policy === '1';

  const texts = buildCorpus();
  const rows = texts.map((text) => {
    const perText = {
      sanitized: sanitizeAnsi(text),
      measure: (() => { const m = measureText(text); return [m.width, m.height]; })(),
    };
    const perWidth = WIDTHS.map((w) => {
      const dependent = [
        WRAP_MODES.map((mode) => wrapText(text, w, mode)),
        lineWrap.hardWrapAnsiLines(text, w),
        wrapTextModule.sliceTextByDisplayWidthWithPolicy(text, Math.floor(w / 3), w, wide),
      ];
      if (policy !== '1') return [null, null, null, null, null, dependent];
      return [
        WRAP_OPTIONS.map((o) => wrapAnsi(text, w, o)),
        TRUNCATE_VARIANTS.map((o) => cliTruncate(text, w, o)),
        sliceRanges(w).map(([start, end]) => (end === null ? sliceAnsi(text, start) : sliceAnsi(text, start, end))),
        [lineWrap.wrapText(text, w, { hard: false }), lineWrap.wrapText(text, w, { hard: true })],
        null,
        dependent,
      ];
    });
    if (policy === '1') {
      perText.alcalzone = [tokenRows(alcalzone.tokenize(text)), alcalzone.styledCharsToString(alcalzone.styledCharsFromTokens(alcalzone.tokenize(text)))];
      perText.spans = SPANS_DIFFER.test(text) ? null : spanLines(parseAnsi(text, 'D'));
    }
    return { text, perText, perWidth };
  });
  return rows;
}

function child(tree, policy) {
  const out = execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--tree', tree, '--child'], {
    env: { ...process.env, MIXDOG_TUI_AMBIGUOUS_WIDE: policy },
    maxBuffer: 1 << 30,
    encoding: 'utf8',
  });
  return JSON.parse(out);
}

async function record(tree) {
  const on = child(tree, '1');
  const off = child(tree, '0');
  const rows = on.map((row, at) => {
    const other = off[at];
    if (other.text !== row.text) throw new Error('the two recordings have different corpora');
    return [
      row.text,
      row.perText.sanitized,
      row.perText.measure,
      other.perText.measure,
      row.perText.alcalzone,
      row.perText.spans,
      row.perWidth.map((entry, w) => {
        const [wrapAnsiRows, truncateRows, sliceRows, lineRows, , dependentOn] = entry;
        return [wrapAnsiRows, truncateRows, sliceRows, lineRows, dependentOn, other.perWidth[w][5]];
      }),
    ];
  });
  const header = {
    widths: WIDTHS,
    wrapAnsiOptions: WRAP_OPTIONS,
    truncateVariants: TRUNCATE_VARIANTS,
    wrapModes: WRAP_MODES,
    sliceRanges: 'for width w: [0, w], [floor(w / 2), end of text], [1, w + 1]',
    columns: ['text', 'sanitized', 'measureOn', 'measureOff', 'alcalzone', 'spans', 'perWidth'],
    perWidthColumns: ['wrapAnsi', 'truncate', 'slice', 'lineWrap', 'dependentOn', 'dependentOff'],
    dependentColumns: ['wrapText', 'hardWrapAnsiLines', 'sliceTextByDisplayWidth(floor(w / 3), w)'],
  };
  const lines = rows.map((row) => '    ' + JSON.stringify(row));
  return ['{', ...Object.entries(header).map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)},`), '  "rows": [', lines.join(',\n'), '  ]', '}', ''].join('\n');
}

const args = parseArgs(process.argv.slice(2));
if (args.child) {
  process.stdout.write(JSON.stringify(await recordChild(args.tree, process.env.MIXDOG_TUI_AMBIGUOUS_WIDE)));
} else {
  const recorded = await record(args.tree);
  if (args.check) {
    const golden = fs.readFileSync(args.check, 'utf8');
    if (golden !== recorded) {
      console.error(`${args.check} differs from a fresh recording of ${args.tree}`);
      process.exit(1);
    }
  } else {
    fs.writeFileSync(args.out, recorded);
  }
}

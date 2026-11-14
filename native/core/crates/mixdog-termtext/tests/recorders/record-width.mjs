// Records what string-width 8.3.0, the display-width policy (src/tui/display-width.mjs) and strip-ansi 7.2.0 answer over
// the corpus of tests/width_twin.rs, as tests/goldens/width.json.
//
//   node record-width.mjs [--tree C:/Project/mixdog] [--out <file>] [--check <golden>]
//
// --tree is the checkout whose src and node_modules are the reference (read only). Without --check the recording is
// written to --out (default: tests/goldens/width.json); with --check it is compared with that golden and the exit code
// says whether they agree. The recording keeps no machine facts: the same tree gives the same bytes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { computeTables } from './gen-width-tables.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { tree: 'C:/Project/mixdog', out: path.join(here, '..', 'goldens', 'width.json'), check: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--tree') args.tree = argv[++i];
    else if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i] === '--check') args.check = argv[++i];
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

const isScalar = (cp) => cp >= 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff);
const str = (...cps) => String.fromCodePoint(...cps);
// A code point the recording Node's Unicode (16.0) has not assigned may be assigned, with another grapheme-break class, by
// the Unicode version of the Rust segmentation crate: such a code point is kept out of the random strings, so the corpus
// compares the port and not two Unicode versions. (Table boundaries stay: the width tables are generated, not segmented.)
const isAssigned = (cp) => isScalar(cp) && !/^\p{Cn}$/u.test(String.fromCodePoint(cp));
// U+11A3A is Prepend in ICU 77 and not in the Unicode version of the segmentation crate: between other characters it
// would compare the two versions as well.
const isSegmentationStable = (cp) => isAssigned(cp) && cp !== 0x11a3a;

function buildCorpus(tables) {
  const corpus = new Set();
  const add = (s) => corpus.add(s);

  // Every range boundary of every table, plus and minus one, alone and between ASCII letters.
  for (const table of Object.values(tables)) {
    if (!Array.isArray(table) || typeof table[0] === 'string') continue;
    for (const [lo, hi] of table) {
      for (const cp of [lo - 1, lo, lo + 1, hi - 1, hi, hi + 1]) {
        if (!isScalar(cp)) continue;
        add(str(cp));
        if (isSegmentationStable(cp)) add('a' + str(cp) + 'b');
      }
    }
  }
  for (const s of tables.RGI_SEQUENCES) add(s);

  // Hangul: syllables sampled, and every jamo shape.
  for (let cp = 0xac00; cp <= 0xd7a3; cp += 11) add(str(cp));
  add(str(0xac00));
  add(str(0xd7a3));
  add('한글 테스트');
  const jamo = [0x1100, 0x1112, 0x115f, 0xa960, 0xa97c, 0x1160, 0x1161, 0x11a7, 0xd7b0, 0xd7c6, 0x11a8, 0x11ff, 0xd7cb, 0xd7fb, 0xac00, 0xb098];
  for (const a of jamo) {
    add(str(a));
    for (const b of jamo) {
      add(str(a, b));
      for (const c of jamo) add(str(a, b, c));
    }
  }
  add(str(0x1100, 0x1100, 0x1161));
  add(str(0x1100, 0x1161, 0x11a8, 0x11a8));
  add(str(0x1100, 0x1161, 0x1100, 0x1161, 0x11a8));

  // Scripts, marks, kana, full and half width forms.
  for (const s of ['日本語', 'ｶﾞ', 'か゛', 'ｰ', 'ﾟ', 'ｱｲｳ', 'ＡＢＣ', '漢字かな交じり', 'e\u0301', '\u0301', 'a\u0300\u0301\u0302', 'a\u20dd', '\u0915\u094d\u0937', '\u0e01\u0e33', '\u0e01\u0e49\u0e32', 'क', 'ि', 'a\u200bb', '\u00ad', '\ufeff', 'a\tb', 'a\u0007b', '\u0085', '\u2028', '', ' ', 'plain ascii text', '~', '\u007f', '\u00e9', 'é', 'ö']) add(s);

  // Emoji: ZWJ families, flags, subdivision flags, keycaps, presentation selectors, skin tones.
  for (const s of ['👨‍👩‍👧‍👦', '🏳️‍🌈', '👩‍💻', '👨‍❤️‍👨', '🧑🏽‍🚀', '🇯🇵', '🇯', '🇯🇵🇰', '🇯🇵🇰🇷', '🏴󠁧󠁢󠁥󠁮󠁧󠁿', '🏴󠁧󠁢󠁳󠁣󠁴󠁿', '1️⃣', '#⃣', '*⃣', '1⃣', '9︎⃣', '❤', '❤️', '❤︎', '☺', '☺️', '©', '©️', '↔', '↔️', '↔︎', '👍', '👍🏽', '👍\u{1f3fb}\u{1f3fc}', '⭐', '✂️', '✂', '🧑‍🧑‍🧒', '\u200d', '👨\u200d', '\u200d👨', '👨\u200d👩', 'a\u200db', '🙂\u200d↔️', '🐦‍⬛', '🧑‍🧑‍🧑‍🧑‍🧑‍🧑‍🧑‍🧑‍🧑‍🧑‍🧑‍🧑‍🧑‍🧑‍🧑‍🧑']) add(s);

  // The Windows problem ranges: arrows U+2190-U+21FF and enclosed alphanumerics U+2460-U+24FF, alone and in company.
  for (const [lo, hi] of [[0x2190, 0x21ff], [0x2460, 0x24ff], [0x2500, 0x257f], [0x2580, 0x259f]]) {
    for (let cp = lo; cp <= hi; cp++) {
      add(str(cp));
      add(str(cp, 0xfe0f));
      add(str(cp, 0xfe0e));
      add('x' + str(cp) + 'y');
      add(str(cp, cp));
    }
  }
  for (const s of ['← ↑ → ↓', '↻ 12%', '① ② ③', '└ │ ⎿ ─', '←Spawn', '↔️ ok', '⇒ ⇧', 'ⓐⓑⓒ', '⑩⑪']) add(s);

  // Escapes: SGR, OSC 8 with both terminators, C1 introducers, and the malformed shapes of the ansi-regex pattern.
  for (const s of [
    '\x1b[31mred\x1b[0m', '\x1b[1;38;2;255;0;0mx\x1b[m', '\x1b[38:2::255:0:0mx', '\x1b[12345m', '\x1b[1;2;3;4;5;;m', '\x1b[1;', '\x1b[', '\x1b', '\x1b[?25h', '\x1b[?25l', '\x1b(B', '\x1b#8', '\x1b[1;2H', '\x1b[2J',
    '\x1b]8;;http://x.test\x07link\x1b]8;;\x07', '\x1b]8;;http://x.test\x1b\\link\x1b]8;;\x1b\\', '\x1b]8;;http://x.test\x9clink', '\x1b]0;title', '\x1b]0;title\x07rest', '\x1b]\x07', '\x1b]x', '\x1b]]1m',
    '\x9b31mx', '\x9b', '\x9b1;', 'a\x9bb', '\x1b[31m日本\x1b[0m語', '\x1b[31m🙂\x1b[0m', 'a\x1bb', '\x1b[\x1b[1mx', '\x1b[1;2;3', '\x1b[1;2;3a', '\x1b[99999m', '\x1b[1:2:3:4:5mx',
  ]) add(s);

  // Seeded random mixed strings.
  const random = seeded(20240601);
  const pools = [
    ...'abcdefghijklmnopqrstuvwxyz ABCXYZ0123456789.,;:!?-_/\\()[]{}#*~'.split(''),
    '日', '本', '語', '한', '글', 'ｶ', 'ﾞ', 'ﾟ', 'ｰ', 'Ａ', 'é', 'e\u0301', '\u0301', '\u200d', '\ufe0f', '\ufe0e', '\u20e3', '\u200b',
    '🙂', '👍', '👍🏽', '👨‍👩‍👧', '🇯🇵', '🇯', '1️⃣', '❤️', '❤', '☺', '©', '⭐', '←', '↑', '↔', '↔️', '↻', '①', '⑳', 'ⓐ', '└', '│', '─', '█',
    str(0x1100), str(0x1161), str(0x11a8), str(0xac00), str(0xa960), str(0xd7b0), str(0xd7cb),
    '\x1b[31m', '\x1b[0m', '\x1b]8;;u\x07', '\x1b]8;;\x07', '\x9b1m', '\t', '\n', '\x07',
  ];
  for (let i = 0; i < 5000; i++) {
    const length = 1 + Math.floor(random() * 12);
    let s = '';
    for (let j = 0; j < length; j++) {
      s += random() < 0.15 ? str(...[0x20 + Math.floor(random() * 0x2fe0)].filter(isAssigned)) : pools[Math.floor(random() * pools.length)];
    }
    add(s);
  }
  return [...corpus];
}

async function record(tree) {
  const tables = await computeTables(tree);
  const modules = path.join(tree, 'node_modules');
  const importFrom = (file, query = '') => import(pathToFileURL(file).href + query);
  const stringWidth = (await importFrom(path.join(modules, 'string-width/index.js'))).default;
  const stripAnsi = (await importFrom(path.join(modules, 'strip-ansi/index.js'))).default;
  // The policy module resolves its switch once at load: load it twice, once per setting, as separate instances.
  const saved = process.env.MIXDOG_TUI_AMBIGUOUS_WIDE;
  process.env.MIXDOG_TUI_AMBIGUOUS_WIDE = '1';
  const policyOn = (await importFrom(path.join(tree, 'src/tui/display-width.mjs'), '?on')).displayWidth;
  process.env.MIXDOG_TUI_AMBIGUOUS_WIDE = '0';
  const policyOff = (await importFrom(path.join(tree, 'src/tui/display-width.mjs'), '?off')).displayWidth;
  if (saved === undefined) delete process.env.MIXDOG_TUI_AMBIGUOUS_WIDE;
  else process.env.MIXDOG_TUI_AMBIGUOUS_WIDE = saved;
  const segmenter = new Intl.Segmenter();

  const rows = buildCorpus(tables).map((s) => [
    s,
    stringWidth(s),
    stringWidth(s, { ambiguousIsNarrow: false }),
    stringWidth(s, { countAnsiEscapeCodes: true }),
    policyOn(s),
    policyOff(s),
    stripAnsi(s),
    [...segmenter.segment(s)].length,
  ]);
  const lines = rows.map((row) => '    ' + JSON.stringify(row));
  return [
    '{',
    '  "columns": ["text", "stringWidth", "stringWidthAmbiguousWide", "stringWidthCountAnsi", "displayWidthWide", "displayWidthNarrow", "stripAnsi", "graphemes"],',
    '  "rows": [',
    lines.join(',\n'),
    '  ]',
    '}',
    '',
  ].join('\n');
}

const args = parseArgs(process.argv.slice(2));
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

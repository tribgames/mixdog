// Generates src/width_tables.rs: the Unicode facts string-width 8.3.0 reads, as V8 and get-east-asian-width evaluate them.
//
//   node gen-width-tables.mjs [--tree C:/Project/mixdog] [--out <file>] [--check]
//
// --tree is the checkout whose node_modules hold string-width, get-east-asian-width and emoji-regex (read only).
// --check compares the tables it would write with the file instead of writing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const MAX_CP = 0x10ffff;

// The regular expressions of string-width/index.js, verbatim. `assertSameSource` fails when the installed package no
// longer contains them, so the tables cannot silently describe other rules.
const VISIBLE_SOURCE = String.raw`/[^\p{Default_Ignorable_Code_Point}\p{Control}\p{Format}\p{Nonspacing_Mark}\p{Enclosing_Mark}\p{Surrogate}]/v`;
const SPACING_MARK_SOURCE = String.raw`/\p{Spacing_Mark}/v`;
const RGI_SOURCE = String.raw`/^\p{RGI_Emoji}$/v`;
const PICTOGRAPHIC_SOURCE = String.raw`/\p{Extended_Pictographic}/gu`;

const visibleRe = /[^\p{Default_Ignorable_Code_Point}\p{Control}\p{Format}\p{Nonspacing_Mark}\p{Enclosing_Mark}\p{Surrogate}]/v;
const spacingMarkRe = /\p{Spacing_Mark}/v;
const rgiRe = /^\p{RGI_Emoji}$/v;
const pictographicRe = /^\p{Extended_Pictographic}$/u;
const modifierBaseRe = /^\p{Emoji_Modifier_Base}$/u;

function parseArgs(argv) {
  const args = { tree: 'C:/Project/mixdog', out: path.join(here, '..', '..', 'src', 'width_tables.rs'), check: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--tree') args.tree = argv[++i];
    else if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i] === '--check') args.check = true;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return args;
}

function ranges(test) {
  const out = [];
  let start = -1;
  for (let cp = 0; cp <= MAX_CP + 1; cp++) {
    const on = cp <= MAX_CP && test(cp);
    if (on && start < 0) start = cp;
    else if (!on && start >= 0) {
      out.push([start, cp - 1]);
      start = -1;
    }
  }
  return out;
}

const compareCodePoints = (a, b) => {
  const x = Array.from(a, (c) => c.codePointAt(0));
  const y = Array.from(b, (c) => c.codePointAt(0));
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
};

// The sequences of emoji-regex's pattern, expanded. The pattern uses only literals, escapes, classes, `?`, `|` and
// `(?:...)`, so a small recursive reader enumerates every string it can match (as UTF-16 text).
function expandEmojiRegex(source) {
  let pos = 0;
  const cross = (left, right) => {
    const out = new Set();
    for (const a of left) for (const b of right) out.add(a + b);
    return [...out];
  };
  const escape = () => {
    const c = source[pos + 1];
    if (c === 'u') {
      const unit = String.fromCharCode(parseInt(source.slice(pos + 2, pos + 6), 16));
      pos += 6;
      return unit;
    }
    if (c === 'x') {
      const unit = String.fromCharCode(parseInt(source.slice(pos + 2, pos + 4), 16));
      pos += 4;
      return unit;
    }
    pos += 2;
    return c;
  };
  const classUnit = () => (source[pos] === '\\' ? escape() : source[pos++]);
  const parseClass = () => {
    pos++; // [
    const out = [];
    while (source[pos] !== ']') {
      const lo = classUnit().charCodeAt(0);
      if (source[pos] === '-' && source[pos + 1] !== ']') {
        pos++;
        const hi = classUnit().charCodeAt(0);
        for (let u = lo; u <= hi; u++) out.push(String.fromCharCode(u));
      } else out.push(String.fromCharCode(lo));
    }
    pos++; // ]
    return out;
  };
  const parseAtom = () => {
    const c = source[pos];
    if (c === '(') {
      if (!source.startsWith('(?:', pos)) throw new Error(`unsupported group at ${pos}`);
      pos += 3;
      const inner = parseAlternation();
      if (source[pos++] !== ')') throw new Error(`unterminated group at ${pos}`);
      return inner;
    }
    if (c === '[') return parseClass();
    if (c === '\\') return [escape()];
    if ('*+{}^$.'.includes(c)) throw new Error(`unsupported pattern character ${c} at ${pos}`);
    pos++;
    return [c];
  };
  const parseSequence = () => {
    let results = [''];
    while (pos < source.length && source[pos] !== '|' && source[pos] !== ')') {
      let atom = parseAtom();
      if (source[pos] === '?') {
        pos++;
        atom = ['', ...atom];
      }
      results = cross(results, atom);
    }
    return results;
  };
  function parseAlternation() {
    const all = new Set(parseSequence());
    while (source[pos] === '|') {
      pos++;
      for (const s of parseSequence()) all.add(s);
    }
    return [...all];
  }
  const out = parseAlternation();
  if (pos !== source.length) throw new Error(`pattern not consumed at ${pos}`);
  return out;
}

function assertSameSource(tree) {
  const text = fs.readFileSync(path.join(tree, 'node_modules/string-width/index.js'), 'utf8');
  for (const literal of [VISIBLE_SOURCE, SPACING_MARK_SOURCE, RGI_SOURCE, PICTOGRAPHIC_SOURCE]) {
    if (!text.includes(literal)) throw new Error(`string-width/index.js no longer contains ${literal}`);
  }
}

export async function computeTables(tree) {
  assertSameSource(tree);
  const eaw = await import(pathToFileURL(path.join(tree, 'node_modules/get-east-asian-width/index.js')).href);
  const emojiRegex = (await import(pathToFileURL(path.join(tree, 'node_modules/emoji-regex/index.js')).href)).default;
  const wide = (cp) => eaw.eastAsianWidth(cp) === 2;
  const ambiguous = (cp) => !wide(cp) && eaw.eastAsianWidth(cp, { ambiguousAsWide: true }) === 2;
  const text = (cp) => String.fromCodePoint(cp);

  const tables = {
    WIDE: ranges(wide),
    AMBIGUOUS: ranges(ambiguous),
    NOT_VISIBLE: ranges((cp) => !visibleRe.test(text(cp))),
    SPACING_MARK: ranges((cp) => spacingMarkRe.test(text(cp))),
    EXTENDED_PICTOGRAPHIC: ranges((cp) => pictographicRe.test(text(cp))),
    RGI_SINGLE: ranges((cp) => rgiRe.test(text(cp))),
  };

  const candidates = new Set(expandEmojiRegex(emojiRegex().source));
  for (let cp = 0; cp <= MAX_CP; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    candidates.add(text(cp) + '\uFE0F');
    candidates.add(text(cp) + '\uFE0E');
    if (modifierBaseRe.test(text(cp))) for (let m = 0x1f3fb; m <= 0x1f3ff; m++) candidates.add(text(cp) + text(m));
  }
  for (const k of '0123456789#*') {
    candidates.add(k + '\u20E3');
    candidates.add(k + '\uFE0F\u20E3');
  }
  for (let a = 0x1f1e6; a <= 0x1f1ff; a++) for (let b = 0x1f1e6; b <= 0x1f1ff; b++) candidates.add(text(a) + text(b));
  tables.RGI_SEQUENCES = [...candidates]
    .filter((s) => Array.from(s).length >= 2 && rgiRe.test(s))
    .sort(compareCodePoints);
  return tables;
}

const hex = (n) => '0x' + n.toString(16);
const rustString = (s) => '"' + Array.from(s, (c) => `\\u{${c.codePointAt(0).toString(16)}}`).join('') + '"';

function render(tables) {
  const lines = [
    '// @generated by tests/recorders/gen-width-tables.mjs from get-east-asian-width 1.6.0, emoji-regex 10.6.0 and the',
    `// regular expressions of string-width 8.3.0 as V8 (Node ${process.versions.node}, ICU ${process.versions.icu}, Unicode ${process.versions.unicode}) evaluates them.`,
    '// Do not edit: run the generator again.',
    '',
  ];
  const docs = {
    WIDE: 'Code points get-east-asian-width counts as 2 cells whatever the ambiguous setting (Fullwidth and Wide).',
    AMBIGUOUS: 'Ambiguous code points: 2 cells only when the ambiguous setting is wide.',
    NOT_VISIBLE: 'Code points the visible-character class of string-width excludes (Default_Ignorable, Control, Format, Nonspacing_Mark, Enclosing_Mark, Surrogate).',
    SPACING_MARK: 'Code points with the Spacing_Mark property.',
    EXTENDED_PICTOGRAPHIC: 'Code points with the Extended_Pictographic property.',
    RGI_SINGLE: 'Single code points that are an RGI_Emoji on their own.',
  };
  for (const name of Object.keys(docs)) {
    lines.push(`/// ${docs[name]} Sorted, inclusive ranges.`, '#[rustfmt::skip]', `pub static ${name}: &[(u32, u32)] = &[`);
    const items = tables[name].map(([lo, hi]) => `(${hex(lo)}, ${hex(hi)})`);
    for (let i = 0; i < items.length; i += 6) lines.push('    ' + items.slice(i, i + 6).join(', ') + ',');
    lines.push('];', '');
  }
  lines.push(
    '/// RGI_Emoji sequences of two or more code points, sorted by code point (the byte order of the UTF-8 text).',
    '#[rustfmt::skip]',
    'pub static RGI_SEQUENCES: &[&str] = &[',
  );
  for (const s of tables.RGI_SEQUENCES) lines.push(`    ${rustString(s)},`);
  lines.push('];', '');
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rendered = render(await computeTables(args.tree));
  if (args.check) {
    const current = fs.existsSync(args.out) ? fs.readFileSync(args.out, 'utf8') : '';
    if (current !== rendered) {
      console.error(`${args.out} differs from the generated tables`);
      process.exit(1);
    }
    return;
  }
  fs.writeFileSync(args.out, rendered);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();

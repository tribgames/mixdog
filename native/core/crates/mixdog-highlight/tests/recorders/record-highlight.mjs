// Records what highlight.js 10.7.3 and cli-highlight 2.1.11 answer for the corpus, for the Rust twin test.
//
//   node record-highlight.mjs --tree <repo with node_modules> --out <golden.json>       writes the golden
//   node record-highlight.mjs --tree <repo> --check <golden.json>                        fails when it differs
//   node record-highlight.mjs --tree <repo> --collect-docs                               refreshes tests/corpus/*.docs.txt
//                                                                                        from the fenced blocks of the docs
//   add --all to record the languages the core set does not carry (all 191 are listed): the corpus is
//   tests/corpus_extra, the golden is tests/goldens/highlight-all.json, and every name and alias is resolved.
//   add --format-token <file> when <repo> has no src/tui/markdown/format-token.mjs (the class map is read from it).
//
// Per (language, snippet): the HTML `highlight(code, {language, ignoreIllegals: true}).value` (compared with the
// engine's HTML), the same with ignoreIllegals false (value, illegal, relevance), and cli-highlight's ANSI with
// the class map `format-token.mjs` builds, under three themes (compared with ansi.rs). Auto detection and the
// language registry answers are recorded too. The timing of a 5,000-line JavaScript file is recorded for the
// benchmark (it is not part of --check).
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const tree = opt('--tree');
const outFile = opt('--out');
const checkFile = opt('--check');
const collectDocs = args.includes('--collect-docs');
const all = args.includes('--all');
const formatTokenFile = opt('--format-token');
if (!tree || (!outFile && !checkFile && !collectDocs)) {
  console.error('usage: record-highlight.mjs --tree <repo> (--out <file> | --check <file> | --collect-docs)');
  process.exit(2);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const corpusDir = path.join(here, '..', all ? 'corpus_extra' : 'corpus');
const dataDir = path.join(here, '..', '..', 'src', 'languages', 'data');
const registry = JSON.parse(fs.readFileSync(path.join(dataDir, '_registry.json'), 'utf8'));
// The languages of the golden: the core set, or with --all every registered language, of which the corpus holds
// the ones the core set does not.
const included = all ? registry.order : registry.included;
const recordedLanguages = all ? registry.order.filter((n) => !registry.included.includes(n)) : registry.included;

const require = createRequire(path.join(path.resolve(tree), 'package.json'));
const hljs = require('highlight.js');
const cliHighlight = require('cli-highlight');
const { Chalk } = await import(pathToFileURL(path.join(path.resolve(tree), 'node_modules', 'chalk', 'source', 'index.js')).href);
const chalk = new Chalk({ level: 3 });

const SEPARATOR = '\n@@@@\n';

// ── the fenced blocks of the docs ───────────────────────────────────────────
function walk(dir, visit) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', 'target', 'out'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, visit);
    else visit(full);
  }
}

function docFences() {
  const root = path.resolve(tree);
  const files = [];
  walk(root, (file) => {
    const rel = path.relative(root, file).split(path.sep).join('/');
    if (!rel.endsWith('.md')) return;
    if (rel.startsWith('docs/') || /(^|\/)README[^/]*\.md$/i.test(rel)) files.push(file);
  });
  files.sort();
  const found = new Map();
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const open = /^(\s*)(`{3,}|~{3,})\s*([^\s`]*)/.exec(lines[i]);
      if (!open) continue;
      const fence = open[2];
      const label = open[3].toLowerCase();
      const body = [];
      let j = i + 1;
      while (j < lines.length && !new RegExp(`^\\s*${fence[0]}{${fence.length},}\\s*$`).test(lines[j])) {
        body.push(lines[j].startsWith(open[1]) ? lines[j].slice(open[1].length) : lines[j]);
        j++;
      }
      i = j;
      const lang = label && hljs.getLanguage(label) ? registeredName(label) : null;
      const code = body.join('\n').trim();
      if (!lang || !included.includes(lang) || !code || code.length > 6000) continue;
      if (!found.has(lang)) found.set(lang, new Set());
      found.get(lang).add(code);
    }
  }
  return found;
}

function registeredName(label) {
  const lang = hljs.getLanguage(label);
  return hljs.listLanguages().find((n) => hljs.getLanguage(n) === lang);
}

if (collectDocs) {
  for (const f of fs.readdirSync(corpusDir)) if (f.endsWith('.docs.txt')) fs.rmSync(path.join(corpusDir, f));
  let total = 0;
  for (const [lang, set] of docFences()) {
    // Plain text is the language of every diagram and output block of the docs: the first 60 stand for them.
    const snippets = [...set].sort().slice(0, lang === 'plaintext' ? 60 : undefined);
    total += snippets.length;
    fs.writeFileSync(path.join(corpusDir, `${lang}.docs.txt`), `${snippets.join(SEPARATOR)}\n`);
  }
  console.log(`wrote ${total} fenced blocks`);
  process.exit(0);
}

// ── themes: the class map of format-token.mjs buildCliHighlightTheme ────────
const formatToken = fs.readFileSync(formatTokenFile ?? path.join(path.resolve(tree), 'src', 'tui', 'markdown', 'format-token.mjs'), 'utf8');
const themeBody = /function buildCliHighlightTheme\(c\) \{[\s\S]*?return \{([\s\S]*?)\n  \};\n\}/.exec(formatToken);
if (!themeBody) throw new Error('buildCliHighlightTheme not found in format-token.mjs');
const classSlots = {};
for (const line of themeBody[1].split('\n')) {
  const m = /^\s*([A-Za-z_]+): (plain|c\.[A-Za-z]+),?\s*$/.exec(line);
  if (m) classSlots[m[1]] = m[2] === 'plain' ? 'body' : m[2].slice(2);
}
if (Object.keys(classSlots).length < 30 || classSlots.default !== 'body') throw new Error('class map not read');

const PALETTES = {
  dark: {
    body: [212, 212, 212], synKeyword: [86, 156, 214], synType: [78, 201, 176], synNumber: [181, 206, 168],
    synString: [206, 145, 120], synFunction: [220, 220, 170], synVariable: [156, 220, 254],
    synComment: [106, 153, 85], synPunct: [128, 128, 128],
  },
  light: {
    body: [30, 30, 30], synKeyword: [0, 0, 255], synType: [38, 127, 153], synNumber: [9, 134, 88],
    synString: [163, 21, 21], synFunction: [121, 94, 38], synVariable: [0, 16, 128],
    synComment: [0, 128, 0], synPunct: [60, 60, 60],
  },
  // A slot that does not parse as a colour is the identity function in format-token.
  sparse: {
    body: null, synKeyword: [255, 0, 255], synType: [255, 0, 255], synNumber: null,
    synString: [0, 255, 255], synFunction: null, synVariable: [1, 2, 3], synComment: [90, 90, 90], synPunct: null,
  },
};
const THEME_NAMES = Object.keys(PALETTES);

function nodeTheme(name) {
  const palette = PALETTES[name];
  const style = (slot) => {
    const rgb = palette[slot];
    return rgb ? chalk.rgb(rgb[0], rgb[1], rgb[2]) : (s) => s;
  };
  const theme = {};
  for (const [cls, slot] of Object.entries(classSlots)) theme[cls] = style(slot);
  return theme;
}
const themesRecord = {};
for (const name of THEME_NAMES) {
  const palette = PALETTES[name];
  const classes = {};
  for (const [cls, slot] of Object.entries(classSlots)) if (cls !== 'default') classes[cls] = palette[slot];
  themesRecord[name] = { classes, default: palette[classSlots.default] };
}
const nodeThemes = Object.fromEntries(THEME_NAMES.map((n) => [n, nodeTheme(n)]));

// ── the corpus ──────────────────────────────────────────────────────────────
function corpus() {
  const out = [];
  for (const file of fs.readdirSync(corpusDir).sort()) {
    const m = /^([a-z0-9_-]+)(\.docs)?\.txt$/.exec(file);
    if (!m) continue;
    const snippets = fs.readFileSync(path.join(corpusDir, file), 'utf8').replace(/\r\n/g, '\n').replace(/\n$/, '').split(SEPARATOR);
    snippets.forEach((code, i) => out.push({ lang: m[1], source: `${file}#${i}`, code }));
  }
  return out;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PUNCT = ['{', '}', '(', ')', '[', ']', ';', ',', '.', ':', "'", '"', '`', '/', '*', '#', '<', '>', '=', '+', '-', '!', '&', '|', '\\', '$', '@', '%', '^', '~', '?', '\n', '\n', ' ', ' ', '  ', '\t', '//', '/*', '*/', '<!--', '-->', '${', '"""', "'''", '<<EOF', '=>', '::', '#!', '\r\n'];

function soups(entries, perLanguage = all ? 20 : 50) {
  const out = [];
  const byLang = new Map();
  for (const e of entries) {
    if (!byLang.has(e.lang)) byLang.set(e.lang, []);
    byLang.get(e.lang).push(e.code);
  }
  for (const lang of recordedLanguages) {
    const words = new Set();
    for (const code of byLang.get(lang) || []) for (const w of code.match(/[A-Za-z_][A-Za-z0-9_]*|\d[0-9a-fA-FxX._]*/g) || []) words.add(w);
    const pool = [...words].sort();
    const seed = createHash('sha256').update(`soup:${lang}`).digest().readUInt32LE(0);
    const rand = mulberry32(seed);
    for (let n = 0; n < perLanguage; n++) {
      const count = 3 + Math.floor(rand() * 58);
      const parts = [];
      for (let k = 0; k < count; k++) {
        const r = rand();
        if (r < 0.45 && pool.length) parts.push(pool[Math.floor(rand() * pool.length)]);
        else parts.push(PUNCT[Math.floor(rand() * PUNCT.length)]);
        if (rand() < 0.5) parts.push(' ');
      }
      out.push({ lang, source: `soup#${n}`, code: parts.join('') });
    }
  }
  return out;
}

function safe(fn) {
  try {
    return fn();
  } catch (e) {
    return { error: String(e && e.message) };
  }
}

function recordCase(entry, themeCount) {
  const html = hljs.highlight(entry.code, { language: entry.lang, ignoreIllegals: true }).value;
  const strict = hljs.highlight(entry.code, { language: entry.lang, ignoreIllegals: false });
  const ansi = {};
  const names = THEME_NAMES.slice(0, themeCount);
  for (const name of names) {
    ansi[name] = safe(() => cliHighlight.highlight(entry.code, { language: entry.lang, theme: nodeThemes[name], ignoreIllegals: true }));
  }
  return {
    lang: entry.lang,
    source: entry.source,
    code: entry.code,
    html,
    strict: { value: strict.value, illegal: strict.illegal === true, relevance: strict.relevance },
    ansi,
  };
}

function autoCases(entries) {
  const subsets = all
    ? [null, null, ['mathematica', 'matlab', 'maxima'], ['ocaml', 'fsharp', 'sml', 'reasonml'], ['erlang', 'prolog', 'lisp', 'scheme'], ['vbnet', 'vbscript', 'delphi'], ['x86asm', 'armasm', 'mipsasm', 'avrasm'], ['scss', 'less', 'stylus']]
    : [null, ['json', 'javascript'], ['xml', 'css', 'javascript'], ['python', 'ruby', 'perl'], ['cpp', 'java', 'csharp'], ['bash', 'powershell']];
  const out = [];
  entries
    .filter((e) => e.source.endsWith('#0') && !e.source.includes('docs') && !e.source.startsWith('soup'))
    .forEach((e, i) => {
      const subset = subsets[i % subsets.length];
      const useSubset = subset ? subset.filter((n) => included.includes(n)) : null;
      const r = hljs.highlightAuto(e.code, useSubset || included);
      out.push({ code: e.code, subset: useSubset || included, language: r.language ?? null, relevance: r.relevance, html: r.value });
    });
  return out;
}

function resolveCases() {
  const edge = [
    'javascript', 'JavaScript', 'js', 'jsx', 'mjs', 'cjs', 'typescript', 'ts', 'tsx', 'json', 'bash', 'sh', 'shell', 'zsh', 'python', 'py',
    'css', 'scss', 'less', 'html', 'xml', 'svg', 'md', 'markdown', 'go', 'golang', 'rust', 'rs', 'java', 'c', 'cpp', 'c++', 'cc', 'h', 'hpp',
    'ruby', 'rb', 'sql', 'yaml', 'yml', 'toml', 'ini', 'kotlin', 'kt', 'kts', 'swift', 'php', 'csharp', 'cs', 'c#', 'dockerfile', 'docker',
    'graphql', 'gql', 'protobuf', 'proto', 'scala', 'dart', 'lua', 'perl', 'pl', 'r', 'rl', 'objc', 'objectivec', 'objective-c', 'obj-c',
    'powershell', 'ps1', 'ps', 'pwsh', 'makefile', 'make', 'nginx', 'vim', 'haskell', 'hs', 'elixir', 'ex', 'exs', 'clojure', 'clj',
    'handlebars', 'hbs', 'mojolicious', 'plaintext', 'text', 'txt', 'diff', 'patch', 'no-highlight', '', 'constructor', 'toString', '__proto__', 'Ｊavascript',
  ];
  // With --all every registered name and every alias, in lower and upper case, is asked too.
  const names = all ? [...new Set([...edge, ...registry.order, ...registry.aliases.map((a) => a[0]), ...registry.order.map((n) => n.toUpperCase()), ...registry.aliases.map((a) => a[0].toUpperCase())])] : edge;
  return names.map((name) => {
    const lang = hljs.getLanguage(name);
    const registered = lang ? hljs.listLanguages().find((n) => hljs.getLanguage(n) === lang) : null;
    return [name, !!lang, registered && (all || included.includes(registered)) ? registered : null];
  });
}

function benchSource() {
  const code = fs.readFileSync(path.join(here, '..', 'corpus', 'javascript.txt'), 'utf8').split(SEPARATOR).join('\n');
  const lines = [];
  while (lines.length < 5000) for (const l of code.split('\n')) lines.push(l);
  return lines.slice(0, 5000).join('\n');
}

function record() {
  const base = corpus();
  const entries = [...base, ...soups(base)];
  const cases = entries.map((e, i) => recordCase(e, e.source.startsWith('soup') || e.source.includes('.docs.') ? 1 + (i % 3) : 3));
  const bench = benchSource();
  const run = () => hljs.highlight(bench, { language: 'javascript', ignoreIllegals: true }).value;
  run();
  run();
  const times = [];
  let value = '';
  for (let i = 0; i < 7; i++) {
    const t0 = performance.now();
    value = run();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  // With --all: the time of highlighting every case once more, warmed up (the Rust live test compares itself to it).
  let allBench = null;
  if (all) {
    const pass = () => { for (const e of entries) hljs.highlight(e.code, { language: e.lang, ignoreIllegals: true }); };
    pass();
    const passTimes = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      pass();
      passTimes.push(performance.now() - t0);
    }
    passTimes.sort((a, b) => a - b);
    allBench = { cases: entries.length, nodeMs: Math.round(passTimes[2] * 10) / 10 };
  }
  return {
    format: 1,
    versions: { highlightjs: hljs.versionString, cliHighlight: JSON.parse(fs.readFileSync(require.resolve('cli-highlight/package.json'), 'utf8')).version },
    themes: themesRecord,
    languages: included,
    resolve: resolveCases(),
    cases,
    auto: autoCases(entries),
    ...(allBench ? { allBench } : {}),
    bench: { lines: 5000, bytes: bench.length, htmlLength: value.length, htmlSha256: createHash('sha256').update(value).digest('hex'), nodeMs: Math.round(times[3] * 10) / 10 },
  };
}

const recorded = record();
if (outFile) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify(recorded)}\n`);
  console.log(`wrote ${recorded.cases.length} cases, ${recorded.auto.length} auto cases to ${outFile} (bench ${recorded.bench.nodeMs} ms${recorded.allBench ? `, all cases ${recorded.allBench.nodeMs} ms` : ''})`);
} else {
  const golden = JSON.parse(fs.readFileSync(checkFile, 'utf8'));
  const strip = (g) => ({ ...g, bench: { ...g.bench, nodeMs: 0 }, ...(g.allBench ? { allBench: { ...g.allBench, nodeMs: 0 } } : {}) });
  const a = JSON.stringify(strip(golden));
  const b = JSON.stringify(strip(recorded));
  if (a !== b) {
    let at = 0;
    while (a[at] === b[at]) at++;
    console.error(`golden differs near offset ${at}:\n  golden:   ${a.slice(Math.max(0, at - 60), at + 80)}\n  recorded: ${b.slice(Math.max(0, at - 60), at + 80)}`);
    process.exit(1);
  }
  console.log(`ok: ${recorded.cases.length} cases match`);
}

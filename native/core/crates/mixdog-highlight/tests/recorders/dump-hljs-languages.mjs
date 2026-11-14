// Serialises the uncompiled mode graph of highlight.js 10.7.3 language definitions to JSON.
//
//   node dump-hljs-languages.mjs --tree <repo with node_modules/highlight.js> --out <dir>     writes the data files
//   node dump-hljs-languages.mjs --tree <repo> --check <dir>                                   fails when <dir> differs
//   add --all to dump every language (default: the core set of format-token's FAMILY_TO_HLJS plus the
//   languages they reach through subLanguage).
//
// The graph is read from the registry of `highlight.js/lib/index.js`, so it is the object graph Node compiles
// on its first highlight. Object identity is kept (a shared mode or keyword table is one entry), because
// compileMode mutates shared objects and its result depends on that sharing. Frozen objects are flagged
// (expandOrCloneMode clones those). Functions other than the allow-listed callbacks make the dump fail.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const tree = opt('--tree');
const outDir = opt('--out');
const checkDir = opt('--check');
const all = args.includes('--all');
if (!tree || (!outDir && !checkDir)) {
  console.error('usage: dump-hljs-languages.mjs --tree <repo> (--out <dir> | --check <dir>) [--all]');
  process.exit(2);
}

const require = createRequire(path.join(path.resolve(tree), 'package.json'));
const hljs = require('highlight.js');
const indexSource = fs.readFileSync(require.resolve('highlight.js/lib/index.js'), 'utf8');

// Registration order and names, as index.js registers them.
const registered = [...indexSource.matchAll(/registerLanguage\('([^']+)', require\('\.\/languages\/([^']+)'\)\)/g)].map((m) => ({
  name: m[1],
  file: m[2],
}));
if (registered.length !== hljs.listLanguages().length) {
  throw new Error(`index.js registers ${registered.length} languages, the registry lists ${hljs.listLanguages().length}`);
}

// Languages reachable from src/tui/markdown/format-token.mjs FAMILY_TO_HLJS plus what supportsLanguage resolves.
const CORE = [
  'javascript', 'typescript', 'json', 'bash', 'python', 'css', 'xml', 'go', 'rust', 'java', 'cpp', 'ruby', 'sql',
  'yaml', 'ini', 'kotlin', 'swift', 'php', 'csharp', 'dockerfile', 'protobuf', 'scala', 'dart', 'lua', 'perl', 'r',
  'objectivec', 'powershell', 'makefile', 'nginx', 'vim', 'haskell', 'elixir', 'clojure',
  // supportsLanguage('text') / ('plaintext') is true in Node, and a fence labelled so reaches highlight().
  'plaintext',
];

// Allow-listed callbacks: sha256 of Function.prototype.toString -> id the Rust hook table knows.
const callbackIds = new Map();
function registerCallback(id, fn) {
  callbackIds.set(sha(fn.toString()), id);
}
const sha = (text) => createHash('sha256').update(text).digest('hex');
registerCallback('shebang', hljs.SHEBANG()['on:begin']);
{
  const m = hljs.END_SAME_AS_BEGIN({});
  registerCallback('endSameAsBeginBegin', m['on:begin']);
  registerCallback('endSameAsBeginEnd', m['on:end']);
}
{
  const js = hljs.getLanguage('javascript');
  const found = [];
  (function walk(o, seen) {
    if (!o || typeof o !== 'object' || seen.has(o)) return;
    seen.add(o);
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (typeof v === 'function' && k === 'on:begin') found.push(v);
      else walk(v, seen);
    }
  })(js, new Set());
  const tag = found.filter((f) => f.toString().includes('nextChar'));
  if (tag.length !== 1) throw new Error(`expected one javascript JSX on:begin callback, found ${tag.length}`);
  registerCallback('isTrulyOpeningTag', tag[0]);
}

// The only compiler extension 10.7.3 ships: r.js's `beforeMatch`.
registerCallback('beforeMatch', hljs.getLanguage('r').compilerExtensions[0]);

const ALLOWED_KEYS = new Set([
  'compilerExtensions', 'beforeMatch',
  'name', 'aliases', 'case_insensitive', 'classNameAliases', 'disableAutodetect', 'supersetOf', 'keywords',
  'contains', 'illegal', 'className', 'begin', 'end', 'match', 'beginKeywords', 'endsWithParent', 'endsParent',
  'endSameAsBegin', 'starts', 'variants', 'relevance', 'returnBegin', 'returnEnd', 'excludeBegin', 'excludeEnd',
  'skip', 'subLanguage', 'lexemes', 'on:begin', 'on:end', 'rawDefinition',
]);

const unexpected = new Set();
function dumpLanguage(lang) {
  const ids = new Map();
  const objects = [];
  const value = (v, where) => {
    if (v === undefined) return undefined;
    if (v === null || typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string') {
      if (typeof v === 'number' && !Number.isFinite(v)) throw new Error(`non-finite number at ${where}`);
      return v;
    }
    if (v instanceof RegExp) return { re: v.source, fl: v.flags };
    if (typeof v === 'function') {
      const id = callbackIds.get(sha(v.toString()));
      if (!id) throw new Error(`function not on the allow list at ${where}: ${sha(v.toString())}\n${v.toString().slice(0, 300)}`);
      return { cb: id };
    }
    if (Array.isArray(v)) return v.map((x, i) => {
      const r = value(x, `${where}[${i}]`);
      return r === undefined ? null : r;
    });
    if (typeof v === 'object') return { o: object(v, where) };
    throw new Error(`unsupported value at ${where}: ${typeof v}`);
  };
  const object = (o, where) => {
    if (ids.has(o)) return ids.get(o);
    const id = objects.length;
    ids.set(o, id);
    const entry = { frozen: Object.isFrozen(o), f: [] };
    objects.push(entry);
    for (const key of Object.keys(o)) {
      // `binary` is an option of hljs.SHEBANG that stays on its mode, `label` names a mode for a human, and `exports` is the table a language hands to
      // other language definitions: the engine reads neither.
      if (key === 'rawDefinition' || key === 'binary' || key === 'label' || (key === 'exports' && o === lang)) continue;
      const topLevel = o === lang;
      if (!topLevel && !ALLOWED_KEYS.has(key) && !isDictionary(where)) unexpected.add(`${key} at ${where}`);
      const v = value(o[key], `${where}.${key}`);
      if (v !== undefined) entry.f.push([key, v]);
    }
    return id;
  };
  const isDictionary = (where) => /\.(keywords|classNameAliases)(\.[^.]*)?$/.test(where);
  const root = object(lang, lang.name);
  return { root, objects };
}

function closureOf(names) {
  const want = new Set();
  const queue = [...names];
  while (queue.length) {
    const name = queue.shift();
    const lang = hljs.getLanguage(name);
    if (!lang) throw new Error(`unknown language ${name}`);
    const real = registered.find((r) => hljs.getLanguage(r.name) === lang).name;
    if (want.has(real)) continue;
    want.add(real);
    (function walk(o, seen) {
      if (!o || typeof o !== 'object' || seen.has(o)) return;
      seen.add(o);
      if (o.subLanguage) for (const n of [].concat(o.subLanguage)) queue.push(n);
      for (const k of Object.keys(o)) walk(o[k], seen);
    })(lang, new Set());
  }
  return registered.map((r) => r.name).filter((n) => want.has(n));
}

const wanted = all ? registered.map((r) => r.name) : closureOf(CORE);

const files = new Map();
const fileFor = (name) => `${name}.json`;
for (const name of wanted) {
  const lang = hljs.getLanguage(name);
  const dumped = dumpLanguage(lang);
  const out = { registeredAs: name, root: dumped.root, objects: dumped.objects };
  files.set(fileFor(name), `${JSON.stringify(out)}\n`);
}

if (unexpected.size) throw new Error(`unexpected keys:\n${[...unexpected].join('\n')}`);

// The registry facts every lookup needs, for all registered languages: the order, the final alias table
// (a later registration overrides an earlier one) and whether auto-detection is allowed.
const aliasTable = new Map();
for (const r of registered) {
  const lang = hljs.getLanguage(r.name);
  for (const a of lang.aliases || []) aliasTable.set(a.toLowerCase(), r.name);
}
files.set(
  '_registry.json',
  `${JSON.stringify({
    order: registered.map((r) => r.name),
    aliases: [...aliasTable.entries()],
    included: wanted,
  })}\n`,
);

// src/languages/generated_index.rs: one include_str! per dumped language plus the registry facts.
const indexLines = [
  '//! Generated by tests/recorders/dump-hljs-languages.mjs: do not edit.',
  '',
  '/// `(registered name, dumped mode graph)` of every language compiled into the crate, in registration order.',
  'pub(super) const LANGUAGES: &[(&str, &str)] = &[',
  ...wanted.map((n) => `    ("${n}", include_str!("data/${n}.json")),`),
  '];',
  '',
  '/// Registration order of every highlight.js language, the final alias table and the dumped names.',
  'pub(super) const REGISTRY: &str = include_str!("data/_registry.json");',
  '',
];
files.set('../generated_index.rs', indexLines.join('\n'));

if (outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of fs.readdirSync(outDir)) if (f.endsWith('.json') && !files.has(f)) fs.rmSync(path.join(outDir, f));
  for (const [f, text] of files) fs.writeFileSync(path.join(outDir, f), text);
  console.log(`wrote ${files.size} files (${wanted.length} languages) to ${outDir}`);
} else {
  const have = new Set([...fs.readdirSync(checkDir).filter((f) => f.endsWith('.json')), '../generated_index.rs']);
  let bad = 0;
  for (const [f, text] of files) {
    if (!have.has(f)) { console.error(`missing ${f}`); bad++; continue; }
    if (fs.readFileSync(path.join(checkDir, f), 'utf8') !== text) { console.error(`differs ${f}`); bad++; }
    have.delete(f);
  }
  for (const f of have) { console.error(`extra ${f}`); bad++; }
  if (bad) process.exit(1);
  console.log(`ok: ${files.size} files match`);
}

#!/usr/bin/env node
// Collects the candidates of the TUI audit: every member the Node terminal UI calls or reads on its session store, the
// session-state fields it reads from the store's snapshot, and the in-process modules it imports from outside the UI.
// Read-only over the Node source; writes JSON to stdout (or --out).
//
//   node collect-tui-calls.mjs --src <the Node tree's src folder> [--out file]
//
// Scanned: <src>/tui (not session/, dist/, dev/, test files), <src>/repl.mjs, <src>/repl/, <src>/app.mjs and, from those, the
// files they import that stay inside tui/ or repl/ (an import of src/runtime or src/lib is not followed but reported as an
// `externalImports` entry: it is code the Node UI ran in its own process). The result is a candidate list: tests/fixtures/
// tui-store-calls.json is the reviewed copy, one entry per member with its class.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(name);
  return at < 0 ? undefined : argv[at + 1];
};
const srcArg = flag('--src') ?? 'C:/Project/mixdog/src';
const outArg = flag('--out');
const SRC = resolve(srcArg);

const SOURCE = /\.(mjs|jsx|js)$/;
// `protocol-session` is the facade the audit replaces (its members are the store's own list, read below), not a user of it.
const SKIP_DIRS = new Set(['dist', 'dev', 'node_modules', 'session', 'protocol-session']);
const isTest = (name) => /\.(test|golden|fixture)\./.test(name) || name === 'record.mjs' || name === 'cases.mjs';

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && entry.name !== 'test-support' && !entry.name.endsWith('-golden') && !entry.name.endsWith('-oracle')) {
        walk(join(dir, entry.name), out);
      }
    } else if (SOURCE.test(entry.name) && !isTest(entry.name)) out.push(join(dir, entry.name));
  }
  return out;
}

const seeds = [];
if (existsSync(join(SRC, 'tui'))) seeds.push(...walk(join(SRC, 'tui'), []));
for (const file of ['repl.mjs', 'app.mjs']) if (existsSync(join(SRC, file))) seeds.push(join(SRC, file));
if (existsSync(join(SRC, 'repl'))) seeds.push(...walk(join(SRC, 'repl'), []));

/** Source text without comments (strings are kept: a `//` inside one is told by what precedes it). */
function strip(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, lead) => lead + ' '.repeat(m.length - lead.length));
}

const files = new Map();
const rel = (file) => relative(SRC, file).split(sep).join('/');
for (const file of seeds) files.set(file, strip(readFileSync(file, 'utf8')));

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** The text of the call's argument list starting at the `(` at `open` (balanced, strings aware enough for a call site). */
function argsAt(text, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return '';
}

function splitArgs(source) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(source.slice(start, i));
      start = i + 1;
    }
  }
  if (source.slice(start).trim()) parts.push(source.slice(start));
  return parts.map((p) => p.trim().replace(/\s+/g, ' ')).filter(Boolean);
}

const shape = (text) => (text.length > 70 ? `${text.slice(0, 67)}...` : text);

const members = new Map();
function note(name, kind, file, text, index, args) {
  let entry = members.get(name);
  if (!entry) members.set(name, (entry = { name, kinds: new Set(), sites: [], argShapes: new Set() }));
  entry.kinds.add(kind);
  entry.sites.push(`${rel(file)}:${lineOf(text, index)}`);
  if (args !== undefined) entry.argShapes.add(args.length ? args.map(shape).join(', ') : '()');
}

// `store` as the session store: the identifier itself, `props.store`, `ctx.store`, `this.store`, or a local alias bound from it.
const STORE_ID = String.raw`(?<![\w$./-])(?:store|sessionStore)\b|(?<=[\w$]\.)store\b`;
// The plain REPL's runtime handle (`runtime.ask(...)`) is another object, scanned in the REPL files only.
const REPL_ID = String.raw`(?<![\w$./-])runtime\b`;
const MEMBER_CALL = new RegExp(String.raw`(?:${STORE_ID})(\?)?\.(\w+)(\?\.|\??)(\()?`, 'g');
const REPL_MEMBER_CALL = new RegExp(String.raw`(?:${REPL_ID})(\?)?\.(\w+)(\?\.|\??)(\()?`, 'g');
const SERVICE_CALL = /\b(?:serviceCall|storeCall|call)\(\s*(['"`])(\w+)\1/g;
const SERVICE_WRAP = /\b(?:runStoreServiceCall|createStoreServiceCall)\(/;
const DESTRUCTURE = /\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:store|sessionStore)\b\s*;/g;
const DYNAMIC = /\b(?:store|sessionStore)\??\.?\[\s*([^\]]+)\]/g;
const ALIAS = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:store|sessionStore)\s*;/g;
const STATE_BIND = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:useSession\(\s*store\s*\)|(?:store|sessionStore)\??\.getState\??\.?\(\s*\))/g;

const stateFields = new Map();
function noteField(name, file, text, index) {
  let entry = stateFields.get(name);
  if (!entry) stateFields.set(name, (entry = { name, sites: [] }));
  entry.sites.push(`${rel(file)}:${lineOf(text, index)}`);
}

const externalImports = new Map();
const IMPORT = /\bimport\s+(?:([\w$]+|\{[^}]*\}|\*\s+as\s+[\w$]+)\s*(?:,\s*(\{[^}]*\}))?\s+from\s+)?(['"])([^'"]+)\3/g;
const DYNAMIC_IMPORT = /\bimport\(\s*(['"])([^'"]+)\1\s*\)/g;

const followed = new Set(seeds);
const queue = [...seeds];
while (queue.length) {
  const file = queue.pop();
  const text = files.get(file);
  const reads = [];
  for (const match of text.matchAll(IMPORT)) reads.push({ spec: match[4], names: [match[1], match[2]].filter(Boolean).join(', '), index: match.index });
  for (const match of text.matchAll(DYNAMIC_IMPORT)) reads.push({ spec: match[2], names: '(dynamic)', index: match.index });
  for (const { spec, names, index } of reads) {
    if (!spec.startsWith('.')) continue;
    const target = resolve(dirname(file), spec);
    if (!SOURCE.test(target) || !existsSync(target) || !statSync(target).isFile()) continue;
    const inside = (root) => target.startsWith(join(SRC, root) + sep) || target === join(SRC, `${root}.mjs`);
    if (inside('tui') || inside('repl')) {
      const segments = relative(SRC, target).split(sep);
      if (segments.includes('session') && segments[0] === 'tui' && segments.length > 2) continue;
      if (!followed.has(target) && !isTest(target) && !segments.some((s) => SKIP_DIRS.has(s))) {
        followed.add(target);
        files.set(target, strip(readFileSync(target, 'utf8')));
        queue.push(target);
      }
      continue;
    }
    const key = rel(target);
    let entry = externalImports.get(key);
    if (!entry) externalImports.set(key, (entry = { module: key, imports: new Set(), from: new Set() }));
    entry.imports.add(names);
    entry.from.add(`${rel(file)}:${lineOf(text, index)}`);
  }
}

for (const [file, text] of files) {
  const isRepl = rel(file) === 'repl.mjs' || rel(file).startsWith('repl/');
  for (const match of text.matchAll(isRepl ? REPL_MEMBER_CALL : MEMBER_CALL)) {
    const [, , name, , open] = match;
    const callAt = match.index + match[0].length - 1;
    note(name, open ? 'call' : 'read', file, text, match.index, open ? splitArgs(argsAt(text, callAt)) : undefined);
  }
  for (const match of text.matchAll(SERVICE_CALL)) {
    const before = text.slice(Math.max(0, match.index - 400), match.index);
    const near = SERVICE_WRAP.test(text) || /store/.test(before);
    if (!near) continue;
    const callAt = text.indexOf('(', match.index);
    note(match[2], 'serviceCall', file, text, match.index, splitArgs(argsAt(text, callAt)).slice(1));
  }
  for (const match of text.matchAll(DESTRUCTURE)) {
    for (const part of match[1].split(',')) {
      const name = part.trim().split(/[:=\s]/)[0];
      if (name) note(name, 'destructured', file, text, match.index);
    }
  }
  for (const match of text.matchAll(DYNAMIC)) note(`[${match[1].trim()}]`, 'dynamic', file, text, match.index);
  const holders = new Set(['state']);
  for (const match of text.matchAll(STATE_BIND)) holders.add(match[1]);
  for (const match of text.matchAll(ALIAS)) {
    const alias = match[1];
    const aliased = new RegExp(String.raw`(?<![\w$.])${alias}(\?)?\.(\w+)(\?\.|\??)(\()?`, 'g');
    for (const m of text.matchAll(aliased)) note(m[2], m[4] ? 'call' : 'read', file, text, m.index, m[4] ? splitArgs(argsAt(text, m.index + m[0].length - 1)) : undefined);
  }
  for (const holder of holders) {
    const field = new RegExp(String.raw`(?<![\w$.])${holder.replace('$', String.raw`\$`)}\??\.(\w+)`, 'g');
    for (const m of text.matchAll(field)) noteField(m[1], file, text, m.index);
    const destructured = new RegExp(String.raw`\{([^{}]*)\}\s*=\s*${holder.replace('$', String.raw`\$`)}\b`, 'g');
    for (const m of text.matchAll(destructured)) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/[:=\s]/)[0];
        if (name && !name.startsWith('...')) noteField(name, file, text, m.index);
      }
    }
  }
}

const byName = (a, b) => a.name.localeCompare(b.name, 'en');
const result = {
  src: srcArg,
  scanned: [...files.keys()].map(rel).sort(),
  storeMembers: [...members.values()]
    .map((m) => ({ name: m.name, kinds: [...m.kinds].sort(), sites: [...new Set(m.sites)].sort(), argShapes: [...m.argShapes].sort() }))
    .sort(byName),
  stateFields: [...stateFields.values()].map((f) => ({ name: f.name, sites: [...new Set(f.sites)].sort() })).sort(byName),
  externalImports: [...externalImports.values()]
    .map((e) => ({ module: e.module, imports: [...e.imports].sort(), from: [...e.from].sort() }))
    .sort((a, b) => a.module.localeCompare(b.module, 'en')),
};
const text = `${JSON.stringify(result, null, 2)}\n`;
if (outArg) writeFileSync(resolve(outArg), text);
else process.stdout.write(text);

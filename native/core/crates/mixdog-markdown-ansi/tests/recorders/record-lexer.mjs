#!/usr/bin/env node
// Records (or checks) the lexer golden of the mixdog-markdown-ansi crate from the Node product's own lexer.
//
//   node record-lexer.mjs --tree <mixdog checkout> --write <goldens/lexer.json> [--refresh-corpus]
//   node record-lexer.mjs --tree <mixdog checkout> --check <goldens/lexer.json>
//
// The lexer is `marked.lexer(text)` of the tree's node_modules/marked (14.1.4) after `configureMarked()` of the
// tree's src/tui/markdown/render-ansi.mjs (the pair-only `~~strike~~` tokenizer): exactly what the TUI's
// lexMarkdown calls. src/ui/markdown.mjs (the REPL renderer) does not use marked, so there is no second setup.
//
// Inputs are the files of ../corpus: strings.json (every string literal of the markdown tests), docs.json (every
// *.md under docs/ and the repository root), edge.json (hand written) and prefix.json (the documents of docs.json
// whose prefixes, one per UTF-16 unit, are lexed to cover streaming input). `--refresh-corpus` rebuilds strings.json
// and docs.json from the tree; edge.json and prefix.json are written by hand.
//
// A token is recorded as `JSON.stringify` writes it (undefined and null object members dropped, `align` arrays keep
// their nulls) plus the link table the lexer collected; its digest is the first 16 hex digits of the SHA-256 of the
// canonical JSON (sorted keys). Small inputs (strings, edge) keep the whole token list so a difference reads; the
// documents keep the digest only. A prefix keeps 8 hex digits. A cut inside a surrogate pair is skipped: a Rust
// string cannot hold half of one, and text that reaches the renderer is decoded from UTF-8 first.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const corpusDir = path.join(here, '..', 'corpus');

function parseArgs(argv) {
  const out = { tree: '', check: '', write: '', refresh: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--tree') out.tree = argv[++i] ?? '';
    else if (a === '--check') out.check = argv[++i] ?? '';
    else if (a === '--write') out.write = argv[++i] ?? '';
    else if (a === '--refresh-corpus') out.refresh = true;
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

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(text, hex) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, hex);
}

function dropNulls(_key, value) {
  if (value === null && !Array.isArray(this)) return undefined;
  return value;
}

function lexed(marked, text) {
  const tokens = marked.lexer(text);
  const links = {};
  for (const [tag, link] of Object.entries(tokens.links ?? {})) links[tag] = link;
  const plain = JSON.parse(JSON.stringify({ tokens, links }, dropNulls));
  return plain;
}

function ruleTable(marked) {
  const rules = marked.Lexer.rules;
  const out = { block: {}, inline: {} };
  for (const [side, table] of [['block', rules.block.gfm], ['inline', rules.inline.gfm]]) {
    for (const [name, re] of Object.entries(table)) {
      if (!(re instanceof RegExp)) continue;
      out[side][name] = { source: re.source.replace(/\t/g, '\\t'), flags: re.flags };
    }
  }
  return out;
}

function isHigh(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

function record(marked, hasMarkdownSyntax) {
  const strings = readJson(path.join(corpusDir, 'strings.json'));
  const edge = readJson(path.join(corpusDir, 'edge.json'));
  const docs = readJson(path.join(corpusDir, 'docs.json'));
  const prefix = readJson(path.join(corpusDir, 'prefix.json'));
  const whole = (entry) => {
    const result = lexed(marked, entry.text);
    return { id: entry.id, syntax: hasMarkdownSyntax(entry.text), digest: digest(canonical(result), 16), result };
  };
  const out = {
    marked: '14.1.4',
    rules: ruleTable(marked),
    strings: strings.map(whole),
    edge: edge.map(whole),
    docs: docs.map((entry) => {
      const { id, syntax, digest: d } = whole(entry);
      return { id, syntax, digest: d };
    }),
    prefixes: [],
  };
  const byId = new Map(docs.map((entry) => [entry.id, entry.text]));
  for (const { id, limit } of prefix.docs) {
    const text = byId.get(id);
    if (text === undefined) throw new Error(`prefix document ${id} is not in docs.json`);
    const end = Math.min(limit, text.length);
    let digests = '';
    for (let n = 1; n <= end; n += 1) {
      if (isHigh(text.charCodeAt(n - 1)) && n < text.length) {
        digests += '--------';
        continue;
      }
      digests += digest(canonical(lexed(marked, text.slice(0, n))), 8);
    }
    out.prefixes.push({ id, limit: end, digests });
  }
  return out;
}

function stringLiterals(acorn, source) {
  const found = [];
  const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const walk = (node) => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'Literal' && typeof node.value === 'string') found.push(node.value);
    if (node.type === 'TemplateElement' && typeof node.value.cooked === 'string') found.push(node.value.cooked);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') walk(value);
    }
  };
  walk(ast);
  return found;
}

function walkMarkdown(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkMarkdown(full, out);
    else if (entry.name.endsWith('.md')) out.push(full);
  }
}

async function refreshCorpus(tree, acorn) {
  const seen = new Set();
  const strings = [];
  for (const rel of ['src/tui/markdown/markdown-behavior.test.mjs', 'scripts/markdown-surface-test.mjs', 'src/ui/markdown.test.mjs']) {
    const source = fs.readFileSync(path.join(tree, rel), 'utf8');
    for (const text of stringLiterals(acorn, source)) {
      if (!text || seen.has(text)) continue;
      seen.add(text);
      strings.push({ id: `${path.basename(rel)}#${strings.length}`, text });
    }
  }
  const files = [];
  for (const name of fs.readdirSync(tree).sort()) if (name.endsWith('.md')) files.push(path.join(tree, name));
  walkMarkdown(path.join(tree, 'docs'), files);
  const docs = files.map((file) => ({
    id: path.relative(tree, file).split(path.sep).join('/'),
    text: fs.readFileSync(file, 'utf8').replace(/^﻿/, ''),
  }));
  fs.writeFileSync(path.join(corpusDir, 'strings.json'), `${JSON.stringify(strings, null, 1)}\n`);
  fs.writeFileSync(path.join(corpusDir, 'docs.json'), `${JSON.stringify(docs)}\n`);
  console.log(`corpus: ${strings.length} strings, ${docs.length} documents`);
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tree = path.resolve(args.tree);
  const toUrl = (rel) => pathToFileURL(path.join(tree, rel)).href;
  const render = await import(toUrl('src/tui/markdown/render-ansi.mjs'));
  render.configureMarked();
  const { marked } = await import(toUrl('node_modules/marked/lib/marked.esm.js'));
  if (args.refresh) {
    if (!args.write) throw new Error('--refresh-corpus goes with --write');
    const acorn = await import(toUrl('node_modules/acorn/dist/acorn.mjs'));
    await refreshCorpus(tree, acorn);
  }
  const recorded = record(marked, render.hasMarkdownSyntax);
  if (args.write) {
    fs.writeFileSync(args.write, `${JSON.stringify(recorded)}\n`);
    console.log(`wrote ${args.write}`);
    return;
  }
  const golden = readJson(args.check);
  const diff = firstDifference(golden, JSON.parse(JSON.stringify(recorded)), 'golden');
  if (diff) {
    console.error(`lexer golden differs from the tree's lexer at ${diff}`);
    process.exit(1);
  }
  console.log('lexer golden matches');
}

main().catch((error) => {
  console.error(error?.stack ?? String(error));
  process.exit(1);
});

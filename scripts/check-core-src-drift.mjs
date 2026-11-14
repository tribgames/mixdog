#!/usr/bin/env node
// Reports two things about apps/desktop/src/shared/core-src, the desktop's copy of
// shared runtime modules:
//   unreferenced - copies that no desktop source imports, directly or through
//                  another kept copy (they are to be deleted);
//   drift        - copies whose bytes differ from the file at the same path
//                  under src/ (a copy without a counterpart is reported as
//                  "no counterpart", not as drift).
// Exit code 1 when either list is not empty, 0 when both are empty.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_EXT = /\.(?:[cm]?[jt]sx?)$/;
const SKIP_DIRS = new Set(['node_modules', 'out', 'dist', 'release', '.git']);
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*|\bimport\s+)(['"`])([^'"`\n]+)\1/g;

function normalizeLineEndings(text) {
  return text.replace(/\r\n/g, '\n');
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
    } else if (entry.isFile()) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

function relativeSpecifiers(text) {
  const found = [];
  for (const match of text.matchAll(SPECIFIER)) {
    const specifier = match[2];
    if (specifier.startsWith('.')) found.push(specifier);
  }
  return found;
}

// The file a relative specifier names, among the candidates that exist.
function resolveSpecifier(fromFile, specifier, known) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [base];
  if (/\.[cm]?js$/.test(base)) candidates.push(base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'));
  for (const suffix of ['.mjs', '.js', '.ts', '.tsx', '.d.mts', '/index.mjs', '/index.js', '/index.ts']) candidates.push(base + suffix);
  return candidates.find((candidate) => known.has(candidate)) ?? null;
}

// `desktopRoot` is apps/desktop; `runtimeRoot` is the repository's src.
export function analyzeCoreSrc({ desktopRoot, runtimeRoot }) {
  const coreSrc = path.join(desktopRoot, 'src', 'shared', 'core-src');
  const inCoreSrc = (file) => file.startsWith(coreSrc + path.sep);
  const coreFiles = fs.existsSync(coreSrc) ? walk(coreSrc) : [];
  const known = new Set(coreFiles);
  const outside = walk(desktopRoot).filter((file) => !inCoreSrc(file));

  const reached = new Set();
  const queue = [];
  const visit = (file, text) => {
    for (const specifier of relativeSpecifiers(text)) {
      const target = resolveSpecifier(file, specifier, known);
      if (target && !reached.has(target)) {
        reached.add(target);
        queue.push(target);
      }
    }
  };
  for (const file of outside) {
    if (SOURCE_EXT.test(file)) visit(file, fs.readFileSync(file, 'utf8'));
  }
  while (queue.length) {
    const file = queue.pop();
    if (SOURCE_EXT.test(file)) visit(file, fs.readFileSync(file, 'utf8'));
  }
  // A declaration file lives and dies with the module it declares.
  for (const file of coreFiles) {
    if (file.endsWith('.d.mts') && reached.has(file.slice(0, -'.d.mts'.length) + '.mjs')) reached.add(file);
  }

  const unreferenced = coreFiles.filter((file) => !reached.has(file) && !file.endsWith('.d.mts'));
  const unreferencedDeclarations = coreFiles.filter(
    (file) => file.endsWith('.d.mts') && !reached.has(file)
  );
  const drift = [];
  const noCounterpart = [];
  for (const file of coreFiles) {
    if (!reached.has(file)) continue;
    const counterpart = path.join(runtimeRoot, path.relative(coreSrc, file));
    if (!fs.existsSync(counterpart)) {
      noCounterpart.push(file);
    } else if (
      normalizeLineEndings(fs.readFileSync(file, 'utf8')) !== normalizeLineEndings(fs.readFileSync(counterpart, 'utf8'))
    ) {
      drift.push(file);
    }
  }
  const rel = (list) => list.map((file) => path.relative(desktopRoot, file).split(path.sep).join('/')).sort();
  return {
    unreferenced: rel([...unreferenced, ...unreferencedDeclarations]),
    drift: rel(drift),
    noCounterpart: rel(noCounterpart),
  };
}

function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const result = analyzeCoreSrc({
    desktopRoot: path.join(repoRoot, 'apps', 'desktop'),
    runtimeRoot: path.join(repoRoot, 'src'),
  });
  const section = (title, list) => {
    console.log(`${title} (${list.length})`);
    for (const file of list) console.log(`  ${file}`);
  };
  section('unreferenced (delete)', result.unreferenced);
  section('drift from src/', result.drift);
  section('no counterpart in src/', result.noCounterpart);
  process.exitCode = result.unreferenced.length || result.drift.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

// The production import closure of the desktop: every file the main, preload and renderer entries reach through relative imports,
// checked against what K1 deletes. Rerun at the cut:
//
//   node import-closure.mjs --manifest <k1-deletion-manifest.txt> [--deleted-by <base>..<ref>] ...
//
// --deleted-by (repeatable) adds the files a slice deleted or renamed away (`git diff -M` between the two revisions). src/tui/** and
// src/standalone/protocol-session/** survive K1 and are never counted as deleted. Prints the reached count and every deleted hit;
// exits 1 on a hit.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..');
const argv = process.argv.slice(2);
const values = (flag) => argv.flatMap((a, i) => (a === flag ? [argv[i + 1]] : []));
const [manifestPath] = values('--manifest');
if (!manifestPath) throw new Error('usage: node import-closure.mjs --manifest <file> [--deleted-by <base>..<ref>]');

const deleted = new Set();
let section = '';
for (const line of readFileSync(manifestPath, 'utf8').split(/\r?\n/)) {
  if (line.startsWith('## ')) section = line;
  else if (line && !line.startsWith('#') && /^## (DELETE|BLOCKED)/.test(section)) deleted.add(line.trim());
}
for (const range of values('--deleted-by')) {
  const diff = spawnSync('git', ['-C', root, 'diff', '-M', '--name-status', range.replace('..', ' ').split(' ')[0], range.split('..')[1]], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (diff.status !== 0) throw new Error(`git diff ${range}: ${diff.stderr}`);
  for (const row of diff.stdout.split('\n')) {
    const [status, from] = row.split('\t');
    if (status === 'D' || status?.startsWith('R')) deleted.add(from);
  }
}
const survives = (rel) => rel.startsWith('src/tui/') || rel.startsWith('src/standalone/protocol-session/');

const desktop = resolve(root, 'apps/desktop');
const entries = [
  'src/main/index.ts',
  ...['index', 'computer-overlay', 'remote-window', 'browser-login', 'browser-page', 'desktop-pet', 'remote-webrtc-sender', 'remote-transport-peer'].map((n) => `src/preload/${n}.ts`),
  ...['index', 'desktop-pet', 'remote-webrtc-sender', 'remote-transport-peer'].map((n) => `src/renderer/${n}.html`),
].map((e) => resolve(desktop, e));

const suffixes = ['', '.ts', '.tsx', '.mts', '.mjs', '.js', '.jsx', '.cjs', '/index.ts', '/index.tsx', '/index.mjs', '/index.js'];
const isFile = (p) => existsSync(p) && statSync(p).isFile();
function resolveSpec(from, spec) {
  const base = resolve(dirname(from), spec);
  const bases = [base];
  if (/\.(m?js|jsx)$/.test(base)) bases.push(base.replace(/\.mjs$/, '.mts'), base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'), base.replace(/\.jsx$/, '.tsx'));
  for (const b of bases) for (const s of suffixes) if (isFile(b + s)) return b + s;
  return null;
}
const importRe = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\(\s*|new URL\(\s*)['"](\.{1,2}\/[^'"]+|\/[^'"/][^'"]*)['"]|\b(?:src|href)=["'](\.{1,2}\/[^"']+|\/[^"'/][^"']*)["']/g;

const seen = new Set();
const stack = [...entries];
while (stack.length) {
  const file = stack.pop();
  if (seen.has(file)) continue;
  seen.add(file);
  if (!/\.(m?[jt]sx?|cts|html)$/.test(file)) continue;
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(importRe)) {
    let spec = (m[1] ?? m[2]).split('?')[0];
    if (spec.startsWith('/')) {
      if (!file.endsWith('.html')) continue; // Vite serves an absolute path in the page from the renderer root
      spec = `.${spec}`;
    }
    const target = resolveSpec(file, spec);
    if (target) stack.push(target);
  }
}
const reached = [...seen].map((f) => relative(root, f).replace(/\\/g, '/'));
const hits = reached.filter((r) => deleted.has(r) && !survives(r)).sort();
console.log(`reached ${reached.length} files; deleted hits ${hits.length}`);
for (const hit of hits) console.log(`  HIT ${hit}`);
process.exit(hits.length ? 1 : 0);

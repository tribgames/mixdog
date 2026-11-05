#!/usr/bin/env node
// Re-hashes every fixture set against its MANIFEST.json and (re)writes the
// top-level native/core/fixtures/MANIFEST.json index. Exit 1 on any mismatch,
// missing or unlisted file. `--write-index` refreshes the index only.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { FIXTURES_ROOT, parseArgs, resolveTree, sha256, walkFiles, writeJson, writeSetManifest } from './lib/common.mjs';

const args = parseArgs();
// A set is every top-level directory under the fixtures root, except `migration`, whose children are the sets
// (the migration corpus itself is referenced, not copied). Discovered, not listed: a new unlisted set fails below.
const topDirs = readdirSync(FIXTURES_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
const SETS = topDirs.flatMap((name) => name === 'migration'
  ? readdirSync(join(FIXTURES_ROOT, name), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => `migration/${d.name}`)
  : [name]).sort();
// `--adopt <set>=<recorder.mjs>,...` writes the manifest of sets whose recorder predates manifests (needs --tree).
if (args.has('adopt')) {
  resolveTree(args);
  for (const pair of args.get('adopt').split(',')) {
    const [set, recorder] = pair.split('=');
    const rel = `benchmarks/rust-core/recorders/${recorder}`;
    writeSetManifest(join(FIXTURES_ROOT, set), { set, recorder: rel, command: `node ${rel} --tree <tree>` });
  }
}
let bad = 0;
const index = [];
for (const set of SETS) {
  const dir = join(FIXTURES_ROOT, set);
  const manifestPath = join(dir, 'MANIFEST.json');
  if (!existsSync(manifestPath)) {
    console.error(`MISSING manifest ${set}`);
    bad += 1;
    continue;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const listed = new Set();
  for (const f of manifest.files) {
    listed.add(f.path);
    const p = join(dir, f.path);
    if (!existsSync(p)) {
      console.error(`MISSING ${set}/${f.path}`);
      bad += 1;
    } else if (sha256(readFileSync(p)) !== f.sha256) {
      console.error(`MISMATCH ${set}/${f.path}`);
      bad += 1;
    }
  }
  for (const f of walkFiles(dir)) {
    const rel = relative(dir, f).split(sep).join('/');
    if (rel !== 'MANIFEST.json' && !listed.has(rel)) {
      console.error(`UNLISTED ${set}/${rel}`);
      bad += 1;
    }
  }
  index.push({ set, manifest: `${set}/MANIFEST.json`, manifestSha256: sha256(readFileSync(manifestPath)), recorder: manifest.recorder, command: manifest.command, fileCount: manifest.fileCount, totalBytes: manifest.totalBytes, productSrcTree: manifest.product.srcTree });
}
if (!bad) writeJson(join(FIXTURES_ROOT, 'MANIFEST.json'), { note: 'Index of P0-BENCH fixture sets. Verify with benchmarks/rust-core/recorders/verify-manifests.mjs.', sets: index });
console.log(bad ? `FAILED: ${bad} problem(s)` : `OK: ${index.length} sets, ${index.reduce((s, x) => s + x.fileCount, 0)} files`);
process.exit(bad ? 1 : 0);

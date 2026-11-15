#!/usr/bin/env node
// Re-hashes every fixture set against its MANIFEST.json and (re)writes the
// top-level native/core/fixtures/MANIFEST.json index. Exit 1 on any mismatch,
// missing or unlisted file; the index is written only when nothing is wrong.
// `--write-index` first gives every set that has no MANIFEST.json one (its files hashed as they are on disk, product
// null: those sets were never written by a recorder that writes manifests), then verifies and writes the index.
// A set that mismatches is never re-hashed by it: re-record the set, or `--refresh <set> --tree <dir>` when several
// recorders (or a hand-extracted file) write into it.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { FIXTURES_ROOT, REPO_ROOT, parseArgs, resolveTree, sha256, walkFiles, writeCanonicalJson, writeSetManifest } from './lib/common.mjs';

// The manifest of a set: MANIFEST.json, or the manifest.json its recorder wrote (office-startup), which a case-folding
// checkout also finds as MANIFEST.json. A listed path is relative to the set directory and may leave it (the recorder).
const manifestFile = (dir) => ['MANIFEST.json', 'manifest.json'].map((n) => join(dir, n)).find((p) => readdirSync(dir).includes(basename(p)));
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
// `--refresh <set>,...` re-hashes sets that several recorders write into (each adds its own files), keeping the
// manifest's recorder, command and extra fields (needs --tree).
if (args.has('refresh')) {
  resolveTree(args);
  for (const set of args.get('refresh').split(',')) {
    const { recorder, command, product, fileCount, totalBytes, files, set: _s, ...extra } = JSON.parse(readFileSync(join(FIXTURES_ROOT, set, 'MANIFEST.json'), 'utf8'));
    writeSetManifest(join(FIXTURES_ROOT, set), { set, recorder, command, extra });
  }
}
// `--write-index`: a set with no manifest gets one that lists its files by the bytes on disk. Its recorders, when the
// set directory holds them (record*.mjs), are named; there is no Node product tree to identify, so `product` is null.
if (args.has('write-index')) {
  for (const set of SETS) {
    const dir = join(FIXTURES_ROOT, set);
    if (manifestFile(dir)) continue;
    const files = walkFiles(dir).map((f) => {
      const data = readFileSync(f);
      return { path: relative(dir, f).split(sep).join('/'), bytes: data.length, sha256: sha256(data) };
    });
    const recorders = readdirSync(dir).filter((n) => /^record.*\.mjs$/.test(n)).sort().map((n) => relative(REPO_ROOT, join(dir, n)).split(sep).join('/'));
    writeCanonicalJson(join(dir, 'MANIFEST.json'), {
      set,
      recorder: recorders.length ? recorders.join(', ') : null,
      command: null,
      product: null,
      note: 'Indexed from the files as they stand: no recorder of this set wrote a manifest (or the set is hand-extracted evidence); not secret-scanned, since some of it (browser-parity/redaction.json) is secret-shaped text on purpose.',
      fileCount: files.length,
      totalBytes: files.reduce((s, f) => s + f.bytes, 0),
      files,
    });
  }
}
// The files a manifest lists: `files: [{path, sha256}]`, or, for a set that records only the sha256 of its single
// `golden.json` (office-stats), `goldenSha256`.
const listedFiles = (manifest) => manifest.files ?? (manifest.goldenSha256 ? [{ path: 'golden.json', sha256: manifest.goldenSha256 }] : []);
let bad = 0;
const index = [];
for (const set of SETS) {
  const dir = join(FIXTURES_ROOT, set);
  const manifestPath = manifestFile(dir);
  if (!manifestPath) {
    console.error(`MISSING manifest ${set}`);
    bad += 1;
    continue;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const files = listedFiles(manifest);
  const listed = new Set();
  let totalBytes = 0;
  for (const f of files) {
    listed.add(f.path);
    const p = join(dir, f.path);
    if (!existsSync(p)) {
      console.error(`MISSING ${set}/${f.path}`);
      bad += 1;
    } else {
      const data = readFileSync(p);
      totalBytes += data.length;
      if (sha256(data) !== f.sha256) {
        console.error(`MISMATCH ${set}/${f.path}`);
        bad += 1;
      }
    }
  }
  for (const f of walkFiles(dir)) {
    const rel = relative(dir, f).split(sep).join('/');
    if (rel !== basename(manifestPath) && !listed.has(rel)) {
      console.error(`UNLISTED ${set}/${rel}`);
      bad += 1;
    }
  }
  index.push({
    set,
    manifest: `${set}/${basename(manifestPath)}`,
    manifestSha256: sha256(readFileSync(manifestPath)),
    recorder: manifest.recorder ?? null,
    command: manifest.command ?? null,
    fileCount: manifest.fileCount ?? files.length,
    totalBytes: manifest.totalBytes ?? totalBytes,
    productSrcTree: manifest.product?.srcTree ?? null,
  });
}
if (!bad) writeCanonicalJson(join(FIXTURES_ROOT, 'MANIFEST.json'), { note: 'Index of P0-BENCH fixture sets. Verify with benchmarks/rust-core/recorders/verify-manifests.mjs.', sets: index });
console.log(bad ? `FAILED: ${bad} problem(s)` : `OK: ${index.length} sets, ${index.reduce((s, x) => s + x.fileCount, 0)} files`);
process.exit(bad ? 1 : 0);

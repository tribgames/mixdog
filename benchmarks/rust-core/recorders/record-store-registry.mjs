#!/usr/bin/env node
// Golden twin of the user-registered project registry (`src/runtime/shared/projects.mjs`):
// each case lays out `projects.json` (and optionally its `.bak`), runs a list of reads and
// mutations through the real module, and records every result, the file left behind and the
// project-id markers written. Paths are `<ABS>` placeholders for a temp directory; timestamps
// the module stamps are `<now>`.
//
//   node benchmarks/rust-core/recorders/record-store-registry.mjs --tree <dir>
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const base = mkdtempSync(join(tmpdir(), 'registry-'));
const file = join(base, 'projects.json');
process.env.MIXDOG_PROJECTS_FILE = file;
delete process.env.MIXDOG_DISABLE_PROJECT_MARKERS;
process.chdir(base);
const projects = await importFrom(tree, 'src/runtime/shared/projects.mjs');

const escaped = JSON.stringify(base).slice(1, -1);
const mask = (value) => {
  if (typeof value === 'string') {
    const text = value.split(base).join('<ABS>');
    return text.includes('<ABS>') ? text.replaceAll('\\', '/') : text;
  }
  if (Array.isArray(value)) return value.map(mask);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mask(v)]));
  }
  return value;
};

const entry = (name, path, extra = {}) => ({ name, path: `<ABS>/${path}`, addedAt: 100, ...extra });
const doc = (...list) => JSON.stringify({ projects: list });

const cases = [
  { name: 'sorted-by-recency-then-name-then-path', file: doc(
      entry('b', 'b', { addedAt: 10 }), entry('a', 'a', { addedAt: 10 }), entry('c', 'c', { addedAt: 5, lastSelectedAt: 50 }),
      entry('a', 'z', { addedAt: 10 }), entry('Z', 'zz', { addedAt: 10 }), entry('é', 'e', { addedAt: 10 })),
    ops: [{ op: 'list' }, { op: 'listStrict' }] },
  { name: 'tolerant-list-keeps-relative-and-fills-defaults', file: JSON.stringify({ projects: [
      { path: 'rel/dir' }, { path: '<ABS>/x', name: '', addedAt: 'bad', lastSelectedAt: -4 },
      { name: 'nopath' }, { path: '   ' }, null, 7, { path: '<ABS>/y', name: 'y', addedAt: 3, lastSelectedAt: 9, extra: 1 }] }),
    ops: [{ op: 'list' }, { op: 'listStrict' }] },
  { name: 'name-is-coerced_with_string_semantics', file: JSON.stringify({ projects: [
      { path: '<ABS>/n1', name: 5 }, { path: '<ABS>/n2', name: true }, { path: '<ABS>/n3', name: [1, [2, 3]] },
      { path: '<ABS>/n4', name: {} }, { path: '<ABS>/n5', name: 0 }, { path: '<ABS>/n6', name: false },
      { path: '<ABS>/n7', name: null }, { path: '<ABS>/n8', name: '' }, { path: '<ABS>/n9', name: 1.5 },
      { path: '<ABS>/n10', name: [] }, { path: '<ABS>/n11', name: [null, { a: 1 }, 'x'] }] }),
    ops: [{ op: 'list' }, { op: 'add', path: '<ABS>/added' }, { op: 'list' }] },
  // `String(name)` throws: a tolerant list reads as empty, a strict list and every mutation throw.
  { name: 'name-that-cannot-be-stringified', file: JSON.stringify({ projects: [
      { path: '<ABS>/ok', name: 'ok' }, { path: '<ABS>/bad', name: { toString: 1 } }] }),
    ops: [{ op: 'list' }, { op: 'listStrict' }, { op: 'add', path: '<ABS>/added' }, { op: 'remove', path: '<ABS>/ok' }, { op: 'list' }] },
  { name: 'name-with-nested-unstringifiable-element', file: JSON.stringify({ projects: [
      { path: '<ABS>/bad', name: [1, { toString: null }] }] }),
    ops: [{ op: 'list' }, { op: 'rename', path: '<ABS>/bad', name: 'x' }] },
  { name: 'projects-not-an-array', file: JSON.stringify({ projects: { a: 1 } }), ops: [{ op: 'list' }, { op: 'listStrict' }] },
  { name: 'missing-file', file: null, ops: [{ op: 'list' }, { op: 'listStrict' }] },
  { name: 'bom-prefixed-file', file: `\ufeff${doc(entry('a', 'a'))}`, ops: [{ op: 'list' }] },
  { name: 'damaged-without-backup', file: '{ "projects": [', ops: [{ op: 'list' }, { op: 'list' }] },
  { name: 'nul-filled-file', file: '\0\0\0\0', ops: [{ op: 'list' }] },
  { name: 'damaged-with-backup-restores-it', file: '{ nope', bak: doc(entry('good', 'good', { addedAt: 7 })), ops: [{ op: 'list' }, { op: 'list' }] },
  { name: 'add-dedupes-by-normalized-path', file: doc(entry('a', 'a')), dirs: ['a', 'n'],
    ops: [{ op: 'add', path: '<ABS>/a' }, { op: 'add', path: '<ABS>/a/' }, { op: 'add', path: '<ABS>/n' }, { op: 'add', path: '' }, { op: 'list' }] },
  { name: 'add-resolves-relative-against-cwd', file: null, dirs: ['rel/proj'], ops: [{ op: 'add', path: 'rel/proj' }, { op: 'add', path: 'rel/../rel/proj/.' }, { op: 'list' }] },
  { name: 'add-existing-marker-is-preserved', file: null, dirs: ['m/.mixdog'], preset: { 'm/.mixdog/project.id': 'custom\n' }, ops: [{ op: 'add', path: '<ABS>/m' }] },
  { name: 'add-blank-marker-is-rewritten', file: null, dirs: ['m/.mixdog'], preset: { 'm/.mixdog/project.id': '\0\0' }, ops: [{ op: 'add', path: '<ABS>/m' }] },
  { name: 'add-missing-directory-writes-no-marker', file: null, ops: [{ op: 'add', path: '<ABS>/ghost' }] },
  { name: 'add-common-name-writes-no-marker', file: null, dirs: ['common'], ops: [{ op: 'add', path: '<ABS>/common' }] },
  { name: 'touch-selected', file: doc(entry('a', 'a'), entry('b', 'b')), dirs: ['a'], ops: [{ op: 'touch', path: '<ABS>/b' }, { op: 'touch', path: '<ABS>/none' }, { op: 'list' }] },
  { name: 'remove', file: doc(entry('a', 'a'), entry('b', 'b')), ops: [{ op: 'remove', path: '<ABS>/a' }, { op: 'remove', path: '<ABS>/a' }, { op: 'remove', path: '' }, { op: 'list' }] },
  { name: 'rename', file: doc(entry('a', 'a'), entry('b', 'b')), ops: [{ op: 'rename', path: '<ABS>/a', name: '  Alpha ' }, { op: 'rename', path: '<ABS>/b', name: '   ' }, { op: 'rename', path: '<ABS>/none', name: 'x' }, { op: 'list' }] },
  { name: 'mutation-drops-entries-without-absolute-path', file: JSON.stringify({ projects: [{ path: 'rel' }, entry('a', 'a')] }), ops: [{ op: 'add', path: '<ABS>/b' }, { op: 'list' }] },
  { name: 'mutation-on-damaged-file-keeps-it-aside-and-restores-backup', file: '{ x', bak: doc(entry('old', 'old')), ops: [{ op: 'add', path: '<ABS>/new' }, { op: 'list' }] },
  { name: 'mutation-keeps-previous-version-as-backup', file: doc(entry('a', 'a')), ops: [{ op: 'add', path: '<ABS>/b' }] },
];

const tokens = (text) => text.replaceAll('<ABS>', escaped);
const rawPath = (path) => path.replaceAll('<ABS>', base);

function reset() {
  for (const name of readdirSync(base)) rmSync(join(base, name), { recursive: true, force: true });
}

const recorded = [];
for (const c of cases) {
  reset();
  for (const dir of c.dirs ?? []) mkdirSync(join(base, dir), { recursive: true });
  for (const [rel, text] of Object.entries(c.preset ?? {})) writeFileSync(join(base, rel), text);
  if (c.file !== null) writeFileSync(file, tokens(c.file));
  if (c.bak) writeFileSync(`${file}.bak`, tokens(c.bak));
  const start = Date.now();
  const stamp = (e) => e && typeof e === 'object' && !Array.isArray(e)
    ? Object.fromEntries(Object.entries(e).map(([k, v]) => [k, (k === 'addedAt' || k === 'lastSelectedAt') && v >= start ? '<now>' : v]))
    : e;
  const results = [];
  for (const op of c.ops) {
    const path = rawPath(op.path ?? '');
    let value;
    try {
      if (op.op === 'list') value = projects.listProjects().map(stamp);
      else if (op.op === 'listStrict') value = projects.listProjectsStrict().map(stamp);
      else if (op.op === 'add') value = stamp(projects.addProject(path));
      else if (op.op === 'touch') value = stamp(projects.touchProjectSelected(path));
      else if (op.op === 'remove') value = projects.removeProject(path);
      else value = stamp(projects.renameProject(path, op.name));
      results.push({ ok: mask(value) });
    } catch (error) {
      results.push({ thrown: true });
    }
  }
  const after = existsSync(file) ? readFileSync(file, 'utf8') : null;
  let parsed = null;
  try { parsed = after === null ? null : JSON.parse(after.replace(/^\ufeff/, '')); } catch { parsed = { unparsable: after.replaceAll('\0', '\\0') }; }
  const stampDoc = (d) => Array.isArray(d?.projects) ? { ...d, projects: d.projects.map(stamp) } : d;
  const names = readdirSync(base).filter((n) => n.startsWith('projects.json'));
  const markers = {};
  for (const dir of [...(c.dirs ?? []), 'ghost', 'rel/proj']) {
    const marker = join(base, dir, '.mixdog', 'project.id');
    if (existsSync(marker)) markers[dir.replace(/\.mixdog$/, '').replace(/\/$/, '')] = readFileSync(marker, 'utf8').replaceAll('\0', '\\0');
  }
  recorded.push({
    name: c.name,
    file: c.file === null ? null : c.file,
    bak: c.bak ?? null,
    dirs: c.dirs ?? [],
    preset: c.preset ?? {},
    ops: c.ops,
    results,
    after: mask(stampDoc(parsed)),
    backup: existsSync(`${file}.bak`) ? mask(stampDoc(JSON.parse(readFileSync(`${file}.bak`, 'utf8')))) : null,
    aside: names.filter((n) => n.includes('.corrupt-')).length,
    markers,
  });
}

const finalDir = join(FIXTURES_ROOT, 'store');
const out = stageSet(finalDir, ['registry']);
writeJson(join(out, 'registry', 'projects-registry.json'), {
  domain: 'projects-registry',
  recorder: 'benchmarks/rust-core/recorders/record-store-registry.mjs',
  cases: recorded,
});
writeSetManifest(out, {
  set: 'store',
  recorder: 'benchmarks/rust-core/recorders/record-store-registry.mjs',
  command: 'node benchmarks/rust-core/recorders/record-store-registry.mjs --tree <tree>',
  identityTree: tree,
});
commitStage(out, finalDir);
process.chdir(tmpdir());
rmSync(base, { recursive: true, force: true });
console.log(`recorded ${recorded.length} registry cases`);

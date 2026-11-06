// Records the PG-runtime installer golden from today's Node product (runtime-fetcher.mjs).
// Usage: node record-runtime-install.mjs --tree <mixdog checkout> --out <dir>
//   (writes golden.json and runtime.tar.gz; native/core/fixtures/tools/memory/runtime-install)
// Runs a copy of the Node modules against a temp data dir and a local stub release server.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync,
  utimesSync, writeFileSync,
} from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const outDir = arg('--out');
const TREE = arg('--tree');
// Everything below runs on a fresh temp dir; no real Mixdog data dir is touched.
const WORK = mkdtempSync(join(tmpdir(), 'rtgold-'));
process.env.MIXDOG_DATA_DIR = join(WORK, 'env-data');
process.env.MIXDOG_QUIET_MEMORY_LOG = '1';
delete process.env.MIXDOG_RUNTIME_RELEASE_REPOSITORY;
delete process.env.RUNTIME_RELEASE_REPOSITORY;

// ── a copy of exactly the Node modules the fetcher loads ─────────────────
const SRC = join(TREE, 'src');
const COPY = join(WORK, 'node');
mkdirSync(join(COPY, 'src/runtime/memory/lib/pg'), { recursive: true });
mkdirSync(join(COPY, 'src/runtime/memory/data'), { recursive: true });
writeFileSync(join(COPY, 'package.json'), '{"type":"module"}');
cpSync(join(SRC, "runtime/shared"), join(COPY, 'src/runtime/shared'), { recursive: true });
for (const f of ['runtime-fetcher.mjs', 'memory-log.mjs', 'pg/run-child.mjs']) {
  copyFileSync(join(SRC, "runtime/memory/lib", f), join(COPY, 'src/runtime/memory/lib', f));
}
const MANIFEST_FILE = join(COPY, 'src/runtime/memory/data/runtime-manifest.json');
const fetcher = await import(pathToFileURL(join(COPY, 'src/runtime/memory/lib/runtime-fetcher.mjs')).href);
const nativeAsset = await import(pathToFileURL(join(COPY, 'src/runtime/shared/native-asset.mjs')).href);

// ── the archive the stub serves: a fake runtime tree ─────────────────────
const exe = process.platform === 'win32' ? '.exe' : '';
const tree = join(WORK, 'tree');
for (const [path, text] of [
  [`bin/postgres${exe}`, 'fake postgres executable\n'],
  [`bin/pg_ctl${exe}`, 'fake pg_ctl executable\n'],
  [`bin/initdb${exe}`, 'fake initdb executable\n'],
  ['lib/libpq.dll', 'fake library\n'],
  ['share/postgres.bki', 'fake share file\n'],
]) {
  mkdirSync(dirname(join(tree, path)), { recursive: true });
  writeFileSync(join(tree, path), text);
}
const archive = join(WORK, 'runtime.tar.gz');
execFileSync('tar', ['-czf', archive, '-C', tree, 'bin', 'lib', 'share']);
const archiveBytes = readFileSync(archive);
const ARCH_SHA = createHash('sha256').update(archiveBytes).digest('hex');
const ARCH_SIZE = archiveBytes.length;
const listing = (flags) => execFileSync('tar', [flags, archive]).toString().split('\n').filter(Boolean);

// ── the stub release server ──────────────────────────────────────────────
let serve = {};
const server = http.createServer((req, res) => {
  const what = serve[req.url];
  if (what === 'archive') {
    res.writeHead(200, { 'content-length': archiveBytes.length });
    res.end(archiveBytes);
  } else {
    res.writeHead(404);
    res.end('not found');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;
const requests = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => {
  const u = String(url);
  requests.push(u.replace(BASE, '{base}'));
  const gh = /^https:\/\/github\.com(\/.*)$/.exec(u);
  return realFetch(gh ? `${BASE}/gh${gh[1]}` : u, init);
};

// ── scenarios ────────────────────────────────────────────────────────────
const HOST = nativeAsset.platformKey();
const VERSION = 'pg16.4+pgvector-0.8.2';
const KEY = `${VERSION}-${ARCH_SHA.slice(0, 12)}`;
const manifestOf = (assets) => ({
  schema_version: 1, release_tag: 'runtime-vTEST', pg: { major: 16, minor: 4 }, pgvector: { version: '0.8.2' }, assets,
});
const asset = (path, over = {}) => ({ url: `{base}${path}`, sha256: ARCH_SHA, size: ARCH_SIZE, ...over });
const GH = 'https://github.com/tribgames/mixdog/releases/download/runtime-vTEST/a.tar.gz';
const installed = (key, sha = ARCH_SHA, postgres = { text: 'fake postgres executable\n' }) => [
  { path: `runtime/runtime-${key}/bin/postgres${exe}`, ...postgres },
  { path: `runtime/runtime-${key}/lib/libpq.dll`, text: 'lib\n' },
  { path: `runtime/runtime-${key}/.version-sha256`, text: sha },
  { path: 'runtime/active-version', text: key },
];
const OLD = 'pg15.0+pgvector-0.1.0';
const STALE_MS = 600_000;
const scenarios = [
  {
    name: 'fresh-install',
    note: 'an empty data dir downloads, verifies, extracts, stamps, publishes; the old runtime and dead staging are collected',
    seed: [
      ...installed(OLD, 'a'.repeat(64)),
      { path: 'runtime/staging-dead', dir: true },
      { path: 'runtime/staging-dead.lock', text: '999999999 1\n' },
      { path: 'runtime/staging-dead.tar.gz', text: 'partial' },
    ],
    manifest: manifestOf({ [HOST]: asset('/ok.tar.gz') }),
    serve: { '/ok.tar.gz': 'archive' },
  },
  {
    name: 'cache-hit-keyed',
    note: 'active-version names version-sha12 and the stamp matches: no request',
    seed: installed(KEY),
    manifest: manifestOf({ [HOST]: asset('/ok.tar.gz') }),
    serve: { '/ok.tar.gz': 'archive' },
  },
  {
    name: 'cache-hit-bare-version',
    note: 'an install from before keyed names keeps its bare version name and stays valid',
    seed: installed(VERSION),
    manifest: manifestOf({ [HOST]: asset('/ok.tar.gz') }),
    serve: { '/ok.tar.gz': 'archive' },
  },
  {
    name: 'reinstall-zeroed-postgres',
    note: 'a stamped tree whose postgres executable is NUL-filled is not complete',
    seed: installed(KEY, ARCH_SHA, { zeros: 64 }),
    manifest: manifestOf({ [HOST]: asset('/ok.tar.gz') }),
    serve: { '/ok.tar.gz': 'archive' },
  },
  {
    name: 'reinstall-other-stamp',
    note: 'the stamp names another digest: a fresh install replaces the tree',
    seed: installed(KEY, 'b'.repeat(64)),
    manifest: manifestOf({ [HOST]: asset('/ok.tar.gz') }),
    serve: { '/ok.tar.gz': 'archive' },
  },
  {
    name: 'bad-checksum',
    note: 'the download is not the digest the manifest names: nothing is published, the partial files are gone',
    seed: [],
    manifest: manifestOf({ [HOST]: asset('/ok.tar.gz', { sha256: 'c'.repeat(64) }) }),
    serve: { '/ok.tar.gz': 'archive' },
  },
  {
    name: 'http-404',
    note: 'a 4xx answer is terminal and the only candidate fails',
    seed: [],
    manifest: manifestOf({ [HOST]: asset('/missing.tar.gz') }),
    serve: {},
  },
  {
    name: 'stale-locks',
    note: 'entry GC keeps what a live, fresh lock guards and collects the rest; the active runtime is a cache hit',
    seed: [
      ...installed(KEY),
      { path: 'runtime/runtime-other', dir: true },
      { path: 'runtime/runtime-leftover-file', text: 'x' },
      { path: 'runtime/staging-live', dir: true },
      { path: 'runtime/staging-live.lock', text: '{self} {now}\n' },
      { path: 'runtime/staging-deadpid', dir: true },
      { path: 'runtime/staging-deadpid.lock', text: '999999999 {now}\n' },
      { path: 'runtime/staging-old', dir: true },
      { path: 'runtime/staging-old.lock', text: '{self} 1\n', age_ms: STALE_MS + 60_000 },
      { path: 'runtime/staging-edge', dir: true },
      { path: 'runtime/staging-edge.lock', text: '{self} 1\n', age_ms: STALE_MS - 60_000 },
      { path: 'runtime/staging-nolock', dir: true },
      { path: 'runtime/staging-garbage', dir: true },
      { path: 'runtime/staging-garbage.lock', text: 'garbage\n' },
      { path: 'runtime/staging-garbage-old', dir: true },
      { path: 'runtime/staging-garbage-old.lock', text: 'garbage\n', age_ms: STALE_MS + 60_000 },
      { path: 'runtime/staging-orphan.lock', text: '999999999 {now}\n' },
      { path: 'runtime/staging-orphan-live.lock', text: '{self} {now}\n' },
      { path: 'runtime/staging-dl.tar.gz', text: 'partial' },
      { path: 'runtime/staging-dl.lock', text: '{self} {now}\n' },
      { path: 'runtime/staging-dl2.tar.gz', text: 'partial' },
      { path: 'runtime/staging-dl2.lock', text: '999999999 {now}\n' },
      { path: 'runtime/unrelated', text: 'kept' },
    ],
    manifest: manifestOf({ [HOST]: asset('/ok.tar.gz') }),
    serve: {},
  },
  {
    name: 'missing-platform-asset',
    note: 'the manifest has no asset for this platform',
    seed: [],
    manifest: manifestOf({ 'freebsd-x64': asset('/ok.tar.gz'), 'aix-ppc64': asset('/ok.tar.gz', { unsupported: true }) }),
    serve: {},
  },
  {
    name: 'no-assets-at-all',
    seed: [],
    manifest: { schema_version: 1, pg: { major: 16, minor: 4 }, pgvector: { version: '0.8.2' } },
    serve: {},
  },
  {
    name: 'platform-marked-unsupported',
    seed: [],
    manifest: manifestOf({ [HOST]: asset('/ok.tar.gz', { unsupported: true }) }),
    serve: {},
  },
  ...[
    ['placeholder-sha', { sha256: 'TBD' }],
    ['uppercase-sha', { sha256: ARCH_SHA.toUpperCase() }],
    ['zero-size', { size: 0 }],
    ['fractional-size', { size: 10.5 }],
    ['empty-url', { url: '' }],
  ].map(([name, over]) => ({
    name: `unusable-asset-${name}`, seed: [], manifest: manifestOf({ [HOST]: asset('/ok.tar.gz', over) }), serve: {},
  })),
  {
    name: 'candidates-all-fail',
    note: 'repositories named in the environment are tried in order after the manifest url',
    env: { MIXDOG_RUNTIME_RELEASE_REPOSITORY: ' o1/r1, o2/r2;tribgames/mixdog\to1/r1 ' },
    seed: [],
    manifest: manifestOf({ [HOST]: { url: GH, sha256: ARCH_SHA, size: ARCH_SIZE } }),
    serve: {},
  },
  {
    name: 'candidates-second-serves',
    env: { RUNTIME_RELEASE_REPOSITORY: 'o1/r1 o2/r2' },
    seed: [],
    manifest: manifestOf({ [HOST]: { url: GH, sha256: ARCH_SHA, size: ARCH_SIZE } }),
    serve: { '/gh/o1/r1/releases/download/runtime-vTEST/a.tar.gz': 'archive' },
  },
  {
    name: 'candidates-first-env-name-wins',
    env: { MIXDOG_RUNTIME_RELEASE_REPOSITORY: 'o1/r1', RUNTIME_RELEASE_REPOSITORY: 'o9/r9' },
    seed: [],
    manifest: manifestOf({ [HOST]: { url: GH, sha256: ARCH_SHA, size: ARCH_SIZE } }),
    serve: {},
  },
];

// ── running a scenario ───────────────────────────────────────────────────
const slash = (s) => s.split(sep).join('/');
function applySeed(data, seed) {
  for (const e of seed) {
    const path = join(data, e.path);
    if (e.dir) {
      mkdirSync(path, { recursive: true });
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    const text = e.text?.replaceAll('{self}', String(process.pid)).replaceAll('{now}', String(Date.now()));
    writeFileSync(path, e.zeros ? Buffer.alloc(e.zeros) : text);
    if (e.age_ms) {
      const at = new Date(Date.now() - e.age_ms);
      utimesSync(path, at, at);
    }
  }
}
function walk(root, dir = root, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const rel = slash(relative(root, path));
    if (statSync(path).isDirectory()) {
      out.push({ path: rel, kind: 'dir' });
      walk(root, path, out);
    } else {
      const entry = { path: rel, kind: 'file' };
      if (name === 'active-version' || name === '.version-sha256') entry.text = readFileSync(path, 'utf8');
      out.push(entry);
    }
  }
  return out;
}
const TAG = /staging-\d+-\d+-[a-z0-9]+/g;

const results = [];
for (const sc of scenarios) {
  const data = mkdtempSync(join(WORK, 'data-'));
  const norm = (s) => String(s)
    .replaceAll(slash(data), '{data}').replaceAll(data, '{data}').replaceAll(BASE, '{base}').replace(TAG, 'staging-{tag}');
  applySeed(data, sc.seed);
  writeFileSync(MANIFEST_FILE, JSON.stringify(sc.manifest).replaceAll('{base}', BASE));
  serve = sc.serve;
  requests.length = 0;
  for (const name of ['MIXDOG_RUNTIME_RELEASE_REPOSITORY', 'RUNTIME_RELEASE_REPOSITORY']) delete process.env[name];
  Object.assign(process.env, sc.env ?? {});
  let outcome;
  try {
    const r = await fetcher.ensureRuntime(data);
    outcome = {
      ok: {
        runtimeDir: slash(relative(data, r.runtimeDir)),
        pgBinDir: slash(relative(data, r.pgBinDir)),
        libDir: slash(relative(data, r.libDir)),
        sharePath: slash(relative(data, r.sharePath)),
        version: r.version,
      },
    };
  } catch (error) {
    outcome = { error: norm(error.message) };
  }
  results.push({
    name: sc.name, note: sc.note, seed: sc.seed, env: sc.env ?? {}, manifest: sc.manifest, serve: sc.serve,
    outcome, requests: [...requests], tree: walk(data).map((e) => ({ ...e, path: norm(e.path) })),
  });
}

// ── pure parts ───────────────────────────────────────────────────────────
const bsd = (type, name, extra = '') => `${type}rw-r--r--  0 0      0           5 Jan  1  2020 ${name}${extra}`;
const tarCases = [
  ['regular files and directories', ['bin/', 'bin/postgres'], [bsd('d', 'bin/'), bsd('-', 'bin/postgres')]],
  ['dot and double slash segments', ['./bin//x'], [bsd('-', './bin//x')]],
  ['symlink inside', ['lib/a', 'lib/b'], [bsd('-', 'lib/a'), bsd('l', 'lib/b', ' -> a')]],
  ['symlink up and back in', ['lib/a', 'share/b'], [bsd('-', 'lib/a'), bsd('l', 'share/b', ' -> ../lib/a')]],
  ['symlink to a directory entry', ['lib/', 'x'], [bsd('d', 'lib/'), bsd('l', 'x', ' -> lib')]],
  ['symlink target missing', ['x'], [bsd('l', 'x', ' -> nowhere')]],
  ['symlink out of the tree', ['lib/a', 'lib/x'], [bsd('-', 'lib/a'), bsd('l', 'lib/x', ' -> ../../a')]],
  ['symlink absolute target', ['x'], [bsd('l', 'x', ' -> /etc/passwd')]],
  ['symlink backslash target', ['x'], [bsd('l', 'x', ' -> a\\b')]],
  ['symlink drive target', ['x'], [bsd('l', 'x', ' -> C:foo')]],
  ['symlink with no marker', ['x'], [bsd('l', 'x')]],
  ['symlink with empty target', ['x'], [bsd('l', 'x', ' -> ')]],
  ['hard link inside', ['a', 'b'], [bsd('-', 'a'), bsd('h', 'b', ' link to a')]],
  ['hard link missing', ['b'], [bsd('h', 'b', ' link to a')]],
  ['arrow in the name', ['a -> b', 'c'], [bsd('-', 'a -> b'), bsd('l', 'c', ' -> a -> b')]],
  ['character device', ['dev'], [bsd('c', 'dev')]],
  ['fifo', ['f'], [bsd('p', 'f')]],
  ['leading spaces in detail', ['a'], ['   -rw-r--r-- 0 0 0 5 Jan  1  2020 a']],
  ['parent segment', ['a/../b'], [bsd('-', 'a/../b')]],
  ['leading parent', ['../b'], [bsd('-', '../b')]],
  ['absolute entry', ['/b'], [bsd('-', '/b')]],
  ['backslash entry', ['a\\b'], [bsd('-', 'a\\b')]],
  ['drive entry', ['C:/b'], [bsd('-', 'C:/b')]],
  ['drive letter without slash', ['c:b'], [bsd('-', 'c:b')]],
  ['nul in entry', ['a\0b'], [bsd('-', 'a\0b')]],
  ['empty entry', [''], [bsd('-', '')]],
  ['listings disagree', ['a', 'b'], [bsd('-', 'a')]],
  ['no entries', [], []],
];
const tarEntries = tarCases.map(([name, entries, details]) => {
  let outcome = 'ok';
  try {
    fetcher._validateRuntimeTarEntries(entries, details, join(WORK, 'stage', 'staging-x'));
  } catch (error) {
    outcome = error.message;
  }
  return { name, entries, details, outcome };
});
const platformKeys = [['win32', 'arm64'], ['win32', 'x64'], ['linux', 'arm64'], ['linux', 'x64'], ['darwin', 'arm64'], ['darwin', 'x64']]
  .map(([p, a]) => ({ platform: p, arch: a, candidates: nativeAsset.platformKeyCandidates(p, a) }));

mkdirSync(outDir, { recursive: true });
copyFileSync(archive, join(outDir, 'runtime.tar.gz'));
writeFileSync(
  join(outDir, 'golden.json'),
  `${JSON.stringify({
    recordedOn: HOST,
    node: process.version,
    version: VERSION,
    key: KEY,
    stale_lock_ms: STALE_MS,
    archive: { file: 'runtime.tar.gz', sha256: ARCH_SHA, size: ARCH_SIZE, entries: listing('-tzf') },
    platformKeys,
    tarEntries,
    install: results,
  }, null, 2)}\n`,
);
server.close();
rmSync(WORK, { recursive: true, force: true });
console.log(`recorded ${results.length} installs, ${tarEntries.length} tar cases`);

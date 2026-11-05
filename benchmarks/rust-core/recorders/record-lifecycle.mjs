#!/usr/bin/env node
// 1.4.5 tag fixtures for the lifecycle gates (LR §11): the REAL tag modules
// (git archive 69fe41b05) run against a barrier data dir; their verdicts and
// the barrier bytes are stored. The tag tree itself is not checked in: this
// recorder extracts it on demand (`--extract <dir>`), and the manifest pins the
// blob id of every tag file the tests rely on. The 1.4.5 migration corpus
// lives in the scratch dir and is REFERENCED, not duplicated.
//
//   node benchmarks/rust-core/recorders/record-lifecycle.mjs --tree <HEAD tree w/ node_modules> \
//        [--tag-tree <dir>] [--corpus <migration-corpus dir>]
//   --tag-tree: reuse an existing `git archive 69fe41b05` extraction (with node_modules);
//               otherwise one is extracted into a temp dir and node_modules is taken from --tree.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, commitStage, stageSet, REPO_ROOT, parseArgs, resolveTree, sha256, writeJson, writeSetManifest, writeText } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const TAG = 'v1.4.5';
const TAG_SHORT = '69fe41b05';
const git = (...a) => execFileSync('git', a, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 1 << 28 }).trim();
const tagCommit = git('rev-parse', `${TAG_SHORT}^{commit}`);
if (git('rev-parse', `${TAG}^{commit}`) !== tagCommit) throw new Error(`${TAG} does not point at ${TAG_SHORT}`);

const work = mkdtempSync(join(tmpdir(), 'mixdog-lifecycle-'));
let tagTree = args.get('tag-tree') ? resolve(args.get('tag-tree')) : null;
if (!tagTree) {
  tagTree = join(work, 'tag');
  mkdirSync(tagTree);
  const tarball = join(work, 'tag.tar');
  git('archive', '--format=tar', '-o', tarball, TAG_SHORT);
  execFileSync('tar', ['-xf', tarball, '-C', tagTree]);
  // Dev-PC shortcut: the tag lockfile's install is replaced by the HEAD tree's
  // node_modules (recorded in the manifest as `nodeModulesFrom`).
  symlinkSync(join(tree, 'node_modules'), join(tagTree, 'node_modules'), 'junction');
}

const PINNED = [
  'src/runtime/shared/singleton-owner.mjs',
  'src/runtime/shared/file-lock.mjs',
  'src/runtime/shared/pid-liveness.mjs',
  'src/standalone/daemon-owner.mjs',
  'src/standalone/daemon.mjs',
  'src/standalone/session-client.mjs',
  'apps/desktop/src/main/ssh/remote-install-daemon.ts',
  'apps/desktop/src/main/ssh/remote-install-program.ts',
  'apps/desktop/src/main/session-transport.ts',
];
const tagFiles = PINNED.map((p) => ({ path: p, blob: git('rev-parse', `${TAG_SHORT}:${p}`) }));

const mod = (rel) => import(pathToFileURL(join(tagTree, rel)).href);
const { claimSingletonOwner, refreshSingletonOwner, refreshSingletonOwnerAsync, handoffSingletonOwner, releaseSingletonOwner, readSingletonOwner } = await mod('src/runtime/shared/singleton-owner.mjs');

// ---- barrier bytes (LR §2.2) -----------------------------------------------
const BARRIER = '4294967296 0 mixdog-barrier-v1:fixture-instance\n';
const RECORD = '{"kind":"mixdog-daemon","pid":"Update Mixdog to continue","protocol":2,"version":"1.4.6"}\n';
const finalDir = join(FIXTURES_ROOT, 'lifecycle');
const outDir = stageSet(finalDir);
writeText(join(outDir, 'barrier', 'daemon-owner.json.claim.lock'), BARRIER);
writeText(join(outDir, 'barrier', 'daemon-owner.json'), RECORD);

// ---- §11.1 barrier unit against the real tag modules ------------------------
const dataDir = join(work, 'barrier-data');
mkdirSync(dataDir);
writeFileSync(join(dataDir, 'daemon-owner.json.claim.lock'), BARRIER);
writeFileSync(join(dataDir, 'daemon-owner.json'), RECORD);
const recordPath = join(dataDir, 'daemon-owner.json');
const bytes = () => readFileSync(recordPath, 'utf8');
const before = bytes();
const barrierUnit = {};
const strip = (r) => ({ ...r, owner: r?.owner === undefined ? undefined : '<record>' });
barrierUnit.claimIsStaleTrue = strip(claimSingletonOwner(recordPath, { kind: 'mixdog-daemon', isStale: () => true }));
barrierUnit.refresh = strip(refreshSingletonOwner(recordPath, { pid: process.pid, kind: 'mixdog-daemon' }));
barrierUnit.refreshAsync = strip(await refreshSingletonOwnerAsync(recordPath, { pid: process.pid, kind: 'mixdog-daemon' }));
barrierUnit.handoff = strip(handoffSingletonOwner(recordPath, process.pid, { kind: 'mixdog-daemon' }));
barrierUnit.release = releaseSingletonOwner(recordPath);
const read = readSingletonOwner(recordPath);
barrierUnit.readAlive = read.alive;
barrierUnit.recordByteIdentical = bytes() === before;
rmSync(recordPath);
barrierUnit.claimWithRecordDeleted = strip(claimSingletonOwner(recordPath, { kind: 'mixdog-daemon', isStale: () => true }));
barrierUnit.recordWrittenWhenDeleted = existsSync(recordPath);
barrierUnit.barrierLockUnchanged = readFileSync(join(dataDir, 'daemon-owner.json.claim.lock'), 'utf8') === BARRIER;
let killError = null;
try {
  process.kill(4294967296, 0);
} catch (e) {
  killError = e.code;
}
barrierUnit.killPidBeyond32bit = killError;
writeJson(join(outDir, 'barrier-unit.json'), { node: process.version, platform: process.platform, expectedFromSpec: { claim: 'owned:false', refresh: 'status busy', handoff: 'owned:false', release: false, kill: 'ERR_INVALID_ARG_TYPE' }, observed: barrierUnit });

// ---- §11.2 real 1.4.5 daemon start against the barrier dir -------------------
const daemonDir = join(work, 'daemon-data');
mkdirSync(daemonDir);
writeFileSync(join(daemonDir, 'daemon-owner.json.claim.lock'), BARRIER);
writeFileSync(join(daemonDir, 'daemon-owner.json'), RECORD);
const run = spawnSync(process.execPath, [join(tagTree, 'src/standalone/daemon.mjs')], {
  cwd: tagTree,
  encoding: 'utf8',
  timeout: 120_000,
  env: { ...process.env, MIXDOG_DATA_DIR: daemonDir, MIXDOG_HOME: join(work, 'home'), MIXDOG_RUNTIME_ROOT: join(work, 'runtime'), MIXDOG_DAEMON_SKIP_MEMORY: '1', MIXDOG_DISABLE_MCP: '1', HOME: join(work, 'home'), USERPROFILE: join(work, 'home') },
});
const logText = existsSync(join(daemonDir, 'daemon.log')) ? readFileSync(join(daemonDir, 'daemon.log'), 'utf8') : '';
const scrubTemp = (s) => s.replaceAll(work, '<WORK>').replaceAll(work.replace(/\\/g, '/'), '<WORK>');
const exitLine = (logText + run.stdout + run.stderr).split(/\r?\n/).filter((l) => /barrier|owner|claim|exit|attach/i.test(l)).map((l) => scrubTemp(l.replace(/^\[?[\d\-T:.Z ]+\]?\s*/, ''))).slice(0, 12);
writeJson(join(outDir, 'daemon-start-against-barrier.json'), {
  exitCode: run.status,
  signal: run.signal,
  timedOut: run.error?.code === 'ETIMEDOUT',
  relevantOutputLines: exitLine,
  recordAfterStartByteIdentical: readFileSync(join(daemonDir, 'daemon-owner.json'), 'utf8') === RECORD,
  barrierAfterStartByteIdentical: readFileSync(join(daemonDir, 'daemon-owner.json.claim.lock'), 'utf8') === BARRIER,
  dataDirEntries: readdirSync(daemonDir).sort(),
});

// ---- pins + migration corpus reference ---------------------------------------
const corpus = resolve(args.get('corpus') ?? 'C:/Users/tempe/.mixdog/data/scratch/rust-core/migration-corpus');
const corpusManifest = join(corpus, 'manifest.json');
writeJson(join(outDir, 'tag.json'), {
  tag: TAG,
  commit: tagCommit,
  extract: `git archive --format=tar -o tag.tar ${TAG_SHORT}; tar -xf tag.tar -C <dir>; (cd <dir> && git show ${TAG_SHORT}:package-lock.json > package-lock.json && npm ci --omit=dev --ignore-scripts)`,
  nodeModulesFrom: args.get('tag-tree') ? 'caller-provided' : 'HEAD tree node_modules (dev-PC shortcut; CI must use the tag lockfile)',
  files: tagFiles,
});
writeJson(join(outDir, 'migration-corpus-ref.json'), {
  note: 'The 1.4.5 migration corpus is referenced, not duplicated. Reproduce it with the corpus generator that produced it; check by manifest digest.',
  location: 'scratch/rust-core/migration-corpus (outside the repo; CI restores it as an artifact)',
  manifestSha256: existsSync(corpusManifest) ? sha256(readFileSync(corpusManifest)) : null,
  trees: existsSync(corpus) ? readdirSync(corpus).sort() : [],
  usedBy: ['SM §11.8 migration gate (v145, dev146, fixture-busy-seed)', 'electron-profile migration', 'LR §11 tests 5, 7, 11 (1.4.5 data dir state)'],
});

writeSetManifest(outDir, {
  set: 'lifecycle-1.4.5',
  recorder: 'benchmarks/rust-core/recorders/record-lifecycle.mjs',
  command: 'node benchmarks/rust-core/recorders/record-lifecycle.mjs --tree <tree with node_modules>',
  extra: { tag: TAG, tagCommit },
  identityTree: tagTree,
  identityRef: tagCommit,
});
commitStage(outDir, finalDir);
rmSync(work, { recursive: true, force: true });
console.log(JSON.stringify({ barrierUnit, daemon: { exit: run.status, lines: exitLine.length } }, null, 1));

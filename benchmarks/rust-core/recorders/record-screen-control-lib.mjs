// Shared plumbing of the `record-screen-control-*.mjs` recorders (a library: run one of those, not this).
//
// They record the phone's screen control on the secure desktop (UAC prompt, lock screen) from Node at b6f10295a:
// the source switch (secure-desktop-switch.ts), the input router (screen-input-router.ts), the helper lease
// (secure-desktop-helper.ts), the install request (secure-desktop/install-request.ts), the helper's video runs
// (screen-webrtc-source.ts), the screen session (screen-source.ts) and the helper adapter (secure-desktop-adapter.ts).
// Every one drives the real TypeScript of an exact export of that commit through fakes of the desktop and the helper:
// a fake input-desktop name, a fake helper transport and a fake installer port that only records the request. No
// desktop is switched, nothing is installed, no UAC prompt is raised, nothing is elevated and no input is injected.
//
//   (cd <tree>/apps/desktop && node --import tsx <this repo>/benchmarks/rust-core/recorders/record-screen-control-<part>.mjs --tree <tree> [--patch <file>] [--only <scenario>])
//
// `--patch <file>`: the tree is that export with a fix of a Node bug applied (`git diff` format against the commit;
// the same fix is built into Rust). The recorder refuses to go on unless the tree is exactly the commit with the
// patch applied, and the manifests name the base commit and the patch's sha256.
//
// The recorders write one fixture set, `native/core/fixtures/screen-control`, each into its own sub-directory with
// its own MANIFEST.json: the recorder's path and sha256, this library's and common.mjs's sha256, `process.version`,
// the product identity (exact export of the commit) and the inputs (the scenario names, in order). The set's
// MANIFEST.json is the index of every file of every sub-directory, sub-manifests included.
//
// `--only <scenario>` plays that one scenario and compares it with the committed recording, writing nothing.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FIXTURES_ROOT,
  GIT_TIMEOUT_MS,
  REPO_ROOT,
  commitStage,
  exactProductIdentity,
  parseArgs,
  productIdentity,
  resolveTree,
  sha256,
  stageSet,
  walkFiles,
  writeCanonicalJson,
  writeJson,
  writeSetManifest,
} from './lib/common.mjs';

export const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const SET = 'screen-control';
const LIB = 'benchmarks/rust-core/recorders/record-screen-control-lib.mjs';
const COMMON = 'benchmarks/rust-core/recorders/lib/common.mjs';
const ARGS = new Set(['tree', 'patch', 'only']);

const repoPath = (absolute) => relative(REPO_ROOT, absolute).split(sep).join('/');
const fileSha = (rel) => sha256(readFileSync(join(REPO_ROOT, rel)));

const lf = (data) => data.toString('utf8').replace(/\r\n/g, '\n');

/**
 * The identity of `tree` as the export of `NODE_COMMIT` with `patchFile` applied: the patch is applied to the
 * commit's own blobs of the files it touches, each of those files in the tree must equal the result, and every
 * other file must equal the commit's (exactly the patched files differ from it).
 */
function patchedProductIdentity(tree, patchFile) {
  const git = (args, cwd) => execFileSync('git', args, { cwd, maxBuffer: 256 * 1024 * 1024, timeout: GIT_TIMEOUT_MS });
  const paths = git(['apply', '--numstat', patchFile], REPO_ROOT).toString('utf8').split('\n').filter(Boolean).map((line) => line.split('\t')[2]);
  if (paths.length === 0) throw new Error(`${patchFile} changes no file`);
  const work = mkdtempSync(join(tmpdir(), 'screen-control-patch-'));
  try {
    for (const path of paths) {
      mkdirSync(dirname(join(work, path)), { recursive: true });
      writeFileSync(join(work, path), git(['show', `${NODE_COMMIT}:${path}`], REPO_ROOT));
    }
    git(['apply', patchFile], work);
    for (const path of paths) {
      if (lf(readFileSync(join(tree, path))) !== lf(readFileSync(join(work, path)))) {
        throw new Error(`tree ${tree}: ${path} is not ${NODE_COMMIT}'s with ${basename(patchFile)} applied`);
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  const identity = productIdentity(tree, NODE_COMMIT);
  const { filesDifferingFromCommit, commitFilesMissingFromTree } = identity.refComparison;
  if (filesDifferingFromCommit !== paths.length || commitFilesMissingFromTree !== 0) {
    throw new Error(`tree ${tree} differs from ${NODE_COMMIT} in ${filesDifferingFromCommit} file(s) (${commitFilesMissingFromTree} missing), the patch touches ${paths.length}`);
  }
  // `commit` with `patch`: exactly that commit with that patch applied, as checked above.
  return {
    ...identity,
    commit: NODE_COMMIT,
    baseCommit: NODE_COMMIT,
    patch: { file: basename(patchFile), sha256: sha256(readFileSync(patchFile)), paths },
    exact: true,
  };
}

/**
 * The export of `NODE_COMMIT` named by `--tree`, refused unless it is exactly that commit (or, with `--patch`, that
 * commit with the patch applied), and `--only`.
 */
export function openTree() {
  const args = parseArgs();
  for (const name of args.keys()) if (!ARGS.has(name)) throw new Error(`unknown option --${name} (known: --tree, --patch, --only)`);
  const tree = resolveTree(args);
  const patch = args.get('patch');
  const identity = patch ? patchedProductIdentity(tree, patch) : exactProductIdentity(tree, NODE_COMMIT);
  return { tree, identity, only: args.get('only') ?? null };
}

export const importTs = (tree, rel) => import(new URL(`file:///${join(tree, rel).replaceAll('\\', '/')}`).href);

/** `--only`: the committed recording of `name` in `committed` (a list of named entries) against what was played now. */
function compareOnly(sub, name, played, committed) {
  const want = committed.find((entry) => entry.name === name);
  if (!want) throw new Error(`${sub}: the committed recording has no scenario named ${JSON.stringify(name)}`);
  const got = JSON.stringify(played, null, 2);
  const expected = JSON.stringify(want, null, 2);
  if (got === expected) {
    console.log(`${sub}: ${name}: same as the committed recording`);
    return;
  }
  let at = 0;
  while (at < got.length && got[at] === expected[at]) at += 1;
  console.log(`${sub}: ${name}: differs from the committed recording at character ${at}`);
  console.log(`  committed: ${expected.slice(Math.max(0, at - 200), at + 200)}`);
  console.log(`  now:       ${got.slice(Math.max(0, at - 200), at + 200)}`);
  process.exitCode = 1;
}

/**
 * Records `sub`: `entries` are the named inputs (scenarios, or the parts of a table) in order; `play(entry)` gives
 * what Node did for one; `files(results)` turns the results, in order, into the sub-directory's files (name → JSON).
 * With `--only <name>` only that entry is played and compared with the committed one (`committed(files)` reads the
 * committed list back from the sub-directory's files); nothing is written.
 */
export async function record({ sub, recorderUrl, identity, only, entries, play, files, committed }) {
  const names = entries.map((entry) => entry.name);
  if (new Set(names).size !== names.length) throw new Error(`${sub}: two entries share a name`);
  if (only !== null) {
    const entry = entries.find((candidate) => candidate.name === only);
    if (!entry) throw new Error(`${sub}: no scenario named ${JSON.stringify(only)}; the names are:\n  ${names.join('\n  ')}`);
    const dir = join(FIXTURES_ROOT, SET, sub);
    const read = (name) => JSON.parse(readFileSync(join(dir, name), 'utf8'));
    compareOnly(sub, only, await play(entry), committed(read));
    return;
  }
  const results = [];
  for (const entry of entries) results.push(await play(entry));
  const finalDir = join(FIXTURES_ROOT, SET);
  const stage = stageSet(finalDir, [sub]);
  for (const [name, value] of Object.entries(files(results))) writeJson(join(stage, sub, name), value);
  const recorder = repoPath(fileURLToPath(recorderUrl));
  const subDir = join(stage, sub);
  const listed = walkFiles(subDir).map((file) => {
    const data = readFileSync(file);
    return { path: relative(subDir, file).split(sep).join('/'), bytes: data.length, sha256: sha256(data) };
  });
  writeCanonicalJson(join(subDir, 'MANIFEST.json'), {
    set: `${SET}/${sub}`,
    recorder,
    recorderSha256: fileSha(recorder),
    lib: LIB,
    libSha256: fileSha(LIB),
    common: COMMON,
    commonSha256: fileSha(COMMON),
    node: process.version,
    command: `(cd <tree>/apps/desktop && node --import tsx ${recorder} --tree <tree>${identity.patch ? ` --patch ${identity.patch.file}` : ''})`,
    product: identity,
    inputs: {
      tree: identity.patch ? `export of ${NODE_COMMIT} with ${identity.patch.file} (sha256 ${identity.patch.sha256}) applied` : `exact export of ${NODE_COMMIT}`,
      scenarios: names,
    },
    fileCount: listed.length,
    totalBytes: listed.reduce((sum, file) => sum + file.bytes, 0),
    files: listed,
  });
  writeSetManifest(stage, {
    set: SET,
    recorder: LIB,
    command: 'index of the sub-directories: each one has its own MANIFEST.json naming its recorder',
    identity,
  });
  commitStage(stage, finalDir);
  console.log(`${sub}: ${names.length} recorded`);
}

const realSetImmediate = globalThis.setImmediate;
/** Lets every pending microtask run (Node drains them all before an immediate): the scenario's "nothing more can happen now". */
export const checkpoint = () => new Promise((resolve) => realSetImmediate(resolve));

/**
 * Virtual time: timers wait in one queue ordered by absolute due time, then registration order, and run one callback
 * at a time with the microtasks drained between callbacks (Node's own order). `Date.now` and the timer functions are
 * replaced while it is installed; nothing waits on the wall clock.
 */
export class VirtualTime {
  constructor(start) {
    this.now = start;
    this.start = start;
    this.seq = 0;
    this.queue = [];
    this.real = {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
      now: Date.now,
    };
  }

  install() {
    const arm = (callback, ms, args, every) => {
      const timer = { due: this.now + Math.max(0, Number(ms) || 0), seq: ++this.seq, callback, args, cleared: false, every };
      Object.assign(timer, { ref: () => timer, unref: () => timer, hasRef: () => true });
      this.queue.push(timer);
      return timer;
    };
    const clear = (timer) => {
      if (timer) timer.cleared = true;
    };
    globalThis.setTimeout = (callback, ms, ...args) => arm(callback, ms, args, null);
    // An interval runs again `ms` after each run, with a new place in the registration order.
    globalThis.setInterval = (callback, ms, ...args) => arm(callback, ms, args, Math.max(0, Number(ms) || 0));
    globalThis.clearTimeout = clear;
    globalThis.clearInterval = clear;
    Date.now = () => this.now;
  }

  restore() {
    Object.assign(globalThis, {
      setTimeout: this.real.setTimeout,
      clearTimeout: this.real.clearTimeout,
      setInterval: this.real.setInterval,
      clearInterval: this.real.clearInterval,
    });
    Date.now = this.real.now;
  }

  pending() {
    return this.queue.filter((timer) => !timer.cleared).sort((a, b) => a.due - b.due || a.seq - b.seq);
  }

  /** Moves the clock forward by `ms`, running each timer that falls due, in order, one at a time. Returns how many ran. */
  async advance(ms) {
    const until = this.now + ms;
    let ran = 0;
    for (;;) {
      const [timer] = this.pending();
      if (!timer || timer.due > until) break;
      this.queue = this.queue.filter((entry) => entry !== timer);
      this.now = Math.max(this.now, timer.due);
      timer.callback(...timer.args);
      if (timer.every !== null && !timer.cleared) {
        Object.assign(timer, { due: this.now + timer.every, seq: ++this.seq });
        this.queue.push(timer);
      }
      await checkpoint();
      ran += 1;
    }
    this.now = until;
    return ran;
  }

  /** Time elapsed since the start, for the golden. */
  elapsed() {
    return this.now - this.start;
  }
}

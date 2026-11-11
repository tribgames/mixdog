#!/usr/bin/env node
// Records Node's daemon owner lock for the k1 UNTESTED daemon-owner-lock.test.mjs (gaps-rest.md: mixdog-app-server-daemon
// ownership). Each case runs the test's steps against Node's real `acquireDaemonOwnerLock`, in this process and in
// contender processes (each acquires, reports `{held}`, then holds what it got until killed), and records every value the
// test observes, in order.
//
//   node benchmarks/rust-core/recorders/record-daemon-owner-lock-cases.mjs --tree <exact export of b6f10295a with node_modules>
//
// Writes native/core/fixtures/daemon-owner-lock-cases/{golden.json,MANIFEST.json}.
import { spawn } from 'node:child_process';
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const RECORDER = 'benchmarks/rust-core/recorders/record-daemon-owner-lock-cases.mjs';
const TEST = 'src/standalone/daemon-owner-lock.test.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, NODE_COMMIT);
const LOCK_URL = pathToFileURL(join(tree, 'src', 'standalone', 'daemon-owner-lock.mjs')).href;
const { acquireDaemonOwnerLock, daemonOwnerLockPath } = await importFrom(tree, 'src/standalone/daemon-owner-lock.mjs');
const root = mkdtempSync(join(tmpdir(), 'mixdog-owner-lock-cases-'));

let fixtures = 0;
let closers = [];
function lockFixture() {
  const dir = join(root, `fx-${++fixtures}`);
  mkdirSync(dir, { recursive: true });
  return { lockPath: daemonOwnerLockPath(join(dir, 'data')) };
}
async function closeAll() {
  for (const close of closers.reverse()) await close();
  closers = [];
}

function contender({ lockPath }) {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const { acquireDaemonOwnerLock } = await import(${JSON.stringify(LOCK_URL)});
globalThis.lock = await acquireDaemonOwnerLock(${JSON.stringify(lockPath)});
process.stdout.write(JSON.stringify({ held: globalThis.lock.held }) + '\\n');
setInterval(() => {}, 60_000);`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  closers.push(async () => {
    child.kill('SIGKILL');
    await exited;
  });
  const verdict = new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
      const end = out.indexOf('\n');
      if (end >= 0) resolve(JSON.parse(out.slice(0, end)));
    });
    exited.then(({ code }) => reject(new Error(`contender exited ${code} before answering: ${stderr}`)));
  });
  return { child, verdict, exited, stderr: () => stderr };
}

const cases = [];
async function record(name, steps) {
  const observed = [];
  await steps((what, value) => observed.push({ what, value }));
  await closeAll();
  cases.push({ case: name, observed });
}

await record('a held lock refuses every other process, and a SIGKILLed holder frees it at once', async (see) => {
  const fx = lockFixture();
  const holder = contender(fx);
  see('holder', await holder.verdict);
  see('this process', (await acquireDaemonOwnerLock(fx.lockPath)).held);
  const second = contender(fx);
  see('second contender', await second.verdict);
  see('holder stderr has an ExperimentalWarning', /ExperimentalWarning/.test(holder.stderr()));
  holder.child.kill('SIGKILL');
  await holder.exited;
  const next = await acquireDaemonOwnerLock(fx.lockPath);
  closers.push(() => next.release());
  see('this process after the kill', next.held);
});

await record('the holder opening, reading and closing the lock file (as a hosted Read tool would) keeps the lock', async (see) => {
  const fx = lockFixture();
  const lock = await acquireDaemonOwnerLock(fx.lockPath);
  closers.push(() => lock.release());
  see('this process', lock.held);
  see('read bytes', readFileSync(fx.lockPath).length);
  closeSync(openSync(fx.lockPath, 'r+'));
  see('contender', await contender(fx).verdict);
  see('intact', lock.intact());
});

await record('simultaneous acquisitions leave exactly one holder', async (see) => {
  const fx = lockFixture();
  const racers = Array.from({ length: 4 }, () => contender(fx));
  const verdicts = await Promise.all(racers.map((racer) => racer.verdict));
  see('holders of 4', verdicts.filter((verdict) => verdict.held).length);
});

await record('data dirs whose lock files hold equal bytes (empty, or copied) are locked independently', async (see) => {
  for (const seed of ['empty', 'copied']) {
    const first = lockFixture();
    const second = lockFixture();
    if (seed === 'empty') {
      mkdirSync(dirname(first.lockPath), { recursive: true });
      mkdirSync(dirname(second.lockPath), { recursive: true });
      writeFileSync(first.lockPath, '');
      writeFileSync(second.lockPath, '');
    }
    const holder = contender(first);
    see(`${seed}: holder of the first`, await holder.verdict);
    if (seed === 'copied') {
      mkdirSync(dirname(second.lockPath), { recursive: true });
      copyFileSync(first.lockPath, second.lockPath);
    }
    const lock = await acquireDaemonOwnerLock(second.lockPath);
    closers.push(() => lock.release?.());
    see(`${seed}: this process on the second`, lock.held);
  }
});

await record('racing daemons on an existing lock file leave exactly one holder', async (see) => {
  const fx = lockFixture();
  mkdirSync(dirname(fx.lockPath), { recursive: true });
  writeFileSync(fx.lockPath, '');
  const racers = Array.from({ length: 4 }, () => contender(fx));
  const verdicts = await Promise.all(racers.map((racer) => racer.verdict));
  see('holders of 4', verdicts.filter((verdict) => verdict.held).length);
});

await record('one process holds it once; release frees it; intact() follows the locked file at its path', async (see) => {
  const fx = lockFixture();
  const lock = await acquireDaemonOwnerLock(fx.lockPath);
  closers.push(() => lock.release());
  see('this process', lock.held);
  see('a second acquisition here', (await acquireDaemonOwnerLock(fx.lockPath)).held);
  see('intact', lock.intact());
  let removed = true;
  try {
    rmSync(fx.lockPath);
  } catch {
    removed = false;
  }
  see('deleted', removed);
  see('exists', existsSync(fx.lockPath));
  see('intact after the delete', lock.intact());
  if (removed) return;
  lock.release();
  const again = await acquireDaemonOwnerLock(fx.lockPath);
  closers.push(() => again.release());
  see('this process after the release', again.held);
});

const excluded = {
  'only the process that took the lock knows it owns the data dir':
    "not observable outside the process: the flag's one reader is the gone-row sweep's gate (Node " +
    'src/session-runtime/services/agent-tool/terminal-reaper/gone-rows.mjs:109 `ownsDataDir = daemonOwnerLockHeldHere`, :160 ' +
    '`if (!ownsDataDir()) return 0`), whose only outside effect is that a process not owning the data dir (the `--plain` REPL) ' +
    "never prunes the worker index. The core has no such second process: its agent registry is composed only after " +
    '`ownership::acquire` succeeds (native/core/crates/mixdog-app-server-daemon/src/startup.rs:119), and a second start on ' +
    'the data dir is refused `AlreadyOwned` (startup.rs:296), as the replayed case "a held lock refuses every other process" shows',
  'releasing the lock ends this process ownership of the data dir':
    "not observable outside the process: `daemonOwnerLockHeldHere()` after `release()` is read only by the same sweep gate " +
    '(gone-rows.mjs:160); a released Node owner stops pruning, and a core that drops its `CoreOwnership` has ended (the value ' +
    'lives for the core\'s life, startup.rs:296 "L is held for the core\'s life"); the release itself is replayed in ' +
    '"one process holds it once; release frees it"',
};

const finalDir = join(FIXTURES_ROOT, 'daemon-owner-lock-cases');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), { note: `Node's daemon owner lock at ${NODE_COMMIT}, per case of ${RECORDER}`, test: TEST, platform: process.platform, cases });
writeSetManifest(stage, {
  set: 'daemon-owner-lock-cases',
  recorder: RECORDER,
  command: `node ${RECORDER} --tree <exact export of ${NODE_COMMIT}>`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    compared: 'every value each case observes, in order (contender verdicts, held, intact, the delete, the file read)',
    excluded,
  },
});
commitStage(stage, finalDir);
rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
console.log(`daemon-owner-lock-cases: ${cases.length} case(s), ${Object.keys(excluded).length} named exclusion(s)`);
process.exit(0);

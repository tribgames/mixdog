#!/usr/bin/env node
// What the daemon's data-dir owner lock does between PROCESSES (src/standalone/daemon-owner-lock.mjs, the OS-held exclusive lock on
// `daemon-owner.lock`): the REAL `acquireDaemonOwnerLock` in real child processes, killed with SIGKILL (TerminateProcess on Windows).
// Scenarios (daemon-owner-lock.test.mjs):
//   refuseAndKill:  one holder; this process and a second contender are refused; the holder is killed and the next acquisition holds.
//   holderReads:    the holder opens, reads and closes its own lock file (as a hosted Read tool would): a contender is still refused.
//   simultaneous:   four processes acquire at once: how many hold.
//   equalBytes:     two data dirs whose lock files hold equal bytes (both empty; the second a copy of the first): both are locked
//                   independently.
//   racingExisting: four processes race on an existing, empty lock file: how many hold.
// The order in which racers answer is not recorded (it is the scheduler's): per race, the number of racers and how many held.
// Rust `mixdog_app_server_daemon::ownership::acquire` must answer the same across real processes.
//   node benchmarks/rust-core/recorders/record-owner-lock.mjs [--tree <dir>]
// Output: native/core/fixtures/owner-lock/golden.json.
import { spawn } from 'node:child_process';
import { copyFileSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, commitStage, exactProductIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const tree = resolveTree(parseArgs());
const identity = exactProductIdentity(tree, NODE_COMMIT);
const finalDir = join(FIXTURES_ROOT, 'owner-lock');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-owner-lock.mjs';
const lockModule = pathToFileURL(join(tree, 'src', 'standalone', 'daemon-owner-lock.mjs')).href;
const { acquireDaemonOwnerLock, daemonOwnerLockPath } = await import(lockModule);

// The one failure deadline of every wait on a child: a stuck contender fails the recording with a message naming what did not arrive.
const DEADLINE_MS = 30_000;
function within(promise, what) {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not arrive within ${DEADLINE_MS} ms`)), DEADLINE_MS);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

const roots = [];
const children = [];
const contenders = [];
const dirOf = () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-owner-lock-rec-'));
  roots.push(root);
  return daemonOwnerLockPath(join(root, 'data'));
};

// Another process trying the lock: answers whether it got it, then holds what it got until killed (or until its stdin closes).
function contender(lockPath) {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const { acquireDaemonOwnerLock } = await import(${JSON.stringify(lockModule)});
globalThis.lock = await acquireDaemonOwnerLock(${JSON.stringify(lockPath)});
process.stdout.write(JSON.stringify({ held: globalThis.lock.held }) + '\\n');
process.stdin.on('end', () => process.exit(0));
process.stdin.resume();`,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
  );
  children.push(child);
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  const answer = new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
      const end = out.indexOf('\n');
      if (end >= 0) resolve(JSON.parse(out.slice(0, end)));
    });
    exited.then(({ code }) => reject(new Error(`a contender exited ${code} before answering`)));
  });
  const started = {
    child,
    verdict: within(answer, `the verdict of the contender on ${lockPath}`),
    exit: () => within(exited, `the exit of the contender on ${lockPath}`),
  };
  contenders.push(started);
  return started;
}

const kill = async (c) => {
  c.child.kill('SIGKILL');
  await c.exit();
};
const heldCount = (verdicts) => verdicts.filter((v) => v.held).length;

const golden = {};
try {
  {
    const lockPath = dirOf();
    const holder = contender(lockPath);
    const first = await holder.verdict;
    const parent = await acquireDaemonOwnerLock(lockPath);
    const second = contender(lockPath);
    const secondVerdict = await second.verdict;
    await kill(holder);
    const next = await acquireDaemonOwnerLock(lockPath);
    golden.refuseAndKill = { holder: first, thisProcess: { held: parent.held }, secondContender: secondVerdict, afterKill: { held: next.held } };
    next.release();
  }
  {
    const lockPath = dirOf();
    const lock = await acquireDaemonOwnerLock(lockPath);
    readFileSync(lockPath);
    closeSync(openSync(lockPath, 'r+'));
    const other = contender(lockPath);
    golden.holderReads = { holder: { held: lock.held }, contender: await other.verdict, intact: lock.intact() };
    await kill(other);
    lock.release();
  }
  {
    const lockPath = dirOf();
    const racers = Array.from({ length: 4 }, () => contender(lockPath));
    const verdicts = await Promise.all(racers.map((r) => r.verdict));
    golden.simultaneous = { racers: racers.length, held: heldCount(verdicts) };
    for (const r of racers) await kill(r);
  }
  {
    golden.equalBytes = {};
    for (const seed of ['empty', 'copied']) {
      const first = dirOf();
      const second = dirOf();
      if (seed === 'empty') {
        for (const path of [first, second]) {
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, '');
        }
      }
      const holder = contender(first);
      const holderVerdict = await holder.verdict;
      if (seed === 'copied') {
        mkdirSync(dirname(second), { recursive: true });
        copyFileSync(first, second);
      }
      const lock = await acquireDaemonOwnerLock(second);
      golden.equalBytes[seed] = { holder: holderVerdict, otherDir: { held: lock.held } };
      lock.release?.();
      await kill(holder);
    }
  }
  {
    const lockPath = dirOf();
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, '');
    const racers = Array.from({ length: 4 }, () => contender(lockPath));
    const verdicts = await Promise.all(racers.map((r) => r.verdict));
    golden.racingExisting = { racers: racers.length, held: heldCount(verdicts) };
    for (const r of racers) await kill(r);
  }
} finally {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  // A child holds its lock file until it exits: the exit is the event that lets the directories go.
  await Promise.all(contenders.map((c) => c.exit()));
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}

writeJson(join(stage, 'golden.json'), { platform: process.platform, ...golden });
writeSetManifest(stage, {
  set: 'owner-lock',
  recorder,
  command: `node ${recorder} --tree <tree>`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    exclusions: 'The order racers answer in is not recorded: a race records its racer count and how many held. The lock-file deletion step of the Node test (platform dependent) is not recorded.',
  },
});
commitStage(stage, finalDir);
process.exit(0);

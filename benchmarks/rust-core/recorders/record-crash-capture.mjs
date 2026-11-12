#!/usr/bin/env node
// What a boot's crash capture holds after each way the daemon can end, from real processes:
//   - a launcher process opens the boot's capture (`beginDaemonSpawnCapture`, launcher `core`, as ensure-core.mjs
//     does), spawns the daemon detached with fd 2 in the capture file, tracks it, notes it ready, and exits: the
//     launcher is gone before the daemon ends, the usual case, so nobody but the daemon writes its exit;
//   - the daemon process installs the exit recorder as daemon.mjs does (`installDaemonExitRecorder({ dataDir })`,
//     its `uncaughtException` handler and `shutdown`'s `settleExit`, quoted below from daemon.mjs), waits for the go
//     file, and ends the way its case names;
//   - for an end that runs no hook (killed from outside, V8's heap-out-of-memory abort), the next boot settles the
//     capture (`reconcileLostDaemonCaptures`, as daemon.mjs boots).
// Recorded per case: the sidecar as the launcher left it and as it is at the end, with what differs per run
// (process ids, times, uptime, memory, the boot's stem) as placeholders and a JS error as its message.
//
//   node benchmarks/rust-core/recorders/record-crash-capture.mjs --tree <exact export of b6f10295a>
// Output: native/core/fixtures/crash-capture/golden.json
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recorderProvenance } from './lib/provenance.mjs';
import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, within, writeJson, writeSetManifest } from './lib/common.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const recorder = 'benchmarks/rust-core/recorders/record-crash-capture.mjs';
const self = fileURLToPath(import.meta.url);
const parsed = parseArgs();
const tree = resolveTree(parsed);
const args = Object.fromEntries(parsed);
const CAPTURE = 'src/session-runtime/services/daemon-crash-capture.mjs';
const EXIT_RECORD = 'src/session-runtime/services/daemon-crash-capture/daemon-exit-record.mjs';
const MESSAGE = 'the core lost its store';
const BOOT_ERROR = 'the data folder is held by another core';

const until = async (label, test, ms = 30_000) => {
  const deadline = Date.now() + ms;
  while (!test()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

if (args.role === 'launcher') {
  // ensure-core.mjs launchCore: the capture, the detached spawn with fd 2 in it, track, ready; then this process ends.
  const { beginDaemonSpawnCapture } = await importFrom(tree, CAPTURE);
  const capture = beginDaemonSpawnCapture({ launcher: 'core', dataDir: args.data, prune: false });
  const heapFlags = args.case === 'oom' ? ['--max-old-space-size=16'] : [];
  const child = spawn(process.execPath, [...heapFlags, self, '--tree', tree, '--role', 'daemon', '--case', args.case, '--data', args.data], {
    detached: true,
    stdio: ['ignore', 'ignore', capture.stderrStdio],
    windowsHide: true,
  });
  capture.track(child, { detached: true, heapFlags });
  child.once('spawn', () => {
    capture.noteReady();
    child.unref();
    process.stdout.write(`${JSON.stringify({ pid: child.pid, record: capture.recordPath })}\n`, () => process.exit(0));
  });
} else if (args.role === 'daemon') {
  const { installDaemonExitRecorder } = await importFrom(tree, EXIT_RECORD);
  const exitRecorder = installDaemonExitRecorder({ dataDir: args.data });
  // daemon.mjs settleExit / shutdown / onFatalError, without the teardown they wrap.
  let fatalExit = null;
  const settleExit = (reason, code, error) => {
    if (fatalExit) {
      exitRecorder.setReason(`shutdown: ${reason} (fatal ${fatalExit.label})`, 1, fatalExit.detail);
      return 1;
    }
    exitRecorder.setReason(`shutdown: ${reason}`, code, error);
    return code;
  };
  const shutdown = async (reason, code = 0, error = null) => process.exit(settleExit(reason, code, error));
  const onFatalError = (label, err) => {
    const detail = err?.stack || err?.message || String(err);
    process.exitCode = 1;
    fatalExit ||= { label, detail };
    exitRecorder.write({ reason: `fatal ${label}`, code: 1, error: detail });
    shutdown(`fatal ${label}`, 1, detail).finally(() => process.exit(1));
  };
  process.on('unhandledRejection', (err) => onFatalError('unhandled rejection', err));
  process.on('uncaughtException', (err) => onFatalError('uncaught exception', err));
  const go = join(args.data, 'go');
  await until('the go file', () => existsSync(go));
  // Thrown from a timer, outside any promise: an uncaught exception, as a panic is.
  if (args.case === 'uncaught') setTimeout(() => {
    throw new Error(MESSAGE);
  });
  if (args.case === 'fatal-boot') {
    // main().catch → shutdown('fatal boot error', 2)
    process.stderr.write(`fatal boot error: Error: ${BOOT_ERROR}\n`);
    void shutdown('fatal boot error', 2);
  }
  if (args.case === 'exit-code') process.exit(3);
  if (args.case === 'oom') {
    const kept = [];
    for (;;) kept.push(new Array(1_000_000).fill(kept.length));
  }
  // 'killed': stays until the recorder ends it from outside.
  setInterval(() => {}, 1_000);
} else {
  const identity = exactProductIdentity(tree, NODE_COMMIT);
  const { reconcileLostDaemonCaptures } = await importFrom(tree, EXIT_RECORD);
  const { isPidAlive } = await importFrom(tree, 'src/runtime/shared/pid-liveness.mjs');
  const root = mkdtempSync(join(tmpdir(), 'mixdog-crash-capture-'));

  // The sidecar with what differs per run as placeholders.
  const steady = (record) => {
    const out = { ...record };
    for (const key of ['spawnedAt', 'readyAt', 'exitedAt', 'exitReconciledAt']) if (out[key]) out[key] = `<${key}>`;
    if (out.pid) out.pid = '<pid>';
    if (out.launcherPid) out.launcherPid = '<launcherPid>';
    if (out.stderrFile) out.stderrFile = '<stem>.err.log';
    if (Number.isInteger(out.uptimeMs)) out.uptimeMs = '<uptimeMs>';
    if (out.stderrBytes) out.stderrBytes = '<stderrBytes>';
    if (out.daemonExit) {
      const exit = { ...out.daemonExit, at: '<at>', uptimeMs: '<uptimeMs>', rssBytes: '<rssBytes>', heapUsedBytes: '<heapUsedBytes>' };
      // A JS error is its stack; its message is what the record carries across runtimes.
      if (exit.error) exit.error = exit.error.replace(/^Error: /, '').replace(/ at .*$/, '');
      out.daemonExit = exit;
    }
    return out;
  };
  const cases = [];
  for (const name of ['uncaught', 'fatal-boot', 'exit-code', 'killed', 'oom']) {
    const data = join(root, name);
    mkdirSync(data, { recursive: true });
    const launcher = spawn(process.execPath, [self, '--tree', tree, '--role', 'launcher', '--case', name, '--data', data], { stdio: ['ignore', 'pipe', 'inherit'] });
    let said = '';
    launcher.stdout.on('data', (chunk) => {
      said += chunk;
    });
    await within(`the ${name} launcher`, new Promise((resolve) => launcher.once('exit', resolve)), 30_000);
    const { pid, record } = JSON.parse(said);
    const launched = JSON.parse(readFileSync(record, 'utf8'));
    writeFileSync(join(data, 'go'), '');
    if (name === 'killed') process.kill(pid);
    await until(`the ${name} daemon to end`, () => !isPidAlive(pid), 120_000);
    // The next boot settles a capture that ended without any hook.
    const settled = reconcileLostDaemonCaptures({ dir: join(data, 'daemon-crash'), selfPid: process.pid });
    const ended = JSON.parse(readFileSync(record, 'utf8'));
    cases.push({ name, settledByNextBoot: settled, launched: steady(launched), ended: steady(ended) });
    if (readdirSync(join(data, 'daemon-crash')).filter((f) => f.endsWith('.json')).length !== 1) throw new Error(`${name}: one sidecar`);
  }
  rmSync(root, { recursive: true, force: true });

  const finalOut = join(FIXTURES_ROOT, 'crash-capture');
  const out = stageSet(finalOut);
  writeJson(join(out, 'golden.json'), {
    note: 'a boot\'s crash-capture sidecar as the launcher left it and after each way the daemon ended, launcher gone',
    message: MESSAGE,
    bootError: BOOT_ERROR,
    cases,
  });
  writeSetManifest(out, {
    set: 'crash-capture',
    recorder,
    command: `node ${recorder} --tree <exact export of ${NODE_COMMIT}>`,
    identity,
    extra: {
      ...recorderProvenance(import.meta.url),
      syntheticInputs: [
        'the daemon side is daemon.mjs\'s exit-recorder install, uncaughtException handler, onFatalError, shutdown and settleExit quoted without the teardown they wrap',
        'uncaught: an Error thrown after the go file; fatal-boot: main().catch\'s shutdown(\'fatal boot error\', 2); exit-code: process.exit(3); killed: process.kill by the recorder; oom: --max-old-space-size=16 and arrays kept until V8 aborts',
      ],
      keptWhole: 'per case: the sidecar as launched and as ended (ids, times, uptime, memory and the stem as placeholders; a JS error as its message) and whether the next boot settled it',
    },
  });
  commitStage(out, finalOut);
  console.log(JSON.stringify(cases, null, 1));
  process.exit(0);
}

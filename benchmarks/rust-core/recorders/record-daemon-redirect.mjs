// Records the bytes the real Node daemon leaves in daemon.log for its stderr (reference tree b6f10295a).
// usage: node benchmarks/rust-core/recorders/record-daemon-redirect.mjs --tree <export of the commit> --commit <full id>
// The tree must be exactly the commit (every src/apps file, both ways) or the recorder refuses to write. Output: golden.json and the
// set's MANIFEST.json (shared with record-daemon-redirect-memory.mjs).
// A child process stands in for the daemon the way `remote-install-daemon.ts` starts it: its stdout and stderr are the
// log file's descriptor. Before `enableFileLogging` it writes straight to that descriptor; after
// `enableFileLogging` + `installRedirect` every stderr/console write goes through `createDaemonLog`.
// Each `[<ISO>]` stamp is replaced by the token <ISO> after its exact shape is checked.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, commitStage, exactProductIdentity, parseArgs, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

if (process.argv[2] === 'child') {
  const [root, logPath] = process.argv.slice(3);
  const { createDaemonLog } = await import(pathToFileURL(path.join(root, 'src/standalone/daemon-log.mjs')).href);
  const log = createDaemonLog({ logPath });
  log.log('before ready');
  process.stderr.write('[mod] raw before ready\n');
  log.enableFileLogging();
  log.installRedirect();
  // `announceDaemonReady` (daemon.mjs:856-857) with the real profiler; port, pid and the two durations are masked below.
  const { performance } = await import('node:perf_hooks');
  const { createBootPhaseProfiler } = await import(pathToFileURL(path.join(root, 'src/standalone/boot-phase-profiler.mjs')).href);
  const startedAt = performance.now();
  const bootPhases = createBootPhaseProfiler({ log: log.log, startedAt });
  log.log(`ready port=${54366} pid=${process.pid} in ${(performance.now() - startedAt).toFixed(0)}ms`);
  bootPhases.mark('daemon-ready');
  log.log('after ready');
  process.stderr.write('[mod] single line\n');
  process.stderr.write('[mod] first\n[mod] second\n');
  process.stderr.write('[mod] no newline');
  console.warn('[mod] warned', 3);
  console.error('[mod] errored');
  await log.flush();
  process.exit(0);
}

const args = parseArgs();
const root = path.resolve(args.get('tree') ?? (() => { throw new Error('--tree is required'); })());
const identity = exactProductIdentity(root, args.get('commit') ?? (() => { throw new Error('--commit is required'); })());
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-redirect-'));
const file = path.join(dir, 'daemon.log');
const fd = fs.openSync(file, 'a');
const run = spawnSync(process.execPath, [process.argv[1], 'child', root, file], { stdio: ['ignore', fd, fd] });
if (run.status !== 0) throw new Error(`child exited ${run.status}`);
const text = fs.readFileSync(file, 'utf8');
const masked = text
  .replace(/\[\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\] /g, '[<ISO>] ')
  .replace(/^(\[<ISO>\] \[daemon\] ready port=)\d+ pid=\d+ in \d+ms$/m, '$1<PORT> pid=<PID> in <MS>ms')
  .replace(/^(\[<ISO>\] \[daemon\] boot-phase phase=daemon-ready status=mark totalMs=)\d+(\.\d)?$/m, '$1<TOTAL>');
if (!masked.includes('<PORT>') || !masked.includes('<TOTAL>')) throw new Error('ready rows did not have the expected shape');
fs.rmSync(dir, { recursive: true, force: true });
const finalDir = path.join(FIXTURES_ROOT, 'daemon-redirect');
const stage = stageSet(finalDir, []);
writeJson(path.join(stage, 'golden.json'), { file: masked });
// One manifest for the set, written by whichever recorder runs: the other's file is listed from the staged copy.
const recorder = 'benchmarks/rust-core/recorders/record-daemon-redirect.mjs';
const command = `node ${recorder} --tree <tree> --commit ${identity.commit}`;
writeSetManifest(stage, { set: 'daemon-redirect', recorder, command, extra: { alsoRecordedBy: ['benchmarks/rust-core/recorders/record-daemon-redirect-memory.mjs'] }, identity });
commitStage(stage, finalDir);

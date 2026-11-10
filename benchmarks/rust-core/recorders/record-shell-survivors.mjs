#!/usr/bin/env node
// What the agent sees when a foreground shell command finishes but leaves a descendant running (Node's
// `probeShellDescendants` → survivors task), through its whole life: the start notice, `task read` while it runs,
// `task wait` / `task read` after it ended on its own, `task read output:tail`, `task cancel` (while running, again,
// and after a natural end), the read after a cancel and `task list`. The real Node shell and task tools run on a clean checkout of one commit with the
// mixdog-spawn binary built from that same commit; the task id, the two timestamps and the child's pid are
// replaced by placeholders. Windows form of the commands (the host this was recorded on).
//
//   node benchmarks/rust-core/recorders/record-shell-survivors.mjs --tree <git checkout at --commit, with node_modules> \
//        --commit <40-hex> --spawn-bin <mixdog-spawn built from the same commit> \
//        --spawn-build-command "<the cargo command>" --spawn-target-dir <its CARGO_TARGET_DIR> --rustc <rustc of the build>
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitCheckoutIdentity, importFrom, parseArgs, resolveTree, sha256, writeJson, writeSetManifest } from './lib/common.mjs';

const args = parseArgs();
const need = (name) => args.get(name) ?? (() => { throw new Error(`--${name} is required`); })();
const tree = resolveTree(args);
const commit = need('commit');
if (process.platform !== 'win32') throw new Error('the recorded commands are the Windows form');
const identity = commitCheckoutIdentity(tree, commit);
const git = (...a) => execFileSync('git', ['-C', tree, ...a], { encoding: 'utf8' }).trim();
const spawnBin = need('spawn-bin');
const spawnIdentity = {
  sourceTree: git('rev-parse', 'HEAD:native/mixdog-spawn'),
  cargoLockSha256: sha256(readFileSync(join(tree, 'native', 'mixdog-spawn', 'Cargo.lock'))),
  binarySha256: sha256(readFileSync(spawnBin)),
  buildCommand: need('spawn-build-command'),
  buildCwd: 'native/mixdog-spawn',
  targetDir: need('spawn-target-dir'),
  toolchain: execFileSync(need('rustc'), ['--version', '--verbose'], { encoding: 'utf8' }).trim().split(/\r?\n/),
};

const work = mkdtempSync(join(tmpdir(), 'mixdog-survivors-golden-'));
process.env.MIXDOG_DATA_DIR = join(work, 'data');
const keepAlive = setInterval(() => {}, 1000); // `task wait` holds only unref'd timers
const { _setNativeSpawnBinaryForTest } = await importFrom(tree, 'src/runtime/agent/orchestrator/tools/lib/native-spawn-client.mjs');
_setNativeSpawnBinaryForTest(spawnBin);
const { executeBuiltinTool } = await importFrom(tree, 'src/runtime/agent/orchestrator/tools/builtin.mjs');
const { normalizeToolEnvelope } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/tool-envelope.mjs');

const ws = join(work, 'ws');
mkdirSync(ws, { recursive: true });
const text = async (tool, input) => String(normalizeToolEnvelope(await executeBuiltinTool(tool, input, ws)).result ?? '');
// The descendant is a hidden PowerShell that blocks on a named event the observer owns, and only then sleeps `seconds`: it
// cannot end before the observer holds it, and it ends by itself only once the observer opens the gate.
const GATE = '<GATE>';
const child = (seconds) => `$p = Start-Process powershell -ArgumentList '-NoProfile','-Command','[void][Threading.EventWaitHandle]::OpenExisting(''${GATE}'').WaitOne(); Start-Sleep -Seconds ${seconds}' -PassThru -WindowStyle Hidden; Write-Output "CHILD=$($p.Id)"`;
const NATURAL = child(1);
const LONG = child(90);

// The observer's side of a gate: a holder process creates the event and opens it when told to.
const gates = [];
const makeGate = async (tag) => {
  const name = `mixdog-survivor-gate-${process.pid}-${tag}`;
  const holder = spawn('powershell', ['-NoProfile', '-Command',
    `$e = New-Object Threading.EventWaitHandle($false, [Threading.EventResetMode]::ManualReset, '${name}'); [Console]::Out.WriteLine('ready'); [void][Console]::In.ReadLine(); $e.Set(); Start-Sleep -Seconds 120`]);
  await new Promise((resolve, reject) => {
    holder.once('error', reject);
    holder.stdout.on('data', (d) => String(d).includes('ready') && resolve());
  });
  gates.push(holder);
  return { name, open: () => holder.stdin.write('\n') };
};

const scrubbers = [];
const scrub = (t) => {
  let out = t;
  for (const [from, to] of scrubbers) out = out.replaceAll(from, to);
  return out.replace(/(started|finished): \S+/g, '$1: <TIME>').replace(/CHILD=\d+/g, 'CHILD=<PID>');
};
const start = async (template, gate) => {
  scrubbers.push([gate.name, GATE]);
  const ran = await text('shell', { command: template.replace(GATE, gate.name) });
  const id = /task_id: (\S+)/.exec(ran)[1];
  scrubbers.push([id, '<TASK>']);
  return { ran, id };
};

const naturalGate = await makeGate('natural');
const natural = await start(NATURAL, naturalGate);
const naturalOut = {
  command: NATURAL,
  run: natural.ran,
  readRunning: await text('task', { action: 'read', task_id: natural.id }),
  gate: naturalGate.open(),
  wait: await text('task', { action: 'wait', task_id: natural.id, timeout_ms: 20000 }),
  read: await text('task', { action: 'read', task_id: natural.id }),
  tail: await text('task', { action: 'read', task_id: natural.id, output: 'tail' }),
  cancelAfterEnd: await text('task', { action: 'cancel', task_id: natural.id }),
};
const cancelled = await start(LONG, await makeGate('cancelled')); // never opened: the descendant waits until the cancel ends it
const cancelOut = {
  command: LONG,
  run: cancelled.ran,
  readRunning: await text('task', { action: 'read', task_id: cancelled.id }),
  cancel: await text('task', { action: 'cancel', task_id: cancelled.id }),
  cancelAgain: await text('task', { action: 'cancel', task_id: cancelled.id }),
  read: await text('task', { action: 'read', task_id: cancelled.id }),
  tail: await text('task', { action: 'read', task_id: cancelled.id, output: 'tail' }),
};
const list = await text('task', { action: 'list' });

const dir = join(FIXTURES_ROOT, 'shell-survivors');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const finish = (section) => Object.fromEntries(Object.entries(section).filter(([k]) => k !== 'gate').map(([k, v]) => [k, k === 'command' ? v : scrub(v)]));
writeJson(join(dir, 'golden.json'), {
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  nodeCommit: commit,
  normalization: 'task id -> <TASK>; started/finished values -> <TIME>; CHILD=<digits> -> CHILD=<PID>; the gate event name -> <GATE>',
  natural: finish(naturalOut),
  cancelled: finish(cancelOut),
  list: scrub(list),
});
const command = `node benchmarks/rust-core/recorders/record-shell-survivors.mjs --tree <git checkout of ${commit}> --commit ${commit} --spawn-bin <mixdog-spawn built from it> --spawn-build-command <cargo command> --spawn-target-dir <dir> --rustc <rustc>`;
writeSetManifest(dir, {
  set: 'shell-survivors',
  recorder: 'benchmarks/rust-core/recorders/record-shell-survivors.mjs',
  command,
  identity,
  extra: { spawn: spawnIdentity, scenarios: ['natural end', 'cancel while running', 'cancel after the natural end', 'cancel twice'], blocked: ['unconfirmed cancel and the kill/observe schedule: expectations are the shell-tracker-trace recording; a Windows job object ends every member, nothing here resists the kill', 'POSIX recordings (no-pidfd termination, SIGTERM/SIGKILL sequence): this machine is Windows'] },
});
clearInterval(keepAlive);
for (const holder of gates) holder.kill();
rmSync(work, { recursive: true, force: true });
console.log('recorded shell-survivors');
process.exit(0);
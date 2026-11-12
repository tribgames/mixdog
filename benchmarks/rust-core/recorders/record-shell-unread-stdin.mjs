#!/usr/bin/env node
// Records what Node's shell tool answers when its PowerShell never reads the script it is fed on stdin: a stand-in
// `pwsh.exe` (native/core/crates/mixdog-app-server-daemon/src/testdata/unread_stdin_shell.rs, built here with rustc) prints
// a line, waits 30 s without reading its input and exits. A 1 MiB command fills the input pipe, so the helper's write
// blocks for as long as the shell lives. Node hands the helper the script (`stdinWrite`) without waiting for the write and
// starts its hold and run limit at once (`shell-run-spawn.mjs`), so a run limit ends the shell and the hold moves it to the
// background while the write still waits. Each call is `executeBuiltinTool('shell', input, ws)` through the native spawn
// server, warm standby off; the recorder checks each answer came before the stand-in's 30 s were up. The Rust replay makes
// the same calls with the same stand-in.
//
//   node benchmarks/rust-core/recorders/record-shell-unread-stdin.mjs --tree <git archive export of b6f10295a with the patch> \
//        --patch benchmarks/rust-core/recorders/node-patches/node-fix-partial-script.patch \
//        --spawn-bin <mixdog-spawn.exe built from that tree's native/mixdog-spawn>
//
// Output: native/core/fixtures/shell-unread-stdin/golden.json (+ MANIFEST.json). The background task's id is written as
// <TASK>, its start time as <TIME> and its log paths as <LOGS>.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const sandbox = mkdtempSync(join(tmpdir(), 'shell-unread-stdin-'));
const STANDIN_SOURCE = 'native/core/crates/mixdog-app-server-daemon/src/testdata/unread_stdin_shell.rs';
const standin = join(sandbox, 'standin', 'pwsh.exe');
mkdirSync(join(sandbox, 'standin'), { recursive: true });
// Built with this user's own toolchain, before the user dirs move to the sandbox.
execFileSync('rustc', ['-O', '-o', standin, fileURLToPath(new URL(`../../../${STANDIN_SOURCE}`, import.meta.url))], {
  stdio: 'inherit',
  timeout: 300_000,
});
// Import-time sweeps delete real user data: every user dir is a fresh temp dir first.
for (const key of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
  process.env[key] = join(sandbox, key.toLowerCase());
  mkdirSync(process.env[key], { recursive: true });
}
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
process.env.MIXDOG_SHELL_WARM_STANDBY = '0';
process.env.MIXDOG_TOOL_FAILURE_LOG_PATH = join(sandbox, 'failures.jsonl');
const { FIXTURES_ROOT, REPO_ROOT, commitStage, importFrom, nodeTreeIdentity, parseArgs, resolveTree, sha256, stageSet, within, writeJson, writeSetManifest } =
  await import('./lib/common.mjs');
const { recorderProvenance } = await import('./lib/provenance.mjs');

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const recorder = 'benchmarks/rust-core/recorders/record-shell-unread-stdin.mjs';
const STANDIN_LIFE_MS = 30_000;
const args = parseArgs();
const tree = resolveTree(args);
if (!args.get('patch')) throw new Error('pass --patch benchmarks/rust-core/recorders/node-patches/node-fix-partial-script.patch, the fix the tree carries');
const identity = nodeTreeIdentity(args, tree, NODE_COMMIT);
const spawnBin = args.get('spawn-bin');
if (!spawnBin) throw new Error('--spawn-bin <mixdog-spawn.exe of the patched tree> is required');

const { _setNativeSpawnBinaryForTest, shutdownNativeSpawnServer } = await importFrom(tree, 'src/runtime/agent/orchestrator/tools/lib/native-spawn-client.mjs');
_setNativeSpawnBinaryForTest(spawnBin);
const { setConfiguredShell } = await importFrom(tree, 'src/runtime/agent/orchestrator/tools/builtin/shell-runtime.mjs');
setConfiguredShell(standin);
const { executeBuiltinTool } = await importFrom(tree, 'src/runtime/agent/orchestrator/tools/builtin.mjs');
const { normalizeToolEnvelope } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/tool-envelope.mjs');

const ws = join(sandbox, 'ws');
mkdirSync(ws, { recursive: true });

// The warm-standby recorder's `sizedCommand`: `$PSScriptRoot` keeps it out of the long-command file transport.
function sizedCommand(size) {
  const head = "$null = $PSScriptRoot; $s = '";
  const tail = "'; Write-Output ('len|' + $s.Length)";
  return head + 'a'.repeat(size - head.length - tail.length) + tail;
}

const CASES = [
  { name: 'a run limit ends a shell that never reads its input', input: { size: 1048576, timeout_ms: 3000 } },
  { name: 'the hold moves a shell that never reads its input to the background', input: { size: 1048576, wait_ms: 1000 } },
];
const TASK_ID = /\bjob_\d+_[0-9a-f]+\b/g;
// What differs from run to run in the background answer: when the task started and where its logs are.
const view = (text) => text.replace(TASK_ID, '<TASK>').replace(/^started: .*$/m, 'started: <TIME>').replace(/^logs: .*$/m, 'logs: <LOGS>');

let code = 0;
try {
  const cases = [];
  for (const scenario of CASES) {
    const { size, ...rest } = scenario.input;
    const started = Date.now();
    const raw = await within(`running ${scenario.name}`, executeBuiltinTool('shell', { command: sizedCommand(size), ...rest }, ws));
    const elapsed = Date.now() - started;
    if (elapsed >= STANDIN_LIFE_MS) throw new Error(`${scenario.name}: answered after ${elapsed} ms, when the stand-in had ended`);
    const envelope = normalizeToolEnvelope(raw);
    cases.push({
      name: scenario.name,
      input: scenario.input,
      text: view(String(envelope.result ?? '')),
      isError: envelope.isError === true,
      answeredBeforeTheShellEnded: true,
    });
  }
  const finalDir = join(FIXTURES_ROOT, 'shell-unread-stdin');
  const stage = stageSet(finalDir);
  writeJson(join(stage, 'golden.json'), { domain: 'shell-unread-stdin', recorder, standin: STANDIN_SOURCE, standinLifeMs: STANDIN_LIFE_MS, cases });
  writeSetManifest(stage, {
    set: 'shell-unread-stdin',
    recorder,
    command: `node ${recorder} --tree <b6f10295a with the patch> --patch ${identity.patch.file} --spawn-bin <mixdog-spawn.exe of that tree>`,
    identity,
    extra: {
      ...recorderProvenance(import.meta.url),
      standin: STANDIN_SOURCE,
      standinSha256: sha256(readFileSync(join(REPO_ROOT, STANDIN_SOURCE))),
      exclusions: ['MIXDOG_SHELL_WARM_STANDBY=0: the stand-in is never parked'],
      normalized: ['cases[*].text: the background task id is <TASK>, its start time <TIME> and its log paths <LOGS>'],
    },
  });
  commitStage(stage, finalDir);
  console.log(`recorded ${cases.length} cases`);
  for (const scenario of cases) console.log(JSON.stringify(scenario.text));
} catch (error) {
  console.error(error);
  code = 1;
} finally {
  // Ending the spawn server ends the backgrounded stand-in (its job), which holds its executable in the sandbox.
  await shutdownNativeSpawnServer('recorder-finish');
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 10 });
}
process.exit(code);

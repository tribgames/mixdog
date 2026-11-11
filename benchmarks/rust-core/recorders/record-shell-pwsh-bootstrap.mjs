#!/usr/bin/env node
// Records what Node's shell tool answers for PowerShell commands whose output depends on the startup script every
// fresh pwsh run executes (`STANDBY_BOOTSTRAP`, `shell-warm-standby.mjs`, fed the command on stdin by
// `shell-run-spawn.mjs`): a parse error (`ParserError: <message>` in UTF-8), non-ASCII stdout and stderr, and an
// ordinary error record. Each case is `executeBuiltinTool('shell', input, ws)` through the native spawn server (the
// stdin delivery needs it), with the warm standby off so every call is a fresh spawn
// (`MIXDOG_SHELL_WARM_STANDBY=0`: a parked standby runs the same bootstrap). The Rust replay calls its shell tool with
// the same input and the same shell.
//
//   node benchmarks/rust-core/recorders/record-shell-pwsh-bootstrap.mjs --tree <git archive export of b6f10295a with the patch> \
//        --patch benchmarks/rust-core/recorders/node-patches/node-fix-partial-script.patch \
//        --spawn-bin <mixdog-spawn.exe built from that tree's native/mixdog-spawn> [--only <case name>]
//
// The patch fixes a Node bug: b6f10295a's bootstrap ran whatever part of a script had arrived when its input closed (the
// helper ignored a failed write and closed the input after it); the patched bootstrap runs a script only when the length
// its first line declares arrived. The fix's other half, in the helper (it ends the process before it closes the input
// after a failed write), is in the Node patch with the spawn binary built from it; no recorded call fails a write.
//
// Output: native/core/fixtures/shell-pwsh-bootstrap/golden.json (+ MANIFEST.json). With --only, that case is printed
// and nothing is written.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Import-time sweeps delete real user data: every user dir is a fresh temp dir first.
const sandbox = mkdtempSync(join(tmpdir(), 'shell-pwsh-bootstrap-'));
for (const key of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
  process.env[key] = join(sandbox, key.toLowerCase());
  mkdirSync(process.env[key], { recursive: true });
}
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
process.env.MIXDOG_SHELL_WARM_STANDBY = '0';
process.env.MIXDOG_TOOL_FAILURE_LOG_PATH = join(sandbox, 'failures.jsonl');
const { FIXTURES_ROOT, commitStage, importFrom, nodeTreeIdentity, orderedStringify, parseArgs, recordingProvenance, resolveTree, stageSet, within, writeJson, writeSetManifest } =
  await import('./lib/common.mjs');

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const recorder = 'benchmarks/rust-core/recorders/record-shell-pwsh-bootstrap.mjs';
const SHELL = 'pwsh';
const args = parseArgs();
const tree = resolveTree(args);
if (!args.get('patch')) throw new Error('pass --patch benchmarks/rust-core/recorders/node-patches/node-fix-partial-script.patch, the fix the tree carries');
const identity = nodeTreeIdentity(args, tree, NODE_COMMIT);
const only = args.get('only') ?? null;
const spawnBin = args.get('spawn-bin');
if (!spawnBin) throw new Error('--spawn-bin <mixdog-spawn.exe of the patched tree> is required');
const { _setNativeSpawnBinaryForTest } = await importFrom(tree, 'src/runtime/agent/orchestrator/tools/lib/native-spawn-client.mjs');
_setNativeSpawnBinaryForTest(spawnBin);
const { setConfiguredShell } = await importFrom(tree, 'src/runtime/agent/orchestrator/tools/builtin/shell-runtime.mjs');
setConfiguredShell(SHELL);
const { STANDBY_ARGS } = await importFrom(tree, 'src/runtime/agent/orchestrator/tools/lib/shell-warm-standby.mjs');
const { executeBuiltinTool } = await importFrom(tree, 'src/runtime/agent/orchestrator/tools/builtin.mjs');
const { normalizeToolEnvelope } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/tool-envelope.mjs');

const ws = join(sandbox, 'ws');
mkdirSync(ws, { recursive: true });

const CASES = [
  { name: 'a parse error with Korean text', input: { command: 'Write-Output "한글 출력 (' } },
  { name: 'non-ASCII stdout and stderr', input: { command: "Write-Output '표준 출력 한글 é'; [Console]::Error.WriteLine('표준 오류 한글 ü')" } },
  { name: 'an error record', input: { command: "Get-Item -LiteralPath 'Z:\\no-such\\파일.txt'" } },
];
const cases = CASES.filter((scenario) => !only || scenario.name === only);
if (!cases.length) throw new Error(`--only ${CASES.map((c) => c.name).join(' | ')}, got ${only}`);

async function record(scenario) {
  const raw = await within(`running ${scenario.name}`, executeBuiltinTool('shell', scenario.input, ws));
  const envelope = normalizeToolEnvelope(raw);
  return { name: scenario.name, input: scenario.input, text: String(envelope.result ?? ''), isError: envelope.isError === true };
}

let code = 0;
try {
  const recorded = [];
  for (const scenario of cases) recorded.push(await record(scenario));
  if (only) process.stdout.write(orderedStringify(recorded[0]));
  else {
    const finalDir = join(FIXTURES_ROOT, 'shell-pwsh-bootstrap');
    const stage = stageSet(finalDir);
    writeJson(join(stage, 'golden.json'), { domain: 'shell-pwsh-bootstrap', recorder, shell: SHELL, standbyArgs: STANDBY_ARGS, cases: recorded });
    writeSetManifest(stage, {
      set: 'shell-pwsh-bootstrap',
      recorder,
      command: `node ${recorder} --tree <b6f10295a with the patch> --patch ${identity.patch.file} --spawn-bin <mixdog-spawn.exe of that tree>`,
      identity,
      extra: {
        ...recordingProvenance(recorder, ['benchmarks/rust-core/recorders/lib/common.mjs']),
        exclusions: ['MIXDOG_SHELL_WARM_STANDBY=0: every call is a fresh spawn; a parked standby runs the same bootstrap'],
      },
    });
    commitStage(stage, finalDir);
    console.log(`recorded ${recorded.length} cases`);
  }
} catch (error) {
  console.error(error);
  code = 1;
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
// The native spawn server is a child of this process: ending it ends the server.
process.exit(code);

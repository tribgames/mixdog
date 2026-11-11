#!/usr/bin/env node
// Records what Node's shell tool answers when a PowerShell command runs in the warm standby (`shell-warm-standby.mjs`):
// cold calls park a standby; the next call, from a folder whose name needs the Base64 hand-off (a typographic
// apostrophe), runs in it and sees its folder for PowerShell and for .NET and the session's TEMP, and sets a global;
// the call after that runs in the next standby and does not see that global (a standby runs one command, then exits);
// a call from another folder does not use the standby parked for the first (its environment differs) and runs cold.
// Each call is `executeBuiltinTool('shell', input, ws)` through the native spawn server; before each warm call the
// recorder waits until a standby is parked, as a model's pace allows. The Rust replay makes the same calls.
//
//   node benchmarks/rust-core/recorders/record-shell-warm-standby.mjs --tree <git archive export of b6f10295a> \
//        --spawn-bin <mixdog-spawn.exe built from b6f10295a:native/mixdog-spawn>
//
// Output: native/core/fixtures/shell-warm-standby/golden.json (+ MANIFEST.json). Paths are written as <A>, <B> (the two
// folders) and <TEMP> (the TEMP the cold call printed).
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
// Import-time sweeps delete real user data: every user dir is a fresh temp dir first.
const sandbox = mkdtempSync(join(tmpdir(), 'shell-warm-standby-'));
for (const key of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
  process.env[key] = join(sandbox, key.toLowerCase());
  mkdirSync(process.env[key], { recursive: true });
}
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
delete process.env.MIXDOG_SHELL_WARM_STANDBY;
process.env.MIXDOG_TOOL_FAILURE_LOG_PATH = join(sandbox, 'failures.jsonl');
const { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, within, writeJson, writeSetManifest } =
  await import('./lib/common.mjs');
const { recorderProvenance } = await import('./lib/provenance.mjs');

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const recorder = 'benchmarks/rust-core/recorders/record-shell-warm-standby.mjs';
const SHELL = 'pwsh';
const args = parseArgs();
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, NODE_COMMIT);
const spawnBin = args.get('spawn-bin');
if (!spawnBin) throw new Error('--spawn-bin <mixdog-spawn.exe of b6f10295a> is required');
const { _setNativeSpawnBinaryForTest } = await importFrom(tree, 'src/runtime/agent/orchestrator/tools/lib/native-spawn-client.mjs');
_setNativeSpawnBinaryForTest(spawnBin);
const { setConfiguredShell } = await importFrom(tree, 'src/runtime/agent/orchestrator/tools/builtin/shell-runtime.mjs');
setConfiguredShell(SHELL);
const { _parkedShellStandbyForTest } = await importFrom(tree, 'src/runtime/agent/orchestrator/tools/lib/shell-warm-standby.mjs');
const { executeBuiltinTool } = await importFrom(tree, 'src/runtime/agent/orchestrator/tools/builtin.mjs');
const { normalizeToolEnvelope } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/tool-envelope.mjs');

const A = join(sandbox, 'ws-a it’s');
const B = join(sandbox, 'ws-b');
mkdirSync(A, { recursive: true });
mkdirSync(B, { recursive: true });

// The calls, in order: the folder each runs in and whether a parked standby is awaited first. A standby serves only the
// environment it was started with, which names the folder of the call that started it (`MIXDOG_SESSION_CWD`): the last
// call, from the other folder, finds a standby it cannot use, which is ended, and runs cold.
const CALLS = [
  { ws: 'A', parked: false, command: 'Write-Output "cold|$((Get-Location).ProviderPath)|$env:TEMP"' },
  // The first take can come before the spawn server's handshake, which a standby needs: a second call parks one.
  { ws: 'A', parked: false, command: 'Write-Output ready' },
  {
    ws: 'A',
    parked: true,
    command: '$global:mixdogMark = \'set\'; Write-Output "warm|$((Get-Location).ProviderPath)|$([System.Environment]::CurrentDirectory)|$env:TEMP"',
  },
  { ws: 'A', parked: true, command: 'Write-Output "next|[$global:mixdogMark]|$((Get-Location).ProviderPath)"' },
  { ws: 'B', parked: true, command: 'Write-Output "drift|$((Get-Location).ProviderPath)"' },
];
// Each command also prints its process id last, which tells whether it ran in the parked standby; the line is cut from
// the recorded text.
const PID_LINE = /\r?\npid\|(\d+)\s*$/;

async function parked() {
  for (let i = 0; i < 400; i += 1) {
    const pid = _parkedShellStandbyForTest()?.native.child.pid;
    if (pid > 0) return pid;
    await delay(50);
  }
  throw new Error('no standby was parked');
}

let code = 0;
try {
  const raw = [];
  for (const call of CALLS) {
    const parkedPid = call.parked ? await parked() : 0;
    const command = `${call.command}; Write-Output "pid|$PID"`;
    const result = await within(`running ${call.command}`, executeBuiltinTool('shell', { command }, call.ws === 'A' ? A : B));
    const envelope = normalizeToolEnvelope(result);
    const text = String(envelope.result ?? '');
    const pid = text.match(PID_LINE);
    if (!pid) throw new Error(`no pid line in ${JSON.stringify(text)}`);
    raw.push({
      ws: call.ws,
      parked: call.parked,
      taken: Number(pid[1]) === parkedPid,
      input: { command },
      text: text.replace(PID_LINE, ''),
      isError: envelope.isError === true,
    });
  }
  const temp = raw[0].text.split('|')[2].trim();
  const view = (text) => text.replaceAll(B, '<B>').replaceAll(A, '<A>').replaceAll(temp, '<TEMP>');
  const calls = raw.map((call) => ({ ...call, text: view(call.text) }));
  const finalDir = join(FIXTURES_ROOT, 'shell-warm-standby');
  const stage = stageSet(finalDir);
  writeJson(join(stage, 'golden.json'), { domain: 'shell-warm-standby', recorder, shell: SHELL, calls });
  writeSetManifest(stage, {
    set: 'shell-warm-standby',
    recorder,
    command: `node ${recorder} --tree <tree> --spawn-bin <mixdog-spawn.exe of b6f10295a>`,
    identity,
    extra: recorderProvenance(import.meta.url),
  });
  commitStage(stage, finalDir);
  console.log(`recorded ${calls.length} calls`);
  for (const call of calls) console.log(JSON.stringify(call.text));
} catch (error) {
  console.error(error);
  code = 1;
} finally {
  _parkedShellStandbyForTest()?.native.child.kill();
  rmSync(sandbox, { recursive: true, force: true });
}
// The native spawn server is a child of this process: ending it ends the server.
process.exit(code);

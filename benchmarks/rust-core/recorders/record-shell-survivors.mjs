#!/usr/bin/env node
// What the agent sees when a foreground shell command finishes but leaves a descendant running (Node's
// `probeShellDescendants` → survivors task), and after `task cancel` of it: the real Node shell and task
// tools run once, the task id and the two timestamps are replaced by placeholders. Windows form of the
// command (the host this was recorded on); the descendant is a hidden `ping` that would run 90 s.
//
//   node benchmarks/rust-core/recorders/record-shell-survivors.mjs --tree <dir> --spawn-bin <mixdog-spawn binary>
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
if (process.platform !== 'win32') throw new Error('the recorded command is the Windows form');
const work = mkdtempSync(join(tmpdir(), 'mixdog-survivors-golden-'));
process.env.MIXDOG_DATA_DIR = join(work, 'data');
const { _setNativeSpawnBinaryForTest } = await importFrom(tree, 'src/runtime/agent/orchestrator/tools/lib/native-spawn-client.mjs');
_setNativeSpawnBinaryForTest(args.get('spawn-bin'));
const { executeBuiltinTool } = await importFrom(tree, 'src/runtime/agent/orchestrator/tools/builtin.mjs');
const { normalizeToolEnvelope } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/tool-envelope.mjs');

const ws = join(work, 'ws');
mkdirSync(ws, { recursive: true });
const command = "Start-Process ping -ArgumentList '-n','90','127.0.0.1' -WindowStyle Hidden";
const text = async (tool, input) => {
  const env = normalizeToolEnvelope(await executeBuiltinTool(tool, input, ws));
  return String(env.result ?? '');
};
const ran = await text('shell', { command });
const id = /task_id: (\S+)/.exec(ran)[1];
const cancelled = await text('task', { action: 'cancel', task_id: id });
const read = await text('task', { action: 'read', task_id: id });
const scrub = (t) => t.replaceAll(id, '<TASK>').replace(/(started|finished): \S+/g, '$1: <TIME>');
const dir = join(FIXTURES_ROOT, 'shell-survivors');
mkdirSync(dir, { recursive: true });
writeJson(join(dir, 'golden.json'), {
  recorder: 'benchmarks/rust-core/recorders/record-shell-survivors.mjs',
  nodeCommit: 'b6f10295a',
  platform: 'win32',
  command,
  shell: scrub(ran),
  cancel: scrub(cancelled),
  read: scrub(read),
});
rmSync(work, { recursive: true, force: true });
console.log('recorded shell-survivors');
process.exit(0);
import '../../../../../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { executeBuiltinTool } from '../builtin.mjs';

// The 1.8 s bound is the tool's own deadline (a slow part is reported as
// unavailable); a wall-clock assertion here measured the machine, not the tool.
test('machine reports CPU, memory, drives and top processes', async () => {
  const out = String(await executeBuiltinTool('machine', { top: 3 }, process.cwd()));
  assert.match(out, /^cpu: \d+% busy of \d+ cores/m);
  assert.match(out, /^memory: [\d.]+ GB available of [\d.]+ GB \(\d+% used\)$/m);
  assert.match(out, /^top by cpu:\n(?:  .+\n){1,3}top by memory:\n(?:  .+\n?){1,3}|^processes: unavailable/m);
  assert.match(out, /^drives \(free of total\):\n  \S.* [\d.]+ GB of [\d.]+ GB/m);
  assert.doesNotMatch(out, /matching/);
});

test('machine refuses an overlong process name and never echoes control characters', async () => {
  const long = String(await executeBuiltinTool('machine', { process: 'x'.repeat(100000) }, process.cwd()));
  assert.match(long, /^Error: machine process must be at most 128 characters/);
  assert.ok(long.length < 200, `${long.length} bytes`);
  const out = String(await executeBuiltinTool('machine', { process: 'no\nsuch\u001b[31m-name' }, process.cwd()));
  assert.doesNotMatch(out, /[\u001b\r]|no\nsuch/);
  if (!/^processes: unavailable/m.test(out)) assert.match(out, /^processes matching "no such \[31m-name" \(0\):/m);
});

test('machine lists the processes matching a name and bounds the lists', async () => {
  const out = String(await executeBuiltinTool('machine', { process: 'node', top: 1 }, process.cwd()));
  // On a machine too loaded to list processes in time the answer says so instead of waiting.
  if (/^processes: unavailable/m.test(out)) return;
  assert.match(out, /^processes matching "node" \(\d+\):\n  node(?:\.exe)? \(pid \d+\)/m);
  assert.equal((out.split('top by cpu:\n')[1].split('top by memory:')[0].match(/^ {2}\S/gm) ?? []).length, 1);
  const none = String(await executeBuiltinTool('machine', { process: 'no-such-process-name' }, process.cwd()));
  if (!/^processes: unavailable/m.test(none)) assert.match(none, /^processes matching "no-such-process-name" \(0\):\n  none$/m);
});

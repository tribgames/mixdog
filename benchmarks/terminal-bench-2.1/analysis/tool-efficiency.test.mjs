import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

test('efficiency report separates unmet loads, command failures, and successful recovery trials', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-efficiency-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agent = join(root, 'date', 'task__trial', 'agent');
  mkdirSync(agent, { recursive: true });
  const rows = [
    { id: 'load', name: 'load_tool', arguments: { names: 'git' }, output: 'Loaded deferred tools:\nmissing: git' },
    { id: 'python', name: 'shell', arguments: { command: 'python3 script.py' }, output: 'No interpreter' },
    { id: 'node', name: 'shell', arguments: { command: 'node script.js' }, output: 'done' },
  ].map((item) => ({ type: 'item.completed', item: { type: 'tool_call', status: 'completed', ...item } }));
  writeFileSync(join(agent, 'mixdog.txt'), rows.map((row) => JSON.stringify(row)).join('\n'));
  writeFileSync(join(agent, 'agent-trace.jsonl'), JSON.stringify({
    kind: 'shell_output', payload: { tool_call_id: 'python', exit_code: 127 },
  }));
  writeFileSync(join(root, 'date', 'task__trial', 'result.json'),
    JSON.stringify({ verifier_result: { rewards: { reward: 1 } } }));
  const output = join(root, 'metrics.json');
  execFileSync(process.execPath, [
    fileURLToPath(new URL('./tool-efficiency.mjs', import.meta.url)), root, '--json', output,
  ]);
  const [report] = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(report.tools.load_tool.unfulfilled, 1);
  assert.equal(report.tools.load_tool.toolFailures, 0);
  assert.equal(report.tools.shell.commandFailures, 1);
  assert.equal(report.tools.shell.ok, 1);
  assert.equal(report.completedTrialsWithIssues, 1);
  assert.equal(report.failChains.recovered, 0);
  assert.equal(report.failChains.unresolved, 2);
});

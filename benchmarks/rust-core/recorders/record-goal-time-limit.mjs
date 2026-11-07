#!/usr/bin/env node
// The create budget of the model-facing `goal` tool: Node's own `executeGoalTool` (goal-tool-exec.mjs) runs `create`
// over `time_limit_minutes` values on both sides of every check, `Number()` coercion and the minutes-to-ms overflow
// included (1e308 minutes is a finite number whose product with 60000 is Infinity: `parseGoalDuration` answers
// "goal duration must be positive", not "exceeds 7 days"). The Goal store behind it is a stub that records the
// `timeLimitMs` it is handed, so only the tool's own validation is recorded. Rust `mixdog-tools` `time_limit_ms` must equal it.
//
//   node benchmarks/rust-core/recorders/record-goal-time-limit.mjs --tree <tree w/ node_modules>
// Output: native/core/fixtures/goal-time-limit/golden.json
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const { executeGoalTool } = await importFrom(tree, 'src/runtime/agent/orchestrator/runtime-core/goal-tool-exec.mjs');

// `undefined` marks a call that carries no `time_limit_minutes` at all.
const VALUES = [
  undefined, null, '', 1, 0.5, 2.5, 10080, 10080.4, 10081, 20000, 0, -5, 5e-6, 8.3e-6, '5', ' 5 ', '0x10', '1e2', 'x', true, false, [2], [], {},
  1e303, 1e304, 1e305, 1e308, 1.7976931348623157e308, -1e308, 5e-324,
];

let handed;
const ctx = {
  withMutation: (_id, work) => work(),
  createGoal: (_id, options) => {
    handed = options;
    return { id: 'g', status: 'active', timeUsedMs: 0, remainingMs: options.timeLimitMs ?? null };
  },
};

const cases = [];
for (const value of VALUES) {
  const input = { action: 'create', objective: 'x' };
  if (value !== undefined) input.time_limit_minutes = value;
  handed = undefined;
  const row = { args: value === undefined ? {} : { time_limit_minutes: value } };
  try {
    await executeGoalTool(ctx, 'goal', input, { sessionId: 's1' });
    if (handed.timeLimitMs !== undefined) row.timeLimitMs = handed.timeLimitMs;
  } catch (error) {
    row.error = error.message;
  }
  cases.push(row);
}

const finalOut = join(FIXTURES_ROOT, 'goal-time-limit');
const out = stageSet(finalOut);
writeJson(join(out, 'golden.json'), {
  note: 'executeGoalTool create over time_limit_minutes: the budget handed to the Goal store (absent when none), or the refusal text',
  cases,
});
writeSetManifest(out, {
  set: 'goal-time-limit',
  recorder: 'benchmarks/rust-core/recorders/record-goal-time-limit.mjs',
  command: 'node benchmarks/rust-core/recorders/record-goal-time-limit.mjs --tree <tree>',
  extra: { cases: cases.length },
});
commitStage(out, finalOut);
console.log(`cases=${cases.length}`);

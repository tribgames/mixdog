#!/usr/bin/env node
// Genuine 1.4.5 session todo state: Node's own `todoPhases` / `todoSnapshot` over stored `session.todo`
// records (stored records are untrusted), and what `executeTodoTool` (commitPhases) and `clearTodo`
// leave on the session record (`todo`, `updatedAt`). The Rust `ThreadTodos` over the session header
// must read and write the same.
//
//   node benchmarks/rust-core/recorders/record-todo-list.mjs --tree <tree w/ node_modules>
// Output: native/core/fixtures/todo-list/golden.json
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const { todoPhases, todoSnapshot, executeTodoTool, clearTodo } = await importFrom(tree, 'src/runtime/agent/orchestrator/runtime-core/todo-list.mjs');

const AT = 1234567;
const realNow = Date.now;
Date.now = () => AT;

const stored = [
  { name: 'whitespace and statuses', todo: { updatedAt: 41, phases: [
    { name: '  Build \n step ', tasks: [
      { content: ' Write\t the  code ', status: 'blocked', blocker: 'waiting' },
      { content: 'Ship', status: 'completed', note: '  all\n done ' },
      { content: '   ', status: 'pending' },
      { status: 'pending' },
      'stray',
      { content: 'Dropped', status: 'abandoned' },
    ] },
    { name: '', tasks: [{ content: 'Loose', status: 'in_progress', note: ' ' }] },
    { name: 'Empty', tasks: [] },
    { name: 'Bad' },
  ] } },
  { name: 'no record', todo: undefined },
  { name: 'null record', todo: null },
  { name: 'phases not an array', todo: { phases: 'x' } },
  { name: 'empty phases', todo: { phases: [] } },
  { name: 'a string record', todo: 'x' },
  { name: 'nameless phase', todo: { phases: [{ tasks: [{ content: 'A', status: 'pending' }] }] } },
];
const reads = stored.map(({ name, todo }) => {
  const session = { id: 's', todo };
  return { name, todo: todo === undefined ? null : todo, phases: todoPhases(session), snapshot: todoSnapshot(session) };
});

const commits = [];
const run = (name, todo, toolArgs) => {
  const session = { id: 's', todo: todo ?? null, updatedAt: 1 };
  let reply;
  let error = null;
  try { reply = executeTodoTool(session, toolArgs); } catch (e) { error = e.message; }
  commits.push({ name, before: todo ?? null, args: toolArgs, reply: reply ?? null, error, after: { todo: session.todo, updatedAt: session.updatedAt } });
};
run('init from items', null, { op: 'init', items: ['A', 'B'] });
run('init phases', null, { op: 'init', phases: [{ name: 'P1', items: ['a', 'b'] }, { name: 'P2', items: ['c'] }] });
const two = { updatedAt: 5, phases: [{ name: 'Tasks', tasks: [{ content: 'A', status: 'in_progress' }, { content: 'B', status: 'pending' }] }] };
run('done moves the start on', two, { op: 'done', item: 'A', note: 'ok' });
run('drop', two, { op: 'drop', item: 'B' });
run('append to the last phase', two, { op: 'append', items: ['C'] });
run('rm', two, { op: 'rm', item: 'B' });
run('refused: unknown item', two, { op: 'start', item: 'Z' });
run('refused: init over unfinished', two, { op: 'init', items: ['X'] });
run('refused: empty list', null, { op: 'done', item: 'A' });

const cleared = { id: 's', todo: two, updatedAt: 1 };
clearTodo(cleared);
Date.now = realNow;

const finalOut = join(FIXTURES_ROOT, 'todo-list');
const out = stageSet(finalOut);
writeJson(join(out, 'golden.json'), {
  note: 'todoPhases/todoSnapshot over stored records; executeTodoTool and clearTodo results with Date.now frozen at `at`',
  at: AT,
  reads,
  commits,
  cleared: { before: two, after: { todo: cleared.todo, updatedAt: cleared.updatedAt } },
});
writeSetManifest(out, {
  set: 'todo-list',
  recorder: 'benchmarks/rust-core/recorders/record-todo-list.mjs',
  command: 'node benchmarks/rust-core/recorders/record-todo-list.mjs --tree <tree>',
  extra: { reads: reads.length, commits: commits.length },
});
commitStage(out, finalOut);
console.log(`reads=${reads.length} commits=${commits.length}`);

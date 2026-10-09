import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveToolCardModel } from './tool-card-model.mjs';
import { summarizeToolResult } from './tool-result-summary.mjs';
import { aggregateToolCategoryEntry, formatToolSurface } from './tool-surface.mjs';

const C = (name, args, result, extra = {}) => deriveToolCardModel({ name, args, result, rawResult: result, ...extra });
const FAILED = { isError: true, callErrorCount: 1 };
const unit = (name, args) => {
  const { done, noun } = aggregateToolCategoryEntry(name, args);
  return `${done} ${noun}`;
};

test('agent cards are call, check or response, never decided by result content', () => {
  const envelope = 'agent task: t\nstatus: completed\nagent: reviewer\n\n### finding';
  assert.equal(C('agent', { type: 'status', tag: 'review-x' }, envelope).labelText, 'Status Reviewer (review-x)');
  assert.equal(C('agent', { type: 'read', tag: 'review-x' }, envelope).labelText, 'Read Reviewer (review-x)');
  assert.equal(C('agent', { type: 'list' }, 'agents: 1\n- a').labelText, 'Agent status');
  const diagnostic = 'agent task: t\nstatus: running\nworker_stage: reading\n\nworker_stage: reading';
  assert.equal(C('agent', { type: 'status', tag: 'x', agent: 'worker' }, diagnostic).labelText, 'Status Worker (x)');
  for (const [type, verb] of [['spawn', 'Spawn'], ['send', 'Send'], ['close', 'Close'], ['cancel', 'Cancel'], ['cleanup', 'Cleanup']]) {
    assert.equal(C('agent', { type, agent: 'worker', prompt: 'p' }, 'queued reply text').labelText, `${verb} Worker`);
  }
  const notification =
    '<task-notification>\n<task-id>t</task-id>\n<tag>x</tag>\n<status>completed</status>\n<summary>Agent "x" completed</summary>\n<result>\nall good\n</result>\n</task-notification>';
  assert.equal(C('agent', { type: 'result', agent: 'worker', tag: 'x' }, notification).labelText, 'Response Worker (x)');
});

test('terminal status comes from the head envelope, never from file content', () => {
  assert.equal(C('read', { file_path: 'a.ts' }, 'text\n\n<status>failed</status>').terminalStatus, 'completed');
  assert.equal(C('read', { file_path: 'a.ts' }, 'status: failed\nbody').terminalStatus, 'completed');
  assert.equal(C('task', { action: 'read', task_id: 't' }, 'status: failed\ntask_id: t').terminalStatus, 'failed');
  assert.equal(C('task', { action: 'read', task_id: 't' }, 'status: completed\ntask_id: t', FAILED).terminalStatus, 'failed');
});

test('media parses the job outcome and tells a status read from the job state', () => {
  const failed = C('media', { action: 'status', job: 'j' }, '{"ok":false,"job":"j","status":"failed","error":"quota"}');
  assert.equal(failed.terminalStatus, 'failed');
  assert.equal(failed.detailLine, 'Failed · quota');
  const running = C('media', { action: 'status', job: 'j' }, '{"ok":true,"job":"j","status":"running"}');
  assert.equal(running.terminalStatus, 'completed');
  assert.equal(running.detailLine, 'Job running');
  const cancelled = C('media', { action: 'cancel', job: 'j' }, '{"ok":true,"job":"j","status":"canceled","canceled":true}');
  assert.equal(cancelled.terminalStatus, 'cancelled');
  assert.equal(cancelled.labelText, 'Cancelled 1 media job');
});

test('failed calls keep their cause', () => {
  const spawn = C('agent', { type: 'spawn', agent: 'worker', prompt: 'Inspect the code' }, 'Error: permission denied', FAILED);
  assert.equal(spawn.detailLine, 'Failed · permission denied');
  const read = C('read', { file_path: 'missing.ts' }, 'Error: file not found', FAILED);
  assert.equal(read.detailLine, 'Failed · file not found');
});

test('browser args summarize identically as an object or a JSON string', () => {
  const args = { action: 'click', input: { ref: 'e1', tab: 2 } };
  assert.equal(formatToolSurface('browser', args).summary, 'click · e1 (tab 2)');
  assert.equal(formatToolSurface('browser', JSON.stringify(args)).summary, 'click · e1 (tab 2)');
  const devtools = { action: 'cookies', input: { operation: 'clear' } };
  assert.equal(formatToolSurface('browser_devtools', devtools).summary, 'cookies clear');
  assert.equal(formatToolSurface('browser_devtools', JSON.stringify(devtools)).summary, 'cookies clear');
});

test('task control keeps its verbs and a queued envelope reads Queued', () => {
  const body = 'status: completed\ntask_id: t\ncancelled: shell/run';
  assert.equal(C('task', { action: 'cancel', task_id: 't' }, body).labelText, 'Cancel task');
  const wait = 'background task\ntask_id: t\nsurface: web_search\nstatus: completed\n\nresult text';
  assert.equal(C('task', { action: 'wait', task_id: 't' }, wait).labelText, 'Wait for task');
  assert.equal(C('task', { action: 'list' }, 'tasks: 0').labelText, 'List tasks');
  assert.equal(C('task', { action: 'read', task_id: 't' }, 'background task\ntask_id: t\nsurface: shell\nstatus: queued').labelText, 'Read task');
  const queued = C('shell', { command: 'x' }, 'background task\ntask_id: t\nsurface: shell\nstatus: queued');
  assert.equal(queued.labelText, 'Queued Shell');
});

test('work units are action-aware', () => {
  for (const action of ['snapshot', 'get', 'query', 'describe', 'detect', 'issues', 'qa', 'validate', 'render', 'diff', 'transactions']) {
    assert.match(unit('office', { action }), /^Read /, action);
  }
  assert.match(unit('office', { action: 'batch' }), /^Edited /);
  assert.match(unit('memory', { op: 'delete', id: 1 }), /^Deleted /);
  assert.match(unit('tidy', { action: 'fix', apply: false }), /^Previewed /);
  assert.match(unit('tidy', { action: 'fix', apply: true }), /^Tidied /);
  assert.match(unit('tidy', { action: 'install' }), /^Installed /);
  assert.equal(unit('cwd', { action: 'set', path: '/x' }), 'Selected project');
  assert.equal(unit('cwd', { path: '/x' }), 'Selected project');
  assert.match(unit('cwd', { action: 'list' }), /^Listed /);
  assert.match(unit('media', { action: 'cancel', job: 'j' }), /^Cancelled /);
  assert.equal(C('office', { action: 'snapshot', path: 'a.docx' }, 'ok').labelText, 'Read 1 document action');
});

test('failed effects do not claim success', () => {
  const load = C('load_tool', { names: ['browser'] }, 'Error: Tool not found', FAILED);
  assert.equal(load.labelText, 'Failed while loading browser');
  const patch = '*** Begin Patch\n*** Add File: a.ts\n+x\n*** End Patch';
  assert.equal(C('apply_patch', { patch }, 'Error: bad', FAILED).labelText, 'Failed while creating 1 file');
  assert.equal(C('apply_patch', { patch }, 'Created: a.ts').labelText, 'Created 1 file');
  const aggregate = deriveToolCardModel({
    aggregate: true,
    isError: true,
    count: 1,
    completedCount: 1,
    errorCount: 1,
    categories: {},
    doneCategories: {
      k: { category: 'Patch', active: 'Creating', done: 'Created', noun: 'file', pluralNoun: 'files', count: 1, effect: true },
    },
  });
  assert.equal(aggregate.labelText, 'Failed while creating 1 file');
  assert.equal(aggregate.detailLine, 'Failed');
});

test('read ranges are one-based', () => {
  assert.equal(C('read', { file_path: 'a.ts', offset: 10, limit: 2 }, 'x').summaryText, 'a.ts · lines 10-11');
});

test('grep summaries count what the mode returns', () => {
  const grep = (args, text) => summarizeToolResult('grep', args, text);
  assert.equal(grep({ pattern: 'x', output_mode: 'count' }, 'a.ts:10\nb.ts:20'), '30 matches in 2 files');
  assert.equal(grep({ pattern: 'x', output_mode: 'files_with_matches' }, 'a.ts\nb.ts'), '2 files');
  assert.equal(grep({ pattern: 'x' }, '# a.ts:1 [lines 1-3]\n1:x\n2- y\n3- z\n\n# b.ts:3 [lines 3-4]\n3:x'), '2 matches');
});

test('code_graph recognises symbol_search and keeps scalar or array targets', () => {
  assert.equal(formatToolSurface('code_graph', { mode: 'symbol_search', symbols: 'run' }).label, 'Search');
  assert.equal(formatToolSurface('code_graph', { mode: 'overview', files: 'src/a.ts' }).summary, 'overview · a.ts');
  assert.equal(formatToolSurface('code_graph', { mode: 'callers', symbols: ['a', 'b'] }).summary, 'callers · a, b');
});

test('a shell is never "Verified" without explicit provenance', () => {
  assert.equal(C('shell', { command: 'npm test' }, '[exit 0]').labelText, 'Ran 1 command');
});

test('terminal is its own unit with action verbs', () => {
  assert.equal(C('terminal', { action: 'list' }, 'ok').labelText, 'Listed 1 terminal tab');
  assert.equal(C('terminal', { action: 'read', tab: 1 }, 'ok').labelText, 'Read 1 terminal output');
  assert.equal(aggregateToolCategoryEntry('terminal', { action: 'list' }).category, 'Terminal');
});

test('public-schema formatters name the action and its target', () => {
  assert.equal(
    formatToolSurface('github', { action: 'issue.create', repo: 'owner/repo', title: 'Bug' }).summary,
    'Create issue owner/repo · Bug'
  );
  assert.equal(
    formatToolSurface('github', { action: 'run.cancel', repo: 'owner/repo', id: 42 }).summary,
    'Cancel run 42 · owner/repo'
  );
  assert.equal(formatToolSurface('setup', { action: 'set_workflow', workflow: 'default' }).summary, 'set_workflow · default');
  assert.equal(formatToolSurface('goal', { action: 'create', objective: 'Ship it' }).summary, 'create · Ship it');
  assert.equal(formatToolSurface('recall', { id: [1, 2] }).summary, '#1, #2');
  assert.equal(formatToolSurface('recall', { query: 'auth' }).summary, '"auth"');
  assert.equal(formatToolSurface('git', { action: 'stage', change_ids: ['a', 'b'] }).summary, '2 changes');
});

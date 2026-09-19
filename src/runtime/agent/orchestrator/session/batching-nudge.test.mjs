import test from 'node:test';
import assert from 'node:assert/strict';
import { observeToolBatchForNudge, batchingNudgeMessage } from './batching-nudge.mjs';
import { processToolBatch } from './tool-batch.mjs';

const tools = [
  { name: 'read', annotations: { readOnlyHint: true } },
  { name: 'grep', annotations: { readOnlyHint: true } },
  { name: 'glob', annotations: { readOnlyHint: true } },
  { name: 'git', annotations: { readOnlyHint: false } },
  { name: 'edit', annotations: { readOnlyHint: false } },
  { name: 'task', annotations: { readOnlyHint: true } },
];
let nextId = 0;
const call = (name, args) => ({ id: `${name}-${++nextId}`, name, arguments: args });
const round = (sessionRef, calls, results) =>
  observeToolBatchForNudge({ sessionRef, calls, results: results ?? calls.map(() => 'ok'), tools });

test('three single calls of one tool in a row earn one reminder naming the surface arrays', () => {
  const session = {};
  assert.equal(round(session, [call('grep', { pattern: 'a' })]), null);
  assert.equal(round(session, [call('grep', { pattern: 'b' })]), null);
  // A different tool restarts the streak: read → shell → edit is a workflow.
  assert.equal(round(session, [call('shell', { command: 'node --version' })]), null);
  assert.deepEqual(session.batchingNudge.serial, ['shell']);
  round(session, [call('grep', { pattern: 'c' })]);
  round(session, [call('grep', { pattern: 'd' })]);
  const nudge = round(session, [call('grep', { pattern: 'e' })]);
  assert.equal(nudge.trigger, 'serial_calls');
  assert.deepEqual(nudge.tools, ['grep', 'grep', 'grep']);
  assert.match(nudge.text, /last 3 rounds were single calls \(grep, grep, grep\)/);
  assert.match(nudge.text, /read\.file_path\[\], grep\.pattern\[\]\/path\[\], glob\.pattern\[\], git\.command\[\]/);
  assert.doesNotMatch(nudge.text, /code_graph/);
  const message = batchingNudgeMessage(nudge);
  assert.equal(message.role, 'user');
  assert.ok(message.content.startsWith('<system-reminder>\n'));
  assert.ok(message.content.endsWith('\n</system-reminder>'));
  assert.deepEqual(message.meta, { source: 'batching-nudge' });
  assert.equal(session.batchingNudge.nudges, 1);
  assert.deepEqual(session.batchingNudge.serial, []);
});

test('only a call that did not need the previous round counts: provenance or a mutation before it restarts the streak', () => {
  // The grep result names the file the next read targets, and the read's
  // content supplies the edit's old_string: ordered steps, not wasted rounds.
  const ordered = {};
  round(ordered, [call('grep', { pattern: 'observe', path: 'src' })], ['src/session/nudge.mjs:12: observe()']);
  round(ordered, [call('read', { file_path: 'src/session/nudge.mjs' })], ['export function observe() {}']);
  assert.deepEqual(ordered.batchingNudge.serial, ['read']);
  round(
    ordered,
    [
      call('edit', {
        file_path: 'src/session/nudge.mjs',
        old_string: 'observe() {}',
        new_string: 'observe() { return 1; }',
      }),
    ],
    ['Updated src/session/nudge.mjs (1 replacement)']
  );
  assert.deepEqual(ordered.batchingNudge.serial, ['edit']);
  // Verification after a mutation is ordered behind it; the checks after that are not.
  round(ordered, [call('shell', { command: 'node --test src/session/nudge.test.mjs' })], ['# pass 3']);
  assert.deepEqual(ordered.batchingNudge.serial, ['shell']);
  round(ordered, [call('shell', { command: 'npx biome check src' })], ['Checked 12 files']);
  const nudge = round(ordered, [call('shell', { command: 'node --check src/session/nudge.mjs' })], ['']);
  assert.equal(nudge.trigger, 'serial_calls');
  assert.deepEqual(nudge.tools, ['shell', 'shell', 'shell']);
  assert.match(nudge.text, /did not need the previous result/);

  // A scope carried over from the previous call is not provenance.
  const scoped = {};
  round(scoped, [call('grep', { pattern: 'alpha', path: 'src' })], ['src/a.mjs:1: alpha']);
  round(scoped, [call('grep', { pattern: 'beta', path: 'src' })], ['src/b.mjs:1: beta']);
  assert.equal(
    round(scoped, [call('grep', { pattern: 'gamma', path: 'src' })], ['src/c.mjs:1: gamma']).trigger,
    'serial_calls'
  );
  round(scoped, [call('read', { file_path: 'src/a.mjs', offset: 1, limit: 100 })], ['const x = 1;']);
  round(scoped, [call('read', { file_path: 'src/a.mjs', offset: 200, limit: 100 })], ['const y = 2;']);
  assert.deepEqual(scoped.batchingNudge.serial, ['read', 'read']);

  // Edits after edits batch unless one targets text the previous edit created.
  const edits = {};
  round(edits, [call('edit', { file_path: 'src/a.mjs', old_string: 'one', new_string: 'uno' })], ['Updated src/a.mjs']);
  round(
    edits,
    [call('edit', { file_path: 'src/a.mjs', old_string: 'three', new_string: 'tres' })],
    ['Updated src/a.mjs']
  );
  const reminder = round(
    edits,
    [call('edit', { file_path: 'src/c.mjs', old_string: 'five', new_string: 'cinco' })],
    ['Updated src/c.mjs']
  );
  assert.deepEqual(reminder.tools, ['edit', 'edit', 'edit']);
  assert.match(reminder.text, /Edits to different files or regions go together too/);
  round(edits, [call('edit', { file_path: 'src/a.mjs', old_string: 'uno', new_string: 'uno dos' })], ['Updated']);
  assert.equal(
    round(edits, [call('edit', { file_path: 'src/a.mjs', old_string: 'uno dos', new_string: 'x' })], ['Updated']),
    null
  );
  assert.deepEqual(edits.batchingNudge.serial, ['edit']);

  // Task waits and one-per-turn tools clear the streak. An array inside a
  // single call does not: it merges targets of one tool, and the round could
  // still have joined the previous one (the recorded Gemini review alternated
  // one- and two-command git rounds for 15 rounds without ever earning it).
  const cleared = {};
  round(cleared, [call('git', { command: 'git status' })], ['M src/a.mjs']);
  round(cleared, [call('git', { command: 'git diff' })], ['diff --git']);
  assert.deepEqual(cleared.batchingNudge.serial, ['git', 'git']);
  assert.equal(
    round(cleared, [call('git', { command: ['git log -1', 'git branch'] })], ['abc']).trigger,
    'serial_calls'
  );
  assert.deepEqual(cleared.batchingNudge.serial, []);
  round(cleared, [call('read', { file_path: ['src/a.mjs', 'src/b.mjs'] })]);
  assert.deepEqual(cleared.batchingNudge.serial, ['read']);
  round(cleared, [call('read', { file_path: 'src/c.mjs' })]);
  assert.equal(round(cleared, [call('task', { action: 'wait', task_id: 't' })]), null);
  assert.deepEqual(cleared.batchingNudge.serial, []);
  round(cleared, [call('read', { file_path: 'src/a.mjs' })]);
  round(cleared, [call('read', { file_path: 'src/b.mjs' })]);
  assert.equal(round(cleared, [call('computer', { action: 'screenshot' })]), null);
  assert.deepEqual(cleared.batchingNudge.serial, []);
  assert.equal(cleared.batchingNudge.nudges, 1);
});

test('a name a file list revealed rounds ago is not provenance when the model walks the list one item per round', () => {
  // The recorded Gemini review: one `git diff --name-only`, then one diff per
  // round; the third diff's target was named by the list three rounds back
  // and happened to appear in the previous diff too.
  const session = {};
  round(session, [call('git', { command: 'git diff --name-only' })], ['CHANGELOG.md\nREADME.md\nsrc/a.mjs\nsrc/b.mjs']);
  round(session, [call('git', { command: 'git diff CHANGELOG.md' })], ['+ Batching reminders.']);
  assert.deepEqual(session.batchingNudge.serial, ['git']);
  round(session, [call('git', { command: 'git diff README.md' })], ['+ See src/a.mjs for the nudge.']);
  assert.deepEqual(session.batchingNudge.serial, ['git', 'git']);
  const nudge = round(session, [call('git', { command: 'git diff src/a.mjs' })], ['+ export function nudge() {}']);
  assert.equal(nudge.trigger, 'serial_calls');
});

test('a scope prefix in the previous result and names known before that round are not provenance', () => {
  // The recorded Gemini chain: callers → redundant grep on the same symbol →
  // symbols of a file the round before last had already named.
  const session = {};
  round(
    session,
    [call('code_graph', { mode: 'callers', symbols: 'processToolBatch' })],
    ['src/runtime/session/agent-loop.mjs:524 caller=agentLoop']
  );
  round(
    session,
    [call('code_graph', { mode: 'references', symbols: 'processToolBatch' })],
    ['src/runtime/session/agent-loop.mjs:524: await processToolBatch(']
  );
  assert.deepEqual(session.batchingNudge.serial, ['code_graph', 'code_graph']);
  const nudge = round(
    session,
    [call('code_graph', { mode: 'symbols', files: 'src/runtime/session/agent-loop.mjs' })],
    ['export function agentLoop (L79-587)']
  );
  assert.equal(nudge.trigger, 'serial_calls');
  assert.deepEqual(nudge.tools, ['code_graph', 'code_graph', 'code_graph']);
  // A file the previous result revealed for the first time is provenance.
  round(
    session,
    [call('code_graph', { mode: 'callers', symbols: 'agentLoop' })],
    ['src/runtime/session/manager/runtime-loaders.mjs:40 caller=loadRuntime']
  );
  round(session, [call('read', { file_path: 'src/runtime/session/manager/runtime-loaders.mjs' })], ['// loaders']);
  assert.deepEqual(session.batchingNudge.serial, ['read']);
  // A whole-token mention counts even when the result names it only in a path.
  round(
    session,
    [call('grep', { pattern: 'loadRuntime' })],
    ['src/runtime/session/manager/index.mjs:9: loadRuntime()']
  );
  round(session, [call('read', { file_path: 'src/runtime/session/manager/index.mjs' })], ['export {}']);
  assert.deepEqual(session.batchingNudge.serial, ['read']);
});

test('a route round-reminder is appended verbatim after every single-call round that did not batch', () => {
  const REMINDER = 'Batching: every call the task still needs goes in your next response together.';
  const reminded = (sessionRef, calls, results) =>
    observeToolBatchForNudge({
      sessionRef,
      calls,
      results: results ?? calls.map(() => 'ok'),
      tools,
      reminder: REMINDER,
    });
  const session = {};
  const first = reminded(session, [call('grep', { pattern: 'alpha' })]);
  assert.equal(first.trigger, 'per_round');
  assert.deepEqual(first.tools, ['grep']);
  assert.equal(first.text, REMINDER);
  // Another tool that took nothing from the previous result still gets the
  // line; the serial streak restarts underneath.
  assert.equal(reminded(session, [call('read', { file_path: 'src/x.mjs' })], ['// x']).trigger, 'per_round');
  // Batched rounds and array calls get nothing.
  assert.equal(reminded(session, [call('read', { file_path: ['a.mjs', 'b.mjs'] })]), null);
  assert.equal(reminded(session, [call('grep', { pattern: 'a' }), call('git', { command: 'git status' })]), null);
  assert.equal(reminded(session, [call('task', { action: 'wait', task_id: 't' })]), null);
  // The third independent single call earns the serial reminder instead of the line.
  reminded(session, [call('grep', { pattern: 'one' })]);
  reminded(session, [call('grep', { pattern: 'two' })]);
  const serial = reminded(session, [call('grep', { pattern: 'three' })]);
  assert.equal(serial.trigger, 'serial_calls');
  assert.equal(session.batchingNudge.perRound, 4);
  assert.equal(session.batchingNudge.nudges, 1);
  // No reminder on the route (or a blank one) leaves the round silent.
  const other = {};
  assert.equal(
    observeToolBatchForNudge({
      sessionRef: other,
      calls: [call('grep', { pattern: 'a' })],
      results: ['ok'],
      tools,
      reminder: '  ',
    }),
    null
  );
  assert.equal(round(other, [call('grep', { pattern: 'b' })]), null);
});

test('a single call whose argument came out of the previous round earns no route reminder', () => {
  const REMINDER = 'Batching: every call the task still needs goes in your next response together.';
  const session = {};
  const reminded = (calls, results) =>
    observeToolBatchForNudge({
      sessionRef: session,
      calls,
      results: results ?? calls.map(() => 'ok'),
      tools,
      reminder: REMINDER,
    });
  const locating = reminded(
    [call('grep', { pattern: 'carriesArray' })],
    ['src/dep.mjs:321: function carriesArray(call) {']
  );
  assert.equal(locating.trigger, 'per_round');
  // The read takes its window out of that result, so it could never have
  // shared the round that produced it.
  assert.equal(reminded([call('read', { file_path: 'src/dep.mjs', offset: 321, limit: 30 })], ['// body']), null);
  assert.equal(session.batchingNudge.perRound, 1);
});

test('a path the previous result printed with backslashes or as a deeper path is provenance', () => {
  const REMINDER = 'Batching: every call the task still needs goes in your next response together.';
  const session = {};
  const reminded = (calls, results) =>
    observeToolBatchForNudge({
      sessionRef: session,
      calls,
      results: results ?? calls.map(() => 'ok'),
      tools,
      reminder: REMINDER,
    });
  // A process list names the install directory only as the prefix of an exe
  // path, with Windows separators; the next call inspects that directory.
  reminded(
    [call('shell', { command: 'Get-Process Mixdog' })],
    ['20944 Mixdog C:\\Users\\tempe\\AppData\\Local\\Programs\\mixdog-desktop\\Mixdog.exe']
  );
  assert.equal(
    reminded([call('shell', { command: 'rg -l reminder C:/Users/tempe/AppData/Local/Programs/mixdog-desktop' })], ['']),
    null
  );
  // A file listed with backslashes, then opened with slashes.
  reminded([call('shell', { command: 'rg -l pattern C:/data' })], ['C:\\data\\sessions\\sess_abc.json']);
  assert.equal(reminded([call('read', { file_path: 'C:/data/sessions/sess_abc.json' })], ['{}']), null);
  assert.equal(session.batchingNudge.perRound, 2);
  // A bare name is still not revealed by a longer path it prefixes.
  const scoped = {};
  observeToolBatchForNudge({
    sessionRef: scoped,
    calls: [call('glob', { pattern: '*.mjs' })],
    results: ['src/x.mjs'],
    tools,
    reminder: REMINDER,
  });
  assert.equal(
    observeToolBatchForNudge({
      sessionRef: scoped,
      calls: [call('grep', { pattern: 'x', path: 'src' })],
      results: [''],
      tools,
      reminder: REMINDER,
    }).trigger,
    'per_round'
  );
});

test('provenance matches literal tokens with the existing word and path boundaries', () => {
  const cases = [
    ['target', 'target', true],
    ['target', '(target)', true],
    ['target', 'xtarget', false],
    ['target', 'target2', false],
    ['target', '_target target_', false],
    ['target', '-target target-', false],
    ['target', 'target/file target\\file', false],
    ['target', 'xtarget target2 (target)', true],
    ['target', 'étarget', true],
    ['(((', 'x((((', true],
    ['target.*[x](value)?$', 'target.*[x](value)?$', true],
    ['target.*[x](value)?$', 'targetZxvalue', false],
    ['src/part', 'src\\part\\child', true],
    ['src\\part', 'src/part/child', true],
    ['src/part', 'src\\part-more src/part_more', false],
  ];
  for (const [candidate, text, dependent] of cases) {
    const session = {};
    round(session, [call('shell', { command: 'inspect' })], [text]);
    const nudge = observeToolBatchForNudge({
      sessionRef: session,
      calls: [call('shell', { command: candidate })],
      results: [''],
      tools,
      reminder: 'Batch independent calls.',
    });
    assert.equal(nudge?.trigger ?? null, dependent ? null : 'per_round', JSON.stringify({ candidate, text }));
  }
});

test('whole-file edit arguments do not overflow provenance matching or lose dependency checks', () => {
  const source = `import type React from 'react';\n${'render(<Pane path="./view" />);\n'.repeat(4_000)}`;
  for (const [result, expected] of [
    [source, null],
    ['unrelated content', 'per_round'],
  ]) {
    const session = {};
    const file = 'src/App.tsx';
    round(session, [call('read', { file_path: file })], [result]);
    const nudge = observeToolBatchForNudge({
      sessionRef: session,
      calls: [call('edit', { file_path: file, old_string: source, new_string: '' })],
      results: ['Updated'],
      tools,
      reminder: 'Batch independent calls.',
    });
    assert.equal(nudge?.trigger ?? null, expected);
  }
});

test('same-tool calls differing only in one array field are reported, other arguments must match', () => {
  const session = {};
  const nudge = round(session, [
    call('read', { file_path: 'a.mjs' }),
    call('read', { file_path: 'b.mjs' }),
    call('grep', { pattern: 'x', path: 'src' }),
    call('grep', { pattern: 'y', path: 'lib' }),
  ]);
  assert.equal(nudge.trigger, 'same_tool_scalars');
  assert.deepEqual(nudge.tools, ['read']);
  assert.match(nudge.text, /2 `read` calls differing only in `file_path`/);
  assert.doesNotMatch(nudge.text, /`grep` calls/);
  // The very next offending round is reported again.
  const again = round(session, [
    call('grep', { pattern: 'x', path: 'src' }),
    call('grep', { pattern: 'y', path: 'src' }),
  ]);
  assert.equal(again.trigger, 'same_tool_scalars');
  assert.match(again.text, /2 `grep` calls differing only in `pattern`/);
  assert.equal(session.batchingNudge.nudges, 2);
});

test('one-element arrays count as single targets (array-only provider schemas)', () => {
  const session = {};
  const nudge = round(session, [call('read', { file_path: ['a.mjs'] }), call('read', { file_path: ['b.mjs'] })]);
  assert.equal(nudge.trigger, 'same_tool_scalars');
  assert.match(nudge.text, /2 `read` calls differing only in `file_path`/);
  assert.equal(round(session, [call('read', { file_path: ['a.mjs', 'b.mjs'] })]), null);
});

test('git commands of any kind merge into one command array', () => {
  const session = {};
  const writes = round(session, [call('git', { command: 'git add a' }), call('git', { command: 'git add b' })]);
  assert.match(writes.text, /2 `git` calls differing only in `command`/);
  const reads = round(session, [call('git', { command: 'git status' }), call('git', { command: 'git diff' })]);
  assert.match(reads.text, /2 `git` calls differing only in `command`/);
});

test('the reminder repeats whenever a pattern recurs; only a batched round silences it', () => {
  const session = {};
  let issued = 0;
  for (let i = 0; i < 9; i++) {
    if (round(session, [call('read', { file_path: `f${i}.mjs` })])) issued++;
  }
  assert.equal(issued, 3);
  for (let i = 0; i < 5; i++) {
    if (round(session, [call('read', { file_path: 'a' }), call('read', { file_path: 'b' })])) issued++;
  }
  assert.equal(issued, 8);
  assert.equal(session.batchingNudge.nudges, 8);
  assert.equal(round(session, [call('read', { file_path: ['a', 'b'] })]), null);
  assert.equal(observeToolBatchForNudge({ sessionRef: null, calls: [call('read', { file_path: 'a' })], tools }), null);
});

test('processToolBatch appends the reminder after the round that completes the pattern', async () => {
  const sessionRef = {};
  const messages = [];
  const results = [];
  const runRound = (calls, iteration) =>
    processToolBatch({
      calls,
      messages,
      tools,
      cwd: process.cwd(),
      sessionId: null,
      sessionRef,
      signal: null,
      opts: {},
      iterations: iteration,
      assistantTurnMsg: { role: 'assistant', content: '', toolCalls: calls },
      pending: new Map(),
      epoch: { mutation: 0 },
      startEagerRun: () => {},
      crossTurnCalls: new Map(),
      crossTurnCap: 100,
      sessionAgent: null,
      pushToolResultMessage: (message) => results.push(message),
      throwIfAborted: () => {},
      repeatFailLimit: 3,
      dedupStubTotal: 0,
      editCount: 0,
      executeToolFn: async () => 'ok',
    });
  await runRound([call('grep', { pattern: 'a' })], 1);
  await runRound([call('grep', { pattern: 'b' })], 2);
  assert.equal(messages.length, 0);
  await runRound([call('grep', { pattern: 'c' })], 3);
  assert.equal(results.length, 3);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'user');
  assert.deepEqual(messages[0].meta, { source: 'batching-nudge' });
  assert.match(messages[0].content, /^<system-reminder>\nTool batching: the last 3 rounds were single calls/);
  assert.equal(sessionRef.batchingNudge.nudges, 1);
});

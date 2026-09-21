import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { freshContextCompactMessages } from '../compact.mjs';
import { runFreshContextCompact } from '../loop/fresh-context.mjs';
import { persistToolResultArtifactSync, pruneOffloadSession } from '../tool-result-offload.mjs';
import { projectSessionMessagesForIngest } from '../../../../memory/lib/session-ingest.mjs';
import { toAnthropicMessages } from '../../providers/lib/anthropic-request-utils.mjs';
import {
  buildExecutionTail,
  executionTokens,
  toolHistoryBudget,
  EXECUTION_RECOVERY_SOURCE,
} from './execution-tail.mjs';
import { isActualUserInstructionMessage } from './messages.mjs';
import { renderAgentCompletionEnvelope } from '../../../../shared/task-notification-envelope.mjs';

test('tagged completions are neither user instructions nor memory conversation', () => {
  const content = renderAgentCompletionEnvelope({
    id: 'task_agent_tail',
    tag: 'review',
    status: 'completed',
    result: 'reviewed',
  });
  const message = {
    role: 'user',
    content,
    meta: { source: 'task-notification', execution: { id: 'task_agent_tail', surface: 'agent', status: 'completed' } },
  };
  assert.equal(isActualUserInstructionMessage(message), false);
  assert.equal(isActualUserInstructionMessage({ role: 'user', content }), false);
  assert.deepEqual(projectSessionMessagesForIngest([message]), []);
});

function sandbox(t) {
  const previous = process.env.MIXDOG_DATA_DIR;
  const root = mkdtempSync(join(tmpdir(), 'mixdog-execution-tail-'));
  process.env.MIXDOG_DATA_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function pair(id, result, args = { file_path: `${id}.js`, old_string: 'before', new_string: 'after' }) {
  return [
    { role: 'assistant', content: '', toolCalls: [{ id, name: 'edit', arguments: args }] },
    { role: 'tool', toolCallId: id, content: result },
  ];
}

test('tool history scales with 5% of the context window without a fixed token ceiling', () => {
  for (const [contextWindow, expected] of [
    [20_000, 1_000],
    [100_000, 5_000],
    [500_000, 25_000],
    [1_000_000, 50_000],
  ]) {
    assert.equal(toolHistoryBudget(contextWindow), expected);
  }
});

test('rule-only compaction preserves seven completed edits and the original request before steering', async () => {
  const original = { role: 'user', content: 'Remove mobile from h1, not metadata.' };
  const steering = { role: 'user', content: 'Steam too.', meta: { source: 'steering' } };
  const messages = [{ role: 'system', content: 'rules' }, original, ...pair('rank-0', 'Updated rank-hub.js')];
  messages.push(steering);
  for (let i = 1; i < 7; i += 1) messages.push(...pair(`edit-${i}`, `Updated file ${i}`));
  let providerCalls = 0;
  const compacted = await runFreshContextCompact({
    sessionRef: { id: 'seven-edits', contextWindow: 500_000, provider: 'stub', model: 'stub-model' },
    sessionId: 'seven-edits',
    // An explicit empty config keeps the route on the stub provider: the
    // developer's own maintenance route must not decide this test.
    config: {},
    messages,
    compactBudgetTokens: 250_000,
    compactPolicy: { contextWindow: 500_000, reserveTokens: 0 },
    activeTurn: true,
    provider: {
      name: 'stub',
      async send() {
        providerCalls += 1;
        return { content: 'The assistant plans to edit h1.' };
      },
    },
    executeMemorySearch: async ({ action }) => (action === 'ingest_session' ? 'ok' : 'The assistant plans to edit h1.'),
  });
  assert.equal(providerCalls, 0);
  assert.deepEqual(
    compacted.messages.filter((m) => m.role === 'tool'),
    messages.filter((m) => m.role === 'tool')
  );
  assert.deepEqual(
    compacted.messages.flatMap((m) => m.toolCalls || []),
    messages.flatMap((m) => m.toolCalls || [])
  );
  assert.equal(compacted.messages.filter((m) => m.content === original.content).length, 1);
  assert.equal(compacted.messages.filter((m) => m.content === steering.content).length, 1);
  assert.equal(compacted.diagnostics.toolHistoryBudget, 25_000);
  const again = freshContextCompactMessages(compacted.messages, 250_000, {
    force: true,
    contextWindow: 500_000,
    handoffText: 'Still in progress.',
    activeTurn: true,
  });
  assert.deepEqual(
    again.messages.filter((m) => m.role === 'tool'),
    messages.filter((m) => m.role === 'tool')
  );
  assert.equal(again.messages.filter((m) => m.content === original.content).length, 1);
});

test('failed, partially applied, and running outcomes remain verbatim and are never promoted to success', () => {
  const messages = [
    { role: 'user', content: 'Apply the changes and verify.' },
    ...pair('partial', 'Applied a.js; rejected b.js: context mismatch'),
    ...pair('failed', 'Error: permission denied'),
    ...pair('running', 'background task\ntask_id: job-123\nstatus: running', { command: 'node build.mjs' }),
  ];
  const result = buildExecutionTail(messages, { contextWindow: 100_000 });
  assert.deepEqual(
    result.messages.filter((m) => m.role === 'tool'),
    messages.filter((m) => m.role === 'tool')
  );
  assert.equal(result.toolBudget, 5_000);
});

test('large UI diffs cannot evict the latest edit failure and skipped verification during Compact', (t) => {
  sandbox(t);
  const outcomes = Array.from({ length: 10 }, (_, index) => pair(`edit-${index}`, `Updated file ${index}`));
  outcomes.push(
    pair('failed', 'Error: edit failed (old_string found 2 times)', { file_path: 'failed.js', uiDiff: 'actual input' }),
    pair(
      'verify',
      '[mutation-dependency-guard] shell skipped because earlier mutation call(s) failed; no verification ran.'
    )
  );
  const assistant = {
    role: 'assistant',
    content: '',
    toolCalls: outcomes.flatMap(([message]) => message.toolCalls),
  };
  assistant.providerReplay = {
    provider: 'anthropic',
    items: assistant.toolCalls.map((call) => ({
      type: 'tool_use',
      id: call.id,
      name: call.name,
      input: call.arguments,
    })),
  };
  const toolKindAt = (index) => {
    if (index === 10) return 'error';
    return index === 11 ? 'blocked' : 'normal';
  };
  const results = outcomes.map(([, message], index) => ({
    ...message,
    ...(index < 10 ? { uiDiff: 'display-only diff\n'.repeat(4_000) } : {}),
    toolKind: toolKindAt(index),
  }));
  const messages = [{ role: 'user', content: 'Apply the approved edits and verify.' }, assistant, ...results];
  const before = structuredClone(messages);
  const withoutUi = messages.map(({ uiDiff: _uiDiff, ...message }) => message);
  assert.deepEqual(toAnthropicMessages(messages), toAnthropicMessages(withoutUi));
  assert.equal(executionTokens(messages), executionTokens(withoutUi));
  const result = freshContextCompactMessages(messages, 125_000, {
    force: true,
    contextWindow: 500_000,
    sessionId: 'ui-diff-regression',
    activeTurn: true,
  });
  assert.deepEqual(
    result.messages.filter((message) => message.role === 'tool'),
    results
  );
  assert.deepEqual(
    result.messages.find((message) => message.toolCalls?.length),
    assistant
  );
  assert.equal(result.diagnostics.omittedToolGroups, 0);
  assert.ok(result.diagnostics.toolHistoryTokens <= 50_000);
  assert.deepEqual(messages, before);
});

test('repeated legacy Goal turns cannot crowd the real request and execution evidence out of Compact', () => {
  const request = { role: 'user', content: 'Finish the approved changes and verify them.' };
  const evidence = pair('verified-edit', 'Updated source.js; verification passed.');
  const clock = '<system-reminder>\n# Current Time\n2026-09-13\n</system-reminder>';
  const messages = [{ role: 'system', content: 'Session rules.' }, request, ...evidence];
  for (let index = 0; index < 125; index++) {
    messages.push(
      {
        role: 'user',
        content: `<system-reminder>\n# Active Goal\n${'Approved task details. '.repeat(250)}\n</system-reminder>\n\n${clock}`,
      },
      { role: 'assistant', content: 'No changes; waiting for the deadline.' }
    );
  }
  const before = structuredClone(messages);
  const currentGoal =
    '<system-reminder>\n<goal_state>\nCurrent verified Goal state.\n</goal_state>\n</system-reminder>';
  const result = freshContextCompactMessages(messages, 10_000, {
    force: true,
    contextWindow: 200_000,
    handoffText: 'The requested edit and verification finished. The full duration has not ended.',
    latestUserPrefix: currentGoal,
    activeTurn: true,
  });
  assert.ok(result.diagnostics.finalTokens <= 10_000);
  assert.equal(result.messages.filter((m) => m.content === `${currentGoal}\n\n${request.content}`).length, 1);
  assert.deepEqual(
    result.messages.filter((m) => m.role === 'tool'),
    [evidence[1]]
  );
  assert.deepEqual(
    result.messages.flatMap((m) => m.toolCalls || []),
    evidence[0].toolCalls
  );
  assert.equal(
    result.messages.some((m) => typeof m.content === 'string' && m.content.includes('# Active Goal')),
    false
  );
  assert.deepEqual(messages, before, 'compaction must not alter the original transcript');
});

test('a legacy transcript with no raw human request still receives the current Goal snapshot after Compact', () => {
  const currentGoal =
    '<system-reminder>\n<goal_state>\nStatus: blocked\nKeep the unfinished work.\n</goal_state>\n</system-reminder>';
  const messages = [
    { role: 'system', content: 'Session rules.' },
    ...pair('prior-edit', 'Updated source.js.'),
    {
      role: 'user',
      content:
        '<system-reminder>\n# Active Goal\nOld automatic continuation.\n</system-reminder>\n\n<system-reminder>\n# Current Time\n2026-09-13\n</system-reminder>',
    },
  ];
  const result = freshContextCompactMessages(messages, 10_000, {
    force: true,
    contextWindow: 200_000,
    handoffText: 'The earlier user request is summarized here; its raw turn is no longer present.',
    latestUserPrefix: currentGoal,
    activeTurn: true,
  });
  assert.equal(result.messages.filter((m) => m.content === currentGoal).length, 1);
  assert.equal(result.messages.filter(isActualUserInstructionMessage).length, 0);
  assert.equal(result.messages.find((m) => m.toolCallId === 'prior-edit').content, 'Updated source.js.');
  assert.equal(
    result.messages.some((m) => m.content?.includes?.('# Active Goal')),
    false
  );
});

test('large tool results are archived exactly and retained calls remain paired under the strict cap', (t) => {
  sandbox(t);
  const content = 'EXACT_OUTPUT\n'.repeat(15_000);
  const messages = [
    { role: 'user', content: 'inspect' },
    ...pair('huge', content),
    ...pair('recent', 'Updated recent.js'),
  ];
  const result = buildExecutionTail(messages, { contextWindow: 40_000, sessionId: 'huge-results' });
  assert.equal(result.toolBudget, 2_000);
  assert.ok(result.toolTokens <= result.toolBudget);
  const recovery = result.messages.find((m) => m.meta?.source === EXECUTION_RECOVERY_SOURCE);
  const path = recovery.content.match(/available at (.+?) \(sha256:/)[1];
  const archive = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(archive.messages, messages);
  assert.equal(result.messages.find((m) => m.toolCallId === 'recent').content, 'Updated recent.js');
  const ids = result.messages.flatMap((m) => (m.toolCalls || []).map((c) => c.id));
  assert.deepEqual(
    result.messages.filter((m) => m.role === 'tool').map((m) => m.toolCallId),
    ids
  );
  assert.equal(
    projectSessionMessagesForIngest(result.messages).some((m) => m.content.includes('available at')),
    false
  );
});

test('large arguments and opaque provider replay cannot bypass the tool-history budget', (t) => {
  sandbox(t);
  const messages = [
    { role: 'user', content: 'work' },
    ...pair('old', 'Updated old.js', { patch: 'large patch '.repeat(5_000) }),
    ...pair('latest', 'Updated latest.js'),
  ];
  messages[1].providerReplay = { items: [{ type: 'reasoning', encrypted_content: 'opaque'.repeat(5_000) }] };
  const result = buildExecutionTail(messages, { contextWindow: 20_000, sessionId: 'large-arguments' });
  assert.equal(result.toolBudget, 1_000);
  assert.ok(result.toolTokens <= 1_000);
  assert.ok(result.omittedGroups > 0);
  assert.ok(result.messages.some((m) => m.toolCallId === 'latest'));
  assert.equal(
    result.messages.some((m) => m.toolCallId === 'old'),
    false
  );
  assert.ok(executionTokens(messages.slice(1, 3)) > 1_000);
});

test('an oversized latest execution group refuses compaction instead of losing its failure outcome', (t) => {
  sandbox(t);
  for (const field of ['arguments', 'providerReplay']) {
    const latest = pair('latest', 'Error: permission denied');
    if (field === 'arguments') {
      latest[0].toolCalls[0].arguments = { patch: 'large patch '.repeat(5_000) };
    } else {
      latest[0].providerReplay = { items: [{ type: 'reasoning', encrypted_content: 'opaque'.repeat(10_000) }] };
    }
    const messages = [{ role: 'user', content: 'work' }, ...pair('old', 'Updated old.js'), ...latest];
    const before = structuredClone(messages);
    assert.throws(
      () => buildExecutionTail(messages, { contextWindow: 20_000, sessionId: `oversized-${field}` }),
      /latest execution group cannot fit.*original context preserved/
    );
    assert.deepEqual(messages, before);
  }
});

test('adding an archive reference cannot silently displace the only retained execution group', (t) => {
  sandbox(t);
  const latest = pair('latest', 'Verification skipped; the preceding edit failed.', {
    command: 'verification command '.repeat(200),
  });
  const messages = [
    { role: 'user', content: 'work' },
    ...pair('old', 'Updated old.js', { patch: 'large patch '.repeat(5_000) }),
    ...latest,
  ];
  const before = structuredClone(messages);
  assert.throws(
    () =>
      buildExecutionTail(messages, {
        contextWindow: executionTokens(latest) * 10,
        sessionId: 'archive-reference-displacement',
      }),
    /latest execution group cannot fit.*original context preserved/
  );
  assert.deepEqual(messages, before);
});

test('archive failure leaves the input unchanged and refuses compaction rather than dropping evidence', (t) => {
  const root = sandbox(t);
  const blocked = join(root, 'not-a-directory');
  writeFileSync(blocked, 'occupied');
  process.env.MIXDOG_DATA_DIR = blocked;
  const messages = [{ role: 'user', content: 'work' }, ...pair('large', 'result '.repeat(10_000))];
  const before = JSON.stringify(messages);
  assert.throws(
    () => buildExecutionTail(messages, { contextWindow: 20_000, sessionId: 'blocked' }),
    /could not be archived/
  );
  assert.equal(JSON.stringify(messages), before);
});

test('repeated archive references keep their underlying artifacts reachable during pruning', async (t) => {
  sandbox(t);
  const sessionId = 'archive-chain';
  const original = persistToolResultArtifactSync({ sessionId, toolCallId: 'original', content: 'original evidence' });
  const inner = persistToolResultArtifactSync({
    sessionId,
    toolCallId: 'inner',
    content: JSON.stringify({ path: original.path }),
  });
  const outer = persistToolResultArtifactSync({
    sessionId,
    toolCallId: 'outer',
    content: JSON.stringify({ path: inner.path }),
  });
  const unused = persistToolResultArtifactSync({ sessionId, toolCallId: 'unused', content: 'unreachable evidence' });
  const old = new Date(Date.now() - 3_600_000);
  for (const artifact of [original, inner, outer, unused]) utimesSync(artifact.path, old, old);
  await pruneOffloadSession(sessionId, () => [{ content: outer.path }]);
  assert.equal(readFileSync(original.path, 'utf8'), 'original evidence');
  assert.ok(existsSync(inner.path));
  assert.ok(existsSync(outer.path));
  assert.equal(existsSync(unused.path), false);
  assert.equal(dirname(inner.path), dirname(outer.path));
});

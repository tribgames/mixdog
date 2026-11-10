import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { freshContextCompactMessages, SUMMARY_PREFIX } from './compact.mjs';
import { runFreshContextCompact } from './loop/fresh-context.mjs';
import { withRuntimeUserContext } from './runtime-user-context.mjs';
import { toAnthropicMessages } from '../providers/lib/anthropic-request-utils.mjs';
import { renderAgentCompletionEnvelope } from '../../../shared/task-notification-envelope.mjs';
import { isActualUserInstructionMessage, latestActualUserInstructionMessage } from './compact/messages.mjs';
import { agentTaskMessage, routineResultMessage } from './routine-result.mjs';
import { estimateMessagesTokens } from './context-utils.mjs';

test('fresh Compact summarizes the live conversation without calling Memory', async () => {
  const messages = [{ role: 'system', content: 'system' }];
  for (let index = 0; index < 7; index += 1) {
    messages.push(
      { role: 'user', content: `request-${index}` },
      {
        role: 'assistant',
        content: index === 0 ? 'LOCAL_ONLY_OLD_HISTORY DUPLICATE_STATE' : `answer-${index}`,
      }
    );
  }
  let summaryInput = '';
  const sessionId = 'sess-recall-verbatim';
  const result = await runFreshContextCompact({
    config: {},
    model: 'fake-model',
    provider: {
      name: 'fake',
      async send(input) {
        summaryInput = input[1].content;
        return { content: GENERATED_HANDOFF };
      },
    },
    sessionRef: {
      id: sessionId,
      cwd: 'C:\\Project\\mixdog',
      compaction: { conversationThresholdTokens: 1 },
      contextWindow: 100_000,
      compactBoundaryTokens: 100_000,
    },
    messages,
    compactBudgetTokens: 30_000,
    compactPolicy: {
      contextWindow: 100_000,
      boundaryTokens: 100_000,
      reserveTokens: 0,
    },
    sessionId,
    executeMemorySearch: async () => {
      assert.fail('compaction must not read or write Memory');
    },
  });

  const summary = result.messages.find(
    (message) =>
      message.role === 'user' && typeof message.content === 'string' && message.content.startsWith(SUMMARY_PREFIX)
  );
  assert.ok(summary);
  assert.match(summaryInput, /LOCAL_ONLY_OLD_HISTORY/);
  assert.match(summary.content, /one Compact path/);
  assert.doesNotMatch(summary.content, /memory_session=/);
});

test('fresh Compact summarizes tool calls as bounded lines, ask_user answers verbatim, and never skill bodies', async () => {
  const answer =
    'User has answered your questions: "Which db?"="PG"; "Which features?"="X, Y". You can now continue with these answers in mind.';
  let summaryInput = '';
  const result = await runFreshContextCompact({
    config: {},
    model: 'fake-model',
    provider: {
      name: 'fake',
      async send(input) {
        summaryInput = input[1].content;
        return { content: GENERATED_HANDOFF };
      },
    },
    sessionRef: {
      id: 'sess-ingest-barrier',
      cwd: 'C:\\Project\\mixdog',
      compaction: { conversationThresholdTokens: 1 },
      contextWindow: 100_000,
      compactBoundaryTokens: 100_000,
    },
    messages: [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'old request' },
      { role: 'assistant', content: 'old answer' },
      { role: 'user', meta: 'skill', content: '<skill>\n<name>demo</name>\nSKILL_BODY_ONLY\n</skill>' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'read-source', name: 'read', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'read-source', content: `TOOL_OUTPUT_ONLY ${'long body '.repeat(200)}` },
      { role: 'assistant', content: '', toolCalls: [{ id: 'ask', name: 'ask_user', arguments: { q: 'db' } }] },
      { role: 'tool', toolCallId: 'ask', content: `${answer} ${'and more context '.repeat(40)}` },
      { role: 'user', content: 'current request' },
    ],
    compactBudgetTokens: 50_000,
    compactPolicy: {
      contextWindow: 100_000,
      boundaryTokens: 100_000,
      reserveTokens: 0,
    },
    sessionId: 'sess-ingest-barrier',
  });
  assert.match(summaryInput, /old request/);
  assert.doesNotMatch(summaryInput, /SKILL_BODY_ONLY/);
  // One bounded line per call, with its outcome; an ask_user answer whole.
  assert.match(summaryInput, /\[tool call\] read\(\{\}\) → TOOL_OUTPUT_ONLY long body[^\n]*… \[\d+ more chars\]\n/);
  assert.ok(summaryInput.includes(`[tool call] ask_user({"q":"db"}) → ${answer}`));
  assert.ok(summaryInput.includes('and more context '.repeat(40).trim()));
  // The retained execution tail keeps the result whole.
  assert.match(
    result.messages.find((m) => m.toolCallId === 'read-source')?.content,
    /^TOOL_OUTPUT_ONLY (long body ){200}$/
  );
});

test('pre-send active turn reaches the fresh builder as a continuation', async () => {
  const result = await runFreshContextCompact({
    config: {},
    model: 'fake-model',
    provider: {
      name: 'fake',
      async send() {
        return { content: GENERATED_HANDOFF };
      },
    },
    sessionRef: {
      id: 'sess-active-turn',
      cwd: 'C:\\Project\\mixdog',
      contextWindow: 100_000,
      compactBoundaryTokens: 100_000,
    },
    messages: [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'inspect the mobile page' },
      {
        role: 'assistant',
        content: 'starting mobile inspection',
        toolCalls: [{ id: 'browser-call', name: 'browser', arguments: '{}' }],
      },
      { role: 'tool', toolCallId: 'browser-call', content: 'mobile inspection completed' },
    ],
    compactBudgetTokens: 50_000,
    compactPolicy: {
      contextWindow: 100_000,
      boundaryTokens: 100_000,
      reserveTokens: 0,
    },
    sessionId: 'sess-active-turn',
    activeTurn: true,
  });

  assert.match(String(result.messages.at(-1)?.content), /already in progress/i);
  assert.equal(result.diagnostics.activeTurnContinuation, true);
});

test('an agent report delivered as the turn input survives Compact into the next model request', async () => {
  const report = renderAgentCompletionEnvelope({
    id: 'task_agent_advise',
    tag: 'advise-pr-146',
    status: 'completed',
    result: 'ADVISOR_REPORT_BODY: recommend merge as is.',
  });
  const notification = {
    role: 'user',
    content: report,
    meta: { source: 'task-notification' },
  };
  let summaryInput = '';
  const result = await runFreshContextCompact({
    config: {},
    model: 'fake-model',
    provider: {
      name: 'fake',
      async send(input) {
        summaryInput = input[1].content;
        return { content: GENERATED_HANDOFF };
      },
    },
    sessionRef: {
      id: 'sess-notification-wake',
      cwd: 'C:\\Project\\mixdog',
      compaction: { conversationThresholdTokens: 1 },
      contextWindow: 100_000,
      compactBoundaryTokens: 100_000,
    },
    messages: [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'review PR #146' },
      { role: 'assistant', content: 'PR #146 looks acceptable.' },
      { role: 'user', content: 'ask the Advisor too' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'agent-call', name: 'agent', arguments: '{"action":"spawn"}' }],
      },
      { role: 'tool', toolCallId: 'agent-call', content: 'agent task: task_agent_advise\nstatus: running' },
      { role: 'assistant', content: 'The Advisor is reviewing; waiting for its report.' },
      notification,
    ],
    compactBudgetTokens: 30_000,
    compactPolicy: { contextWindow: 100_000, boundaryTokens: 100_000, reserveTokens: 0 },
    sessionId: 'sess-notification-wake',
    activeTurn: true,
  });

  assert.ok(result.messages.some((m) => typeof m.content === 'string' && m.content.startsWith(SUMMARY_PREFIX)));
  assert.doesNotMatch(summaryInput, /ADVISOR_REPORT_BODY/);
  // The unanswered report is the turn's input: it ends the context verbatim,
  // with no reminder claiming the earlier user request is still in progress.
  assert.deepEqual(result.messages.at(-1), notification);
  assert.equal(result.diagnostics.activeTurnContinuation, false);
  const request = JSON.stringify(toAnthropicMessages(result.messages.filter((m) => m.role !== 'system')));
  assert.match(request, /ADVISOR_REPORT_BODY: recommend merge as is\./);
  assert.doesNotMatch(request, /active-turn-continuation/);
});

function summaryRun(messages, sessionId, capture, extra = {}) {
  return runFreshContextCompact({
    config: {},
    model: 'fake-model',
    provider: {
      name: 'fake',
      async send(input) {
        capture.input = (capture.input || '') + input[1].content;
        return { content: GENERATED_HANDOFF };
      },
    },
    sessionRef: { id: sessionId, compaction: { conversationThresholdTokens: 1 }, contextWindow: 100_000 },
    messages,
    compactBudgetTokens: 30_000,
    compactPolicy: { contextWindow: 100_000, boundaryTokens: 100_000, reserveTokens: 0 },
    sessionId,
    ...extra,
  });
}

const rulesCompact = (messages, extra = {}) =>
  freshContextCompactMessages(messages, 10_000, { force: true, contextWindow: 40_000, ...extra });

function answeredReport(body) {
  return {
    role: 'user',
    content: renderAgentCompletionEnvelope({ id: 'task_agent_done', tag: 'advise', status: 'completed', result: body }),
    meta: { source: 'task-notification' },
  };
}

test('an answered agent report reaches the summary bounded and stays whole in rule-only Compact', async () => {
  const report = answeredReport(`ANSWERED_REPORT_BODY ${'finding '.repeat(800)}`);
  const messages = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'ask the Advisor' },
    { role: 'assistant', content: 'Waiting for the Advisor.' },
    report,
    { role: 'assistant', content: 'The Advisor recommends merging.' },
    { role: 'user', content: 'current request' },
  ];
  const capture = {};
  await summaryRun(messages, 'sess-answered-report', capture);
  assert.match(capture.input, /ANSWERED_REPORT_BODY/);
  assert.match(capture.input, /… \[\d+ more chars\]/);
  const rules = rulesCompact(messages);
  assert.ok(rules.messages.some((m) => m.content === report.content));
});

test('the summary request reads tool outcomes and notification bodies with their secrets redacted', async () => {
  const messages = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'check the deploy environment' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'env', name: 'shell', arguments: { command: 'env' } }] },
    {
      role: 'tool',
      toolCallId: 'env',
      content: `Authorization: Bearer sk-live-HEADER_SECRET\nAUTH_TOKEN=tok-KV_SECRET PATH=/usr/bin\n${'line\n'.repeat(200)}`,
    },
    { role: 'assistant', content: 'The environment is set.' },
    {
      role: 'user',
      content: 'Async shell task job_1 (printenv) finished.\nResult:\npassword: hunter2-NOTIFY_SECRET',
      meta: { source: 'task-notification' },
    },
    { role: 'assistant', content: 'The background check finished.' },
    { role: 'user', content: 'current request' },
  ];
  const capture = {};
  await summaryRun(messages, 'sess-redacted-outcomes', capture);
  assert.match(capture.input, /\[tool call\] shell\(\{"command":"env"\}\) → Authorization: \[redacted\]/);
  assert.match(capture.input, /AUTH_TOKEN=\[redacted\] PATH=\/usr\/bin/);
  assert.match(capture.input, /password: \[redacted\]/);
  for (const secret of ['HEADER_SECRET', 'KV_SECRET', 'NOTIFY_SECRET']) {
    assert.equal(capture.input.includes(secret), false, secret);
  }
});

test('a plain-text channel notification never displaces the human request it interrupts', () => {
  const notification = { role: 'user', content: 'Build #12 failed on main.', meta: { source: 'task-notification' } };
  assert.equal(isActualUserInstructionMessage(notification), false);
  const goal = '<system-reminder><goal_state>GOAL_NOW</goal_state></system-reminder>';
  const messages = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'fix the flaky test' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'r1', name: 'read', arguments: '{}' }] },
    { role: 'tool', toolCallId: 'r1', content: 'read ok' },
    notification,
    { role: 'assistant', content: '', toolCalls: [{ id: 'r2', name: 'read', arguments: '{}' }] },
    { role: 'tool', toolCallId: 'r2', content: 'read ok' },
  ];
  assert.equal(latestActualUserInstructionMessage(messages).content, 'fix the flaky test');
  const result = rulesCompact(messages, { handoffText: 'Fixing the test.', latestUserPrefix: goal, activeTurn: true });
  assert.ok(result.messages.some((m) => m.content === `${goal}\n\nfix the flaky test`));
  assert.ok(result.messages.some((m) => m.content === notification.content));
});

test('home-thread routine and task results reach the summary and stay in rule-only Compact', async () => {
  const routine = routineResultMessage({ name: 'news', ok: true, text: 'ROUTINE_RESULT_BODY', messageId: 'r_1' });
  const task = agentTaskMessage({
    title: 'fix',
    status: 'completed',
    text: 'TASK_REPLY_BODY',
    taskSessionId: 'sess_task_1',
    messageId: 'r_2',
  });
  const messages = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'start the task' },
    { role: 'assistant', content: 'Started.' },
    routine,
    task,
    { role: 'assistant', content: 'The task finished.' },
    { role: 'user', content: 'current request' },
  ];
  const capture = {};
  await summaryRun(messages, 'sess-home-results', capture);
  assert.match(capture.input, /ROUTINE_RESULT_BODY/);
  assert.match(capture.input, /TASK_REPLY_BODY/);
  const rules = rulesCompact(messages);
  for (const row of [routine, task]) assert.ok(rules.messages.some((m) => m.content === row.content));
});

test('rule-only Compact keeps an interrupt marker as its own row', () => {
  const marker = { role: 'user', content: '[Request interrupted by user]' };
  const messages = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'rename the module' },
    { role: 'assistant', content: 'Starting the rename.' },
    marker,
    { role: 'user', content: 'only the tests, please' },
  ];
  const result = rulesCompact(messages);
  const index = result.messages.findIndex((m) => m.content === marker.content);
  assert.ok(index > 0);
  assert.equal(result.messages[index + 1].content, 'only the tests, please');
});

test('a notification turn in a thread with no human request keeps its continuation and ack', () => {
  const report = answeredReport('HOME_REPORT_BODY');
  const messages = [
    { role: 'system', content: 'system' },
    report,
    { role: 'assistant', content: 'Relaying.', toolCalls: [{ id: 'h1', name: 'read', arguments: '{}' }] },
    { role: 'tool', toolCallId: 'h1', content: 'read ok' },
  ];
  const result = rulesCompact(messages, { handoffText: 'A report arrived.', activeTurn: true });
  assert.equal(result.diagnostics.activeTurnContinuation, true);
  const summary = result.messages.findIndex((m) => m.meta?.source === 'compact-summary');
  assert.equal(result.messages[summary + 1].content, '.');
  assert.ok(result.messages.some((m) => m.content === report.content));
});

test('a skill body Compact cannot restore leaves a reload reminder that lasts until it is reloaded', () => {
  const body = {
    role: 'user',
    meta: 'skill',
    content: `<skill>\n<name>guide</name>\n${'rule '.repeat(12_000)}\n</skill>`,
  };
  const messages = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'use the guide' },
    body,
    { role: 'assistant', content: 'Following the guide.' },
    { role: 'user', content: 'continue' },
  ];
  const reminder = (list) => list.filter((m) => m.meta?.source === 'compact-skill-reload');
  const first = freshContextCompactMessages(messages, 20_000, { force: true, contextWindow: 200_000 });
  assert.equal(
    first.messages.some((m) => m === body),
    false
  );
  assert.equal(reminder(first.messages).length, 1);
  assert.match(reminder(first.messages)[0].content, /Skill "guide" was active[\s\S]*Reload it with the Skill tool/);
  assert.equal(isActualUserInstructionMessage(reminder(first.messages)[0]), false);
  const second = freshContextCompactMessages(first.messages, 20_000, { force: true, contextWindow: 200_000 });
  assert.equal(reminder(second.messages).length, 1);
  // Reloaded, and restored by a Compact with room for it: the reminder is gone.
  const reloaded = [
    ...second.messages,
    { ...body },
    { role: 'assistant', content: 'Reloaded the guide.' },
    { role: 'user', content: 'go on' },
  ];
  const third = freshContextCompactMessages(reloaded, 100_000, { force: true, contextWindow: 1_000_000 });
  assert.ok(third.messages.some((m) => m.content === body.content));
  assert.equal(reminder(third.messages).length, 0);
});

test('skill reload reminders are charged to the skill budget, so a tight Compact still fits', () => {
  const opts = { force: true, contextWindow: 200_000 };
  const base = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'use the guides' },
    { role: 'assistant', content: 'Noted. '.repeat(5_200) },
    { role: 'user', content: 'continue' },
  ];
  const { finalTokens: committed, budgetTokens: budget } = freshContextCompactMessages(base, 10_000, opts).diagnostics;
  const skillBudget = budget - committed;
  assert.ok(skillBudget > 100 && skillBudget < budget * 0.2, `skill budget ${skillBudget}`);
  const skill = (name, words) => ({
    role: 'user',
    meta: 'skill',
    content: `<skill>\n<name>${name}</name>\n${'rule '.repeat(words)}\n</skill>`,
  });
  // The newest body alone fills the skill budget to within one word, so an
  // uncharged reminder for the older, too-large skill would overflow it.
  let words = 1;
  while (estimateMessagesTokens([skill('fit', words + 1)]) <= skillBudget) words += 1;
  const messages = [base[0], base[1], skill('big', 20_000), skill('fit', words), base[2], base[3]];
  const result = freshContextCompactMessages(messages, 10_000, opts);
  assert.ok(result.diagnostics.finalTokens <= budget);
  assert.deepEqual(
    result.messages.filter((m) => m.meta?.source === 'compact-skill-reload').map((m) => m.meta.skill),
    ['big', 'fit']
  );
});

test('repeated compact replaces one cumulative summary and does not replay older raw history', async () => {
  const sessionId = 'sess-repeat-full-rebuild';
  const prompts = [];
  const provider = {
    name: 'fake',
    async send(input) {
      prompts.push(input[1].content);
      return { content: GENERATED_HANDOFF.replace('one Compact path', `CUMULATIVE_REVISION_${prompts.length}`) };
    },
  };
  const compactPolicy = {
    contextWindow: 100_000,
    boundaryTokens: 100_000,
    reserveTokens: 0,
  };
  const original = [{ role: 'system', content: 'system' }];
  for (let turn = 1; turn <= 7; turn += 1) {
    original.push({ role: 'user', content: `request-${turn}` }, { role: 'assistant', content: `answer-${turn}` });
  }
  const first = await runFreshContextCompact({
    config: {},
    provider,
    model: 'fake-model',
    sessionRef: {
      id: sessionId,
      cwd: 'C:\\Project\\mixdog',
      contextWindow: 100_000,
      compaction: { conversationThresholdTokens: 1 },
    },
    messages: original,
    compactBudgetTokens: 50_000,
    compactPolicy,
    sessionId,
  });
  const second = await runFreshContextCompact({
    config: {},
    provider,
    model: 'fake-model',
    sessionRef: {
      id: sessionId,
      cwd: 'C:\\Project\\mixdog',
      contextWindow: 100_000,
      compaction: { conversationThresholdTokens: 1 },
    },
    messages: [
      ...JSON.parse(JSON.stringify(first.messages)),
      { role: 'user', content: 'follow-up request' },
      { role: 'assistant', content: 'follow-up answer' },
      { role: 'user', content: 'current request' },
    ],
    compactBudgetTokens: 50_000,
    compactPolicy,
    sessionId,
  });
  const secondSummary = second.messages.find(
    (message) => typeof message.content === 'string' && message.content.startsWith(SUMMARY_PREFIX)
  );
  assert.equal(prompts.length, 2);
  assert.match(prompts[0], /request-1/);
  assert.match(prompts[1], /CUMULATIVE_REVISION_1/);
  assert.match(prompts[1], /follow-up request/);
  assert.doesNotMatch(prompts[1], /request-1|answer-1/);
  assert.match(secondSummary.content, /CUMULATIVE_REVISION_2/);
  assert.doesNotMatch(secondSummary.content, /CUMULATIVE_REVISION_1/);
  assert.equal(second.messages.filter((m) => m.meta?.source === 'compact-summary').length, 1);
  assert.equal(secondSummary?.content.split(SUMMARY_PREFIX).length - 1, 1);
});

test('fresh layout keeps session injection and stable summary before the volatile Goal/latest-user tail', () => {
  const sessionPrefix = [
    { role: 'system', content: 'BP1 tool policy' },
    { role: 'system', content: 'BP2 profile and skills' },
    { role: 'system', content: 'BP3 workflow and memory', cacheTier: 'tier3' },
    { role: 'system', content: 'session environment', cacheTier: 'env' },
    {
      role: 'user',
      content: '<system-reminder>\n# SessionStart Hook Context\nstable hook context\n</system-reminder>',
    },
    { role: 'assistant', content: '.' },
  ];
  const staleGoal = '<system-reminder>\n<goal_state>\nSTALE_GOAL_STATE\n</goal_state>\n</system-reminder>\n\n';
  const latestInstruction =
    '<system-reminder>\n# Current Time\n2026-09-01\n</system-reminder>\n\nLATEST_REAL_USER_INSTRUCTION';
  const messages = [
    ...sessionPrefix,
    { role: 'user', content: 'older request' },
    {
      role: 'assistant',
      content: 'old assistant execution',
      toolCalls: [{ id: 'old-call', name: 'read', arguments: '{}' }],
      providerReplay: { items: [{ type: 'reasoning', encrypted_content: 'OLD_PROVIDER_REPLAY' }] },
    },
    { role: 'tool', toolCallId: 'old-call', content: 'OLD_TOOL_RESULT' },
    { role: 'assistant', content: 'old final answer' },
    withRuntimeUserContext({ role: 'user', content: latestInstruction }, { prefix: staleGoal }),
    {
      role: 'user',
      content:
        '<task-notification>\n<task-id>task-1</task-id>\n<status>completed</status>\n<exit-code>0</exit-code>\n<summary>Shell task completed (exit 0)</summary>\n</task-notification>',
    },
    { role: 'user', content: '[mixdog-runtime] Empty response (1/2). Return final text.' },
    { role: 'user', content: '[Request interrupted]' },
  ];
  const goalReminder = '<system-reminder>\n<goal_state>\nCURRENT_GOAL_STATE\n</goal_state>\n</system-reminder>';
  const result = freshContextCompactMessages(messages, 40_000, {
    force: true,
    handoffText: 'FULL_CUMULATIVE_SESSION_SUMMARY',
    latestUserPrefix: goalReminder,
  });

  assert.deepEqual(result.messages.slice(0, sessionPrefix.length), sessionPrefix);
  const summaryIndex = result.messages.findIndex(
    (message) => typeof message?.content === 'string' && message.content.startsWith(SUMMARY_PREFIX)
  );
  assert.equal(summaryIndex, sessionPrefix.length);
  assert.equal(result.messages[summaryIndex + 1]?.role, 'assistant');
  assert.equal(result.messages[summaryIndex + 1]?.content, '.');
  const volatileTail = result.messages.at(-1);
  assert.equal(volatileTail?.role, 'user');
  assert.ok(String(volatileTail.content).startsWith(goalReminder));
  assert.ok(
    String(volatileTail.content).endsWith(
      '<system-reminder>\n# Current Time\n2026-09-01\n</system-reminder>\n\nLATEST_REAL_USER_INSTRUCTION'
    )
  );
  assert.equal(String(volatileTail.content).includes('STALE_GOAL_STATE'), false);
  assert.equal((String(volatileTail.content).match(/<goal_state>/g) || []).length, 1);
  assert.equal(String(result.messages[summaryIndex].content).includes('CURRENT_GOAL_STATE'), false);
  assert.equal(
    result.messages.some((message) => message?.content === 'OLD_TOOL_RESULT'),
    true
  );
  assert.equal(result.diagnostics.retainedAssistantToolMessages, 1);
  assert.equal(result.diagnostics.retainedProviderReplayMessages, 0);
});

test('mid-turn Compact resumes completed progress instead of replaying the latest request as unanswered', () => {
  const result = freshContextCompactMessages(
    [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'older request' },
      { role: 'assistant', content: 'older answer' },
      { role: 'user', content: '모바일뷰로도 볼 수 있나?' },
      {
        role: 'assistant',
        content: '모바일 viewport로 전환해 확인하겠습니다.',
        toolCalls: [
          { id: 'goal-call', name: 'goal', arguments: '{"action":"resume"}' },
          { id: 'browser-call', name: 'browser', arguments: '{"action":"emulate"}' },
        ],
      },
      { role: 'tool', toolCallId: 'goal-call', content: 'goal resumed' },
      { role: 'tool', toolCallId: 'browser-call', content: '390x844 mobile emulation completed' },
    ],
    40_000,
    {
      force: true,
      handoffText: 'The user requested mobile inspection; tool execution is absent from this Memory handoff.',
      activeTurn: true,
    }
  );

  const latestRequest = result.messages.find(
    (message) => message?.role === 'user' && message.content === '모바일뷰로도 볼 수 있나?'
  );
  const continuation = result.messages.at(-1);
  assert.ok(latestRequest);
  assert.equal(continuation?.role, 'user');
  assert.match(String(continuation?.content), /already in progress/i);
  assert.match(String(continuation?.content), /without repeating/i);
  assert.equal(
    result.messages.find((message) => message.toolCallId === 'browser-call')?.content,
    '390x844 mobile emulation completed'
  );
  assert.equal(result.diagnostics.activeTurnContinuation, true);
});

test('out-of-loop Compact does not fabricate an active continuation from completed history', () => {
  const result = freshContextCompactMessages(
    [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'completed request' },
      { role: 'assistant', content: 'completed answer' },
    ],
    40_000,
    {
      force: true,
      handoffText: 'The request and answer are complete.',
    }
  );

  assert.equal(
    result.messages.some(
      (message) => typeof message?.content === 'string' && message.content.includes('<active-turn-continuation>')
    ),
    false
  );
  assert.equal(result.diagnostics.activeTurnContinuation, false);
});

test('mid-turn continuation survives repeated Compact once and clears for a new real user request', () => {
  const first = freshContextCompactMessages(
    [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'inspect the mobile page' },
      {
        role: 'assistant',
        content: 'starting the inspection',
        toolCalls: [{ id: 'browser-call', name: 'browser', arguments: '{}' }],
      },
      { role: 'tool', toolCallId: 'browser-call', content: 'inspection completed' },
    ],
    40_000,
    {
      force: true,
      handoffText: 'The inspection completed and only interpretation remains.',
      activeTurn: true,
    }
  );
  const second = freshContextCompactMessages(first.messages, 40_000, {
    force: true,
    handoffText: 'The inspection completed and only interpretation remains.',
    activeTurn: true,
  });
  const continuationCount = second.messages.filter(
    (message) => typeof message?.content === 'string' && message.content.includes('<active-turn-continuation>')
  ).length;
  assert.equal(continuationCount, 1);
  assert.equal(
    second.messages.filter((message) => message?.role === 'user' && message.content === 'inspect the mobile page')
      .length,
    1
  );
  assert.equal(second.diagnostics.activeTurnContinuation, true);

  const nextTurn = freshContextCompactMessages(
    [...second.messages, { role: 'user', content: 'show me the final result' }],
    40_000,
    {
      force: true,
      handoffText: 'The prior mobile inspection is complete.',
      activeTurn: true,
    }
  );
  assert.equal(nextTurn.messages.at(-1)?.content, 'show me the final result');
  assert.equal(nextTurn.diagnostics.activeTurnContinuation, false);
});

test('263k-class tool-heavy transcript retains bounded recent execution and archives overflow', (t) => {
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-heavy-compact-'));
  process.env.MIXDOG_DATA_DIR = dataDir;
  t.after(() => {
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });
  const messages = [
    { role: 'system', content: 'session rules' },
    { role: 'user', content: 'initial tool-heavy request' },
  ];
  const payload = 'large completed tool result '.repeat(320);
  for (let index = 0; index < 127; index += 1) {
    const id = `tool-heavy-${index}`;
    messages.push(
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id, name: 'read', arguments: `{"index":${index}}` }],
        providerReplay: { items: [{ type: 'reasoning', encrypted_content: `replay-${index}` }] },
      },
      { role: 'tool', toolCallId: id, content: `${payload}${index}` }
    );
  }
  messages.push(
    { role: 'assistant', content: 'all completed tools were processed' },
    { role: 'user', content: 'LATEST_AFTER_127_TOOLS' }
  );
  const handoffText = `FULL_SESSION_SUMMARY ${'covered context '.repeat(4_000)}`.trim();
  const result = freshContextCompactMessages(messages, 136_000, {
    force: true,
    handoffText,
    handoffTokenCap: 136_000,
    sessionId: 'test-compact-heavy-execution',
    contextWindow: 500_000,
  });

  assert.ok(result.diagnostics.baseTokens > 200_000);
  assert.ok(result.diagnostics.finalTokens < 136_000);
  assert.ok(
    result.messages.some(
      (message) =>
        typeof message?.content === 'string' &&
        message.content.startsWith(SUMMARY_PREFIX) &&
        message.content.includes(handoffText)
    )
  );
  assert.equal(result.messages.at(-1)?.content, 'LATEST_AFTER_127_TOOLS');
  assert.ok(result.messages.some((message) => message.toolCallId === 'tool-heavy-126'));
  assert.equal(result.diagnostics.toolHistoryBudget, 25_000);
  assert.ok(result.diagnostics.toolHistoryTokens <= 25_000);
  assert.ok(result.diagnostics.omittedToolGroups > 0);
});

test('the deterministic builder fails closed instead of truncating an oversized complete handoff', () => {
  const messages = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'old request' },
    { role: 'assistant', content: 'old answer' },
    { role: 'user', content: 'current request' },
  ];
  assert.throws(
    () =>
      freshContextCompactMessages(messages, 12_000, {
        force: true,
        handoffText: `[old episode] ${'context '.repeat(20_000)}`,
        handoffTokenCap: 50_000,
      }),
    /complete handoff exceeds the compact budget/
  );
});

test('Reference files retain only a stable path manifest after Compact', () => {
  const result = freshContextCompactMessages(
    [
      { role: 'system', content: 'system' },
      {
        role: 'user',
        content: 'Reference files:\n\n### C:\\Project\\refs\\design.md\n```\nVERY_LARGE_REFERENCE_BODY\n```',
      },
      { role: 'assistant', content: '.' },
      { role: 'user', content: 'older request' },
      { role: 'assistant', content: 'older answer' },
      { role: 'user', content: 'latest request' },
    ],
    40_000,
    {
      force: true,
      handoffText: 'FULL_SESSION_HANDOFF',
    }
  );
  const encoded = JSON.stringify(result.messages);
  assert.ok(encoded.includes('C:\\\\Project\\\\refs\\\\design.md'));
  assert.equal(encoded.includes('VERY_LARGE_REFERENCE_BODY'), false);
  assert.equal(result.messages.at(-1)?.content, 'latest request');
});

const GENERATED_HANDOFF = [
  '## Goal',
  '- continue the task',
  '',
  '## Constraints & Preferences',
  '- preserve context',
  '',
  '## Progress',
  '### Done',
  '- inspected prior work',
  '### In Progress',
  '- implementing',
  '### Blocked',
  '- (none)',
  '',
  '## Key Decisions',
  '- one Compact path',
  '',
  '## Next Steps',
  '1. verify',
  '',
  '## Critical Context',
  '- full coverage',
  '',
  '## Relevant Files',
  '- src/example.mjs',
].join('\n');

test('Agent sessions use the same fresh layout with a session-local handoff', async () => {
  let providerCalls = 0;
  const provider = {
    name: 'fake',
    async send() {
      providerCalls += 1;
      return {
        content: GENERATED_HANDOFF,
        usage: { inputTokens: 100, outputTokens: 50, cachedTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
  const result = await runFreshContextCompact({
    config: {},
    sessionRef: {
      id: 'sess-agent-fresh',
      compaction: { conversationThresholdTokens: 1 },
      owner: 'agent',
      provider: 'fake',
      model: 'fake-model',
      contextWindow: 100_000,
    },
    messages: [
      { role: 'system', content: 'agent rules' },
      { role: 'user', content: 'older agent request' },
      { role: 'assistant', content: 'older agent answer' },
      { role: 'user', content: 'LATEST_AGENT_REQUEST' },
    ],
    compactBudgetTokens: 40_000,
    compactPolicy: { reserveTokens: 0, contextWindow: 100_000, handoffTimeoutMs: 5_000 },
    sessionId: 'sess-agent-fresh',
    provider,
    model: 'fake-model',
    sendOpts: {},
  });
  assert.equal(providerCalls, 1);
  assert.equal(result.handoffSource, 'session-local');
  assert.equal(result.messages.at(-1)?.content, 'LATEST_AGENT_REQUEST');
  assert.equal(
    result.messages.some((message) => message?.role === 'tool'),
    false
  );
  assert.ok(
    result.messages.some(
      (message) => typeof message?.content === 'string' && message.content.includes('one Compact path')
    )
  );
});

test('large conversation input is batched completely within the summary model window', async () => {
  let providerCalls = 0;
  const prompts = [];
  const provider = {
    name: 'fake',
    async send(input) {
      providerCalls += 1;
      prompts.push(input[1].content);
      return { content: GENERATED_HANDOFF, usage: { inputTokens: 10, outputTokens: 5 } };
    },
  };
  const result = await runFreshContextCompact({
    config: {},
    sessionRef: {
      id: 'sess-memory-compressed',
      provider: 'fake',
      model: 'fake-model',
      cwd: 'C:\\Project\\mixdog',
      contextWindow: 24_000,
    },
    messages: [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'old request' },
      { role: 'assistant', content: 'old answer' },
      ...Array.from({ length: 60 }, (_, i) => ({
        role: 'assistant',
        content: `SOURCE_MARKER_${i}_END`.padEnd(1600, '.'),
      })),
      { role: 'user', content: 'LATEST_MEMORY_REQUEST' },
    ],
    compactBudgetTokens: 12_000,
    compactPolicy: { reserveTokens: 0, contextWindow: 24_000, handoffTimeoutMs: 5_000 },
    sessionId: 'sess-memory-compressed',
    provider,
    model: 'fake-model',
    sendOpts: {},
  });
  assert.ok(providerCalls > 1);
  for (let i = 0; i < 60; i += 1) {
    assert.ok(
      prompts.some((prompt) => prompt.includes(`SOURCE_MARKER_${i}_END`)),
      `source fragment ${i} was omitted`
    );
  }
  assert.equal(result.usage.inputTokens, providerCalls * 10);
  assert.equal(result.handoffSource, 'session-local');
  assert.equal(result.messages.at(-1)?.content, 'LATEST_MEMORY_REQUEST');
  assert.ok(
    result.messages.some(
      (message) => typeof message?.content === 'string' && message.content.includes('one Compact path')
    )
  );
});

test('the deferred tool list and bridge guidance in the system prompt survive Compact', async () => {
  const system = [
    'You are the Lead.',
    '<available-deferred-tools>\nmcp__demo__fetch\nmcp__demo__search\n</available-deferred-tools>',
    '<tool-bridge>\nDeferred tools are run with call_tool {name, arguments}.\n</tool-bridge>',
  ].join('\n\n');
  const messages = [{ role: 'system', content: system }];
  for (let index = 0; index < 7; index += 1) {
    messages.push({ role: 'user', content: `request-${index}` }, { role: 'assistant', content: `answer-${index}` });
  }
  const result = await runFreshContextCompact({
    config: {},
    model: 'fake-model',
    provider: {
      name: 'fake',
      async send() {
        return { content: GENERATED_HANDOFF };
      },
    },
    sessionRef: {
      id: 'sess-deferred-list-survives',
      cwd: 'C:\\Project\\mixdog',
      compaction: { conversationThresholdTokens: 1 },
      contextWindow: 100_000,
      compactBoundaryTokens: 100_000,
    },
    messages,
    compactBudgetTokens: 30_000,
    compactPolicy: { contextWindow: 100_000, boundaryTokens: 100_000, reserveTokens: 0 },
    sessionId: 'sess-deferred-list-survives',
  });
  const systems = result.messages.filter((message) => message.role === 'system');
  assert.equal(systems.length, 1);
  assert.equal(systems[0].content, system, 'the system prompt, with its deferred list, is carried over unchanged');
  assert.ok(result.messages.some((message) => message.role === 'user' && message.content.startsWith(SUMMARY_PREFIX)));
});

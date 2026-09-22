import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectContext } from './context-inspection.mjs';
import { createContextStatus } from './context-status.mjs';
import {
  estimateMessagesTokens,
  estimateToolSchemaTokens,
  messageReasoningBreakdown,
  summarizeContextMessages,
} from '../runtime/agent/orchestrator/session/context-utils.mjs';
import { SUMMARY_PREFIX } from '../runtime/agent/orchestrator/session/compact.mjs';
import { recordProviderContextBaseline } from '../runtime/agent/orchestrator/session/loop/compact-policy.mjs';
import { withRuntimeUserContext } from '../runtime/agent/orchestrator/session/runtime-user-context.mjs';

const fixture = (extra = {}) => ({
  sessionId: 'inspection',
  provider: 'openai',
  model: 'test',
  messages: [
    { role: 'system', content: '# Rules\nFollow instructions.\n# Core Memory\nPrivate memory.' },
    { role: 'user', content: '<skill>\n<name>sample</name>\nSkill instructions.\n</skill>' },
    { role: 'user', content: 'A normal question.' },
    { role: 'assistant', content: 'A normal answer.' },
  ],
  tools: [{ name: 'read', description: 'Read a file.', inputSchema: { type: 'object' } }],
  overheadTokens: 8,
  ...extra,
});

test('inspection conserves estimates and reports every item without exposing preview content', () => {
  const input = fixture();
  const result = inspectContext(input);
  assert.equal(
    result.estimatedTokens,
    estimateMessagesTokens(input.messages) + estimateToolSchemaTokens(input.tools) + 8
  );
  assert.equal(
    result.entries.reduce((sum, row) => sum + row.tokens, 0),
    result.estimatedTokens
  );
  assert.ok(result.categories.find((row) => row.key === 'memory').tokens > 0);
  assert.ok(result.categories.find((row) => row.key === 'user').tokens > 0);
  assert.doesNotMatch(JSON.stringify(result), /Private memory|normal answer|Read a file/);
  const memory = result.entries.find((row) => row.category === 'memory');
  assert.match(inspectContext(input, { entryId: memory.id, revision: result.revision }).preview.text, /Private memory/);
  // Message rows expose role and ordinal so UIs can localize the label.
  const answer = result.entries.find((row) => row.id === 'message:3');
  assert.deepEqual(
    [answer.kind, answer.role, answer.ordinal, answer.label],
    ['message', 'assistant', 1, 'assistant · 1']
  );
  assert.equal(result.entries.find((row) => row.label === 'Skill: sample').category, 'skills');
  const many = inspectContext(
    fixture({ messages: Array.from({ length: 1001 }, (_, index) => ({ role: 'user', content: `message ${index}` })) })
  );
  assert.equal(many.entries.filter((row) => row.kind === 'message').length, 1001);
});

test('runtime-authored user rows read as system sections and skill sections name themselves', () => {
  const result = inspectContext(
    fixture({
      messages: [
        { role: 'system', content: '# Skills\nApply matching skills.\n# available-skills\n- browser-use: pages.' },
        { role: 'user', content: '<system-reminder>\nPostToolBatch hook blocked continuation\n</system-reminder>' },
        { role: 'user', content: '<mixdog-runtime kind="runtime-control">\n[mixdog-runtime] nudge\n</mixdog-runtime>' },
        // The stored transcript carries no envelope — that projection runs on the
        // provider-bound copy only — so a task notification has to be recognized
        // by its own shape or it inflates the person's message count.
        {
          role: 'user',
          content: 'Async shell task job_1 (completed, exit 1) finished.\n\nResult:\n> [status: completed]',
        },
        { role: 'user', content: 'A normal question.' },
        { role: 'assistant', content: 'A normal answer.' },
      ],
    })
  );
  // Only the two real turns stay message rows, each under its own role.
  const turns = result.entries.filter((entry) => entry.kind === 'message');
  assert.deepEqual(
    turns.map((entry) => [entry.category, entry.group, entry.ordinal]),
    [
      ['user', 'user', 1],
      ['assistant', 'assistant', 1],
    ]
  );
  // A reminder is the system speaking through a user-role row, so it counts as
  // a system message and only its group says where it came from.
  assert.deepEqual(
    result.entries.filter((entry) => entry.group === 'reminder').map((entry) => [entry.category, entry.label]),
    [
      ['system', 'System reminder'],
      ['system', 'System reminder'],
      ['system', 'System reminder'],
    ]
  );
  assert.deepEqual(
    result.entries
      .filter((entry) => entry.category === 'system' && entry.group === 'instruction')
      .map((entry) => entry.label),
    ['Skill instructions', 'Available skills']
  );
  assert.equal(
    result.entries.reduce((sum, row) => sum + row.tokens, 0),
    result.estimatedTokens
  );
});

test('injected skill bodies file under skills while actual tool results remain tool results', () => {
  const body = '<skill>\n<name>sample</name>\nSkill instructions.\n</skill>';
  const input = fixture({
    messages: [
      { role: 'system', content: body },
      { role: 'user', content: body },
      { role: 'assistant', content: body },
      { role: 'tool', name: 'tool_search', toolCallId: 'skill-load', content: body },
    ],
    tools: [],
    overheadTokens: 0,
  });
  const result = inspectContext(input);
  assert.deepEqual(
    result.entries.map((entry) => entry.category),
    ['system', 'skills', 'assistant', 'toolResults']
  );
  for (const entry of result.entries) {
    assert.equal(inspectContext(input, { entryId: entry.id, revision: result.revision }).preview.text, body);
  }
  assert.equal(result.estimatedTokens, estimateMessagesTokens(input.messages));
  assert.equal(
    result.entries.reduce((sum, entry) => sum + entry.tokens, 0),
    result.estimatedTokens
  );
});

test('runtime provenance and text blocks distinguish injected context from human turns', () => {
  const reminder = '<system-reminder>\n# Current Time\n2026-01-01\n</system-reminder>';
  const notification =
    '<task-notification>\n<task-id>job_1</task-id>\n<status>completed</status>\n<summary>Shell task job_1 completed</summary>\n</task-notification>';
  const cases = [
    [{ role: 'user', content: 'Human request', meta: { source: 'steering' } }, 'user'],
    [{ role: 'user', content: notification, meta: { source: 'task-notification' } }, 'system'],
    [{ role: 'user', content: notification }, 'system'],
    [{ role: 'user', content: [{ type: 'text', text: reminder }] }, 'system'],
    [{ role: 'user', content: [{ type: 'text', text: '<skill>\n<name>sample</name>\nBody\n</skill>' }] }, 'skills'],
    [{ role: 'user', content: 'Injected skill body', meta: 'skill' }, 'system'],
    [{ role: 'user', content: 'Reference files: example.txt' }, 'system'],
    [{ role: 'user', content: '<mixdog-runtime kind="context-attachment">\nContext\n</mixdog-runtime>' }, 'system'],
    [{ role: 'user', content: '<mixdog-runtime kind="compact-state">\nSummary\n</mixdog-runtime>' }, 'system'],
    [{ role: 'user', content: 'Saved summary', meta: { source: 'compact-summary' } }, 'system'],
    [{ role: 'user', content: 'Continue working', meta: { source: 'goal-continuation' } }, 'system'],
    [{ role: 'developer', content: 'Follow these rules.' }, 'system'],
    [
      { role: 'tool', name: 'tool_search', toolCallId: 'load-1', content: 'Loaded deferred tools: browser' },
      'toolResults',
    ],
  ];
  for (const [message, category] of cases) {
    const input = fixture({ messages: [message], tools: [], overheadTokens: 0 });
    const before = JSON.stringify(message);
    const result = inspectContext(input);
    assert.deepEqual(
      result.entries.map((entry) => entry.category),
      [category],
      before
    );
    assert.equal(
      result.entries.reduce((sum, entry) => sum + entry.tokens, 0),
      estimateMessagesTokens([message])
    );
    assert.equal(JSON.stringify(message), before);
  }
});

test('mixed human and runtime content is split without losing attachments, previews or tokens', () => {
  const reminder = '<system-reminder>\n# Current Time\n2026-01-01\n</system-reminder>';
  const human = 'Human request';
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
  const messages = [
    withRuntimeUserContext({ role: 'user', content: human }, { suffix: `\n${reminder}` }),
    withRuntimeUserContext(
      { role: 'user', content: [{ type: 'text', text: human }, image] },
      { prefix: `${reminder}\n`, suffix: `\n${reminder}` }
    ),
    { role: 'user', content: `${reminder}\n${human}` },
    { role: 'user', content: `${human}\n${reminder}` },
    { role: 'user', content: `${reminder}\n${human}\n${reminder}` },
  ];
  for (const message of messages) {
    const input = fixture({ messages: [message], tools: [], overheadTokens: 0 });
    const before = JSON.stringify(message);
    const result = inspectContext(input);
    const user = result.entries.filter((entry) => entry.category === 'user');
    assert.equal(user.length, 1);
    assert.equal(user[0].ordinal, 1);
    const userPreview = inspectContext(input, { entryId: user[0].id, revision: result.revision }).preview.text;
    assert.match(userPreview, /Human request/);
    assert.doesNotMatch(userPreview, /Current Time|2026-01-01/);
    const system = result.entries.filter((entry) => entry.category === 'system');
    assert.ok(system.length > 0);
    for (const entry of system) {
      const preview = inspectContext(input, { entryId: entry.id, revision: result.revision }).preview.text;
      assert.doesNotMatch(preview, /Human request/);
    }
    if (Array.isArray(message.content)) {
      assert.equal(result.entries.filter((entry) => entry.category === 'attachments').length, 1);
    }
    assert.equal(new Set(result.entries.map((entry) => entry.id)).size, result.entries.length);
    assert.equal(
      result.entries.reduce((sum, entry) => sum + entry.tokens, 0),
      estimateMessagesTokens([message])
    );
    assert.equal(JSON.stringify(message), before);
  }
});

test('previews exclude opaque fields, binary content, and terminal control sequences', () => {
  const input = fixture({
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Visible reasoning', thinkingSignature: 'SECRET_SIGNATURE' },
          { type: 'image', source: { type: 'base64', data: 'SECRET_BINARY' } },
          { type: 'text', text: '\x1b]52;c;SECRET_CLIPBOARD\x07Visible answer\x00' },
        ],
        thinkingBlocks: [{ type: 'thinking', thinking: 'More reasoning', signature: 'SECRET_NATIVE_SIGNATURE' }],
        providerMetadata: { secret: 'SECRET_METADATA' },
      },
    ],
  });
  const initial = inspectContext(input);
  const result = inspectContext(input, { entryId: 'message:0', revision: initial.revision });
  assert.match(result.preview.text, /Visible reasoning|Visible answer/);
  assert.doesNotMatch(JSON.stringify(result), /SECRET_|\u001b|\u0000/);
  assert.deepEqual(input.messages[0].content[0].thinkingSignature, 'SECRET_SIGNATURE');
});

test('the agent tool is a system tool and a replayed turn previews its content once', () => {
  const input = fixture({
    messages: [
      {
        role: 'assistant',
        content: 'Visible answer',
        toolCalls: [{ id: 'call-1', name: 'Skill', arguments: { name: 'docx' } }],
        providerReplay: {
          items: [
            { type: 'thinking', thinking: 'Replayed reasoning', signature: 'SECRET_SIGNATURE' },
            { type: 'text', text: 'Visible answer' },
            { type: 'tool_use', id: 'call-1', name: 'Skill', input: { name: 'docx' } },
          ],
        },
      },
    ],
    tools: [{ name: 'agent', description: 'Delegate.', inputSchema: { type: 'object' } }],
  });
  const result = inspectContext(input);
  assert.equal(result.entries.find((entry) => entry.label === 'agent').category, 'tools');
  assert.equal(result.categories.find((category) => category.key === 'agents').count, 0);
  const preview = inspectContext(input, { entryId: 'message:0', revision: result.revision }).preview.text;
  assert.equal(preview.match(/Visible answer/g).length, 1);
  assert.equal(preview.match(/"docx"/g).length, 1);
  assert.doesNotMatch(preview, /Replayed reasoning/);
  const reasoningPreview = inspectContext(input, { entryId: 'reasoning:0', revision: result.revision }).preview.text;
  assert.match(reasoningPreview, /Replayed reasoning/);
  assert.doesNotMatch(reasoningPreview, /SECRET_|Visible answer|"docx"/);
  assert.doesNotMatch(preview, /SECRET_/);
});

test('current reasoning is split from assistant occupancy without changing totals or leaking opaque data', () => {
  const thought = { type: 'thinking', thinking: 'plan '.repeat(80), signature: 'S'.repeat(400) };
  const reasoning = { type: 'reasoning', encrypted_content: 'E'.repeat(800), summary: [] };
  const variants = [
    { thinkingBlocks: [thought] },
    { reasoningItems: [reasoning] },
    { assistantBlocks: [thought, { type: 'text', text: 'Visible answer' }] },
    { content: [thought, { type: 'text', text: 'Visible answer' }] },
    {
      providerMetadata: {
        gemini: {
          thoughtParts: [{ thought: true, text: 'plan '.repeat(80), thoughtSignature: 'S'.repeat(400) }],
        },
      },
    },
    {
      providerReplay: {
        items: [reasoning, { type: 'message', content: [{ type: 'output_text', text: 'Visible answer' }] }],
      },
      reasoningItems: [reasoning],
    },
  ];
  for (const variant of variants) {
    const input = fixture({
      messages: [{ role: 'assistant', content: 'Visible answer', ...variant }],
      tools: [],
      overheadTokens: 0,
    });
    const before = JSON.stringify(input.messages);
    const result = inspectContext(input);
    const total = estimateMessagesTokens(input.messages);
    const reasoningTokens = result.categories.find((row) => row.key === 'reasoning').tokens;
    assert.ok(reasoningTokens > 0);
    assert.equal(result.estimatedTokens, total);
    assert.equal(result.categories.find((row) => row.key === 'assistant').tokens + reasoningTokens, total);
    const summary = summarizeContextMessages(input.messages);
    assert.equal(summary.estimatedTokens, total);
    assert.equal(summary.semantic.reasoning.tokens, reasoningTokens);
    assert.equal(summary.semantic.assistant.tokens + reasoningTokens, total);
    const preview = inspectContext(input, { entryId: 'reasoning:0', revision: result.revision }).preview.text;
    assert.doesNotMatch(preview, /S{64}|E{64}/);
    assert.equal(JSON.stringify(input.messages), before);
    const calibrated = inspectContext({ ...input, coverage: { count: 1, tokens: total * 2 } });
    assert.equal(calibrated.estimatedTokens, total * 2);
    assert.equal(calibrated.categories.find((row) => row.key === 'reasoning').tokens, reasoningTokens * 2);
    const cleared = inspectContext({ ...input, messages: [messageReasoningBreakdown(input.messages[0]).message] });
    assert.equal(cleared.categories.find((row) => row.key === 'reasoning').tokens, 0);
    assert.notEqual(cleared.revision, result.revision);
  }
});

test('previews are bounded, revisions reject stale indexes, and key order is not an extra message', () => {
  const input = fixture({ messages: [{ role: 'user', content: 'x'.repeat(40_000) }] });
  const initial = inspectContext(input);
  const preview = inspectContext(input, { entryId: 'message:0', revision: initial.revision }).preview;
  assert.equal(preview.text.length, 32_000);
  assert.equal(preview.truncated, true);
  input.messages[0] = { content: input.messages[0].content, role: 'user' };
  assert.equal(inspectContext(input).revision, initial.revision);
  input.messages[0].content = 'y'.repeat(40_000);
  const stale = inspectContext(input, { entryId: 'message:0', revision: initial.revision }).preview;
  assert.equal(stale.stale, true);
  assert.equal(stale.text, '');
});

test('entries group by role and producing tool, and tools carry their wire state', () => {
  const input = fixture({
    messages: [
      { role: 'user', content: 'question' },
      { role: 'assistant', content: 'calling', toolCalls: [{ id: 'call-1', name: 'read', arguments: {} }] },
      { role: 'tool', toolCallId: 'call-1', content: 'file body' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call-2', name: 'shell' }] },
      { role: 'tool', toolCallId: 'call-2', content: 'output' },
      { role: 'user', content: `${SUMMARY_PREFIX} earlier turns` },
    ],
    tools: [
      { name: 'read', description: 'Read.', inputSchema: { type: 'object' } },
      { name: 'office', description: 'Office.', inputSchema: { type: 'object' } },
      { name: 'browser', description: 'Browser.', inputSchema: { type: 'object' }, deferLoading: true },
    ],
    deferredCatalogNames: new Set(['office', 'browser']),
  });
  const result = inspectContext(input);
  const turns = result.entries.filter((entry) => entry.kind === 'message');
  // Ordinals count turns per role, so the second assistant turn is "assistant 2"
  // even though it sits at transcript index 3.
  // A compaction summary is runtime context, not a human turn.
  assert.deepEqual(
    turns.map((entry) => [entry.category, entry.group, entry.ordinal]),
    [
      ['user', 'user', 1],
      ['assistant', 'assistant', 1],
      ['assistant', 'assistant', 2],
      ['system', 'summary', 1],
    ]
  );
  // A tool result is a row of its own, grouped under the tool that produced it
  // and numbered within that tool.
  assert.deepEqual(
    result.entries
      .filter((entry) => entry.kind === 'toolResult')
      .map((entry) => [entry.category, entry.group, entry.ordinal]),
    [
      ['toolResults', 'read', 1],
      ['toolResults', 'shell', 1],
    ]
  );
  const firstTurn = result.entries.find((entry) => entry.id === 'message:1');
  // The turn keeps the name only; the size moved to the tool row.
  assert.deepEqual(
    firstTurn.toolResults.map((row) => row.name),
    ['read']
  );
  assert.equal(firstTurn.tokens, estimateMessagesTokens(input.messages.slice(1, 2)));
  assert.equal(
    result.entries.find((entry) => entry.id === 'message:2').tokens,
    estimateMessagesTokens(input.messages.slice(2, 3))
  );
  assert.equal(result.entries.find((entry) => entry.id === 'message:3').toolResults[0].name, 'shell');
  assert.equal(
    result.entries.reduce((sum, row) => sum + row.tokens, 0),
    result.estimatedTokens
  );
  const preview = inspectContext(input, { entryId: 'message:1', revision: result.revision }).preview.text;
  assert.match(preview, /calling/);
  assert.doesNotMatch(preview, /file body/);
  assert.match(inspectContext(input, { entryId: 'message:2', revision: result.revision }).preview.text, /file body/);
  const states = Object.fromEntries(
    result.entries.filter((entry) => entry.kind === 'tool').map((entry) => [entry.label, entry.state])
  );
  assert.deepEqual(states, { read: 'active', office: 'loaded', browser: 'deferred' });
  assert.equal(result.entries.find((entry) => entry.label === 'browser').tokens, 0);
  assert.equal(result.calibration.source, 'estimate');
});

test('a provider reading redistributes covered estimates exactly and scales the tail', () => {
  const input = fixture({
    messages: [
      { role: 'user', content: 'first '.repeat(400) },
      { role: 'assistant', content: 'reply '.repeat(400) },
      { role: 'user', content: 'appended '.repeat(400) },
    ],
  });
  const raw = inspectContext(input);
  const coveredRaw = raw.entries
    .filter((entry) => entry.id !== 'message:2')
    .reduce((sum, entry) => sum + entry.estimatedTokens, 0);
  const measured = Math.round(coveredRaw * 0.75);
  const calibrated = inspectContext({ ...input, coverage: { tokens: measured, count: 2 } });
  assert.equal(calibrated.calibration.source, 'provider');
  assert.equal(calibrated.calibration.measuredTokens, measured);
  assert.equal(calibrated.calibration.ratio, 0.75);
  const coveredNow = calibrated.entries
    .filter((entry) => entry.id !== 'message:2')
    .reduce((sum, entry) => sum + entry.tokens, 0);
  assert.equal(coveredNow, measured);
  const tail = calibrated.entries.find((entry) => entry.id === 'message:2');
  assert.equal(tail.tokens, Math.round(tail.estimatedTokens * 0.75));
  assert.equal(
    calibrated.estimatedTokens,
    calibrated.categories.reduce((sum, row) => sum + row.tokens, 0)
  );
  assert.equal(raw.estimatedTokens, calibrated.calibration.estimatedTokens);
  // Every entry still exposes its raw estimate for the UI to show on demand.
  assert.ok(calibrated.entries.every((entry) => Number.isInteger(entry.estimatedTokens)));
  // A reading that cannot be about this request leaves the estimates alone.
  const rejected = inspectContext({ ...input, coverage: { tokens: coveredRaw * 10, count: 2 } });
  assert.equal(rejected.calibration.source, 'estimate');
  assert.equal(rejected.calibration.rejectedRatio, 10);
  assert.equal(rejected.estimatedTokens, raw.estimatedTokens);
});

test('status inspection reconciles with the aligned provider baseline', () => {
  const messages = [
    { role: 'user', content: 'committed '.repeat(200) },
    { role: 'assistant', content: 'done '.repeat(200) },
  ];
  const session = { id: 'live', provider: 'openai', model: 'test', contextWindow: 10000, messages, tools: [] };
  const api = createContextStatus({
    getSession: () => session,
    getRoute: () => ({ provider: 'openai', model: 'test' }),
    getCurrentCwd: () => '.',
    getMode: () => 'full',
  });
  const before = api.contextStatus({ inspect: true });
  assert.equal(before.inspection.calibration.source, 'estimate');
  const measured = Math.round(before.inspection.estimatedTokens * 0.8);
  recordProviderContextBaseline(session, messages, { inputTokens: measured, outputTokens: 0 }, { sendTools: [] });
  const after = api.contextStatus({ inspect: true });
  assert.equal(after.inspection.calibration.source, 'provider');
  assert.equal(after.inspection.estimatedTokens, measured);
});

test('status inspection is opt-in, uncached, live, and absent from ordinary status', () => {
  const session = {
    id: 'live',
    provider: 'openai',
    model: 'test',
    contextWindow: 10000,
    messages: [{ role: 'user', content: 'committed' }],
    tools: [],
  };
  const api = createContextStatus({
    getSession: () => session,
    getRoute: () => ({ provider: 'openai', model: 'test' }),
    getCurrentCwd: () => '.',
    getMode: () => 'full',
  });
  const ordinary = api.contextStatus();
  assert.equal(ordinary.inspection, undefined);
  const first = api.contextStatus({ inspect: true });
  session.liveTurnMessages = [...session.messages, { role: 'assistant', content: 'live content' }];
  const next = api.contextStatus({ inspect: true });
  assert.notEqual(next.inspection.revision, first.inspection.revision);
  assert.equal(next.inspection.entries.filter((entry) => entry.kind === 'message').length, 2);
  const result = api.contextStatus({ inspect: true, entryId: 'message:1', revision: next.inspection.revision });
  assert.equal(result.inspection.preview.text, 'live content');
  // The reader holds the revision the inspector listed, and the running turn
  // keeps appending under it. Resolving against the live transcript answered
  // "context changed" for nearly every entry opened during a turn; the
  // retained snapshot answers the revision that was actually read.
  session.liveTurnMessages = [...session.liveTurnMessages, { role: 'user', content: 'appended after the read' }];
  const moved = api.contextStatus({ inspect: true, entryId: 'message:1', revision: next.inspection.revision });
  assert.equal(moved.inspection.preview.stale, false);
  assert.equal(moved.inspection.preview.text, 'live content');
  // A revision nobody retained is still refused rather than answered from a
  // different transcript.
  const forgotten = api.contextStatus({ inspect: true, entryId: 'message:1', revision: 'forgotten' });
  assert.equal(forgotten.inspection.preview.stale, true);
  assert.equal(api.contextStatus().inspection, undefined);
  assert.equal(session.inspection, undefined);
  assert.equal(ordinary.measurement.source, first.measurement.source);
});

test('attachments and named prompt blocks get their own rows instead of hiding in a message', () => {
  const messages = [
    {
      role: 'system',
      content:
        '# Rules\nFollow instructions.\n\n---\n<available-deferred-tools>\n- recall: Recall prior work.\n</available-deferred-tools>',
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Look at this.' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      ],
    },
  ];
  const result = inspectContext(fixture({ messages, tools: [] }));
  // The manifest block has no markdown heading, so the plain section split left
  // it nameless inside the system prompt; it is its own named row now.
  assert.deepEqual(
    result.entries.filter((entry) => entry.category === 'system').map((entry) => entry.label),
    ['Rules', 'Deferred tool list']
  );
  // The image is billed on its own allowance, so it leaves the user row.
  const attachment = result.entries.find((entry) => entry.category === 'attachments');
  assert.deepEqual([attachment.kind, attachment.role, attachment.ordinal], ['attachment', 'user', 1]);
  assert.ok(attachment.tokens > 0);
  const question = result.entries.find((entry) => entry.id === 'message:1');
  assert.ok(question.tokens > 0 && question.tokens < attachment.tokens);
  assert.equal(question.tokens + attachment.tokens, estimateMessagesTokens(messages.slice(1)));
  assert.equal(
    result.entries.reduce((sum, row) => sum + row.tokens, 0),
    result.estimatedTokens
  );
  assert.equal(result.estimatedTokens, estimateMessagesTokens(messages) + 8);
});

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// MIXDOG_DATA_DIR stays pinned to this temp root for the whole process (the
// store resolves it at write time and its writes are deferred).
const root = mkdtempSync(join(tmpdir(), 'mixdog-import-session-'));
process.env.MIXDOG_DATA_DIR = join(root, 'data');
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
mkdirSync(process.env.MIXDOG_DATA_DIR, { recursive: true });
const { createSession } = await import('../manager/session-lifecycle.mjs');
const { deleteSession, loadSession, listStoredSessionSummaries, _normalizeSummaryIndex } = await import('../store.mjs');
const { normalizedRow } = await import('../store-summary-catalog.mjs');
const { _withRegisteredProviderForTestAsync } = await import('../../providers/registry.mjs');
const { modelToolSchemaAllowlist } = await import('../../runtime-core/tool-profile.mjs');
const { listLeadSessions } = await import('../../../../../session-runtime/lifecycle/session-catalog.mjs');
const { convertConversationText } = await import('./convert.mjs');
const { buildImportOrigin, createImportedSession, importedSessionOptions, importedTranscriptMessages } = await import('./imported-session.mjs');
const { restoreTranscriptItems } = await import('../transcript-restore/restore.mjs');
const { classifySyntheticUserMessage, projectSyntheticUserEnvelopes } = await import('../synthetic-user-envelope.mjs');
const { isActualUserInstructionMessage } = await import('../compact/messages.mjs');
process.on('exit', () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const providerName = 'conversation-import-test';
const provider = {
  name: providerName,
  contextWindow: 128000,
  async send() {
    throw new Error('no turn runs during import');
  },
};

const leadOptions = {
  id: 'reservedidmustnotbereused',
  provider: providerName,
  model: 'fake-model',
  owner: 'agent',
  agent: 'worker',
  lane: 'agent',
  sourceType: 'agent',
  sourceName: 'worker',
  parentSessionId: 'parent-session',
  ownerSessionId: 'parent-session',
  visibility: 'agent-only',
  clientHostPid: 4242,
  mcpScopeId: 'scope-of-importing-runtime',
  cwd: join(root, 'elsewhere'),
  desktopSession: { classification: 'project', projectPath: join(root, 'elsewhere') },
  skipSkills: true,
  schemaAllowedTools: modelToolSchemaAllowlist('headless'),
  workflow: { id: 'headless', delegatesAgents: false },
};

const codexText = [
  { type: 'session_meta', payload: { id: 'foreign-1', cwd: root } },
  {
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Earlier reply' }] },
  },
  { type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"cmd":"ls"}' } },
  {
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Next step please' }] },
  },
]
  .map((record) => JSON.stringify(record))
  .join('\n');

test('an imported session is a normal Lead session with its system layer followed by plain turns', async () => {
  await _withRegisteredProviderForTestAsync(providerName, provider, async () => {
    const conversation = convertConversationText('codex', codexText);
    const origin = buildImportOrigin({
      source: 'codex',
      sourcePath: join(root, 'rollout-a.jsonl'),
      foreignSessionId: conversation.foreignSessionId,
      sourceCwd: conversation.cwd,
      importedAt: 1_700_000_000_000,
    });
    assert.equal(origin.key, 'codex:foreign-1');
    const desktopSession = { classification: 'project', projectPath: root };
    const ingested = [];
    const created = await createImportedSession({
      leadOptions,
      conversation,
      origin,
      cwd: root,
      desktopSession,
      ingestFn: (session) => ingested.push(session),
    });
    const reference = createSession(importedSessionOptions(leadOptions, { cwd: root, desktopSession }));
    try {
      assert.notEqual(created.id, leadOptions.id);
      const stored = loadSession(created.id);
      const systemCount = reference.messages.filter((message) => message.role === 'system').length;
      assert.ok(systemCount > 0);
      assert.deepEqual(
        stored.messages.slice(0, systemCount).map((message) => [message.role, message.cacheTier || null]),
        reference.messages.slice(0, systemCount).map((message) => [message.role, message.cacheTier || null])
      );
      const turns = stored.messages.slice(systemCount);
      assert.deepEqual(
        turns.map((message) => [message.role, message.content]),
        [
          ['user', conversation.turns[0].text],
          ['assistant', 'Earlier reply\n\n[ran tools: shell ×1]'],
          ['user', 'Next step please'],
        ]
      );
      assert.deepEqual(turns[1].meta.importedToolRuns, [
        { start: 15, end: 15 + '[ran tools: shell ×1]'.length, tools: [{ name: 'shell', count: 1 }] },
      ]);
      // Restored: the reply's text, then the tool use as one counted native tool row.
      assert.deepEqual(
        restoreTranscriptItems(stored.messages, { sessionId: created.id }).map((item) =>
          item.kind === 'tool'
            ? [item.kind, item.name, item.count, item.imported]
            : [item.kind, item.text]
        ),
        [
          ['user', conversation.turns[0].text],
          ['assistant', 'Earlier reply'],
          ['tool', 'shell', 1, true],
          ['user', 'Next step please'],
        ]
      );
      for (const message of turns) {
        assert.equal(typeof message.content, 'string');
        assert.match(message.meta.transcript.messageId, /^msg_[0-9a-f]{32}$/);
      }
      assert.equal(stored.messages.length, systemCount + 3);
      // Handed to content search once, saved and complete.
      assert.deepEqual(
        ingested.map((session) => [session.id, session.messages.length]),
        [[created.id, systemCount + 3]]
      );
      assert.deepEqual(stored.importOrigin, origin);
      assert.equal(stored.title, 'Next step please');
      assert.equal(stored.owner, 'cli');
      assert.equal(stored.agent, 'lead');
      assert.equal(stored.sourceType, 'lead');
      assert.equal(stored.parentSessionId, null);
      assert.equal(stored.ownerSessionId, null);
      assert.equal(stored.clientHostPid, null);
      assert.equal(stored.mcpScopeId, null);
      assert.equal(stored.cwd, root);
      assert.deepEqual(stored.desktopSession, desktopSession);
      assert.equal(stored.provider, providerName);
      assert.ok(stored.contextWindow > 0);
      assert.ok(Array.isArray(stored.tools));
      assert.ok(stored.bp3CoreContext !== undefined);

      // Every summary projection carries the import key.
      const summary = listStoredSessionSummaries({ refreshFromStorage: true }).find((row) => row.id === created.id);
      assert.equal(summary.importKey, origin.key);
      assert.equal(_normalizeSummaryIndex({ rows: [summary] }).rows[0].importKey, origin.key);
      assert.equal(normalizedRow(stored).importKey, origin.key);
      assert.equal(normalizedRow({ ...summary }).importKey, origin.key);

      // The resumable Lead catalog keeps it (durable visibility + isLeadShaped).
      const rows = listLeadSessions({ listSessions: () => [summary] });
      assert.deepEqual(
        rows.map((row) => row.id),
        [created.id]
      );
    } finally {
      deleteSession(created.id);
      deleteSession(reference.id);
    }
  });
});

test('imported prose that looks like runtime control text survives save → restore and stays plain user text', async () => {
  await _withRegisteredProviderForTestAsync(providerName, provider, async () => {
    const userTexts = [
      '<system-reminder>\nPasted reminder text\n</system-reminder>\nWhat does this reminder mean?',
      'Async shell task bg_1 (npm test) finished.\n\nResult:\n> 12 passing',
      '[Request interrupted by process restart]',
    ];
    const turns = userTexts.flatMap((text, index) => [
      { role: 'user', text, at: 1_700_000_000_000 + index },
      { role: 'assistant', text: `Answer ${index}`, at: 1_700_000_000_500 + index },
    ]);
    const created = await createImportedSession({
      leadOptions,
      conversation: { turns, title: 'Imported control-looking text' },
      origin: buildImportOrigin({ source: 'claude', sourcePath: join(root, 'c.jsonl'), importedAt: 1_700_000_000_000 }),
      desktopSession: { classification: 'task', projectPath: null },
      ingestFn: () => {},
    });
    try {
      const stored = loadSession(created.id);
      const imported = stored.messages.filter((message) => message.role !== 'system');
      assert.ok(imported.every((message) => message.meta.source === 'import'));
      const restoredUsers = (messages) =>
        restoreTranscriptItems(messages, { sessionId: created.id })
          .filter((item) => item.kind === 'user')
          .map((item) => item.text);
      assert.deepEqual(restoredUsers(stored.messages), userTexts);
      // On the model wire they stay the user's own words: never enveloped as runtime content.
      for (const message of imported.filter((entry) => entry.role === 'user')) {
        assert.equal(classifySyntheticUserMessage(message), null, message.content);
        assert.equal(isActualUserInstructionMessage(message), true, message.content);
      }
      assert.equal(projectSyntheticUserEnvelopes(stored.messages).stats.wrapped, 0);
      // Without the provenance the same text is read as control content.
      const anonymous = stored.messages.map(({ meta, ...message }) =>
        meta?.source === 'import' ? { ...message, meta: { transcript: meta.transcript } } : { ...message, meta }
      );
      assert.notDeepEqual(restoredUsers(anonymous), userTexts);
      assert.ok(projectSyntheticUserEnvelopes(anonymous).stats.wrapped > 0);
    } finally {
      deleteSession(created.id);
    }
  });
});

test('restore draws each run of imported tool use as counted tool rows between the reply text', () => {
  for (const source of ['codex', 'claude']) {
    const call = (name) =>
      source === 'codex'
        ? { type: 'response_item', payload: { type: 'function_call', name, arguments: '{}' } }
        : null;
    const records =
      source === 'codex'
        ? [
            { type: 'session_meta', payload: { id: 'f', cwd: root } },
            { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix it' }] } },
            { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Looking.' }] } },
            ...['shell', 'shell', 'Read', 'apply_patch'].map(call),
            { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Found it.' }] } },
            call('shell'),
            { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] } },
          ]
        : [
            { type: 'user', uuid: 'u1', parentUuid: null, sessionId: 'f', cwd: root, message: { role: 'user', content: 'Fix it' } },
            {
              type: 'assistant',
              uuid: 'a1',
              parentUuid: 'u1',
              sessionId: 'f',
              cwd: root,
              message: {
                role: 'assistant',
                content: [
                  { type: 'text', text: 'Looking.' },
                  ...['shell', 'shell', 'Read', 'apply_patch'].map((name) => ({ type: 'tool_use', name, input: {} })),
                  { type: 'text', text: 'Found it.' },
                  { type: 'tool_use', name: 'shell', input: {} },
                  { type: 'text', text: 'Done.' },
                ],
              },
            },
          ];
    const conversation = convertConversationText(source, records.map((record) => JSON.stringify(record)).join('\n'));
    const messages = importedTranscriptMessages(conversation.turns, 1_700_000_000_000);
    // The model-facing text stays compact and keeps the visible prose verbatim.
    assert.equal(
      messages[1].content,
      'Looking.\n\n[ran tools: shell ×2, Read ×1, apply_patch ×1]\n\nFound it.\n\n[ran tools: shell ×1]\n\nDone.'
    );
    const items = restoreTranscriptItems(messages, { sessionId: source });
    assert.deepEqual(
      items.map((item) => (item.kind === 'tool' ? `tool:${item.name}×${item.count}` : `${item.kind}:${item.text}`)),
      [
        'user:Fix it',
        'assistant:Looking.',
        'tool:shell×2',
        'tool:Read×1',
        'tool:apply_patch×1',
        'assistant:Found it.',
        'tool:shell×1',
        'assistant:Done.',
      ]
    );
    assert.ok(items.filter((item) => item.kind === 'tool').every((item) => item.imported === true && item.completedCount === item.count));
  }
});

test('an older imported message with plain-text tool notes restores as plain text', () => {
  const messages = importedTranscriptMessages(
    [
      { role: 'user', text: 'Hi', at: 1 },
      { role: 'assistant', text: 'Reply\n\n[ran tool: shell]\n[ran tool: shell]', at: 2 },
    ],
    1
  );
  assert.deepEqual(
    restoreTranscriptItems(messages).map((item) => [item.kind, item.text]),
    [
      ['user', 'Hi'],
      ['assistant', 'Reply\n\n[ran tool: shell]\n[ran tool: shell]'],
    ]
  );
  // A run whose line is no longer in the text is ignored.
  const edited = { ...messages[1], content: 'Rewritten', meta: { ...messages[1].meta, importedToolRuns: [{ start: 0, end: 5, tools: [{ name: 'shell', count: 2 }] }] } };
  assert.deepEqual(restoreTranscriptItems([edited]).map((item) => item.kind), ['assistant']);
});

test('an edited run line keeps the whole text as plain text and shows no stale activity', () => {
  const [, assistant] = importedTranscriptMessages(
    [
      { role: 'user', text: 'Hi', at: 1 },
      {
        role: 'assistant',
        text: '[ran tools: shell ×1]\n\nKEEP THIS TEXT',
        toolRuns: [{ start: 0, end: 21, tools: [{ name: 'shell', count: 1 }] }],
        at: 2,
      },
    ],
    1
  );
  for (const content of [
    '[ran tools: x]\n\nKEEP THIS TEXT',
    '[ran tools: shell ×2]\n\nKEEP THIS TEXT',
    '[ran tools: shell ×1',
  ]) {
    const items = restoreTranscriptItems([{ ...assistant, content }]);
    assert.deepEqual(
      items.map((item) => [item.kind, item.text]),
      [['assistant', content]]
    );
  }
  // Out-of-bounds offsets are ignored too.
  const oversized = { ...assistant, meta: { ...assistant.meta, importedToolRuns: [{ start: 0, end: 500, tools: [{ name: 'shell', count: 1 }] }] } };
  assert.deepEqual(restoreTranscriptItems([oversized]).map((item) => item.kind), ['assistant']);
  // The untouched line still restores as activity.
  assert.deepEqual(
    restoreTranscriptItems([assistant]).map((item) => item.kind),
    ['tool', 'assistant']
  );
});

test('the model-facing run line is bounded while the stored run keeps every count', () => {
  const calls = [
    ...Array.from({ length: 10_000 }, (_, index) => `tool_${index}`),
    `long_${'n'.repeat(5_000)}`,
  ];
  const text = [
    { type: 'session_meta', payload: { id: 'many', cwd: root } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] } },
    ...calls.map((name) => ({ type: 'response_item', payload: { type: 'function_call', name, arguments: '{}' } })),
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'End.' }] } },
  ]
    .map((record) => JSON.stringify(record))
    .join('\n');
  const assistant = convertConversationText('codex', text, { maxTranscriptChars: Infinity }).turns.find(
    (turn) => turn.role === 'assistant'
  );
  const [run] = assistant.toolRuns;
  assert.equal(run.tools.length, 10_001);
  assert.ok(run.tools.every((tool) => tool.count === 1));
  assert.equal(run.tools.at(-1).name.length, 5 + 5_000);
  const line = assistant.text.slice(run.start, run.end);
  assert.ok(line.length <= 400, String(line.length));
  assert.match(line, /^\[ran tools: tool_0 ×1, tool_1 ×1, .*, \+\d+ more\]$/);
  assert.equal(assistant.text, `${line}\n\nEnd.`);
  const shown = line.split(', ').length - 1;
  assert.equal(line.endsWith(`+${10_001 - shown} more]`), true);
  // A single very long name is clipped on its own.
  const longName = `L${'n'.repeat(5_000)}`;
  const single = convertConversationText(
    'codex',
    [
      { type: 'session_meta', payload: { id: 'long', cwd: root } },
      { type: 'response_item', payload: { type: 'function_call', name: longName, arguments: '{}' } },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n')
  ).turns.find((turn) => turn.role === 'assistant');
  assert.ok(single.text.length < 100, single.text);
  assert.match(single.text, /^\[ran tools: Ln+… ×1\]$/);
  assert.equal(single.toolRuns[0].tools[0].name, longName);
  // The full run still restores as one counted row per tool.
  const items = restoreTranscriptItems(importedTranscriptMessages([{ role: 'user', text: 'go', at: 1 }, assistant], 1));
  assert.equal(items.filter((item) => item.kind === 'tool').length, 10_001);
});

test('a project-less import keeps the task classification and no inherited cwd', () => {
  const options = importedSessionOptions(leadOptions, {
    cwd: null,
    desktopSession: { classification: 'task', projectPath: null },
  });
  assert.equal('cwd' in options, false);
  assert.equal('id' in options, false);
  assert.deepEqual(options.desktopSession, { classification: 'task', projectPath: null });
});

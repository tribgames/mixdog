import assert from 'node:assert/strict';
import test from 'node:test';
import { IMPORT_ERROR_TOO_LARGE, convertConversationText, createConversationConverter } from './convert.mjs';
import { unwrapClaudePastes } from './claude.mjs';
import { codexMetaFromTruncatedLine } from './codex.mjs';
import { IMAGE_OMITTED_TEXT, IMPORTED_USER_STUB_TEXT } from './turns.mjs';

const jsonl = (records, eol = '\n') => records.map((record) => JSON.stringify(record)).join(eol) + eol;

const codexMeta = (id = 'codex-1', cwd = 'C:\\Project\\demo') => ({
  timestamp: '2026-01-01T00:00:00.000Z',
  type: 'session_meta',
  payload: { id, cwd, base_instructions: { text: 'You are Codex.' } },
});
const codexItem = (payload, at = '2026-01-01T00:00:01.000Z') => ({ timestamp: at, type: 'response_item', payload });
const codexMessage = (role, ...texts) =>
  codexItem({
    type: 'message',
    role,
    content: texts.map((text) => ({ type: role === 'assistant' ? 'output_text' : 'input_text', text })),
  });

test('Codex: session meta, user/assistant text, tool notes; envelopes, outputs and reasoning dropped', () => {
  const text = jsonl([
    codexMeta(),
    { type: 'turn_context', payload: { cwd: 'x' } },
    codexMessage('developer', '<permissions instructions>secret</permissions instructions>'),
    codexItem({ type: 'message', role: 'system', content: [{ type: 'input_text', text: 'system text' }] }),
    codexMessage(
      'user',
      '# AGENTS.md instructions for C:\\Project\\demo\n\n<INSTRUCTIONS>\nrules\n</INSTRUCTIONS>',
      '<environment_context>\n  <cwd>C:\\Project\\demo</cwd>\n</environment_context>'
    ),
    codexMessage(
      'user',
      '<recommended_plugins>\nplugins\n</recommended_plugins>',
      '# AGENTS.md instructions\n\n<INSTRUCTIONS>\nnewer header\n</INSTRUCTIONS>'
    ),
    codexMessage('user', 'Fix the <b>bold</b> bug\nsecond line'),
    codexItem({ type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking' }], encrypted_content: 'zz' }),
    codexMessage('assistant', 'Looking.'),
    codexItem({ type: 'function_call', name: 'shell', arguments: '{"cmd":"rm -rf secret"}', call_id: 'a' }),
    codexItem({ type: 'function_call_output', call_id: 'a', output: 'OUTPUT TEXT' }),
    codexItem({ type: 'custom_tool_call', name: 'apply_patch', input: '*** PATCH BODY', call_id: 'b' }),
    codexItem({ type: 'custom_tool_call_output', call_id: 'b', output: 'patched' }),
    codexItem({ type: 'local_shell_call', action: { type: 'exec', command: ['ls'] }, call_id: 'c' }),
    { type: 'event_msg', payload: { type: 'token_count', info: {} } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'Fix the bold bug' } },
    codexMessage('assistant', 'Done.'),
    codexMessage('user', '<turn_aborted>\nThe user interrupted.\n</turn_aborted>'),
    codexMessage('user', '<note>keep me</note>'),
  ]);
  const result = convertConversationText('codex', text);
  assert.equal(result.errorCode, null);
  assert.equal(result.foreignSessionId, 'codex-1');
  assert.equal(result.cwd, 'C:\\Project\\demo');
  assert.deepEqual(
    result.turns.map(({ role, text: body }) => [role, body]),
    [
      ['user', 'Fix the <b>bold</b> bug\nsecond line'],
      ['assistant', 'Looking.\n\n[ran tools: shell ×1, apply_patch ×1, local_shell ×1]\n\nDone.'],
      ['user', '<note>keep me</note>'],
    ]
  );
  const run = result.turns[1].toolRuns;
  assert.deepEqual(run, [
    {
      start: 10,
      end: 10 + '[ran tools: shell ×1, apply_patch ×1, local_shell ×1]'.length,
      tools: [
        { name: 'shell', count: 1 },
        { name: 'apply_patch', count: 1 },
        { name: 'local_shell', count: 1 },
      ],
    },
  ]);
  assert.equal(result.turns[0].toolRuns, undefined);
  const serialized = JSON.stringify(result.turns);
  for (const dropped of ['rm -rf', 'OUTPUT TEXT', 'PATCH BODY', 'thinking', 'secret', 'system text']) {
    assert.equal(serialized.includes(dropped), false, dropped);
  }
  assert.equal(result.title, 'Fix the <b>bold</b> bug');
  assert.equal(result.messageCount, 3);
  assert.deepEqual(result.warnings, []);
});

test('a long run of tool use becomes one compact line with per-tool counts, in both sources', () => {
  const names = [...Array(1000).fill('shell'), ...Array(400).fill('Read'), 'apply_patch'];
  const codex = convertConversationText(
    'codex',
    jsonl([
      codexMeta(),
      codexMessage('user', 'go'),
      codexMessage('assistant', 'Start.'),
      ...names.map((name) => codexItem({ type: 'function_call', name, arguments: '{}' })),
      codexMessage('assistant', 'End.'),
    ])
  );
  const claude = convertConversationText(
    'claude',
    jsonl([
      claudeEntry('u1', null, 'user', 'go'),
      claudeEntry('a1', 'u1', 'assistant', [
        { type: 'text', text: 'Start.' },
        ...names.map((name, index) => ({ type: 'tool_use', id: `t${index}`, name, input: {} })),
        { type: 'text', text: 'End.' },
      ]),
    ])
  );
  for (const result of [codex, claude]) {
    const line = '[ran tools: shell ×1000, Read ×400, apply_patch ×1]';
    const assistant = result.turns.find((turn) => turn.role === 'assistant');
    assert.equal(assistant.text, `Start.\n\n${line}\n\nEnd.`);
    assert.deepEqual(assistant.toolRuns, [
      {
        start: 8,
        end: 8 + line.length,
        tools: [
          { name: 'shell', count: 1000 },
          { name: 'Read', count: 400 },
          { name: 'apply_patch', count: 1 },
        ],
      },
    ]);
  }
});

test('Codex: BOM, CRLF, malformed lines, images and a leading assistant turn', () => {
  const body = jsonl(
    [
      codexMeta('codex-2'),
      codexMessage('assistant', 'Resumed answer.'),
      codexItem({
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: '<image name=[Image #1]>' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
          { type: 'input_text', text: '</image>' },
          { type: 'input_text', text: 'What is in this picture?' },
        ],
      }),
    ],
    '\r\n'
  );
  const text = `\uFEFF${body}{"type": "response_item", "payload": {broken\r\n`;
  const result = convertConversationText('codex', text);
  assert.equal(result.errorCode, null);
  assert.equal(result.foreignSessionId, 'codex-2');
  assert.deepEqual(
    result.turns.map(({ role, text: value, stub }) => [role, value, stub === true]),
    [
      ['user', IMPORTED_USER_STUB_TEXT, true],
      ['assistant', 'Resumed answer.', false],
      ['user', `${IMAGE_OMITTED_TEXT}\n\nWhat is in this picture?`, false],
    ]
  );
  assert.equal(result.title, 'What is in this picture?');
  assert.deepEqual(result.warnings.sort(), ['imageOmitted', 'malformed']);
  assert.equal(JSON.stringify(result.turns).includes('base64'), false);
});

test('error codes: empty, malformed, unsupported', () => {
  assert.equal(convertConversationText('codex', '').errorCode, 'empty');
  assert.equal(convertConversationText('codex', 'not json\n{also bad\n').errorCode, 'malformed');
  assert.equal(convertConversationText('codex', jsonl([{ type: 'user', message: {} }])).errorCode, 'unsupported');
  assert.equal(convertConversationText('codex', jsonl([codexMeta()])).errorCode, 'empty');
  assert.equal(convertConversationText('claude', jsonl([codexMeta()])).errorCode, 'unsupported');
});

test('a truncated session_meta line still yields id and cwd; partial lines are dropped from prefixes', () => {
  const line = JSON.stringify(codexMeta('codex-3', 'D:\\work')).slice(0, -20);
  assert.deepEqual(codexMetaFromTruncatedLine(line), {
    foreignSessionId: 'codex-3',
    cwd: 'D:\\work',
    internalKind: null,
  });
  const prefix = `${jsonl([codexMeta('codex-4'), codexMessage('user', 'Kept')])}{"type":"response_item","payload":{"ty`;
  const partial = convertConversationText('codex', prefix, { complete: false });
  assert.deepEqual([partial.title, partial.warnings], ['Kept', []]);
});

test('incremental converter: transcript over the char limit fails with tooLarge and stops accepting lines', () => {
  const converter = createConversationConverter('codex', { maxTranscriptChars: 50 });
  assert.equal(converter.pushLine(JSON.stringify(codexMeta('codex-5'))), true);
  assert.equal(converter.pushLine(JSON.stringify(codexMessage('user', 'Short opener'))), true);
  assert.equal(converter.pushLine(JSON.stringify(codexMessage('assistant', 'x'.repeat(60)))), false);
  assert.equal(converter.pushLine(JSON.stringify(codexMessage('user', 'ignored'))), false);
  const result = converter.result();
  assert.equal(result.errorCode, IMPORT_ERROR_TOO_LARGE);
  assert.deepEqual(
    [result.turns, result.messageCount, result.title, result.foreignSessionId],
    [[], 0, 'Short opener', 'codex-5']
  );
  const marked = createConversationConverter('claude');
  marked.markTooLarge();
  assert.equal(marked.result().errorCode, 'tooLarge');
});

const claudeEntry = (uuid, parentUuid, type, content, extra = {}) => ({
  parentUuid,
  isSidechain: false,
  type,
  uuid,
  sessionId: 'claude-1',
  cwd: '/home/me/demo',
  timestamp: '2026-01-01T00:00:00.000Z',
  message: { role: type, content },
  ...extra,
});

test('the text budget holds on the normalized transcript (joins and the user stub count)', () => {
  // 4 kept chars: 'ab' + 'cd' joined by a blank line, after the user stub.
  const text = jsonl([codexMeta('codex-6'), codexMessage('assistant', 'ab', 'cd')]);
  assert.equal(convertConversationText('codex', text, { maxTranscriptChars: 4 }).errorCode, IMPORT_ERROR_TOO_LARGE);
  const budget = IMPORTED_USER_STUB_TEXT.length + 'ab\n\ncd'.length;
  const fits = convertConversationText('codex', text, { maxTranscriptChars: budget });
  assert.equal(fits.errorCode, null);
  assert.equal(
    fits.turns.reduce((total, turn) => total + turn.text.length, 0),
    budget
  );
  assert.equal(
    convertConversationText('codex', text, { maxTranscriptChars: budget - 1 }).errorCode,
    IMPORT_ERROR_TOO_LARGE
  );
});

test('retained entries and their bookkeeping are bounded: text-free Claude entries fail tooLarge', () => {
  // Tool results keep no text but every uuid-bearing entry stays for chain linking.
  const results = Array.from({ length: 50 }, (_, index) =>
    claudeEntry(`r${index}-${'u'.repeat(200)}`, index ? `r${index - 1}-${'u'.repeat(200)}` : null, 'user', [
      { type: 'tool_result', tool_use_id: 't', content: 'x' },
    ])
  );
  const text = jsonl(results);
  assert.equal(convertConversationText('claude', text, { maxRetainedEntries: 10 }).errorCode, IMPORT_ERROR_TOO_LARGE);
  assert.equal(convertConversationText('claude', text, { maxMetadataBytes: 4096 }).errorCode, IMPORT_ERROR_TOO_LARGE);
  const converter = createConversationConverter('claude', { maxRetainedEntries: 10 });
  let accepted = 0;
  for (const record of results) {
    if (!converter.pushLine(JSON.stringify(record))) break;
    accepted += 1;
  }
  assert.equal(accepted, 10, 'stops at the first entry over the limit');
  // Within the defaults the same file converts (no text kept → empty).
  assert.equal(convertConversationText('claude', text).errorCode, 'empty');
  const codex = jsonl([codexMeta('codex-7'), ...Array.from({ length: 20 }, () => codexMessage('user', 'x'))]);
  assert.equal(convertConversationText('codex', codex, { maxRetainedEntries: 5 }).errorCode, IMPORT_ERROR_TOO_LARGE);
});

test('Claude Code: active chain only, tool notes, envelopes/thinking/results dropped, images marked', () => {
  const text = jsonl([
    { type: 'file-history-snapshot', messageId: 'x' },
    claudeEntry('u0', null, 'user', 'Caveat: the messages below…', { isMeta: true }),
    claudeEntry(
      'u1',
      'u0',
      'user',
      '<command-message>init</command-message>\n<command-name>/init</command-name>\n<command-args></command-args>'
    ),
    claudeEntry('u2', 'u1', 'user', [{ type: 'text', text: 'Please refactor the parser' }]),
    claudeEntry('a1', 'u2', 'assistant', [
      { type: 'thinking', thinking: 'private reasoning', signature: 'SIG' },
      { type: 'text', text: 'Reading files.' },
    ]),
    claudeEntry('a2', 'a1', 'assistant', [{ type: 'tool_use', id: 't1', name: 'Read', input: { path: '/etc/x' } }]),
    claudeEntry('u3', 'a2', 'user', [{ type: 'tool_result', tool_use_id: 't1', content: 'FILE BODY' }]),
    // Abandoned branch off a2 (a retry): must not appear.
    claudeEntry('a3-old', 'u3', 'assistant', [{ type: 'text', text: 'Old branch answer' }]),
    claudeEntry('side', 'u3', 'assistant', [{ type: 'text', text: 'Sidechain text' }], { isSidechain: true }),
    claudeEntry('a3', 'u3', 'assistant', [{ type: 'text', text: 'Refactored.' }]),
    claudeEntry('u4', 'a3', 'user', [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      { type: 'text', text: '[Image: original 100x100, displayed at 100x100]' },
      { type: 'text', text: 'Does it look right?' },
    ]),
    claudeEntry('u5', 'u4', 'user', '<task-notification>\n<task-id>1</task-id>\n</task-notification>'),
    claudeEntry('u6', 'u5', 'user', '[Request interrupted by user]'),
    claudeEntry('a4', 'u6', 'assistant', [{ type: 'text', text: 'Yes.' }]),
    { type: 'agent-name', agentName: 'ignored' },
  ]);
  const result = convertConversationText('claude', text);
  assert.equal(result.errorCode, null);
  assert.equal(result.foreignSessionId, 'claude-1');
  assert.equal(result.cwd, '/home/me/demo');
  assert.deepEqual(
    result.turns.map(({ role, text: value }) => [role, value]),
    [
      ['user', '/init\n\nPlease refactor the parser'],
      ['assistant', 'Reading files.\n\n[ran tools: Read ×1]\n\nRefactored.'],
      ['user', `${IMAGE_OMITTED_TEXT}\n\nDoes it look right?`],
      ['assistant', 'Yes.'],
    ]
  );
  const serialized = JSON.stringify(result.turns);
  for (const dropped of ['private reasoning', 'SIG', 'FILE BODY', 'Old branch', 'Sidechain', '/etc/x', 'task-id']) {
    assert.equal(serialized.includes(dropped), false, dropped);
  }
  assert.deepEqual(result.warnings, ['imageOmitted']);
  assert.equal(result.title, 'Please refactor the parser');
});

test('Claude Code: replayed entries do not duplicate and a compaction boundary is crossed', () => {
  const first = claudeEntry('u1', null, 'user', 'First question');
  const answer = claudeEntry('a1', 'u1', 'assistant', [{ type: 'text', text: 'First answer' }]);
  const boundary = {
    type: 'system',
    subtype: 'compact_boundary',
    uuid: 'b1',
    parentUuid: null,
    logicalParentUuid: 'a1',
  };
  const summary = claudeEntry('s1', 'b1', 'user', 'This session is being continued…', { isCompactSummary: true });
  const next = claudeEntry('u2', 's1', 'user', 'Second question');
  const text = jsonl([first, answer, first, answer, boundary, summary, next]);
  const result = convertConversationText('claude', text);
  assert.deepEqual(
    result.turns.map(({ role, text: value }) => [role, value]),
    [
      ['user', 'First question'],
      ['assistant', 'First answer'],
      ['user', 'Second question'],
    ]
  );
});

test('Claude Code: a compaction summary stands in for history the file no longer links to', () => {
  const boundary = {
    type: 'system',
    subtype: 'compact_boundary',
    uuid: 'b1',
    parentUuid: null,
    logicalParentUuid: 'gone',
  };
  const summary = claudeEntry('s1', 'b1', 'user', 'Summary of the earlier work', {
    isCompactSummary: true,
    isVisibleInTranscriptOnly: true,
  });
  const next = claudeEntry('u2', 's1', 'user', 'Second question');
  const answer = claudeEntry('a2', 'u2', 'assistant', [{ type: 'text', text: 'Second answer' }]);
  const result = convertConversationText('claude', jsonl([boundary, summary, next, answer]));
  // The recap is the model's, never a message the user wrote.
  assert.deepEqual(
    result.turns.map(({ role, text: value }) => [role, value]),
    [
      ['user', IMPORTED_USER_STUB_TEXT],
      ['assistant', 'Summary of the earlier work'],
      ['user', 'Second question'],
      ['assistant', 'Second answer'],
    ]
  );
  assert.equal(result.title, 'Second question');
});

// Devin snapshot lines: the session row, then message nodes in node_id order.
const devinMeta = (id = 'devin-1', cwd = '/home/me/demo') => ({
  type: 'session_meta',
  payload: { id, cwd, title: 'Devin session title', created_at: 1_700_000_000, last_activity_at: 1_700_000_100 },
});
const devinNode = (node_id, chat_message, parent_node_id = node_id - 1) => ({
  type: 'node',
  payload: { node_id, parent_node_id, created_at: 1_700_000_000 + node_id, chat_message },
});
const devinMessage = (role, content, extra = {}) => ({ message_id: `m-${content.slice(0, 8)}`, role, content, ...extra });

test('Devin CLI: user inputs, assistant text and tool notes; envelopes and internal turns dropped', () => {
  const text = jsonl([
    devinMeta(),
    devinNode(1, devinMessage('system', 'You are Devin.')),
    devinNode(2, devinMessage('user', 'cache keepalive', { metadata: { is_user_input: false } })),
    devinNode(3, devinMessage('user', 'Fix the flaky test', { metadata: { is_user_input: true } })),
    devinNode(
      4,
      devinMessage('assistant', '', { tool_calls: [{ name: 'exec', arguments: { command: 'HIDDEN_ARG' } }] })
    ),
    devinNode(5, devinMessage('tool', 'TOOL OUTPUT')),
    devinNode(6, devinMessage('assistant', 'Fixed it.')),
    devinNode(7, devinMessage('user', 'Thanks', { metadata: { is_user_input: true } })),
  ]);
  const result = convertConversationText('devin', text);
  assert.equal(result.errorCode, null);
  assert.equal(result.foreignSessionId, 'devin-1');
  assert.equal(result.cwd, '/home/me/demo');
  assert.deepEqual(
    result.turns.map(({ role, text: value }) => [role, value]),
    [
      ['user', 'Fix the flaky test'],
      ['assistant', '[ran tools: exec ×1]\n\nFixed it.'],
      ['user', 'Thanks'],
    ]
  );
  const serialized = JSON.stringify(result.turns);
  for (const dropped of ['You are Devin', 'cache keepalive', 'TOOL OUTPUT', 'HIDDEN_ARG']) {
    assert.equal(serialized.includes(dropped), false, dropped);
  }
});

test('Claude Code: a boundary whose logical parent was never written links to the history before it', () => {
  const boundary = (uuid, logicalParentUuid) => ({
    type: 'system',
    subtype: 'compact_boundary',
    uuid,
    parentUuid: null,
    logicalParentUuid,
  });
  const summary = (uuid, parent, text) =>
    claudeEntry(uuid, parent, 'user', text, { isCompactSummary: true, isVisibleInTranscriptOnly: true });
  const text = jsonl([
    claudeEntry('u1', null, 'user', 'First question'),
    claudeEntry('a1', 'u1', 'assistant', [{ type: 'text', text: 'First answer' }]),
    // Logical parent missing from the file (Claude Code never wrote it).
    boundary('b1', 'never-written'),
    { type: 'attachment', uuid: 'at1', parentUuid: 'b1' },
    summary('s1', 'at1', 'Summary one'),
    claudeEntry('u2', 's1', 'user', 'Second question'),
    claudeEntry('a2', 'u2', 'assistant', [{ type: 'text', text: 'Second answer' }]),
    // Logical parent present.
    boundary('b2', 'a2'),
    summary('s2', 'b2', 'Summary two'),
    claudeEntry('u3', 's2', 'user', 'Third question'),
    claudeEntry('a3', 'u3', 'assistant', [{ type: 'text', text: 'Third answer' }]),
  ]);
  const result = convertConversationText('claude', text);
  assert.deepEqual(
    result.turns.map(({ role, text: value }) => [role, value]),
    [
      ['user', 'First question'],
      ['assistant', 'First answer'],
      ['user', 'Second question'],
      ['assistant', 'Second answer'],
      ['user', 'Third question'],
      ['assistant', 'Third answer'],
    ]
  );
  assert.equal(result.title, 'First question');
});

test('Claude Code: slash commands read as Claude Code shows them; locally answered ones are dropped', () => {
  const text = jsonl([
    claudeEntry('u0', null, 'user', 'Caveat: the messages below…', { isMeta: true }),
    claudeEntry(
      'u1',
      'u0',
      'user',
      '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>'
    ),
    claudeEntry('u2', 'u1', 'user', '<local-command-stdout>Set model to opus</local-command-stdout>'),
    claudeEntry(
      'u3',
      'u2',
      'user',
      '<command-message>launch</command-message>\n<command-name>/launch</command-name>\n<command-args>the beta</command-args>'
    ),
    claudeEntry('u4', 'u3', 'user', [{ type: 'text', text: '## Launch\nExpanded skill body' }], { isMeta: true }),
    claudeEntry('a1', 'u4', 'assistant', [{ type: 'text', text: 'Launching.' }]),
    claudeEntry(
      'u5',
      'a1',
      'user',
      '<command-message>review</command-message>\n<command-name>review</command-name>\n<skill-format>true</skill-format>'
    ),
    claudeEntry('a2', 'u5', 'assistant', [{ type: 'text', text: 'Reviewed.' }]),
  ]);
  const result = convertConversationText('claude', text);
  assert.deepEqual(
    result.turns.map(({ role, text: value }) => [role, value]),
    [
      ['user', '/launch the beta'],
      ['assistant', 'Launching.'],
      ['user', '/review'],
      ['assistant', 'Reviewed.'],
    ]
  );
  assert.equal(result.title, '/launch the beta');
  const serialized = JSON.stringify(result.turns);
  for (const dropped of ['command-', 'skill-format', 'opus', 'Expanded skill body']) {
    assert.equal(serialized.includes(dropped), false, dropped);
  }
});

test('Devin CLI: repeated context nodes keep the first position and the fuller copy', () => {
  const user = devinMessage('user', 'Original question', { metadata: { is_user_input: true } });
  const short = devinMessage('assistant', '…', {});
  const full = { ...short, content: 'Complete answer text' };
  const text = jsonl([
    devinMeta('devin-2'),
    devinNode(1, user),
    devinNode(2, short),
    // A later turn's chain repeats the same context under new node ids.
    devinNode(3, { ...user, message_id: user.message_id }),
    devinNode(4, { ...full, message_id: short.message_id }),
    devinNode(5, devinMessage('user', 'Second question', { metadata: { is_user_input: true } })),
  ]);
  const result = convertConversationText('devin', text);
  assert.equal(result.errorCode, null);
  assert.deepEqual(
    result.turns.map(({ role, text: value }) => [role, value]),
    [
      ['user', 'Original question'],
      ['assistant', 'Complete answer text'],
      ['user', 'Second question'],
    ]
  );
});

test('Devin CLI: a header-only snapshot reports the session but converts empty', () => {
  const result = convertConversationText('devin', jsonl([devinMeta('devin-3')]));
  assert.equal(result.errorCode, 'empty');
  assert.equal(result.foreignSessionId, 'devin-3');
  assert.equal(result.title, 'Devin session title');
});

test('Claude Code: the create-PR instructions are dropped and the app paste envelope is unwrapped', () => {
  const text = jsonl([
    claudeEntry(
      'u1',
      null,
      'user',
      '\n\n<pasted_content id="a1b2">\nerror log line\n\n```\ncode()\n```\n</pasted_content id="a1b2">\n\nWhy?'
    ),
    claudeEntry('a1', 'u1', 'assistant', [{ type: 'text', text: 'Because.' }]),
    claudeEntry('u2', 'a1', 'user', '<create-pr-command>\n## Steps\nRun `gh pr create`.\n</create-pr-command>'),
    claudeEntry('a2', 'u2', 'assistant', [{ type: 'text', text: 'PR opened.' }]),
  ]);
  const result = convertConversationText('claude', text);
  assert.deepEqual(
    result.turns.map(({ role, text: value }) => [role, value]),
    [
      ['user', 'error log line\n\n```\ncode()\n```\nWhy?'],
      ['assistant', 'Because.\n\nPR opened.'],
    ]
  );
  assert.equal(result.title, 'error log line');
});

test('Claude Code: a <pasted_content> the user typed, or one not in the app envelope form, stays as typed', () => {
  const kept = [
    // The reviewer's probe: a literal tag in prose.
    'Explain the literal <pasted_content> tag.',
    // A code sample that mentions the tag.
    'Why does this fail?\n\n```js\nconst open = "<pasted_content>";\nconst close = "</pasted_content>";\n```',
    // A whole bare-tag block (no app id): ambiguous, so untouched.
    '<pasted_content>\nraw\n</pasted_content>\n\nWhat now?',
    // App-like but with mismatched ids, a non-hex id, or no closing tag.
    '<pasted_content id="a1b2">\nbody\n</pasted_content id="c3d4">',
    '<pasted_content id="zzzz">\nbody\n</pasted_content id="zzzz">',
    'Start <pasted_content id="a1b2">\nnever closed',
  ];
  for (const typed of kept) {
    const result = convertConversationText(
      'claude',
      jsonl([
        claudeEntry('u1', null, 'user', typed),
        claudeEntry('a1', 'u1', 'assistant', [{ type: 'text', text: 'Ok.' }]),
      ])
    );
    assert.deepEqual(
      result.turns.map(({ role, text: value }) => [role, value]),
      [
        ['user', typed],
        ['assistant', 'Ok.'],
      ]
    );
  }
  // A literal tag next to a real envelope survives; only the envelope unwraps.
  const mixed = convertConversationText(
    'claude',
    jsonl([
      claudeEntry(
        'u1',
        null,
        'user',
        'Is <pasted_content> special?\n<pasted_content id="0f9e">\nlog\n</pasted_content id="0f9e">'
      ),
    ])
  );
  assert.equal(mixed.turns[0].text, 'Is <pasted_content> special?\nlog');
  // Unwrapping trims only toward a paste: the outer indentation and trailing
  // spaces stay (the message as a whole is trimmed like any other message).
  assert.equal(
    unwrapClaudePastes(
      '    indented first line\n<pasted_content id="0f9e">\nlog\n</pasted_content id="0f9e">\nlast line  '
    ),
    '    indented first line\nlog\nlast line  '
  );
});

test('Codex: the app context before "## My request for Codex:" is dropped, as Codex shows it', () => {
  const text = jsonl([
    codexMeta('codex-ide'),
    codexMessage(
      'user',
      '# Files mentioned by the user:\n\n## shot.png: C:\\tmp\\shot.png\n\n## My request for Codex:\nWhat is this?\n'
    ),
    codexMessage('assistant', 'A chart.'),
    codexMessage(
      'user',
      '\n# Response annotations:\nThe user marked parts of your reply.\n\n<response-annotations>\n[{"text":"quoted reply"}]\n</response-annotations>\n\n## My request for Codex:\nExplain the marked part\n'
    ),
    codexMessage('assistant', 'Sure.'),
    codexMessage('user', 'Plain # heading text stays'),
    codexMessage('assistant', 'Noted.'),
    // Codex splits on the last heading: an earlier one belongs to the context.
    codexMessage('user', '# Context\n## My request for Codex:\nFirst\n## My request for Codex:\n Second\n'),
  ]);
  const result = convertConversationText('codex', text);
  assert.deepEqual(
    result.turns.map(({ role, text: value }) => [role, value]),
    [
      ['user', 'What is this?'],
      ['assistant', 'A chart.'],
      ['user', 'Explain the marked part'],
      ['assistant', 'Sure.'],
      ['user', 'Plain # heading text stays'],
      ['assistant', 'Noted.'],
      ['user', 'Second'],
    ]
  );
  assert.equal(result.title, 'What is this?');
});

test('the title is the first user line, whitespace-normalized and capped at 100 characters', () => {
  const long = `  ${'word '.repeat(40)}\nnext line`;
  const result = convertConversationText('claude', jsonl([claudeEntry('u1', null, 'user', long)]));
  assert.equal(result.title, 'word '.repeat(20).trim());
  const unbroken = convertConversationText('claude', jsonl([claudeEntry('u1', null, 'user', 'x'.repeat(150))]));
  assert.equal(unbroken.title.length, 100);
});

// ── internal records, envelopes, long conversations ──────────────────────────
const codexMetaWith = (extra, id = 'codex-int') => ({
  type: 'session_meta',
  payload: { id, cwd: 'C:\\Project\\demo', originator: 'Codex Desktop', ...extra },
});
const conversationBody = (meta) => jsonl([meta, codexMessage('user', 'Hello'), codexMessage('assistant', 'Hi')]);

test('Codex: records marked guardian review, subagent or internal by session_meta are internal, not conversations', () => {
  const internal = {
    guardianThread: [{ source: 'vscode', thread_source: 'guardian_review' }, 'guardianReview'],
    guardianSource: [{ source: { subagent: { other: 'guardian' } } }, 'guardianReview'],
    guardianInternal: [{ source: { internal: 'guardian' } }, 'guardianReview'],
    spawned: [
      { source: { subagent: { thread_spawn: { parent_thread_id: 'p', depth: 1 } } }, thread_source: 'subagent' },
      'subagent',
    ],
    spawnedSourceOnly: [{ source: { subagent: { thread_spawn: { parent_thread_id: 'p', depth: 1 } } } }, 'subagent'],
    review: [{ source: { subagent: 'review' } }, 'subagent'],
    compact: [{ source: { subagent: 'compact' } }, 'subagent'],
    memory: [{ source: { subagent: 'memory_consolidation' }, thread_source: 'memory_consolidation' }, 'internal'],
    memoryThreadOnly: [{ source: 'exec', thread_source: 'memory_consolidation' }, 'internal'],
  };
  for (const [name, [extra, kind]] of Object.entries(internal)) {
    const result = convertConversationText('codex', conversationBody(codexMetaWith(extra)));
    assert.deepEqual([name, result.errorCode, result.internalKind], [name, 'internalRecord', kind]);
  }
  const user = [
    { source: 'vscode', thread_source: 'user' },
    { source: 'cli', thread_source: 'user' },
    { source: 'exec' },
    { source: 'mcp' },
    { source: { custom: 'atlas' } },
    { source: 'vscode', thread_source: 'automation' },
    { source: 'vscode', thread_source: 'voice_chat' },
    {},
  ];
  for (const extra of user) {
    const result = convertConversationText('codex', conversationBody(codexMetaWith(extra)));
    assert.deepEqual(
      [JSON.stringify(extra), result.errorCode, result.internalKind],
      [JSON.stringify(extra), null, null]
    );
  }
});

test('Codex: only the first session_meta marks a record, and a cut-off first line still carries the marker', () => {
  const later = jsonl([
    codexMetaWith({ source: 'vscode', thread_source: 'user' }),
    codexMessage('user', 'Hello'),
    codexMetaWith({ source: { subagent: 'review' } }, 'codex-other'),
  ]);
  const result = convertConversationText('codex', later);
  assert.deepEqual([result.errorCode, result.foreignSessionId], [null, 'codex-int']);

  const line = JSON.stringify({
    type: 'session_meta',
    payload: {
      id: 'codex-cut',
      cwd: 'D:\\work',
      source: { subagent: { other: 'guardian' } },
      thread_source: 'guardian_review',
      base_instructions: { text: 'x'.repeat(5000) },
    },
  }).slice(0, 300);
  assert.equal(codexMetaFromTruncatedLine(line).internalKind, 'guardianReview');
  const sourceOnly = line.replace('"thread_source":"guardian_review",', '');
  assert.equal(codexMetaFromTruncatedLine(sourceOnly).internalKind, 'guardianReview');
  const spawn =
    '{"type":"session_meta","payload":{"id":"c","cwd":"/w","source":{"subagent":{"thread_spawn":{"depth":1}}},"base_';
  assert.equal(codexMetaFromTruncatedLine(spawn).internalKind, 'subagent');
});

test('Codex: the open-page envelope is not a user message and never names the conversation', () => {
  const result = convertConversationText(
    'codex',
    jsonl([
      codexMetaWith({ source: 'vscode', thread_source: 'user' }),
      codexMessage('user', '<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>'),
      codexMessage('user', 'The real question'),
      codexMessage('assistant', 'Answer'),
    ])
  );
  assert.deepEqual([result.title, result.messageCount], ['The real question', 2]);
  assert.equal(result.turns[0].text, 'The real question');
});

test("Codex: a thread continuing a history_base exposes it; the warning is the file reader's to raise", () => {
  const base = { thread_id: 'rollout-1', end_ordinal_exclusive: 4, end_byte_offset: 100 };
  const result = convertConversationText('codex', conversationBody(codexMetaWith({ history_base: base })));
  assert.deepEqual([result.errorCode, result.warnings, result.historyBase], [null, [], base]);
  assert.equal(convertConversationText('codex', conversationBody(codexMetaWith({}))).historyBase, null);
});

test('Codex: a long, repeatedly compacted and resumed thread converts completely as one conversation', () => {
  const records = [codexMetaWith({ source: 'vscode', thread_source: 'user' })];
  const pairs = 1500;
  for (let n = 0; n < pairs; n++) {
    records.push(codexMessage('user', `Question ${n}`), codexMessage('assistant', `Answer ${n}`));
    if (n % 100 === 99) {
      records.push({ type: 'compacted', payload: { message: '', replacement_history: [] } });
      records.push({ type: 'event_msg', payload: { type: 'task_started' } });
    }
  }
  const result = convertConversationText('codex', jsonl(records));
  assert.equal(result.errorCode, null);
  assert.equal(result.messageCount, pairs * 2);
  assert.equal(result.turns[0].text, 'Question 0');
  assert.equal(result.turns[result.turns.length - 1].text, `Answer ${pairs - 1}`);
});

test('Claude Code: a transcript made only of sidechain messages is a subagent record, not a conversation', () => {
  const sidechain = (uuid, parentUuid, type, content) =>
    claudeEntry(uuid, parentUuid, type, content, { isSidechain: true, agentId: 'agent-1' });
  const only = convertConversationText(
    'claude',
    jsonl([sidechain('s1', null, 'user', 'Explore the repo'), sidechain('s2', 's1', 'assistant', 'Done')])
  );
  assert.deepEqual([only.errorCode, only.internalKind], ['internalRecord', 'subagent']);
  const mixed = convertConversationText(
    'claude',
    jsonl([
      claudeEntry('u1', null, 'user', 'Real question'),
      sidechain('s1', 'u1', 'user', 'Explore the repo'),
      claudeEntry('a1', 'u1', 'assistant', 'Answer'),
    ])
  );
  assert.deepEqual([mixed.errorCode, mixed.internalKind, mixed.title], [null, null, 'Real question']);
});

test('a cut-off session_meta is classified only from payload fields that arrived whole', () => {
  // A CLI record whose custom metadata merely contains marker-looking keys.
  const nested =
    '{"type":"session_meta","payload":{"id":"c","cwd":"/w","source":"cli","metadata":{"source":{"subagent":{"other":"guardian"}},"thread_source":"guardian_review"},"base_';
  assert.deepEqual(codexMetaFromTruncatedLine(nested), { foreignSessionId: 'c', cwd: '/w', internalKind: null });
  // The marker itself was cut off: unclassified rather than guessed.
  const cut = '{"type":"session_meta","payload":{"id":"c","cwd":"/w","source":{"subagent":{"thread_sp';
  assert.deepEqual(codexMetaFromTruncatedLine(cut), { foreignSessionId: 'c', cwd: '/w', internalKind: null });
  // A marker inside an earlier string value is not a field.
  const quoted =
    '{"type":"session_meta","payload":{"id":"c","cwd":"/w","note":"\\"thread_source\\":\\"subagent\\"","source":"vscode","base_';
  assert.equal(codexMetaFromTruncatedLine(quoted).internalKind, null);
  assert.equal(codexMetaFromTruncatedLine('{"type":"response_item","payload":{"id":"c"'), null);
});

#!/usr/bin/env node
// Golden twin of the conversation-import converter (`conversation-import/convert.mjs` with the
// Codex and Claude reducers and `turns.mjs`): a corpus of foreign JSONL transcripts, the result
// Node's real `convertConversationText` gives for each, plus `unwrapClaudePastes` and
// `codexMetaFromTruncatedLine` probes. Rust `import::convert`, `import::claude` and
// `import::codex` must give the same results.
//
//   node benchmarks/rust-core/recorders/record-import-convert.mjs --tree <dir>
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const dir = 'src/runtime/agent/orchestrator/session/conversation-import';
const { convertConversationText } = await importFrom(tree, `${dir}/convert.mjs`);
const { unwrapClaudePastes } = await importFrom(tree, `${dir}/claude.mjs`);
const { codexMetaFromTruncatedLine } = await importFrom(tree, `${dir}/codex.mjs`);

const jsonl = (records, eol = '\n') => records.map((r) => JSON.stringify(r)).join(eol) + eol;
const codexMeta = (id = 'codex-1', cwd = 'C:\\Project\\demo', extra = {}) => ({
  timestamp: '2026-01-01T00:00:00.000Z',
  type: 'session_meta',
  payload: { id, cwd, ...extra },
});
const codexItem = (payload, at = '2026-01-01T00:00:01.000Z') => ({ timestamp: at, type: 'response_item', payload });
const codexMessage = (role, ...texts) =>
  codexItem({
    type: 'message',
    role,
    content: texts.map((text) => ({ type: role === 'assistant' ? 'output_text' : 'input_text', text })),
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
const text = (t) => [{ type: 'text', text: t }];
const cmd = (name, args = '') =>
  `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>\n<command-args>${args}</command-args>`;
const boundary = (uuid, logicalParentUuid) => ({ type: 'system', subtype: 'compact_boundary', uuid, parentUuid: null, logicalParentUuid });

const scenarios = [];
const add = (name, source, body, options = {}) => scenarios.push({ name, source, text: body, ...options });

add('codex envelopes and tools', 'codex', jsonl([
  codexMeta(),
  { type: 'turn_context', payload: { cwd: 'x' } },
  codexMessage('developer', '<permissions instructions>secret</permissions instructions>'),
  codexItem({ type: 'message', role: 'system', content: [{ type: 'input_text', text: 'system text' }] }),
  codexMessage('user', '# AGENTS.md instructions for C:\\P\n\n<INSTRUCTIONS>\nrules\n</INSTRUCTIONS>', '<environment_context>\n  <cwd>x</cwd>\n</environment_context>'),
  codexMessage('user', '<recommended_plugins>\nplugins\n</recommended_plugins>', '# AGENTS.md instructions\n\n<INSTRUCTIONS>\nnewer\n</INSTRUCTIONS>'),
  codexMessage('user', 'Fix the <b>bold</b> bug\nsecond line'),
  codexItem({ type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking' }], encrypted_content: 'zz' }),
  codexMessage('assistant', 'Looking.'),
  codexItem({ type: 'function_call', name: 'shell', arguments: '{"cmd":"rm -rf secret"}', call_id: 'a' }),
  codexItem({ type: 'function_call_output', call_id: 'a', output: 'OUTPUT TEXT' }),
  codexItem({ type: 'custom_tool_call', name: 'apply_patch', input: '*** PATCH', call_id: 'b' }),
  codexItem({ type: 'local_shell_call', action: { type: 'exec', command: ['ls'] }, call_id: 'c' }),
  { type: 'event_msg', payload: { type: 'token_count', info: {} } },
  codexMessage('assistant', 'Done.'),
  codexMessage('user', '<turn_aborted>\nThe user interrupted.\n</turn_aborted>'),
  codexMessage('user', '<note>keep me</note>'),
]));
add('codex long tool run', 'codex', jsonl([
  codexMeta(), codexMessage('user', 'go'), codexMessage('assistant', 'Start.'),
  ...[...Array(30).fill('shell'), ...Array(12).fill('Read'), 'apply_patch'].map((name) => codexItem({ type: 'function_call', name, arguments: '{}' })),
  codexMessage('assistant', 'End.'),
]));
add('codex bom crlf malformed image leading assistant', 'codex',
  `\uFEFF${jsonl([codexMeta('codex-2'), codexMessage('assistant', 'Resumed answer.'), codexItem({ type: 'message', role: 'user', content: [
    { type: 'input_text', text: '<image name=[Image #1]>' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
    { type: 'input_text', text: '</image>' }, { type: 'input_text', text: 'What is in this picture?' }] })], '\r\n')}{"type": "response_item", "payload": {broken\r\n`);
for (const [n, body] of Object.entries({
  empty: '', malformed: 'not json\n{also bad\n', unsupported: jsonl([{ type: 'user', message: {} }]),
  metaOnly: jsonl([codexMeta()]), arrayLine: '[1,2]\n', blankLines: '\n\n  \n',
})) add(`codex error ${n}`, 'codex', body);
add('claude with codex records', 'claude', jsonl([codexMeta()]));
add('codex ide context', 'codex', jsonl([
  codexMeta('codex-ide'),
  codexMessage('user', '# Files mentioned by the user:\n\n## shot.png: C:\\tmp\\shot.png\n\n## My request for Codex:\nWhat is this?\n'),
  codexMessage('assistant', 'A chart.'),
  codexMessage('user', '\n# Response annotations:\nmarked\n\n<response-annotations>\n[{"text":"q"}]\n</response-annotations>\n\n## My request for Codex:\nExplain the marked part\n'),
  codexMessage('assistant', 'Sure.'),
  codexMessage('user', 'Plain # heading text stays'),
  codexMessage('assistant', 'Noted.'),
  codexMessage('user', '# Context\n## My request for Codex:\nFirst\n## My request for Codex:\n Second\n'),
]));
add('codex open page envelope', 'codex', jsonl([
  codexMeta('c', 'C:\\P', { source: 'vscode', thread_source: 'user' }),
  codexMessage('user', '<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>'),
  codexMessage('user', 'The real question'), codexMessage('assistant', 'Answer'),
]));
const body = (extra) => jsonl([codexMeta('codex-int', 'C:\\P', { originator: 'Codex Desktop', ...extra }), codexMessage('user', 'Hello'), codexMessage('assistant', 'Hi')]);
const spawn = { subagent: { thread_spawn: { parent_thread_id: 'p', depth: 1 } } };
for (const [n, extra] of Object.entries({
  guardianThread: { source: 'vscode', thread_source: 'guardian_review' },
  guardianSource: { source: { subagent: { other: 'guardian' } } },
  guardianInternal: { source: { internal: 'guardian' } },
  spawned: { source: spawn, thread_source: 'subagent' }, spawnedSourceOnly: { source: spawn },
  review: { source: { subagent: 'review' } }, compact: { source: { subagent: 'compact' } },
  memory: { source: { subagent: 'memory_consolidation' }, thread_source: 'memory_consolidation' },
  memoryThreadOnly: { source: 'exec', thread_source: 'memory_consolidation' },
  userVscode: { source: 'vscode', thread_source: 'user' }, exec: { source: 'exec' }, custom: { source: { custom: 'atlas' } },
  automation: { source: 'vscode', thread_source: 'automation' }, none: {},
  historyBase: { history_base: { thread_id: 'rollout-1', end_ordinal_exclusive: 4, end_byte_offset: 100 } },
})) add(`codex meta ${n}`, 'codex', body(extra));
add('codex second meta ignored', 'codex', jsonl([codexMeta('codex-int', 'C:\\P', { source: 'vscode', thread_source: 'user' }), codexMessage('user', 'Hello'), codexMeta('codex-other', 'C:\\P', { source: { subagent: 'review' } })]));
add('codex compacted records', 'codex', jsonl([codexMeta(), ...Array.from({ length: 120 }, (_, n) => [
  codexMessage('user', `Question ${n}`), codexMessage('assistant', `Answer ${n}`),
  ...(n % 50 === 49 ? [{ type: 'compacted', payload: { message: '', replacement_history: [] } }, { type: 'event_msg', payload: { type: 'task_started' } }] : []),
]).flat()]));

add('claude active chain', 'claude', jsonl([
  { type: 'file-history-snapshot', messageId: 'x' },
  claudeEntry('u0', null, 'user', 'Caveat: the messages below…', { isMeta: true }),
  claudeEntry('u1', 'u0', 'user', cmd('init')),
  claudeEntry('u2', 'u1', 'user', text('Please refactor the parser')),
  claudeEntry('a1', 'u2', 'assistant', [{ type: 'thinking', thinking: 'private', signature: 'SIG' }, ...text('Reading files.')]),
  claudeEntry('a2', 'a1', 'assistant', [{ type: 'tool_use', id: 't1', name: 'Read', input: { path: '/etc/x' } }]),
  claudeEntry('u3', 'a2', 'user', [{ type: 'tool_result', tool_use_id: 't1', content: 'FILE BODY' }]),
  claudeEntry('a3-old', 'u3', 'assistant', text('Old branch answer')),
  claudeEntry('side', 'u3', 'assistant', text('Sidechain text'), { isSidechain: true }),
  claudeEntry('a3', 'u3', 'assistant', text('Refactored.')),
  claudeEntry('u4', 'a3', 'user', [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }, ...text('[Image: original 100x100, displayed at 100x100]'), ...text('Does it look right?')]),
  claudeEntry('u5', 'u4', 'user', '<task-notification>\n<task-id>1</task-id>\n</task-notification>'),
  claudeEntry('u6', 'u5', 'user', '[Request interrupted by user]'),
  claudeEntry('a4', 'u6', 'assistant', text('Yes.')),
  { type: 'agent-name', agentName: 'ignored' },
]));
add('claude long tool run', 'claude', jsonl([
  claudeEntry('u1', null, 'user', 'go'),
  claudeEntry('a1', 'u1', 'assistant', [...text('Start.'), ...[...Array(30).fill('shell'), ...Array(12).fill('Read'), 'apply_patch'].map((name, i) => ({ type: 'tool_use', id: `t${i}`, name, input: {} })), ...text('End.')]),
]));
const first = claudeEntry('u1', null, 'user', 'First question');
const answer = claudeEntry('a1', 'u1', 'assistant', text('First answer'));
add('claude replay and compaction', 'claude', jsonl([first, answer, first, answer, boundary('b1', 'a1'),
  claudeEntry('s1', 'b1', 'user', 'This session is being continued…', { isCompactSummary: true }), claudeEntry('u2', 's1', 'user', 'Second question')]));
add('claude summary stands in', 'claude', jsonl([boundary('b1', 'gone'),
  claudeEntry('s1', 'b1', 'user', 'Summary of the earlier work', { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
  claudeEntry('u2', 's1', 'user', 'Second question'), claudeEntry('a2', 'u2', 'assistant', text('Second answer'))]));
const summary = (uuid, parent, t) => claudeEntry(uuid, parent, 'user', t, { isCompactSummary: true, isVisibleInTranscriptOnly: true });
add('claude boundary never written', 'claude', jsonl([
  claudeEntry('u1', null, 'user', 'First question'), claudeEntry('a1', 'u1', 'assistant', text('First answer')),
  boundary('b1', 'never-written'), { type: 'attachment', uuid: 'at1', parentUuid: 'b1' }, summary('s1', 'at1', 'Summary one'),
  claudeEntry('u2', 's1', 'user', 'Second question'), claudeEntry('a2', 'u2', 'assistant', text('Second answer')),
  boundary('b2', 'a2'), summary('s2', 'b2', 'Summary two'),
  claudeEntry('u3', 's2', 'user', 'Third question'), claudeEntry('a3', 'u3', 'assistant', text('Third answer')),
]));
add('claude slash commands', 'claude', jsonl([
  claudeEntry('u0', null, 'user', 'Caveat', { isMeta: true }),
  claudeEntry('u1', 'u0', 'user', cmd('model', 'opus')),
  claudeEntry('u2', 'u1', 'user', '<local-command-stdout>Set model to opus</local-command-stdout>'),
  claudeEntry('u3', 'u2', 'user', cmd('launch', 'the beta')),
  claudeEntry('u4', 'u3', 'user', text('## Launch\nExpanded skill body'), { isMeta: true }),
  claudeEntry('a1', 'u4', 'assistant', text('Launching.')),
  claudeEntry('u5', 'a1', 'user', '<command-message>review</command-message>\n<command-name>review</command-name>\n<skill-format>true</skill-format>'),
  claudeEntry('a2', 'u5', 'assistant', text('Reviewed.')),
]));
add('claude only command', 'claude', jsonl([claudeEntry('u1', null, 'user', cmd('compact')), claudeEntry('a1', 'u1', 'assistant', text('Ok'))]));
add('claude paste envelope and create-pr', 'claude', jsonl([
  claudeEntry('u1', null, 'user', '\n\n<pasted_content id="a1b2">\nerror log line\n\n```\ncode()\n```\n</pasted_content id="a1b2">\n\nWhy?'),
  claudeEntry('a1', 'u1', 'assistant', text('Because.')),
  claudeEntry('u2', 'a1', 'user', '<create-pr-command>\n## Steps\nRun `gh pr create`.\n</create-pr-command>'),
  claudeEntry('a2', 'u2', 'assistant', text('PR opened.')),
]));
const PASTES = [
  'Explain the literal <pasted_content> tag.',
  'Why?\n\n```js\nconst open = "<pasted_content>";\nconst close = "</pasted_content>";\n```',
  '<pasted_content>\nraw\n</pasted_content>\n\nWhat now?',
  '<pasted_content id="a1b2">\nbody\n</pasted_content id="c3d4">',
  '<pasted_content id="zzzz">\nbody\n</pasted_content id="zzzz">',
  'Start <pasted_content id="a1b2">\nnever closed',
  'Is <pasted_content> special?\n<pasted_content id="0f9e">\nlog\n</pasted_content id="0f9e">',
  '    indented first line\n<pasted_content id="0f9e">\nlog\n</pasted_content id="0f9e">\nlast line  ',
  '<pasted_content id="0f9e">\n</pasted_content id="0f9e">',
  'a<pasted_content id="0f9e">\nx\n</pasted_content id="0f9e">b<pasted_content id="1234">\ny\n</pasted_content id="1234">\n',
  '<pasted_content id="ÄÄÄÄ">\nx\n</pasted_content id="ÄÄÄÄ">', '', '<pasted_content id="0f9',
];
PASTES.forEach((typed, i) => add(`claude typed ${i}`, 'claude', jsonl([claudeEntry('u1', null, 'user', typed), claudeEntry('a1', 'u1', 'assistant', text('Ok.'))])));
add('claude sidechain only', 'claude', jsonl([claudeEntry('s1', null, 'user', 'Explore', { isSidechain: true, agentId: 'a' }), claudeEntry('s2', 's1', 'assistant', 'Done', { isSidechain: true, agentId: 'a' })]));
add('claude title long', 'claude', jsonl([claudeEntry('u1', null, 'user', `  ${'word '.repeat(40)}\nnext line`)]));
add('claude title unbroken', 'claude', jsonl([claudeEntry('u1', null, 'user', 'x'.repeat(150))]));
add('claude title astral', 'claude', jsonl([claudeEntry('u1', null, 'user', `${'😀'.repeat(60)}\u00a0z`)]));
add('claude title whitespace', 'claude', jsonl([claudeEntry('u1', null, 'user', '\u00a0\u3000 a\t\tb \u2003 c\n')]));
add('claude timestamps', 'claude', jsonl([
  claudeEntry('u1', null, 'user', 'a', { timestamp: '2026-03-04T05:06:07.890Z' }),
  claudeEntry('a1', 'u1', 'assistant', text('b'), { timestamp: 1700000000000 }),
  claudeEntry('u2', 'a1', 'user', 'c', { timestamp: 'garbage' }),
]));
const small = jsonl([codexMeta('codex-6'), codexMessage('assistant', 'ab', 'cd')]);
for (const max of [4, 5, 50, 52, 53, 100]) add(`codex limit ${max}`, 'codex', small, { limits: { maxTranscriptChars: max } });
add('codex incomplete', 'codex', `${jsonl([codexMeta('codex-4'), codexMessage('user', 'Kept')])}{"type":"response_item","payload":{"ty`, { complete: false });
add('codex incomplete no newline', 'codex', '{"type":"session_meta"', { complete: false });
const results = Array.from({ length: 30 }, (_, i) => claudeEntry(`r${i}-${'u'.repeat(100)}`, i ? `r${i - 1}-${'u'.repeat(100)}` : null, 'user', [{ type: 'tool_result', tool_use_id: 't', content: 'x' }]));
add('claude retained default', 'claude', jsonl(results));
add('claude retained limit', 'claude', jsonl(results), { limits: { maxRetainedEntries: 10 } });
add('claude metadata limit', 'claude', jsonl(results), { limits: { maxMetadataBytes: 4096 } });
add('codex retained limit', 'codex', jsonl([codexMeta(), ...Array.from({ length: 20 }, () => codexMessage('user', 'x'))]), { limits: { maxRetainedEntries: 5 } });

const plain = (v) => JSON.parse(JSON.stringify(v));
const conversions = scenarios.map(({ name, source, text: input, complete = true, limits = {} }) => ({
  name, source, text: input, complete, limits,
  result: plain(convertConversationText(source, input, { complete, ...limits })),
}));
const pastes = PASTES.map((input) => ({ input, output: unwrapClaudePastes(input) }));
const lines = jsonl([codexMeta('codex-3', 'D:\\work', { source: { subagent: { other: 'guardian' } }, thread_source: 'guardian_review', base_instructions: { text: 'x'.repeat(5000) } })]);
const TRUNC = [
  lines.slice(0, 120), lines.slice(0, 200), lines.slice(0, 300), lines.trim().replace('"thread_source":"guardian_review",', '').slice(0, 300),
  '{"type":"session_meta","payload":{"id":"c","cwd":"/w","source":{"subagent":{"thread_spawn":{"depth":1}}},"base_',
  '{"type":"session_meta","payload":{"id":"c","cwd":"/w","source":"cli","metadata":{"source":{"subagent":{"other":"guardian"}},"thread_source":"guardian_review"},"base_',
  '{"type":"session_meta","payload":{"id":"c","cwd":"/w","source":{"subagent":{"thread_sp',
  '{"type":"session_meta","payload":{"id":"c","cwd":"/w","note":"\\"thread_source\\":\\"subagent\\"","source":"vscode","base_',
  '{"type":"response_item","payload":{"id":"c"', '', 'garbage', '{"type":"session_meta","payload":{"session_id":" s9 ","cwd":"  "',
];
const truncated = TRUNC.map((input) => ({ input, output: plain(codexMetaFromTruncatedLine(input)) }));

writeJson(join(FIXTURES_ROOT, 'services', 'import-convert-twin.json'), {
  domain: 'import-convert-twin',
  recorder: 'benchmarks/rust-core/recorders/record-import-convert.mjs',
  conversions, pastes, truncated,
});
console.log(`recorded ${conversions.length} conversions, ${pastes.length} pastes, ${truncated.length} truncated metas`);

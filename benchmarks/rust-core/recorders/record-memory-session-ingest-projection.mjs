#!/usr/bin/env node
// Node's session ingest projection (src/runtime/memory/lib/session-ingest-projection.test.mjs, 4 cases) from the real
// `projectSessionMessagesForIngest`, `sessionMessageContentForIngest` and `shouldExcludeIngestMessage`
// (session-ingest.mjs): the messages of the test file plus further shapes of every rule (text blocks, roles, tool
// calls, prefix envelopes, synthetic markers). Each probe records the message as given and the answers.
//
//   node benchmarks/rust-core/recorders/record-memory-session-ingest-projection.mjs --tree <dir>
import { begin, capture, finish, importFrom } from './lib/mc-record.mjs';

const ctx = begin();
const m = await importFrom(ctx.tree, 'src/runtime/memory/lib/session-ingest.mjs');
const { allTextContent, normalizeIngestRole, projectSessionMessagesForIngest, sessionMessageContentForIngest, shouldExcludeIngestMessage, isUnquotedToolCompletionHead } = m;

const projections = [];
const project = async (name, messages) => projections.push({ name, messages, ...(await capture(() => projectSessionMessagesForIngest(messages))) });
const content = async (name, message) => ({ name, message, content: await capture(() => sessionMessageContentForIngest(message)), exclude: await capture(() => shouldExcludeIngestMessage(message)) });

const envelope = ['# Session', 'Cwd: C:\\\\Project\\\\mixdog', 'Model: test', 'Workflow: solo', '', '# Project Instructions', 'repo-local rules', '# Additional context', 'prefetch notes', '# Prefetch', 'file list', '# Task', 'real user prompt'].join('\n');
const continuation = ['<system-reminder>', '<active-turn-continuation>', 'continue without repeating completed tool calls', '</active-turn-continuation>', '</system-reminder>'].join('\n');

await project('every text block of a user message is kept, images dropped', [{
  role: 'user',
  content: [
    { type: 'text', text: '<system-reminder>runtime context</system-reminder>' },
    { type: 'text', text: 'actual user instruction' },
    { type: 'image', source: 'ignored-binary' },
    { type: 'text', text: 'pasted continuation' },
  ],
}]);
await project('compact active-turn continuation rows are excluded', [
  { role: 'user', content: 'actual user instruction' },
  { role: 'user', content: continuation, meta: { source: 'compact-active-turn-continuation', synthetic: true } },
]);
await project('mixed conversation: system, tool, assistant with tool calls, empty and string-content rows', [
  { role: 'system', content: 'system prompt' },
  { role: 'user', content: 'first question' },
  { role: 'assistant', content: 'answer prose', toolCalls: [{ id: 'c1', name: 'read', arguments: {} }] },
  { role: 'tool', content: 'tool output', toolCallId: 'c1' },
  { role: 'assistant', content: [{ type: 'text', text: 'part one' }, { type: 'tool_use', id: 'c2' }, { type: 'text', text: 'part two' }] },
  { role: 'user', content: '' },
  { role: 'user', content: '   ' },
  { role: 'assistant', content: '.' },
  { role: 'user', content: 'Reference files:\nfoo.ts' },
  { role: 'user', content: '(attachment)' },
  { role: 'user', content: '[mixdog-runtime] continue' },
  { role: 'user', content: 'last question', meta: { ts: 1700000000000 } },
]);
await project('no messages / not an array', []);
await project('not an array: null', null);

const rows = [];
rows.push(await content('start-anchored prefix envelope is stripped to the task', { role: 'user', content: envelope }));
rows.push(await content('a prompt that merely mentions the markers later is kept', { role: 'user', content: '# Session\nmeeting notes\n# Task is later' }));
rows.push(await content('envelope without a task section', { role: 'user', content: '# Session\nCwd: x\n# Project Instructions\nrules' }));
rows.push(await content('envelope sections in another order', { role: 'user', content: '# Task\nfirst\n# Session\nlater' }));
rows.push(await content('assistant rows are not envelope-stripped', { role: 'assistant', content: envelope }));
rows.push(await content('array content joins its text blocks', { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }));
rows.push(await content('Reference files', { role: 'user', content: 'Reference files:\nfoo.ts' }));
rows.push(await content('attachment placeholder', { role: 'user', content: '(attachment)' }));
rows.push(await content('skill body with meta skill', { role: 'user', content: '<skill>body</skill>', meta: 'skill' }));
rows.push(await content('runtime marker', { role: 'user', content: '[mixdog-runtime] continue' }));
rows.push(await content('assistant dot', { role: 'assistant', content: '.', toolCalls: undefined }));
rows.push(await content('assistant dot with tool calls', { role: 'assistant', content: '.', toolCalls: [{ id: 'c' }] }));
rows.push(await content('exact user', { role: 'user', content: 'please continue the task' }));
rows.push(await content('exact assistant', { role: 'assistant', content: 'working on it' }));
rows.push(await content('compact summary meta synthetic', { role: 'user', content: 'summary', meta: { source: 'compact-summary', synthetic: true } }));
rows.push(await content('active-turn continuation', { role: 'user', content: continuation, meta: { source: 'compact-active-turn-continuation', synthetic: true } }));
rows.push(await content('synthetic flag only', { role: 'user', content: 'hello', meta: { synthetic: true } }));
rows.push(await content('tool role', { role: 'tool', content: 'out' }));
rows.push(await content('no content', { role: 'user' }));

const helpers = [];
for (const role of ['user', 'assistant', 'system', 'tool', 'USER', ' user ', null, undefined, 'developer']) helpers.push({ fn: 'normalizeIngestRole', role: role === undefined ? { absent: true } : role, ...(await capture(() => normalizeIngestRole(role))) });
for (const value of ['exact', '', null, undefined, [{ type: 'text', text: 'x' }, { type: 'image' }, { type: 'text', text: 'y' }], [{ type: 'text' }], [{ text: 'no type' }], ['str', { type: 'text', text: 'z' }], { type: 'text', text: 'obj' }, 5]) {
  helpers.push({ fn: 'allTextContent', content: value === undefined ? { absent: true } : value, ...(await capture(() => allTextContent(value))) });
}
for (const text of ['', 'Task completed', 'Tool use completed', 'normal text', null]) helpers.push({ fn: 'isUnquotedToolCompletionHead', text, ...(await capture(() => isUnquotedToolCompletionHead(text))) });

finish(ctx, {
  url: import.meta.url,
  set: 'memory-session-ingest-projection',
  golden: {
    domain: 'memory-session-ingest-projection',
    source: 'src/runtime/memory/lib/session-ingest-projection.test.mjs',
    cases: [
      { name: 'session ingest projection preserves every text block in a user message', projections: [projections[0]] },
      { name: 'session ingest projection excludes Compact active-turn continuation rows', projections: [projections[1]] },
      { name: 'user-turn prefix envelopes strip only manager.mjs start-anchored sections', rows: rows.slice(0, 2) },
      { name: 'ingest exclusion drops synthetic rows and keeps conversation', rows: rows.slice(6, 14) },
      { name: 'further shapes (beyond the test file)', projections: projections.slice(2), rows: [...rows.slice(2, 6), ...rows.slice(14)], helpers },
    ],
  },
  extra: {
    entry: { runs: 'projectSessionMessagesForIngest, sessionMessageContentForIngest, shouldExcludeIngestMessage, allTextContent, normalizeIngestRole, isUnquotedToolCompletionHead (session-ingest.mjs)', notRun: 'the ingest runtime that persists the projected rows (session-ingest-runtime)' },
    replay: 'mixdog-services memory: svc/memory/ingest_shape.rs all_text_content + the projection and exclusion (and mixdog-agent compact/ingest.rs for the compact source list); compares projected rows, stripped content and exclusion flags exactly',
    exclusions: 'the last case holds probes the test file does not run',
    normalised: { 'undefined arguments': 'written as {"absent":true}' },
  },
});
process.exit(0);

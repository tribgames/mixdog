#!/usr/bin/env node
// Recording of standalone/session-tool-output.test.mjs (b6f10295a): what the `session` tool's list and read quote the model:
// `sessionListOutput` over catalog pages (selection fields, the rows that are the caller's, the budget cut and its cursor) and
// `sessionReadOutput` over transcript windows (offsets, text windows, byte budgets). Each case records its input (a row list
// or the spec the test generated it from) and the whole output, or the error thrown.
//
//   node benchmarks/rust-core/recorders/record-session-tool-output.mjs --tree <export of b6f10295a with node_modules>
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sandbox = mkdtempSync(join(tmpdir(), 'session-tool-output-'));
for (const key of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
  process.env[key] = join(sandbox, key.toLowerCase());
  mkdirSync(process.env[key], { recursive: true });
}
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
const { openSet } = await import('./lib/case-set.mjs');

const set = openSet('session-tool-output', import.meta.url);
const { sessionListOutput, sessionReadOutput } = await set.load('src/standalone/session-tool-output.mjs');
const { decodeCatalogCursor } = await set.load('src/runtime/agent/orchestrator/session/catalog-db/schema.mjs');

// A case's rows are generated from its `spec` (the same rule is in the replay), the output is recorded whole.
const bigRows = (count) =>
  Array.from({ length: count }, (_, index) => ({
    id: `fixture_${index}`,
    title: '긴 제목😀"\\'.repeat(100),
    status: 'idle',
    cwd: `C:/프로젝트/${'폴더'.repeat(200)}`,
    updatedAt: 1000 - index,
    providerReplay: { secret: 'not part of the tool result' },
    storageSize: 123,
  }));

const budgetPage = { sessions: bigRows(100), nextCursor: null };
await set.run('list cuts a page to the budget and repairs its cursor', () => {
  const out = sessionListOutput(budgetPage, 100);
  const cut = out.sessions.length;
  const cursor = decodeCatalogCursor(out.nextCursor);
  const remainder = sessionListOutput({ sessions: budgetPage.sessions.slice(cut), nextCursor: null }, 100);
  return { out, cursor, remainderFirstId: remainder.sessions[0].id, keys: Object.keys(out.sessions[0]) };
}, { input: { rows: { count: 100, title: '긴 제목😀"\\', titleRepeat: 100, cwdRoot: 'C:/프로젝트/', cwdUnit: '폴더', cwdRepeat: 200, updatedAtFrom: 1000 }, limit: 100 } });

const archivedPage = { sessions: [{ id: 'sess_a', archived: true }, { id: 'sess_b', archived: false }], nextCursor: null };
for (const rich of [true, false]) {
  await set.run(`an archived row says so, rich ${rich}`, () => sessionListOutput(archivedPage, 25, { rich }), { input: { page: archivedPage, limit: 25, rich } });
}

const richPage = {
  sessions: [
    { id: 'sess_home_mailer', title: 'Mailer', lastUsedAt: Date.UTC(2026, 0, 1, 12), lastMessagePreview: 'Sent the\n digest', working: true, storageSize: 1 },
    { id: 'sess_rmem_abc123_mailer', title: 'Room', agentWorking: true },
    { id: 'sess_plain', title: 'Plain', lastMessagePreview: '긴'.repeat(300) },
  ],
  nextCursor: null,
};
await set.run('rich rows carry the bot, last activity, latest line and working state', () => sessionListOutput(richPage, 25), { input: { page: { ...richPage, sessions: richPage.sessions.map((row) => (row.lastMessagePreview?.startsWith('긴') ? { ...row, lastMessagePreview: { repeat: ['긴', 300] } } : row)) }, limit: 25 } });
const taskPage = { sessions: [{ id: 'sess_t', title: 'Fix', sourceName: 'agent:mailer@room', lastMessagePreview: '<system-reminder>x' }], nextCursor: null };
await set.run('a task session names its creator and quotes its preview', () => sessionListOutput(taskPage, 25), { input: { page: taskPage, limit: 25 } });
const backgroundPage = { sessions: [{ id: 'sess_home_mailer', title: 'M', lastMessagePreview: 'p' }] };
await set.run('a background caller gets the plain selection fields', () => sessionListOutput(backgroundPage, 25, { rich: false }), { input: { page: backgroundPage, limit: 25, rich: false } });

const ownPage = {
  sessions: [
    { id: 'sess_user_1', preview: 'private first line', status: 'running', cwd: '/secret', lastMessagePreview: 'x' },
    { id: 'sess_home_mailer', preview: 'own first line', status: 'idle', cwd: '/own' },
  ],
  nextCursor: null,
};
await set.run("a bot's list never titles another's untitled session with its preview", () => sessionListOutput(ownPage, 25, { rich: (row) => row.id === 'sess_home_mailer' }), { input: { page: ownPage, limit: 25, richOwn: 'sess_home_mailer' } });

const workingRows = [
  { id: 'sess_agent', status: 'idle', working: true, lastUsedAt: 1, liveAt: 5 },
  { id: 'sess_lead', status: 'idle', agentWorking: true },
];
for (const rich of [true, false]) {
  await set.run(`a working row reads running for any caller, rich ${rich}`, () => sessionListOutput({ sessions: workingRows, nextCursor: null }, 25, { rich }), { input: { page: { sessions: workingRows, nextCursor: null }, limit: 25, rich } });
}
await set.run('a budget cut continues from cursorOf', () => sessionListOutput({ sessions: workingRows, nextCursor: null }, 1, { cursorOf: (row) => `after:${row.id}` }), { input: { page: { sessions: workingRows, nextCursor: null }, limit: 1, cursorOf: 'after:<id>' } });
await set.run('an empty page and an uncut page keep the service cursor', () => ({
  empty: sessionListOutput({ sessions: [], nextCursor: null }, 25),
  uncut: sessionListOutput({ sessions: [{ id: 'one' }], nextCursor: 'service-cursor' }, 1),
}), { input: {} });

const readItems = [
  { kind: 'user', text: 'old' },
  { kind: 'assistant', id: 'render-only', text: '  indented code\n', providerReplay: 'private' },
  { kind: 'turndone', status: 'failed', detail: 'quota reached', elapsedMs: 100, checkpointId: 'internal' },
];
await set.run('read preserves range indices and removes rendering metadata', () => sessionReadOutput('s', { offset: 7, items: readItems.slice(1), hasOlder: true }), { input: { sessionId: 's', range: { offset: 7, items: readItems.slice(1), hasOlder: true } } });

const unitText = '😀漢字"\\\n';
await set.run('read bounds UTF-8 and escaped text and keeps failure and cancellation signals', () => {
  const items = Array.from({ length: 100 }, () => ({ kind: 'assistant', text: unitText.repeat(2000) }));
  items.push({ kind: 'tool', name: 'shell', isError: true, status: 'cancelled', result: 'Error: cancelled by caller' });
  return { full: sessionReadOutput('s', { items, offset: 0, hasOlder: false }), empty: sessionReadOutput('s', { items: [], offset: 0 }) };
}, { input: { sessionId: 's', range: { items: { assistant: { count: 100, textUnit: unitText, repeat: 2000 }, then: { kind: 'tool', name: 'shell', isError: true, status: 'cancelled', result: 'Error: cancelled by caller' } }, offset: 0, hasOlder: false } } });

const attachmentItems = [
  { kind: 'user', attachments: [{ id: 'a' }, { id: 'b' }], imageRefs: [{ id: 'a' }], images: [{ id: 'a' }] },
  { kind: 'user', imageRefs: [{ id: 'legacy' }] },
  { kind: 'user', images: [{ id: 'live' }] },
];
await set.run('attachment counts prefer canonical records', () => sessionReadOutput('s', { items: attachmentItems, offset: 0 }), { input: { sessionId: 's', range: { items: attachmentItems, offset: 0 } } });

for (const kind of ['assistant', 'tool']) {
  await set.run(`text continuation reconstructs ${kind} text without splitting emoji`, () => {
    const text = `  code\n${unitText.repeat(2500)}`;
    const item = { id: 'stable', kind, ...(kind === 'tool' ? { result: text } : { text }) };
    const range = { offset: 9, items: [item] };
    const pages = [];
    let textOffset = 0;
    let restored = '';
    do {
      const output = sessionReadOutput('s', range, { textOffset, itemId: 'stable' });
      pages.push({ textOffset, text: output.items[0].text.length, nextTextOffset: output.items[0].nextTextOffset ?? null });
      restored += output.items[0].text;
      textOffset = output.items[0].nextTextOffset;
    } while (textOffset !== undefined);
    let stale;
    try { sessionReadOutput('s', range, { textOffset: 2, itemId: 'moved' }); } catch (error) { stale = error.message; }
    let splits;
    try { sessionReadOutput('s', { offset: 0, items: [{ kind: 'assistant', text: 'a😀b' }] }, { textOffset: 2 }); } catch (error) { splits = error.message; }
    return { pages, restoredIsText: restored === text, stale, splits };
  }, { input: { sessionId: 's', item: { id: 'stable', kind, text: { prefix: '  code\n', unit: unitText, repeat: 2500 } }, offset: 9 } });
}

await set.run('tail and subsequent pages use the same budgets', () => {
  const items = Array.from({ length: 100 }, (_, i) => ({ id: String(i), kind: 'assistant', text: 'a'.repeat(2000) }));
  const tail = sessionReadOutput('s', { offset: 0, items, hasOlder: true });
  const page = sessionReadOutput('s', { offset: 100, items, hasOlder: true });
  return { tail, page };
}, { input: { sessionId: 's', items: { count: 100, text: { unit: 'a', repeat: 2000 } } } });

await set.finish({
  entry: 'standalone/session-tool-output.mjs sessionListOutput and sessionReadOutput over the inputs recorded with each case (a generated list is recorded as its spec); the summary of an empty tool result (summarizeToolResult) is not reached by these cases',
  replay: { entry: 'session_list_output and session_read_output over the recorded inputs; compared whole, key order included', normalised: {} },
  exclusions: { summarizeToolResult: 'a tool row with no result text falls back to its summary in Node; none of the recorded cases has such a row, and the core quotes the row\'s own text there' },
});
process.exit(0);

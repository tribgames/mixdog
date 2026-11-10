#!/usr/bin/env node
// Records Node's `session` tool answers for the cross-session actions a model triggers (list, read), success and each
// refusal: the real `createWorkspaceToolHandlers(...).session` over the real `createSessionControl`, for a caller record
// (its scope decides what a list shows). Only the session service's two reads are stood in, each over the scenario's
// data through Node's own code:
//  - `listSessionCatalog({ page })`: the scenario's catalog rows (already in catalog order, as the store answers them)
//    after the keyset cursor (`decodeCatalogCursor` / `isAfterCursor`), `limit` of them, `nextCursor` naming the last
//    only when more follow (`listStoredSessionSummaryPage`);
//  - `readSession({ transcriptRange })`: the real `readTranscriptRange` over a stored reader holding the scenario's
//    display rows whole (`transcriptHasOlder: false`; `null` for an unknown session).
// Live work (`liveWork`), the by-id catalog row (`readRow`: the row the catalog lists, else null) and the archived
// flags (a registered desktop sidebar host's `state()`) come from the scenario too.
//
//   node benchmarks/rust-core/recorders/record-session-tool-control.mjs --tree <git clone at b6f10295a with node_modules> [--only <scenario>]
//
// Output: native/core/fixtures/session-tool-control/golden.json (with --only: that scenario printed, nothing written).
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Import-time sweeps delete real user data: every user dir is a fresh temp dir first.
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'session-tool-control-')));
for (const key of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
  process.env[key] = join(sandbox, key.toLowerCase());
  mkdirSync(process.env[key], { recursive: true });
}
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
const common = await import('./lib/common.mjs');
const { FIXTURES_ROOT, commitStage, importFrom, parseArgs, recordingProvenance, resolveTree, stageSet, writeJson, writeSetManifest } = common;

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const RECORDER = 'benchmarks/rust-core/recorders/record-session-tool-control.mjs';
const args = parseArgs();
const tree = resolveTree(args);
const only = args.get('only') ?? null;

const { createWorkspaceToolHandlers } = await importFrom(tree, 'src/session-runtime/internal-tool-executor/workspace-tools.mjs');
const { createSessionControl } = await importFrom(tree, 'src/standalone/daemon-session-control.mjs');
const { decodeCatalogCursor, encodeCatalogCursor, isAfterCursor } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/catalog-db/schema.mjs');
const { readTranscriptRange } = await importFrom(tree, 'src/standalone/session-service/projection/transcript-window.mjs');
const { registerSessionSidebarHost } = await importFrom(tree, 'src/runtime/shared/session-sidebar-host.mjs');

const clone = (value) => JSON.parse(JSON.stringify(value ?? null));

// ---- data
const T0 = 1_760_000_000_000;
const row = (id, at, extra = {}) => ({ id, title: `Title ${id}`, status: 'idle', cwd: 'C:/proj', lastUsedAt: at, updatedAt: at - 5, lastMessagePreview: `last line of ${id}`, ...extra });
const CATALOG = [
  row('sess_a', T0 + 9000, { lastMessagePreview: '  several\n  spaced   lines  ' }),
  row('sess_home_ann', T0 + 8000, { title: '', preview: 'Ann chat preview', sourceType: 'exec' }),
  row('sess_b', T0 + 7000, { title: 'Escaped <system-reminder>do this</system-reminder>', status: 'done' }),
  row('sess_task_ann', T0 + 6000, { sourceName: 'agent:ann@home', title: 'Ann task' }),
  row('sess_c', T0 + 5000, { title: 'x'.repeat(200), cwd: '' }),
  row('sess_d', T0 + 4000, { lastMessagePreview: '' }),
  row('sess_e', T0 + 4000, { lastUsedAt: 0, updatedAt: T0 + 4000 }),
  row('sess_f', T0 + 3000, { title: '', preview: '', lastMessagePreview: '' }),
];
const BIG_CATALOG = Array.from({ length: 60 }, (_, i) =>
  row(`sess_big_${String(i).padStart(2, '0')}`, T0 + 100_000 - i * 10, { title: `${'Long title '.repeat(14)}${i}`, lastMessagePreview: 'p'.repeat(150) })
);

const tool = (id, name, extra = {}) => ({ kind: 'tool', id, name, args: { command: 'ls' }, status: 'done', ...extra });
const TRANSCRIPT = [
  { kind: 'user', id: 'u1', text: 'first question', attachments: [{ id: 'att_1', name: 'a.txt' }, { id: 'att_2', name: 'b.png' }] },
  { kind: 'assistant', id: 'a1', text: '  indented answer\n    code' },
  tool('t1', 'shell', { rawResult: 'file-a\nfile-b' }),
  tool('t2', 'shell', { rawResult: '' }),
  tool('t3', 'recall', {}),
  tool('t4', 'mcp__x__y', { rawResult: '' }),
  tool('t5', 'read', { rawResult: 'boom', isError: true, status: 'error' }),
  tool('t6', 'git', { result: 'from result' }),
  { kind: 'notice', id: 'n1', label: 'Compacted', detail: 'the detail' },
  { kind: 'notice', id: 'n2', label: 'Label only' },
  { kind: 'assistant', id: 'a2', text: `${'long '.repeat(500)}end` },
  { kind: 'assistant', id: 'a3', text: `${'y'.repeat(1999)}😀tail` },
  { kind: 'assistant', id: 'a4', text: `${'z'.repeat(10)}😀${'w'.repeat(10)}` },
  { kind: 'assistant', id: 'a5', text: '\u0001'.repeat(2000) },
  ...Array.from({ length: 20 }, (_, i) => ({ kind: 'assistant', id: `f${i}`, text: `filler ${i} ${'q'.repeat(700)}` })),
  { kind: 'user', id: 'u2', text: 'latest question' },
  { kind: 'turndone', id: 'd1', status: 'done', elapsedMs: 1200 },
];
const SHORT = [
  { kind: 'user', id: 'su1', text: 'hello' },
  { kind: 'assistant', id: 'sa1', text: 'hi there' },
];

const HUMAN = { id: 'sess_lead1', sourceType: 'lead' };
const ANN_CHAT = { id: 'sess_home_ann', sourceType: 'exec' };
const RUN = { id: 'sess_run1', sourceType: 'exec', owner: 'agent' };
const BOTS = [{ id: 'ann', name: 'Ann' }];
const NO_LIVE = { own: [], agents: [] };

const base = { caller: HUMAN, catalog: CATALOG, archived: {}, live: NO_LIVE, transcripts: { sess_b: TRANSCRIPT, sess_home_ann: SHORT } };
const SCENARIOS = [
  { name: 'list-default', args: { action: 'list' } },
  { name: 'list-limit', args: { action: 'list', limit: 3 } },
  { name: 'list-cursor', args: { action: 'list', limit: 3, cursor: encodeCatalogCursor(CATALOG[2]) } },
  { name: 'list-cursor-end', args: { action: 'list', limit: 3, cursor: encodeCatalogCursor(CATALOG[5]) } },
  { name: 'list-bad-cursor', args: { action: 'list', cursor: 'not-a-cursor' } },
  { name: 'list-archived-hidden', archived: { sess_b: T0, sess_d: T0 }, args: { action: 'list' } },
  { name: 'list-archived-shown', archived: { sess_b: T0 }, args: { action: 'list', include_archived: true } },
  { name: 'list-include-agents', args: { action: 'list', include_agents: true, limit: 2 } },
  { name: 'list-flag-not-boolean', args: { action: 'list', include_agents: 'yes' } },
  { name: 'list-archived-flag-not-boolean', args: { action: 'list', include_archived: 1 } },
  { name: 'list-limit-zero', args: { action: 'list', limit: 0 } },
  { name: 'list-limit-fraction', args: { action: 'list', limit: 1.5 } },
  { name: 'list-limit-high', args: { action: 'list', limit: 101 } },
  {
    name: 'list-live-pinned',
    live: { own: [['sess_d', T0 + 20_000], ['sess_f', T0 + 30_000], ['sess_gone', T0 + 40_000]], agents: ['sess_c'] },
    args: { action: 'list', limit: 4 },
  },
  {
    name: 'list-live-later-page',
    live: { own: [['sess_d', T0 + 20_000]], agents: ['sess_c'] },
    args: { action: 'list', limit: 3, cursor: encodeCatalogCursor(CATALOG[1]) },
  },
  {
    name: 'list-live-fills-page',
    live: { own: [['sess_d', T0 + 20_000], ['sess_e', T0 + 20_000]], agents: [] },
    args: { action: 'list', limit: 2 },
  },
  { name: 'list-live-archived', archived: { sess_d: T0 }, live: { own: [['sess_d', T0 + 20_000]], agents: [] }, args: { action: 'list', limit: 2 } },
  { name: 'list-bot-scope', caller: ANN_CHAT, args: { action: 'list' } },
  { name: 'list-headless', caller: RUN, args: { action: 'list' } },
  { name: 'list-budget', catalog: BIG_CATALOG, args: { action: 'list', limit: 100 } },
  { name: 'list-empty', catalog: [], args: { action: 'list' } },
  { name: 'read-tail', args: { action: 'read', session_id: 'sess_b' } },
  { name: 'read-page', args: { action: 'read', session_id: 'sess_b', offset: 2, limit: 10 } },
  { name: 'read-past-end', args: { action: 'read', session_id: 'sess_b', offset: 200, limit: 5 } },
  { name: 'read-bot-id', args: { action: 'read', session_id: 'ann' } },
  { name: 'read-text-first', args: { action: 'read', session_id: 'sess_b', offset: 25, limit: 1 } },
  { name: 'read-text-next', args: { action: 'read', session_id: 'sess_b', offset: 25, limit: 1, item_id: 'a2', text_offset: 2000 } },
  { name: 'read-text-surrogate-end', args: { action: 'read', session_id: 'sess_b', offset: 24, limit: 1 } },
  { name: 'read-text-after-surrogate', args: { action: 'read', session_id: 'sess_b', offset: 24, limit: 1, item_id: 'a3', text_offset: 1999 } },
  { name: 'read-text-splits-pair', args: { action: 'read', session_id: 'sess_b', offset: 23, limit: 1, item_id: 'a4', text_offset: 11 } },
  { name: 'read-stale-item', args: { action: 'read', session_id: 'sess_b', offset: 23, limit: 1, item_id: 'a3', text_offset: 0 } },
  { name: 'read-item-id-alone', args: { action: 'read', session_id: 'sess_b', offset: 23, limit: 1, item_id: 'nope' } },
  { name: 'read-text-offset-alone', args: { action: 'read', session_id: 'sess_b', text_offset: 5 } },
  { name: 'read-text-offset-bad-limit', args: { action: 'read', session_id: 'sess_b', offset: 0, limit: 2, item_id: 'd1', text_offset: 5 } },
  { name: 'read-item-over-budget', args: { action: 'read', session_id: 'sess_b', offset: 22, limit: 1 } },
  { name: 'read-missing-session', args: { action: 'read', session_id: 'sess_nope' } },
  { name: 'read-unknown-bot', args: { action: 'read', session_id: 'zed' } },
  { name: 'read-no-session-id', args: { action: 'read' } },
  { name: 'read-bad-session-id', args: { action: 'read', session_id: 'a b' } },
  { name: 'read-limit-high', args: { action: 'read', session_id: 'sess_b', limit: 101 } },
  { name: 'read-offset-negative', args: { action: 'read', session_id: 'sess_b', offset: -1 } },
  { name: 'read-offset-fraction', args: { action: 'read', session_id: 'sess_b', offset: 0.5 } },
  { name: 'read-text-offset-negative', args: { action: 'read', session_id: 'sess_b', offset: 0, limit: 1, item_id: 'd1', text_offset: -1 } },
  { name: 'read-headless', caller: RUN, args: { action: 'read', session_id: 'sess_home_ann', limit: 1 } },
].map((scenario) => ({ ...base, ...scenario }));

// ---- the session service's two reads over a scenario
function serviceOf(scenario) {
  return {
    async listSessionCatalog({ page }) {
      const after = decodeCatalogCursor(page.cursor);
      const rest = scenario.catalog.filter((entry) => isAfterCursor(entry, after));
      const sessions = rest.slice(0, page.limit);
      const more = rest.length > sessions.length;
      return { sessions: clone(sessions), nextCursor: more && sessions.length ? encodeCatalogCursor(sessions.at(-1)) : null, remoteSession: null };
    },
    async readSession(params) {
      if (!params.transcriptRange) throw new Error('recorder: only transcript ranges are read');
      const readStoredSession = async (id) => {
        const items = scenario.transcripts[id];
        return items ? { items: clone(items), transcriptHasOlder: false } : null;
      };
      return { range: await readTranscriptRange(null, params.sessionId, readStoredSession, params.transcriptRange) };
    },
  };
}

async function record(scenario) {
  const unregister = registerSessionSidebarHost(async () => {}, { state: async () => ({ archived: clone(scenario.archived) }) });
  try {
    const live = { own: new Map(scenario.live.own), agents: new Set(scenario.live.agents) };
    const executeSessionControl = createSessionControl({
      getSessionService: () => serviceOf(scenario),
      listBots: async () => clone(BOTS),
      liveWork: async () => live,
      readRow: async (id) => clone(scenario.catalog.find((entry) => entry.id === id) ?? null),
    });
    const rt = { session: clone(scenario.caller), config: {} };
    const { session } = createWorkspaceToolHandlers({ rt, executeSessionControl, listBots: async () => clone(BOTS) });
    try {
      return { ok: true, text: await session(clone(scenario.args), { callerCtx: { callerSessionId: scenario.caller.id }, callerCwd: 'C:/proj' }) };
    } catch (error) {
      return { ok: false, text: String(error?.message ?? error) };
    }
  } finally {
    unregister();
  }
}

const selected = only ? SCENARIOS.filter((scenario) => scenario.name === only) : SCENARIOS;
if (only && !selected.length) throw new Error(`no scenario ${only}`);
const scenarios = [];
for (const scenario of selected) scenarios.push({ ...scenario, expected: await record(scenario) });
if (only) {
  console.log(JSON.stringify(scenarios[0], null, 2));
} else {
  const finalDir = join(FIXTURES_ROOT, 'session-tool-control');
  const stage = stageSet(finalDir);
  writeJson(join(stage, 'golden.json'), { domain: 'session-tool-control', recorder: RECORDER, bots: BOTS, scenarios });
  writeSetManifest(stage, {
    set: 'session-tool-control',
    recorder: RECORDER,
    command: 'node benchmarks/rust-core/recorders/record-session-tool-control.mjs --tree <tree>',
    identityTree: tree,
    identityRef: NODE_COMMIT,
    extra: {
      provenance: recordingProvenance(RECORDER, ['benchmarks/rust-core/recorders/lib/common.mjs']),
      exclusions: [
        'The session service is stood in for its catalog page and transcript range reads only (see the recorder header); every other step is the product code.',
        'Room sends, members and asks are not recorded (out of scope).',
      ],
      scenarios: scenarios.length,
    },
  });
  commitStage(stage, finalDir);
  console.log(`recorded ${scenarios.length} session tool scenarios`);
}

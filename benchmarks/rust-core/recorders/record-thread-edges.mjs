#!/usr/bin/env node
// Node's session roster per catalog write, for every way a session row comes to be listed, changes, or stops being listed.
// Node pushed the whole roster on every stored-session catalog change (session-host-catalog.ts publishCatalogs ->
// CatalogChannel.publish, which skipped a canonically equal roster). The roster is the lead-visible rows
// (`_sessionSummary` + `isLeadVisibleRow`, the catalog DB's `lead_visible`) through `desktopSessionSummaries`
// (desktop-state.ts, the second gate), minus the drafts `pendingCatalogSessionIds` holds back. Each trigger is a sequence of
// header writes (the record as the store saved it); after each write the roster is recorded, and `published` says whether
// the channel would have published it (the canonical JSON of the roster changed).
//
//   node benchmarks/rust-core/recorders/record-thread-edges.mjs --tree <tree of b6f10295a with node_modules>
// Output: native/core/fixtures/thread-edges/golden.json
import { join } from 'node:path';
import './lib/ts-register.mjs';
import { FIXTURES_ROOT, exactProductIdentity, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const { _sessionSummary } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/store-summary-index.mjs');
const { isLeadVisibleRow } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/store-summary-catalog.mjs');
const { desktopSessionSummaries } = await importFrom(tree, 'apps/desktop/src/main/desktop-state.ts');

const rec = (id, extra) => ({ id, updatedAt: 1000, createdAt: 500, cwd: 'C:/w', messages: [], ...extra });
// The writes of each trigger, in order. `draft` rows are held back until titled (pendingCatalogSessionIds).
const triggers = [
  { name: 'create', writes: [rec('s_new', {}), rec('s_new', { title: 'First prompt', updatedAt: 1100 })] },
  { name: 'fork', writes: [rec('s_base', { title: 'Base' }), rec('s_fork', { title: 'Base (fork)', inheritedFromSessionId: 's_base', updatedAt: 1200 })] },
  { name: 'inherit', writes: [rec('s_old', { title: 'Old' }), rec('s_heir', { title: 'Heir', inheritedFromSessionId: 's_old', updatedAt: 1300 }), rec('s_heir', { title: 'Heir', inheritedFromSessionId: 's_old', updatedAt: 1300 })] },
  { name: 'import', writes: [rec('s_imp', { title: 'Imported', sourceType: 'import', updatedAt: 1400 })] },
  { name: 'schedule', writes: [rec('s_sch', { title: 'Nightly', sourceType: 'schedule', sourceName: 'nightly', updatedAt: 1500 })] },
  { name: 'webhook', writes: [rec('s_web', { title: 'Hook', sourceType: 'webhook', sourceName: 'hook', updatedAt: 1600 })] },
  { name: 'agent-session', writes: [rec('s_ag', { title: 'Worker', owner: 'agent', agent: 'worker', ownerSessionId: 's_a', updatedAt: 1700 })] },
  { name: 'never-listed', writes: [rec('s_exec', { title: 'exec run', sourceType: 'exec' }), rec('s_bot', { title: 'by a bot', sourceType: 'bot', sourceName: 'newsbot' }), rec('s_foreign', { title: 'foreign', owner: 'importer' })] },
  { name: 'update-and-quiet', writes: [rec('s_u', { title: 'Before', updatedAt: 1800 }), rec('s_u', { title: 'After', updatedAt: 1900 }), rec('s_u', { title: 'After', updatedAt: 1900 })] },
  { name: 'stops-being-listed', writes: [rec('s_gone', { title: 'Here', updatedAt: 2000 }), rec('s_gone', { updatedAt: 2100 })] },
  { name: 'two-sessions', writes: [rec('s_x', { title: 'X', updatedAt: 2200 }), rec('s_y', { title: 'Y', updatedAt: 2300 }), rec('s_x', { title: 'X2', updatedAt: 2400 })] },
  // A rename (`renameSession`: the header's title with `titleSource: user`, and the name in the desktop's `names`) of a session whose
  // generated title is meaningless: the name alone makes the row count. A later write keeps the name (the session may not be loaded).
  {
    name: 'rename-makes-a-meaningless-title-count',
    writes: [
      rec('s_r', { title: '---', updatedAt: 2500 }),
      rec('s_r', { title: '---', titleSource: 'user', titleLocked: true, updatedAt: 2600 }),
      rec('s_r', { title: '---', titleSource: 'user', titleLocked: true, updatedAt: 2700 }),
    ],
  },
  // A session already named when the daemon starts: its first write lists it.
  { name: 'already-renamed-session', writes: [rec('s_n', { title: '---', titleSource: 'user', titleLocked: true, updatedAt: 2800 }), rec('s_n', { title: '---', titleSource: 'user', titleLocked: true, updatedAt: 2900 })] },
  // A name without a meaningful text keeps nothing.
  { name: 'blank-name-keeps-nothing', writes: [rec('s_b', { title: '   ', titleSource: 'user', titleLocked: true, updatedAt: 3000 })] },
];

// The roster Node holds after the writes so far (the last write of an id replaces it).
const rosterOf = (records) => {
  const rows = [...records.values()].map(_sessionSummary).filter(isLeadVisibleRow);
  // `names[id]`: what `renameSession` stored beside the header's user title (the session metadata, whatever the session's state).
  const names = {};
  for (const record of records.values()) if (record.titleSource === 'user') names[record.id] = record.title;
  return desktopSessionSummaries(rows, {}, names)
    .map((row) => ({ id: row.id, title: row.title, preview: row.preview, updatedAt: row.updatedAt, messageCount: row.messageCount, cwd: row.cwd, classification: row.classification, ...(row.inheritedFromSessionId ? { inheritedFromSessionId: row.inheritedFromSessionId } : {}) }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
};
const recorded = triggers.map(({ name, writes }) => {
  const records = new Map();
  let last = JSON.stringify([]);
  const steps = writes.map((record) => {
    records.set(record.id, record);
    const roster = rosterOf(records);
    const json = JSON.stringify(roster);
    const published = json !== last;
    last = json;
    return { id: record.id, record, roster, published };
  });
  return { name, steps };
});

// The roster's own gate (`desktopSessionSummaries`, the second gate) on list rows as the catalog holds them: the rows that carry
// what the gate reads beyond a header (message counts, the cli-resume mark), so they are given as rows. `kept` is Node's answer.
const row = (id, extra) => ({ id, title: 'A title', preview: '', cwd: 'C:/w', updatedAt: 1000, createdAt: 500, messageCount: 0, ...extra });
const gateRows = [
  row('g_plain', {}),
  row('g_nul_cwd', { cwd: 'C:/w\0x' }),
  row('g_project_no_path', { cwd: '', desktopSession: { classification: 'project' } }),
  row('g_project_stored_path', { cwd: '', desktopSession: { classification: 'project', projectPath: 'C:/p' } }),
  row('g_project_nul_path', { cwd: '', desktopSession: { classification: 'project', projectPath: 'C:/p\0' } }),
  row('g_project_workspace', { cwd: '', desktopSession: { classification: 'project' }, workspace: { projectPath: 'C:/p', cwd: 'C:/p-wt' } }),
  row('g_project_workspace_nul', { cwd: '', desktopSession: { classification: 'project' }, workspace: { projectPath: 'C:/p\0', cwd: 'C:/p-wt' } }),
  row('g_task_no_cwd', { cwd: '', desktopSession: { classification: 'task' } }),
  row('g_legacy_no_cwd', { cwd: '' }),
  row('g_bad_classification', { desktopSession: { classification: 'other' } }),
  row('g_meta_array', { desktopSession: [] }),
  row('g_meta_string', { desktopSession: 'x' }),
  row('g_untitled_empty', { title: '' }),
  row('g_untitled_two_messages', { title: '', messageCount: 2, realTurnCount: 1 }),
  row('g_untitled_two_messages_no_turn_count', { title: '', messageCount: 2 }),
  row('g_untitled_one_message', { title: '', messageCount: 1, realTurnCount: 1 }),
  row('g_untitled_no_real_turn', { title: '', messageCount: 2, realTurnCount: 0 }),
  row('g_cli_resume_only', { title: '', messageCount: 2, realTurnCount: 1, detachedReason: 'cli-resume' }),
  row('g_cli_resume_titled', { title: 'Resumed', messageCount: 2, detachedReason: 'cli-resume' }),
  row('g_preview_only', { title: '', preview: 'hello there' }),
  row('g_home_one_message', { id: 'sess_home_ada', title: '', messageCount: 1 }),
  row('sess_home_bob', { title: '', messageCount: 0 }),
  row('g_other_one_message', { title: '', messageCount: 1 }),
];
// The roster's other inputs: the names users gave (`names`, written by `renameSession`) and the host's task workspace.
const TASK_WORKSPACE = 'C:\\Users\\u\\AppData\\Roaming\\mixdog\\workspace\\unclassified';
const gateCases = [
  ...gateRows.map((r) => ({ row: r })),
  // a title the generator drops as meaningless: only a user's name keeps the row
  { row: row('g_meaningless_title', { title: '---' }) },
  { row: row('g_meaningless_title_renamed', { title: '---' }), names: { g_meaningless_title_renamed: '---' } },
  { row: row('g_renamed_untitled', { title: '', preview: '' }), names: { g_renamed_untitled: 'Mine' } },
  { row: row('g_renamed_blank', { title: '' }), names: { g_renamed_blank: '   ' } },
  // a legacy row (no stored classification) in the task workspace is a task, elsewhere a project: kept either way
  { row: row('g_legacy_in_task_workspace', { cwd: TASK_WORKSPACE.toLowerCase().replaceAll('\\', '/') + '/' }), taskWorkspace: TASK_WORKSPACE },
  { row: row('g_legacy_in_task_workspace_untitled', { title: '', cwd: TASK_WORKSPACE }), taskWorkspace: TASK_WORKSPACE },
  { row: row('g_legacy_outside_task_workspace', { cwd: 'C:/elsewhere' }), taskWorkspace: TASK_WORKSPACE },
  { row: row('g_legacy_outside_task_workspace_untitled', { title: '', cwd: 'C:/elsewhere' }), taskWorkspace: TASK_WORKSPACE },
];
const gate = gateCases.map(({ row: r, names, taskWorkspace }) => ({
  row: r,
  ...(names ? { names } : {}),
  ...(taskWorkspace ? { taskWorkspace } : {}),
  kept: desktopSessionSummaries([r], {}, names ?? {}, taskWorkspace ?? '').length > 0,
}));

const finalOut = join(FIXTURES_ROOT, 'thread-edges');
const out = stageSet(finalOut);
writeJson(join(out, 'golden.json'), { note: 'the roster Node pushed after each catalog write of each trigger (header-only records); gate: the roster gate on list rows', triggers: recorded, gate });
writeSetManifest(out, {
  set: 'thread-edges',
  recorder: 'benchmarks/rust-core/recorders/record-thread-edges.mjs',
  command: 'node benchmarks/rust-core/recorders/record-thread-edges.mjs --tree <tree>',
  extra: { triggers: recorded.length, gateRows: gate.length },
  identity: exactProductIdentity(tree, 'b6f10295a2f698afc85332467192de28500bd146'),
});
commitStage(out, finalOut);
console.log(`triggers=${recorded.length} published=${recorded.flatMap((t) => t.steps).filter((s) => s.published).length}`);

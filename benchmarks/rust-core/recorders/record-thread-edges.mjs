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
const { canonicalJson } = await importFrom(tree, 'apps/desktop/src/shared/remote-view-resume.ts');
const { compactedSessionTitle } = await importFrom(tree, 'apps/desktop/src/shared/session-title.mjs');

// The host's task workspace (`<userData>/workspace/unclassified`), the one input of the roster besides the rows and the names.
const TASK_WORKSPACE = 'C:\\Users\\u\\AppData\\Roaming\\mixdog\\workspace\\unclassified';
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
  // Legacy rows (no stored classification) in and outside the host's task workspace, titled and untitled: in it a row is a task with
  // no project path (the folder spelled with the other slash style, a trailing slash and other letter case still match); elsewhere a
  // project at its folder. An untitled one is listed only once a user's name is given. A stored project row in the workspace stays one.
  {
    name: 'legacy-task-workspace',
    taskWorkspace: TASK_WORKSPACE,
    writes: [
      rec('s_in', { title: 'In the task workspace', cwd: TASK_WORKSPACE, updatedAt: 3100 }),
      rec('s_in_spelled', { title: 'Spelled otherwise', cwd: TASK_WORKSPACE.toLowerCase().replaceAll('\\', '/') + '/', updatedAt: 3200 }),
      rec('s_out', { title: 'Outside', cwd: 'C:/elsewhere', updatedAt: 3300 }),
      rec('s_in_untitled', { title: '', cwd: TASK_WORKSPACE, updatedAt: 3400 }),
      rec('s_out_untitled', { title: '', cwd: 'C:/elsewhere', updatedAt: 3500 }),
      rec('s_in_untitled', { title: '---', titleSource: 'user', titleLocked: true, cwd: TASK_WORKSPACE, updatedAt: 3600 }),
      rec('s_out_untitled', { title: '---', titleSource: 'user', titleLocked: true, cwd: 'C:/elsewhere', updatedAt: 3700 }),
      rec('s_in_project', { title: 'Stored project', cwd: TASK_WORKSPACE, desktopSession: { classification: 'project', projectPath: TASK_WORKSPACE }, updatedAt: 3800 }),
    ],
  },
  // The same writes when the host's task workspace is unknown: nothing is in it.
  { name: 'legacy-unknown-task-workspace', taskWorkspace: '', writes: [rec('s_unk', { title: 'Anywhere', cwd: TASK_WORKSPACE, updatedAt: 3900 })] },
];

// The roster Node holds after the writes so far (the last write of an id replaces it).
const rosterOf = (records, taskWorkspace) => {
  const rows = [...records.values()].map(_sessionSummary).filter(isLeadVisibleRow);
  // `names[id]`: what `renameSession` stored beside the header's user title (the session metadata, whatever the session's state).
  const names = {};
  for (const record of records.values()) if (record.titleSource === 'user') names[record.id] = record.title;
  // The complete rows, in the order Node holds them: the value the channel compares and pushes.
  return desktopSessionSummaries(rows, {}, names, taskWorkspace);
};
const recorded = triggers.map(({ name, writes, taskWorkspace = '' }) => {
  const records = new Map();
  let last = canonicalJson([]);
  const steps = writes.map((record) => {
    records.set(record.id, record);
    const roster = rosterOf(records, taskWorkspace);
    // CatalogChannel.publish (session-host-publication.ts:129-142) skips a value whose canonical JSON equals the last one.
    const json = canonicalJson(roster);
    const published = json !== last;
    last = json;
    return { id: record.id, record, roster, published };
  });
  return { name, taskWorkspace, steps };
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
const HANDOFF = 'A previous model worked on this task and produced the compacted handoff summary below.\n[2026-03-01 10:00] u: Recover this task #3\n[2026-03-01 10:01] a: done';
const MEDIA_ONLY = 'A previous model worked on this task and produced the compacted handoff summary below.\n[2026-03-01 10:00] u: shot.png 640x480 displayed at 320x240';
const NO_USER = 'A previous model worked on this task and produced the compacted handoff summary below.\n[2026-03-01 10:01] a: nothing asked';
// compactedSessionTitle on handoffs of every shape the digest takes: the earliest real user entry, by time, then id, then line.
const compactedInputs = [
  HANDOFF,
  MEDIA_ONLY,
  NO_USER,
  'A previous model worked on this task and produced the compacted handoff summary below.\n[2026-03-01 10:05] u: Later ask #9\n[2026-03-01 10:00] u: Earliest ask #2\n[2026-03-01 10:00] u: Same time, later id #5',
  'A previous model worked on this task and produced the compacted handoff summary below.\n[2026-03-01 10:00] u: First line\nsecond line of the ask\n[2026-03-01 10:01] a: reply',
  'A previous model worked on this task and produced the compacted handoff summary below.\n[2026-03-01 10:00] u: Ask above a marker\n</prior-compacted-context>\nnot part of the ask',
  'A previous model worked on this task and produced the compacted handoff summary below.\n[2026-03-01 10:00] u: Ask above a context line\n[context compacted at 10:02]\ntail\n[2026-03-01 10:03] u: Second ask',
  'A previous model worked on this task and produced the compacted handoff summary below.\n[2026-03-01 10:00] u: Ask above a session id\nsession_id=abc\n[2026-03-01 10:03] u: Second ask',
  'A previous model worked on this task and produced the compacted handoff summary below.\n[2026-03-01 10:00] u: shot.png 640x480 displayed at 320x240\n[2026-03-01 10:02] u: A worded ask later',
  'A previous model worked on this task and produced the compacted handoff summary below.\n[2026-03-01 10:00] u: shot.png 640x480\nthe text after the image\nmore',
  'A previous model worked on this task and produced the compacted handoff summary below.\n[2026-03-01 10:00] U: Upper case kind #1',
  'A previous model worked on this task and produced the compacted handoff summary below.\r\n[2026-03-01 10:00] u: CRLF ask #1\r\nwrapped\r\n[2026-03-01 10:01] a: x',
  '  a previous model worked on this task and produced the compacted handoff summary below.\n[2026-03-01 10:00] u: Leading blanks and lower case',
  'before\n\x3cprior-compacted-context>\n[2026-03-01 10:00] u: Inside the marked context',
  'A previous model worked on this task and produced the compacted handoff summary below.\n[2026-03-01 10:00] u: ---',
  '[2026-03-01 10:00] u: not a handoff at all',
  'plain preview text',
  '',
];
const compacted = compactedInputs.map((input) => ({ input, title: compactedSessionTitle(input, '') }));

// The roster's other inputs: the names users gave (`names`, written by `renameSession`) and the host's task workspace.
const gateCases = [
  ...gateRows.map((r) => ({ row: r })),
  // a title the generator drops as meaningless: only a user's name keeps the row
  { row: row('g_meaningless_title', { title: '---' }) },
  { row: row('g_meaningless_title_renamed', { title: '---' }), names: { g_meaningless_title_renamed: '---' } },
  { row: row('g_renamed_untitled', { title: '', preview: '' }), names: { g_renamed_untitled: 'Mine' } },
  { row: row('g_renamed_blank', { title: '' }), names: { g_renamed_blank: '   ' } },
  // a compact handoff as the preview: Node titles the row from the user prompt inside it (compactedSessionTitle), which the
  // generated title of the same text (a synthetic handoff) never gives
  { row: row('g_compacted_preview', { title: '', preview: HANDOFF }) },
  { row: row('g_compacted_preview_media_only', { title: '', preview: MEDIA_ONLY }) },
  { row: row('g_compacted_preview_no_user', { title: '', preview: NO_USER }) },
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
writeJson(join(out, 'golden.json'), { note: 'the roster Node pushed after each catalog write of each trigger (header-only records); gate: the roster gate on list rows', triggers: recorded, gate, compacted });
writeSetManifest(out, {
  set: 'thread-edges',
  recorder: 'benchmarks/rust-core/recorders/record-thread-edges.mjs',
  command: 'node benchmarks/rust-core/recorders/record-thread-edges.mjs --tree <tree>',
  extra: { triggers: recorded.length, gateRows: gate.length },
  identity: exactProductIdentity(tree, 'b6f10295a2f698afc85332467192de28500bd146'),
});
commitStage(out, finalOut);
console.log(`triggers=${recorded.length} published=${recorded.flatMap((t) => t.steps).filter((s) => s.published).length}`);

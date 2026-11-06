#!/usr/bin/env node
// Genuine 1.4.5 behaviour of the thread settings methods the session core serves
// (`thread/readState/update`, `thread/metadata/update`, `thread/archive`, `thread/unarchive`,
// `thread/setToolMode`, `thread/setCwd`'s Project rules): the desktop's own
// DesktopSessionMetadata (`markRead`, `setFavorite`, `setArchived` with descendants) driven by a
// script under a fixed clock, and the pure rules they read (`normalizeToolMode`,
// `toolSpecForMode`, `sessionHasConversationMessages`, `projectIdentity`, `sessionProjectKey`,
// `agentDescendantIds`). The Rust ThreadSettings replays the script over session headers.
//
//   (cwd <tree>/apps/desktop) node --import ./scripts/test-env.mjs --import ./scripts/test-tsx.mjs \
//        <repo>/benchmarks/rust-core/recorders/record-session-sidebar.mjs --tree <tree>
// Output: native/core/fixtures/session-sidebar/golden.json
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const root = mkdtempSync(join(tmpdir(), 'session-sidebar-'));
process.on('exit', () => rmSync(root, { recursive: true, force: true }));

const { DesktopSessionMetadata } = await importFrom(tree, 'apps/desktop/src/main/desktop-session-metadata.ts');
const { normalizeToolMode, toolSpecForMode } = await importFrom(tree, 'src/runtime/agent/orchestrator/runtime-core/effort.mjs');
const { sessionHasConversationMessages } = await importFrom(tree, 'src/runtime/agent/orchestrator/runtime-core/session-text.mjs');
const { projectIdentity, sessionProjectKey } = await importFrom(tree, 'apps/desktop/src/shared/project-identity.ts');
const { agentDescendantIds } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/store-summary-visibility.mjs');

const T0 = 1_800_000_000_000;
let clock = T0;
Date.now = () => clock;

const metadata = new DesktopSessionMetadata(() => root);
await metadata.load();
const outcome = async (run) => {
  try {
    return { value: await run() };
  } catch (error) {
    return { error: error.message };
  }
};

// --- read cursors: markRead(id, count, consumedUnread, numbering) -------------------------------
const reads = [];
const read = async (id, count, consumed, numbering) => {
  const out = await outcome(() => metadata.markRead(id, count, consumed, numbering));
  reads.push({ id, count, consumed, numbering: numbering ?? null, ...out, cursor: metadata.reads[id] ?? null });
};
await read('sess_a', 4, false);
await read('sess_a', 4, false);
await read('sess_a', 4, true);
await read('sess_a', 2, false);
await read('sess_a', 9, false, { messageCount: 6 });
await read('sess_a', 9, false, { messageCount: 0 });
await read('sess_s', 417, false, { compactCount: 16, messageCount: 417 });
await read('sess_s', 66, false, { compactCount: 17, messageCount: 66 });
await read('sess_s', 66, true, { compactCount: 17, messageCount: 66 });
await read('sess_stale', 417, false);
await read('sess_stale', 500, false, { compactCount: 17, messageCount: 0 });
await read('sess_stale', 417, false, { compactCount: 17, messageCount: 62 });
await read('sess_stale', 70, false, { compactCount: 17, messageCount: 80 });
await read('sess_within', 10, false, { compactCount: 3, messageCount: 12 });
await read('sess_within', 10, false, { compactCount: 0, messageCount: 12 });
await read('sess_zero', 0, false, { compactCount: 0, messageCount: 0 });
await read('sess_zero', 0, false, { compactCount: 0, messageCount: 0 });
await read('sess_a', -1, false);
await read('sess_a', 10_000_001, false);
await read('sess_a', 10_000_000, false);
await read('bad id', 1, false);

// --- favorites and archives ----------------------------------------------------------------------
const sidebar = [];
const step = async (op, id, flag, descendants = []) => {
  const out = await outcome(() =>
    op === 'favorite' ? metadata.setFavorite(id, flag) : metadata.setArchived(id, flag, descendants)
  );
  sidebar.push({ op, id, flag, descendants, now: clock, ...out, favorites: { ...metadata.favorites }, archived: { ...metadata.archived } });
};
await step('favorite', 'sess_a', true);
await step('favorite', 'sess_a', true);
clock += 5;
await step('favorite', 'sess_b', true);
await step('favorite', 'sess_a', false);
await step('favorite', 'sess_a', false);
await step('archive', 'sess_lead', true, ['sess_c1', 'sess_c2']);
await step('archive', 'sess_lead', true, ['sess_c1', 'sess_c2']);
await step('archive', 'sess_c3', true);
await step('archive', 'sess_other', true, ['sess_c3', 'sess_c4']);
await step('archive', 'sess_lead', false, ['sess_c1', 'sess_c2', 'sess_c3']);
await step('archive', 'sess_lead', false, ['sess_c1']);
clock += 1000;
await step('archive', 'sess_lead', true, ['sess_c1', 'sess_c4']);
await step('archive', 'sess_other', false, ['sess_c3', 'sess_c4']);
await step('archive', 'sess_missing', false);

// --- the pure rules ------------------------------------------------------------------------------
const MODES = ['full', 'readonly', 'lead', ' ReadOnly ', 'LEAD', 'default', '', 'read only', '\u00a0readonly\u00a0', 'İ'];
const toolModes = MODES.map((mode) => ({ mode, normalized: normalizeToolMode(mode), spec: toolSpecForMode(normalizeToolMode(mode)) }));

const conversations = [
  [],
  [{ role: 'system', content: 'You are Mixy.' }],
  [{ role: 'user', content: '   ' }],
  [{ role: 'assistant', content: '' }],
  [{ role: 'user', content: 'hello' }],
  [{ role: 'tool', content: [{ type: 'text', text: 'done' }] }],
  [{ role: 'tool', content: '' }],
  [{ role: 'user', content: 'Cwd: C:/repos/app' }],
  [{ role: 'user', content: '# permission\nask' }],
  [{ role: 'user', content: [{ type: 'text', text: 'look at this' }, { type: 'image', data: 'x' }] }],
  [{ role: 'user', content: [{ type: 'image', data: 'x' }] }],
  [{ role: 'notice', content: 'a notice' }, { role: 'user', content: '' }],
].map((messages) => ({ messages, conversation: sessionHasConversationMessages({ messages }) }));

const PATHS = ['C:\\Repos\\App\\', ' /repos//app/ ', 'C:/repos/app', '', null, '\\\\server\\share\\x', '/', 'Ä/Ö'];
const identities = PATHS.map((path) => ({ path, identity: projectIdentity(path) }));
const keys = ['c:/repos', 'c:/repos/app', 'c:/repos/app/sub', 'd:/other'];
const ROWS = [
  { cwd: 'C:\\Repos\\App\\src' },
  { cwd: 'C:/repos/apple' },
  { projectPath: 'C:/Repos/App/Sub', cwd: 'C:/tmp' },
  { workspace: { projectPath: 'D:/Other', cwd: 'C:/wt/x' }, cwd: 'C:/wt/x' },
  { workspace: { cwd: 'C:/repos/app/sub/deep' } },
  { cwd: 'E:/elsewhere' },
  {},
];
const projectKeys = ROWS.map((row) => ({ row, keys, key: sessionProjectKey(row, keys) }));

const DESCENDANT_ROWS = [
  { id: 'sess_lead', agent: 'lead' },
  { id: 'sess_w1', owner: 'agent', ownerSessionId: 'sess_lead' },
  { id: 'sess_w2', visibility: 'agent-only', parentSessionId: 'sess_w1' },
  { id: 'sess_w3', owner: 'agent', ownerSessionId: 'sess_w2', parentSessionId: 'sess_lead' },
  { id: 'sess_loop', visibility: 'agent-only', ownerSessionId: 'sess_w3', parentSessionId: 'sess_lead' },
  { id: 'sess_plain', ownerSessionId: 'sess_lead' },
  { id: 'sess_self', visibility: 'agent-only', ownerSessionId: 'sess_self' },
  { id: 'sess_lead2', agent: 'lead', visibility: 'agent-only', ownerSessionId: 'sess_lead' },
  { id: 'sess_other', owner: 'agent', ownerSessionId: 'sess_x' },
];
const descendants = ['sess_lead', 'sess_w1', 'sess_w2', 'sess_x', 'sess_none', ' sess_lead '].map((rootId) => ({
  root: rootId,
  ids: agentDescendantIds(DESCENDANT_ROWS, rootId),
}));

const setDir = join(FIXTURES_ROOT, 'session-sidebar');
writeJson(join(setDir, 'golden.json'), {
  domain: 'session-sidebar',
  recorder: 'benchmarks/rust-core/recorders/record-session-sidebar.mjs',
  t0: T0,
  reads,
  sidebar,
  toolModes,
  conversations,
  identities,
  projectKeys,
  descendantRows: DESCENDANT_ROWS,
  descendants,
});
const rel = 'benchmarks/rust-core/recorders/record-session-sidebar.mjs';
const command = `(cwd <tree>/apps/desktop) node --import ./scripts/test-env.mjs --import ./scripts/test-tsx.mjs <repo>/${rel} --tree <tree>`;
writeSetManifest(setDir, { set: 'session-sidebar', recorder: rel, command });
console.log(`recorded ${reads.length} reads, ${sidebar.length} sidebar steps`);
process.exit(0);

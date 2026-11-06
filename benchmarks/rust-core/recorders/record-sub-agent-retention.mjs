#!/usr/bin/env node
// Golden twin of the pure half of sub-agent retention (store/sweep/sub-agent-retention.mjs):
// which stored records are members (`subAgentMember`: id, parent links, last activity) and how
// members group into trees (`subAgentTrees`). Each case holds the stored records and what Node
// answered; and the outcomes of the real `applySubAgentRetention` over sessions stored in an
// isolated data dir (thresholds, open and moved members, deletion order, failed deletes).
// Rust `mixdog-core-session` `session::sub_agent_retention` must equal it.
//
//   node benchmarks/rust-core/recorders/record-sub-agent-retention.mjs --tree <dir>
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT, importFrom, parseArgs, resolveTree, writeJson } from './lib/common.mjs';

const cli = parseArgs();
const tree = resolveTree(cli);
const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-retention-'));
for (const key of ['MIXDOG_DATA_DIR', 'HOME', 'USERPROFILE', 'CLAUDE_PLUGIN_DATA']) process.env[key] = dataDir;
const retention = await importFrom(tree, 'src/runtime/agent/orchestrator/session/store/sweep/sub-agent-retention.mjs');

const child = (extra) => ({ owner: 'agent', ownerSessionId: 'sess_lead', agent: 'worker', ...extra });
const records = [
  ['sess_w1', child({ lastUsedAt: 1000, updatedAt: 5000, createdAt: 10 })],
  ['sess_w2', child({ updatedAt: 5000, createdAt: 10 })],
  ['sess_w3', child({ createdAt: 10 })],
  ['sess_w4', child({ lastUsedAt: 1000, lastHeartbeatAt: 9000 })],
  ['sess_w5', child({ lastUsedAt: '2000', updatedAt: 'x' })],
  ['sess_w6', child({ lastUsedAt: -5, updatedAt: 0, createdAt: null })],
  ['sess_w7', child({ lastUsedAt: 700, ownerSessionId: 'sess_w1', parentSessionId: 'sess_w2' })],
  ['sess_w8', child({ lastUsedAt: 700, ownerSessionId: '  sess_w1  ', parentSessionId: 'sess_w8' })],
  ['sess_w9', child({ lastUsedAt: 700, ownerSessionId: 'sess_w1', parentSessionId: 'sess_w1' })],
  ['sess_declared', { visibility: 'agent-only', lastUsedAt: 400 }],
  ['sess_declared2', { sessionVisibility: 'Agent-Only', lastUsedAt: 400, ownerSessionId: 'sess_w1' }],
  ['sess_ordinary', { owner: 'user', ownerSessionId: 'sess_lead', lastUsedAt: 400 }],
  ['sess_ownerless', { owner: 'agent', agent: 'worker', lastUsedAt: 400 }],
  ['sess_selfowned', { owner: 'agent', ownerSessionId: 'sess_selfowned', lastUsedAt: 400 }],
  ['sess_lead', { agent: 'Lead', visibility: 'agent-only', lastUsedAt: 400 }],
  ['sess_lead_self', { agent: 'lead', ownerSessionId: 'sess_lead_self', owner: 'agent', lastUsedAt: 400 }],
  ['sess_lead_child', { agent: 'lead', owner: 'agent', ownerSessionId: 'sess_lead', lastUsedAt: 400 }],
  ['sess_task', child({ taskOrigin: { sessionId: 'sess_lead' }, lastUsedAt: 400 })],
  ['sess_home_bot', child({ lastUsedAt: 400 })],
  ['sess_room_x', child({ lastUsedAt: 400 })],
  ['sess_rmem_x', child({ lastUsedAt: 400 })],
  ['sess_homeless', child({ lastUsedAt: 400 })],
];
// A stored record names itself (`id`), which the root-Lead and self-link rules read.
const members = records.map(([id, fields]) => {
  const doc = { id, ...fields };
  return { id, doc, member: retention.subAgentMember(id, doc) };
});

const m = (id, parentIds, lastActive = 1) => ({ id, parentIds, lastActive });
const treeCases = [
  [],
  [m('a', [])],
  [m('a', []), m('b', ['a']), m('c', ['b'])],
  [m('c', ['b']), m('b', ['a']), m('a', [])],
  [m('a', ['lead']), m('b', ['lead']), m('c', ['a', 'b'])],
  [m('a', []), m('b', []), m('c', ['a']), m('d', ['b', 'c'])],
  [m('x', ['y']), m('y', ['x'])],
  [m('x', ['y']), m('y', ['x']), m('z', ['y'])],
  [m('a', ['nope']), m('b', ['a'])],
  [m('k', ['a', 'a']), m('a', [])],
].map((input) => ({ input, trees: retention.subAgentTrees(input).map((t) => t.map((member) => member.id)) }));

// ---- applySubAgentRetention over real stored sessions ------------------------------------------
const store = await importFrom(tree, 'src/runtime/agent/orchestrator/session/store.mjs');
const { sessionPath } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/store/session-paths.mjs');
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 5, 1);
const stored = (id, fields) => ({ id, status: 'idle', createdAt: 1, messages: [{ role: 'user', content: 'hi' }], owner: 'agent', ownerSessionId: 'sess_lead', agent: 'worker', ...fields });
const logOf = (id) => sessionPath(id).replace(/\.json$/, '.log.jsonl');
let counter = 0;
const outcomes = [];
// `sessions`: [suffix, fields]; `live`, `archived`, `unreadable`, `archiveFails`: suffixes; `openAfterDeleted`: [opened, afterDeleted]; `move`: suffix -> lastUsedAt
// stored after the pass read the members.
const scenario = async (name, sessions, { now = NOW, live = [], archived = [], unreadable = [], openAfterDeleted = null, archiveFails = [], move = {} } = {}) => {
  const prefix = `sess_ret${counter++}_`;
  const id = (suffix) => `${prefix}${suffix}`;
  const link = (fields) => ({
    ...fields,
    ...(fields.ownerSessionId && fields.ownerSessionId !== 'sess_lead' ? { ownerSessionId: id(fields.ownerSessionId) } : {}),
  });
  for (const [suffix, fields] of sessions) await store.saveSessionAsync(stored(id(suffix), link(fields)));
  const members = [];
  for (const [suffix] of sessions) {
    const member = retention.subAgentMember(id(suffix), await store.loadSession(id(suffix)));
    if (member) members.push(member);
  }
  for (const [suffix, at] of Object.entries(move)) {
    const [, fields] = sessions.find(([s]) => s === suffix);
    await store.saveSessionAsync(stored(id(suffix), { ...link(fields), lastUsedAt: at }));
  }
  for (const suffix of unreadable) writeFileSync(sessionPath(id(suffix)), '{"foreign":true}');
  const sidebar = [];
  const result = await retention.applySubAgentRetention(members, {
    now,
    isSessionLive: (sid) =>
      live.map(id).includes(sid) ||
      (openAfterDeleted !== null && sid === id(openAfterDeleted[0]) && !existsSync(logOf(id(openAfterDeleted[1])))),
    isArchived: (sid) => archived.map(id).includes(sid),
    setSidebar: async (sid, change) => {
      sidebar.push({ id: sid, change });
      if (archiveFails.map(id).includes(sid)) throw new Error('refused');
    },
  });
  const strip = (ids) => ids.map((sid) => (sid.startsWith(prefix) ? sid.slice(prefix.length) : sid));
  outcomes.push({
    name,
    now,
    sessions: sessions.map(([suffix, fields]) => ({ id: suffix, fields })),
    live,
    archived,
    unreadable,
    openAfterDeleted,
    archiveFails,
    move,
    members: members.map((member) => ({ id: strip([member.id])[0], parentIds: strip(member.parentIds), lastActive: member.lastActive })),
    archivedIds: strip(result.archived),
    deletedIds: strip(result.deleted),
    forgotten: strip(sidebar.filter((call) => call.change.forgotten).map((call) => call.id)),
    remaining: sessions.map(([suffix]) => suffix).filter((suffix) => existsSync(logOf(id(suffix)))),
  });
};
const idle = (days, extra = {}) => ({ lastUsedAt: NOW - days * DAY, ...extra });
await scenario('under three days stays', [['a', idle(2.9)]]);
await scenario('exactly three days archives', [['a', idle(3)]]);
await scenario('an archived member is not archived again', [['a', idle(5)], ['b', idle(5, { ownerSessionId: 'a' })]], { archived: ['a'] });
await scenario('under thirty days only archives', [['a', idle(29.9)]]);
await scenario('exactly thirty days deletes', [['a', idle(30)]]);
await scenario('one recent member keeps the whole tree', [['a', idle(40)], ['b', idle(1, { ownerSessionId: 'a' })]]);
await scenario('two trees are judged apart', [['a', idle(40)], ['b', idle(1)]]);
await scenario('a tree deletes children first', [['a', idle(40)], ['b', idle(40, { ownerSessionId: 'a' })], ['c', idle(40, { ownerSessionId: 'b' })]]);
await scenario('an open member keeps its tree', [['a', idle(40)], ['b', idle(40, { ownerSessionId: 'a' })]], { live: ['b'] });
await scenario('an open member keeps an archive', [['a', idle(5)]], { live: ['a'] });
await scenario('a member that moved after the read keeps its tree', [['a', idle(40)], ['b', idle(40, { ownerSessionId: 'a' })]], { move: { a: NOW } });
await scenario('a member of unknown age keeps its tree', [['a', { lastUsedAt: 0, updatedAt: 0, createdAt: 0 }]]);
await scenario('a member that can no longer be read keeps its tree', [['a', idle(40)], ['b', idle(40, { ownerSessionId: 'a' })]], { unreadable: ['b'] });
await scenario('a member opened while an earlier delete ran is not deleted', [['a', idle(40)], ['b', idle(40, { ownerSessionId: 'a' })], ['c', idle(40, { ownerSessionId: 'b' })]], { openAfterDeleted: ['b', 'c'] });
await scenario('a failed archive is not counted', [['a', idle(5)], ['b', idle(5, { ownerSessionId: 'a' })]], { archiveFails: ['a'] });
await scenario('a deleted member that was archived is forgotten', [['a', idle(40)]], { archived: ['a'] });
await scenario('the heartbeat counts as activity', [['a', idle(40, { lastHeartbeatAt: NOW - DAY })]]);
// The data dir stays in the temp folder: the store holds its writer locks until the process ends.

writeJson(join(REPO_ROOT, 'native/core/crates/mixdog-core-session/src/session/golden/sub_agent_retention.json'), {
  members,
  trees: treeCases,
  outcomes,
});
console.log(`sub-agent retention: ${members.length} members, ${treeCases.length} tree cases, ${outcomes.length} outcomes`);


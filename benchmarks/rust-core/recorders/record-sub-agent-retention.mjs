#!/usr/bin/env node
// Golden twin of the pure half of sub-agent retention (store/sweep/sub-agent-retention.mjs):
// which stored records are members (`subAgentMember`: id, parent links, last activity) and how
// members group into trees (`subAgentTrees`). Each case holds the stored records and what Node
// answered. Rust `mixdog-core-session` `session::sub_agent_retention` must equal it.
//
//   node benchmarks/rust-core/recorders/record-sub-agent-retention.mjs --tree <dir>
import { join } from 'node:path';
import { REPO_ROOT, importFrom, parseArgs, resolveTree, writeJson } from './lib/common.mjs';

const cli = parseArgs();
const tree = resolveTree(cli);
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

writeJson(join(REPO_ROOT, 'native/core/crates/mixdog-core-session/src/session/golden/sub_agent_retention.json'), {
  members,
  trees: treeCases,
});
console.log(`sub-agent retention: ${members.length} members, ${treeCases.length} tree cases`);

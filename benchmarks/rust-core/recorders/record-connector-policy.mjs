#!/usr/bin/env node
// Golden twin of the connector policy rules the agent editor saves with
// (mcp/agent-connectors.mjs): the stored form of a policy given to a save
// (`parseConnectorPolicy` then `storedConnectorPolicy`, integer-like keys in JavaScript's order),
// the remote no-widen check (`assertConnectorPolicyNotWidened`), and the same check inside an
// approved tool change (`withApprovedConnectorToolChange`).
//
//   node benchmarks/rust-core/recorders/record-connector-policy.mjs --tree <dir>
import { writeFileSync } from 'node:fs';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const connectors = await importFrom(tree, 'src/runtime/agent/orchestrator/mcp/agent-connectors.mjs');
const { parseConnectorPolicy, storedConnectorPolicy, assertConnectorPolicyNotWidened, withApprovedConnectorToolChange } = connectors;

let seed = 0x3b9aca07;
const next = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
const chance = (p) => next() < p;
const pick = (list) => list[Math.floor(next() * list.length)];

const SERVERS = ['gmail', 'gmail-2', 'gmail-10', 'github', 'zeta', '10', '2', ' 2', 'a b'];
const TOOLS = ['send', 'read', 'delete', '1', '07', ' 3', '3', 'x'];
const PERMS = ['auto', 'needs_approval', 'disabled'];

function randomTools() {
  const tools = {};
  const servers = 1 + Math.floor(next() * 3);
  for (let i = 0; i < servers; i += 1) {
    const own = {};
    for (let j = 0; j < 1 + Math.floor(next() * 3); j += 1) own[pick(TOOLS)] = chance(0.08) ? 'bogus' : pick(PERMS);
    tools[pick(SERVERS)] = chance(0.05) ? 7 : own;
  }
  return tools;
}

function randomPolicy() {
  const roll = next();
  if (roll < 0.12) return null;
  if (roll < 0.17) return [{ id: pick(SERVERS), enabled: chance(0.6), tools: chance(0.5) ? randomTools()[pick(SERVERS)] : undefined }];
  if (roll < 0.2) return pick(['x', 3, { off: 'a' }, { tools: [] }, { extra: 1 }, true]);
  const policy = {};
  if (chance(0.8)) policy.off = Array.from({ length: Math.floor(next() * 4) }, () => pick(SERVERS));
  if (chance(0.8)) policy.tools = randomTools();
  return policy;
}

const attempt = (run) => {
  try {
    return { ok: run() ?? null };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
};
const plain = (value) => JSON.parse(JSON.stringify(value ?? null));

// 1. What a save stores for a policy it is given.
const stored = [];
for (let i = 0; i < 300; i += 1) {
  const input = randomPolicy();
  stored.push({ input: plain(input), ...attempt(() => (Array.isArray(input) ? (() => { throw new Error('connectors must be { off: [connector id…], tools? } or null'); })() : plain(storedConnectorPolicy(parseConnectorPolicy(input))))) });
}
// Integer-like names: they come first in a stored policy, ascending, whatever order they were given.
for (const input of [
  { off: ['b', '2', '10'], tools: { zeta: { z: 'auto', '2': 'disabled', '10': 'auto' }, '10': { x: 'auto' }, '2': { x: 'disabled' } } },
  { tools: { gmail: { ' 7': 'auto', '7': 'disabled' }, '7': { a: 'auto' }, ' 7': { b: 'disabled' } } },
  { tools: { '2': { send: 'auto' }, '1': { send: 'disabled' }, '01': { send: 'auto' } } },
]) {
  stored.push({ input: plain(input), ...attempt(() => plain(storedConnectorPolicy(parseConnectorPolicy(input)))) });
}

// 2. The no-widen check, plain and inside an approved tool change.
const checks = [];
for (let i = 0; i < 700; i += 1) {
  const before = chance(0.15) ? null : randomPolicy();
  const afterInput = randomPolicy();
  let after;
  try {
    after = afterInput == null ? null : storedConnectorPolicy(parseConnectorPolicy(afterInput));
  } catch {
    continue;
  }
  if (Array.isArray(afterInput)) continue;
  const approved = chance(0.5)
    ? { server: pick(SERVERS), tool: pick(TOOLS), from: pick(PERMS), to: pick(PERMS) }
    : null;
  // Half the approved cases land the approved tool where the change says.
  if (approved && after && chance(0.6)) {
    after = { ...after, tools: { ...after.tools, [approved.server.replace(/-\d+$/, '') || approved.server]: { ...(after.tools ?? {})[approved.server], [approved.tool]: approved.to } } };
  }
  const run = () => assertConnectorPolicyNotWidened(plain(before), plain(after));
  checks.push({ before: plain(before), after: plain(after), approved, ...attempt(() => (approved ? withApprovedConnectorToolChange(approved, run) : run())) });
}

// Approved changes that do what a card asks: the policy as stored, with the one tool at `to`.
for (let i = 0; i < 400; i += 1) {
  const before = { off: Array.from({ length: Math.floor(next() * 3) }, () => pick(SERVERS)), tools: randomTools() };
  if (chance(0.1)) delete before.off;
  const server = pick(SERVERS);
  const group = server.replace(/-\d+$/, '') === server || !['gmail'].includes(server.replace(/-\d+$/, '')) ? server : server.replace(/-\d+$/, '');
  const approved = { server, tool: pick(TOOLS), from: pick(PERMS), to: pick(PERMS) };
  let after;
  try {
    const parsed = storedConnectorPolicy(parseConnectorPolicy(before));
    const tools = { ...(parsed?.tools ?? {}) };
    tools[group] = { ...(tools[group] ?? {}), [approved.tool]: approved.to };
    after = storedConnectorPolicy(parseConnectorPolicy({ off: parsed?.off ?? [], tools }));
  } catch {
    continue;
  }
  const run = () => assertConnectorPolicyNotWidened(plain(before), plain(after));
  checks.push({ before: plain(before), after: plain(after), approved, ...attempt(() => withApprovedConnectorToolChange(approved, run)) });
}

writeFileSync(
  `${FIXTURES_ROOT}/desktop/settings/connector-policy-twin.json`,
  `${JSON.stringify({ domain: 'connector-policy-twin', recorder: 'benchmarks/rust-core/recorders/record-connector-policy.mjs', stored, checks }, null, 1)}\n`
);
const tally = (list) => list.reduce((n, c) => ({ ...n, [c.ok === undefined ? 'error' : 'ok']: (n[c.ok === undefined ? 'error' : 'ok'] ?? 0) + 1 }), {});
console.log('stored', tally(stored), 'checks', tally(checks), 'approved', checks.filter((c) => c.approved).length);

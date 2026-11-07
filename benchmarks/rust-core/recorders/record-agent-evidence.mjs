#!/usr/bin/env node
// Golden of the agent evidence the agent definitions read (`native/core/fixtures/agent-evidence/
// golden.json`), from real Node code:
// - `home`: `homeThreadEvidence(dataDir, agentId)` (`runtime/shared/agent-kind.mjs`) `greeted`
//   and `chatted` for agents whose home threads real Node stored (`saveSessionDurably`), the
//   store files recorded with them;
// - `routines`: `mixyOwnsRoutines()` (`session-runtime/routine-owner.mjs`) over recorded schedule
//   and webhook rows, its Postgres reads replaced by module mocks that answer those rows (a
//   listing that fails rejects).
// Rust migrates the same files and reads them, and the same rows, through
// `SessionAgentEvidence`.
//
//   node --experimental-test-module-mocks <repo>/benchmarks/rust-core/recorders/record-agent-evidence.mjs --tree <tree>
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'node:test';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const repo = resolveTree(parseArgs());
const root = mkdtempSync(join(tmpdir(), 'mixdog-agent-evidence-'));
// Every user dir Node reads is a fresh temp dir before any Mixdog module loads.
for (const [name, dir] of [['HOME', 'home'], ['USERPROFILE', 'home'], ['APPDATA', 'appdata'], ['LOCALAPPDATA', 'localappdata']]) {
  mkdirSync(join(root, dir), { recursive: true });
  process.env[name] = join(root, dir);
}
const data = join(root, 'data');
mkdirSync(join(data, 'sessions'), { recursive: true });
process.env.MIXDOG_HOME = root;
process.env.MIXDOG_DATA_DIR = data;
const url = (p) => pathToFileURL(join(repo, p)).href;

// The routine reads: the case under way answers them.
let current = { cluster: true, schedules: [], webhooks: [] };
const rows = (list) => (list === 'fail' ? Promise.reject(new Error('relation does not exist')) : Promise.resolve(list));
mock.module(url('src/runtime/memory/lib/pg/adapter.mjs'), { namedExports: { pgClusterExists: () => current.cluster } });
mock.module(url('src/runtime/channels/lib/schedules-db.mjs'), { namedExports: { listSchedules: () => rows(current.schedules) } });
mock.module(url('src/runtime/channels/lib/webhooks-db.mjs'), { namedExports: { listEndpoints: () => rows(current.webhooks) } });

const store = await import(url('src/runtime/agent/orchestrator/session/store.mjs'));
const { homeThreadEvidence } = await import(url('src/runtime/shared/agent-kind.mjs'));
const { mixyOwnsRoutines } = await import(url('src/session-runtime/routine-owner.mjs'));

const T = 1_700_000_000_000;
const GREETING = '[mixdog-runtime] The user just created you as Bench, a bot. Say hello.';
const home = (id, messages) => ({
  id,
  owner: 'user',
  agent: 'lead',
  sourceType: 'lead',
  closed: false,
  generation: 0,
  createdAt: T,
  updatedAt: T + 1_000,
  messages,
});
const homes = {
  bench: [{ role: 'user', content: GREETING }, { role: 'assistant', content: 'Hello, I am Bench.' }],
  chat: [{ role: 'user', content: 'hello there' }],
  mixed: [
    { role: 'assistant', content: 'Daily report: all quiet.' },
    { role: 'user', content: '[mixdog-runtime] heartbeat tick' },
    { role: 'user', content: '  \n\t ' },
    { role: 'user', content: [{ type: 'text', text: 'Hi' }, 'there', { type: 'image', attachmentRef: 'x' }] },
  ],
  parts: [{ role: 'user', content: [{ type: 'text', text: 'note' }, { type: 'text', text: GREETING }] }],
  inline: [{ role: 'user', content: `see ${GREETING}` }],
  padded: [{ role: 'user', content: `  ${'[mixdog-runtime]'} queued result` }],
  assistant: [{ role: 'assistant', content: GREETING }],
  'a.b': [{ role: 'user', content: GREETING }, { role: 'user', content: 'and a question' }],
  lead: [{ role: 'user', content: 'what is on today?' }],
};
for (const [agent, messages] of Object.entries(homes)) {
  await store.saveSessionDurably(home(`sess_home_${agent.replace('.', '_')}`, messages));
}
(await import(url('src/runtime/agent/orchestrator/session/store/session-writer-claim.mjs'))).releaseHeldSessionWriters();

const agents = [...Object.keys(homes), 'ghost', 'Bad', ''];
const evidence = agents.map((agentId) => {
  const { greeted, chatted } = homeThreadEvidence(data, agentId);
  return { agentId, greeted, chatted };
});

const routineCases = [
  { name: 'none', cluster: true, schedules: [], webhooks: [] },
  { name: 'no-cluster', cluster: false, schedules: [], webhooks: [] },
  { name: 'bot-owned', cluster: true, schedules: [{ name: 's1', ownerAgentId: 'bench' }], webhooks: [] },
  { name: 'ownerless-schedule', cluster: true, schedules: [{ name: 's1', ownerAgentId: null }], webhooks: [] },
  { name: 'mixy-webhook', cluster: true, schedules: [], webhooks: [{ name: 'w1', ownerAgentId: 'lead' }] },
  { name: 'invalid-owner', cluster: true, schedules: [{ name: 's1', ownerAgentId: 'Bad Id' }], webhooks: [] },
  { name: 'padded-owner', cluster: true, schedules: [{ name: 's1', ownerAgentId: '  bench ' }], webhooks: [] },
  { name: 'empty-owner', cluster: true, schedules: [], webhooks: [{ name: 'w1', ownerAgentId: '' }] },
  { name: 'webhooks-fail', cluster: true, schedules: [{ name: 's1', ownerAgentId: null }], webhooks: 'fail' },
  { name: 'schedules-fail', cluster: true, schedules: 'fail', webhooks: [] },
];
const routines = [];
for (const routine of routineCases) {
  current = routine;
  let outcome;
  try {
    outcome = { owns: await mixyOwnsRoutines() };
  } catch {
    outcome = { error: true };
  }
  routines.push({ ...routine, ...outcome });
}

const dir = join(data, 'sessions');
const files = Object.fromEntries(
  readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isFile())
    .map((name) => [name, readFileSync(join(dir, name), 'utf8')])
);
rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

const set = join(FIXTURES_ROOT, 'agent-evidence');
writeJson(join(set, 'golden.json'), { home: evidence, routines, files });
writeSetManifest(set, {
  set: 'agent-evidence',
  recorder: 'benchmarks/rust-core/recorders/record-agent-evidence.mjs',
  command: 'node --experimental-test-module-mocks <repo>/benchmarks/rust-core/recorders/record-agent-evidence.mjs --tree <tree>',
  identityTree: repo,
});
console.log(`recorded ${evidence.length} homes, ${routines.length} routine sets, ${Object.keys(files).length} files`);
process.exit(0);

#!/usr/bin/env node
// Golden of the session facts the setup tool reads of its caller (`native/core/fixtures/
// session-facts/golden.json`), from real Node code:
// - `agentMode`: `resolveSessionMode({ session: caller }).mode === 'agent'`
//   (`session/agent-mode.mjs`, `setup-tool/extended-actions.mjs` `createdAgentKind`) for caller
//   session records, and for no caller (`session: null`);
// - `mixyName`: `mixyDisplayName()` (`session/mixy-name.mjs`) over data dirs holding the files
//   recorded with each case.
// Rust reads the same records from the session directory and the same files from the data dir
// (`SessionSetupFacts`).
//
//   node <repo>/benchmarks/rust-core/recorders/record-session-facts.mjs --tree <tree>
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const repo = resolveTree(parseArgs());
const root = mkdtempSync(join(tmpdir(), 'mixdog-session-facts-'));
// Every user dir Node reads is a fresh temp dir before any Mixdog module loads.
for (const [name, dir] of [['HOME', 'home'], ['USERPROFILE', 'home'], ['APPDATA', 'appdata'], ['LOCALAPPDATA', 'localappdata']]) {
  mkdirSync(join(root, dir), { recursive: true });
  process.env[name] = join(root, dir);
}
process.env.MIXDOG_HOME = root;
process.env.MIXDOG_DATA_DIR = join(root, 'data');
const at = (p) => import(pathToFileURL(join(repo, p)).href);

const { resolveSessionMode, AGENT_MODE } = await at('src/runtime/agent/orchestrator/session/agent-mode.mjs');
const { mixyDisplayName } = await at('src/runtime/agent/orchestrator/session/mixy-name.mjs');

// Caller records: the live session object a setup call reads (its `id` among its fields).
const callers = [
  { id: 'sess_home_lead', agent: 'lead' },
  { id: 'sess_home_bench' },
  { id: 'sess_home_a_b' },
  { id: 'sess_home_Bad' },
  { id: 'sess_rmem_room123_bench' },
  { id: 'sess_rmem_ro_bench' },
  { id: 'sess_task_owned', ownerAgentId: 'bench' },
  { id: 'sess_task_trimmed', ownerAgentId: '  bench  ' },
  { id: 'sess_task_invalid', ownerAgentId: 'Bad Id' },
  { id: 'sess_home_worker', owner: 'agent' },
  { id: 'sess_home_shouty', owner: ' AGENT ' },
  { id: 'sess_home_hidden', visibility: 'agent-only' },
  { id: 'sess_plain', agent: 'lead', sourceType: 'lead' },
  { id: 'sess_mode_stored', sessionMode: 'agent' },
];
const agentMode = callers.map((session) => ({ session, agentMode: resolveSessionMode({ session }).mode === AGENT_MODE }));
const noCaller = resolveSessionMode({ session: null }).mode === AGENT_MODE;

const lead = 'agents/lead/agent.json';
const mixy = 'bots/mixy/agent.json';
const store = ['bots/migration.json', JSON.stringify({ version: 1, bots: [] })];
const mixyCases = [
  { name: 'no-manifest', files: [] },
  { name: 'lead-name', files: [[lead, JSON.stringify({ name: '  Ada \n\t Lovelace  ' })]] },
  { name: 'unicode-spaces', files: [[lead, JSON.stringify({ name: '\u00a0Zo\u00eb\u3000Two\u00a0' })]] },
  { name: 'empty-name', files: [[lead, JSON.stringify({ name: '   ' })]] },
  { name: 'number-name', files: [[lead, JSON.stringify({ name: 42 })]] },
  { name: 'not-an-object', files: [[lead, JSON.stringify(['Ada'])]] },
  { name: 'malformed', files: [[lead, '{"name": "Ada"']] },
  { name: 'malformed-with-backup', files: [[lead, '{broken'], [`${lead}.bak`, JSON.stringify({ name: 'Backup' })]] },
  { name: 'bot-store', files: [store, [mixy, JSON.stringify({ name: 'Mira' })], [lead, JSON.stringify({ name: 'Old' })]] },
  { name: 'bot-store-without-mixy', files: [store, [lead, JSON.stringify({ name: 'Old' })]] },
  {
    name: 'unfinished-split',
    files: [['bots/migration.json', JSON.stringify({ version: 2 })], [mixy, JSON.stringify({ name: 'Mira' })], [lead, JSON.stringify({ name: 'Old' })]],
  },
];
const mixyName = mixyCases.map(({ name, files }) => {
  const data = join(root, 'cases', name);
  mkdirSync(data, { recursive: true });
  for (const [rel, text] of files) {
    mkdirSync(dirname(join(data, rel)), { recursive: true });
    writeFileSync(join(data, rel), text);
  }
  process.env.MIXDOG_DATA_DIR = data;
  return { name, files: Object.fromEntries(files), mixyName: mixyDisplayName() };
});
rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

const set = join(FIXTURES_ROOT, 'session-facts');
writeJson(join(set, 'golden.json'), { agentMode, noCaller, mixyName });
writeSetManifest(set, {
  set: 'session-facts',
  recorder: 'benchmarks/rust-core/recorders/record-session-facts.mjs',
  command: 'node <repo>/benchmarks/rust-core/recorders/record-session-facts.mjs --tree <tree>',
  identityTree: repo,
});
console.log(`recorded ${agentMode.length} callers, ${mixyName.length} data dirs`);
process.exit(0);

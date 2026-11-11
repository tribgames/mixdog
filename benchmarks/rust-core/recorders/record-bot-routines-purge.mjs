#!/usr/bin/env node
// A bot deleted for good takes its routines with it: Node's `deleteOwnedRoutines` (session-runtime/services/channel-admin.mjs,
// the call agent-editor.mjs makes) over `deleteRoutinesOwnedBy` (runtime/channels/lib/routines-db.mjs, one statement) on a
// real PostgreSQL store in a temporary data directory. The seed is written through the stores' own upserts and delivery
// claim; another bot's schedule, webhook and delivery stay. Then the Lead (refused) and the same bot again (nothing left).
// The tables are read whole after every call.
//
//   node benchmarks/rust-core/recorders/record-bot-routines-purge.mjs --tree <exact export of b6f10295a with node_modules> [--out <file>]
//
// Output: native/core/fixtures/bot-routines-purge/golden.json (+ MANIFEST.json).
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, commitStage, nodeTreeIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const recorder = 'benchmarks/rust-core/recorders/record-bot-routines-purge.mjs';
const SCRATCH = process.env.MIXDOG_RECORDER_SCRATCH ?? 'D:/mixdog-build/tmp/w23/rec';
const args = parseArgs();
const tree = resolveTree(args);
const identity = nodeTreeIdentity(args, tree, NODE_COMMIT);

const dataDir = mkdtempSync(join(SCRATCH, 'data-')).replaceAll('\\', '/');
Object.assign(process.env, {
  MIXDOG_DATA_DIR: dataDir,
  MIXDOG_HOME: dataDir,
  MIXDOG_RUNTIME_ROOT: mkdtempSync(join(SCRATCH, 'rt-')).replaceAll('\\', '/'),
  TZ: 'UTC',
});
const imp = (rel) => import(pathToFileURL(join(tree, rel)).href);
const admin = await imp('src/session-runtime/services/channel-admin.mjs');
const schedulesDb = await imp('src/runtime/channels/lib/schedules-db.mjs');
const webhooksDb = await imp('src/runtime/channels/lib/webhooks-db.mjs');
const pgAdapter = await imp('src/runtime/memory/lib/pg/adapter.mjs');

const seed = {
  schedules: [
    { name: 'alpha', prompt: 'Check the build', whenCron: '0 9 * * *', ownerAgentId: 'gh-bot' },
    { name: 'theirs', prompt: 'Check the build', whenCron: '0 9 * * *', ownerAgentId: 'other-bot' },
    { name: 'zeta', prompt: 'Check the build', whenCron: '0 9 * * *', ownerAgentId: 'gh-bot' },
  ],
  endpoints: [
    { name: 'hook', instructions: 'Triage.', ownerAgentId: 'gh-bot' },
    { name: 'their-hook', instructions: 'Triage.', ownerAgentId: 'other-bot' },
  ],
  deliveries: [
    { endpoint: 'hook', deliveryId: 'd1' },
    { endpoint: 'their-hook', deliveryId: 'd2' },
  ],
};
for (const def of seed.schedules) await schedulesDb.upsertSchedule(def);
for (const def of seed.endpoints) await webhooksDb.upsertEndpoint(def);
for (const { endpoint, deliveryId } of seed.deliveries) await webhooksDb.claimDelivery(endpoint, deliveryId);

const db = await schedulesDb.openSchedulesDb();
// Every row of the three tables, in the order of their keys; the columns kept are the row keys and the owner (every other
// column is the seed's or a time stamp, and the purge only ever removes whole rows).
const tables = async () => ({
  schedules: (await db.query('SELECT name, owner_agent_id FROM scheduler.schedules ORDER BY name')).rows.map((r) => ({ name: r.name, ownerAgentId: r.owner_agent_id })),
  endpoints: (await db.query('SELECT name, owner_agent_id FROM webhooks.endpoints ORDER BY name')).rows.map((r) => ({ name: r.name, ownerAgentId: r.owner_agent_id })),
  deliveries: (await db.query('SELECT endpoint, delivery_id FROM webhooks.deliveries ORDER BY endpoint, delivery_id')).rows.map((r) => ({ endpoint: r.endpoint, deliveryId: r.delivery_id })),
});

const result = { seed, before: await tables(), calls: [] };
for (const agentId of ['gh-bot', 'lead', 'gh-bot']) {
  let outcome;
  try {
    outcome = { reply: await admin.deleteOwnedRoutines(agentId) };
  } catch (error) {
    outcome = { error: error.message };
  }
  result.calls.push({ agentId, ...outcome, after: await tables() });
}

const out = args.get('out');
if (out) {
  writeFileSync(out, JSON.stringify(result, null, 1));
} else {
  const finalDir = join(FIXTURES_ROOT, 'bot-routines-purge');
  const stage = stageSet(finalDir);
  writeJson(join(stage, 'golden.json'), result);
  writeSetManifest(stage, {
    set: 'bot-routines-purge',
    recorder,
    command: `node ${recorder} --tree <exact export of b6f10295a with node_modules>`,
    identity,
    extra: {
      ...recorderProvenance(import.meta.url),
      columns: 'each table row keeps its key and owner only: the purge removes whole rows, and the other columns are the seed\'s or time stamps',
    },
  });
  commitStage(stage, finalDir);
}
await pgAdapter.shutdownOwnedPg({ timeoutMs: 20_000 }).catch(() => {});
process.exit(0);

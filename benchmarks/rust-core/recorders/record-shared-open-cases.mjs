#!/usr/bin/env node
// Records Node's shared opening (`createPgSchemaDb` over `createSharedAbortable`, runtime/shared/pg-schema-db.mjs and
// abort-race.mjs) for the core's `MemoryStack` opening: uses that arrive while the database opens join one opening, all
// get its failure, the next use opens again, and the opening is cancelled once every use that could withdraw has and none
// joined that cannot (abort-race.mjs:79-123). Each scenario holds `ensurePg` at a gate, joins its uses in order, withdraws
// the marked ones, records whether the opening's signal aborted, then releases the gate (the opening fails with 'pg down')
// and records every use's outcome and the number of openings after one more use.
//
//   node benchmarks/rust-core/recorders/record-shared-open-cases.mjs --tree <exact export of b6f10295a>
//
// Writes native/core/fixtures/shared-open-cases/{golden.json,MANIFEST.json}.
import { join } from 'node:path';

import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const RECORDER = 'benchmarks/rust-core/recorders/record-shared-open-cases.mjs';
const TEST = 'src/runtime/shared/pg-schema-db.test.mjs';

const tree = resolveTree(parseArgs());
const identity = exactProductIdentity(tree, NODE_COMMIT);
const { createPgSchemaDb } = await importFrom(tree, 'src/runtime/shared/pg-schema-db.mjs');

async function scenario(name, uses) {
  const gate = Promise.withResolvers();
  const started = Promise.withResolvers();
  let ensureCalls = 0;
  let initSignal = null;
  const getDb = createPgSchemaDb({
    schema: 'memory',
    ddl: 'DDL',
    defaultDataDir: () => '/data',
    ensurePg: async (_dataDir, { signal }) => {
      ensureCalls += 1;
      initSignal ??= signal;
      started.resolve();
      await Promise.race([gate.promise, new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))]);
      throw new Error('pg down');
    },
    withLock: async (_pool, fn) => fn(),
  });
  const controllers = uses.map((use) => (use.signal ? new AbortController() : null));
  const joined = uses.map((_, index) => getDb('/a', { signal: controllers[index]?.signal ?? null }));
  const settled = joined.map((promise) => promise.then(() => 'ok', (error) => error));
  await started.promise;
  uses.forEach((use, index) => {
    if (use.withdraw) controllers[index].abort(new Error('withdrawn'));
  });
  const initAborted = initSignal.aborted;
  gate.resolve();
  const results = (await Promise.all(settled)).map((outcome, index) => (uses[index].withdraw ? 'withdrawn' : outcome instanceof Error ? outcome.message : outcome));
  const openingsDuring = ensureCalls;
  await getDb('/a').catch(() => {});
  return { name, uses, openingsDuring, initAborted, results, openingsAfterNextUse: ensureCalls };
}

const cases = [
  await scenario('uses during an opening join it, share its failure, and the next use opens again', [{ signal: false }, { signal: false }]),
  await scenario('a use withdrawing while another waits leaves the opening running', [{ signal: true, withdraw: true }, { signal: true }]),
  await scenario('every use withdrawing cancels the opening', [{ signal: true, withdraw: true }, { signal: true, withdraw: true }]),
  await scenario('a use that cannot withdraw keeps the opening running', [{ signal: true, withdraw: true }, { signal: false }]),
];

const finalDir = join(FIXTURES_ROOT, 'shared-open-cases');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), { note: `Node's shared opening at ${NODE_COMMIT}, per scenario of ${RECORDER}`, test: TEST, cases });
writeSetManifest(stage, {
  set: 'shared-open-cases',
  recorder: RECORDER,
  command: `node ${RECORDER} --tree <exact export of ${NODE_COMMIT}>`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    compared: 'per scenario: the openings started, whether the opening was cancelled when the uses withdrew, every use\'s outcome in join order, and the openings after one more use',
    excluded: {},
    declared:
      "The core's uses that can withdraw are futures dropped (`MemoryStack::opened`); a use that cannot is `MemoryStack::opened_as(true)`, what `open_in_background` calls " +
      "(Node's join without a signal). The opening ends 'pg down' in both: Node's ensurePg and the core's held runtime install fail after their gate. A withdrawn use has no outcome in the core, " +
      "so its outcome is the label `withdrawn`. The core's runtime errors read `postgres runtime: <text>`: the replay compares the text after that prefix. The runtime install's wait is the gate in both; an opening the last use withdrew from ends in the same failure once its gate opens",
  },
});
commitStage(stage, finalDir);
console.log(`shared-open-cases: ${cases.length} case(s)`);
process.exit(0);

#!/usr/bin/env node
// What the phone's page answers a call that got no answer, at the Node baseline (b6f10295a): Node's call deadline
// (`apps/desktop/src/renderer/remote-call-deadline.ts`, armed by `remote-shim-calls.ts` for every call it hands on) driven on a recorded
// timer: the delays it waits, the probe it makes of the connection, and the error text the call fails with. The protocol adapter's test
// (apps/desktop/src/renderer/remote-protocol-call-timeout.test.mjs) plays the same timers against a core call that never answers.
//
//   node --import ./apps/desktop/scripts/test-env.mjs --import ./apps/desktop/scripts/test-tsx.mjs \
//     benchmarks/rust-core/recorders/record-call-timeout.mjs --tree <git archive of b6f10295a with node_modules>
import { join } from 'node:path';
import { REPO_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const REF = 'b6f10295a2f698afc85332467192de28500bd146';
const tree = resolveTree(parseArgs());
const { armRemoteCallDeadline } = await importFrom(tree, 'apps/desktop/src/renderer/remote-call-deadline.ts');

// Every timer runs when it is due, on a clock that moves only to it: a page that is never frozen and a connection whose probe finds it
// alive (the probe settles nothing), so the call is owed its answer to the end.
const steps = [];
let clock = 0;
const timers = [];
const pending = new Map([[1, true]]);
const failure = await new Promise((resolve) => {
  armRemoteCallDeadline(
    pending,
    1,
    (error) => resolve(error.message),
    () => steps.push({ probe: clock }),
    {
      setTimeout: (callback, ms) => {
        steps.push({ wait: ms });
        timers.push({ at: clock + ms, callback });
        return timers.length;
      },
      clearTimeout() {},
    },
    () => clock
  );
  while (timers.length > 0) {
    const next = timers.shift();
    clock = next.at;
    next.callback();
  }
});

const finalOut = join(REPO_ROOT, 'apps', 'mobile', 'fixtures', 'call-timeout');
const out = stageSet(finalOut);
writeJson(join(out, 'golden.json'), {
  note: "Node's phone page: the waits of a call that got no answer (ms, each from the previous one's end), its probe of the connection, and the error text it fails with.",
  steps,
  error: failure,
  stillPending: pending.has(1),
});
writeSetManifest(out, {
  set: 'call-timeout',
  recorder: 'benchmarks/rust-core/recorders/record-call-timeout.mjs',
  command: `node --import ./apps/desktop/scripts/test-env.mjs --import ./apps/desktop/scripts/test-tsx.mjs benchmarks/rust-core/recorders/record-call-timeout.mjs --tree <git archive of ${REF} (src, apps) with node_modules>`,
  identity: exactProductIdentity(tree, REF),
});
commitStage(out, finalOut);
console.log(`call-timeout: ${JSON.stringify(failure)} after ${steps.length} steps`);

#!/usr/bin/env node
// Records the session-detection case (:74) of src/runtime/computer-bridge/linux-readiness.test.mjs through
// Node's real `detectSession`: per environment of the test, the session it names. The file's other cases
// (:82-:412, the up-front readiness and `requiredCapabilities`) have no core counterpart (gaps-tools row 75, GAP).
//
//   node benchmarks/rust-core/recorders/record-linux-session-cases.mjs --tree <exact export of b6f10295a with node_modules>
//
// Writes native/core/fixtures/linux-session-cases/{golden.json,MANIFEST.json}.
import { join } from 'node:path';

import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const RECORDER = 'benchmarks/rust-core/recorders/record-linux-session-cases.mjs';
const TEST = 'src/runtime/computer-bridge/linux-readiness.test.mjs';

const tree = resolveTree(parseArgs());
const identity = exactProductIdentity(tree, NODE_COMMIT);
const { detectSession } = await importFrom(tree, 'src/runtime/computer-bridge/linux-readiness.mjs');

const envs = [
  { WAYLAND_DISPLAY: 'wayland-0' },
  { WAYLAND_DISPLAY: 'wayland-0', XDG_SESSION_TYPE: 'wayland' },
  { WAYLAND_DISPLAY: 'wayland-0', XDG_SESSION_TYPE: 'x11' },
  { XDG_SESSION_TYPE: 'wayland', DISPLAY: ':0' },
  { DISPLAY: ':0' },
];
const cases = [{ name: 'session detection matches native wayland_session()', checks: envs.map((env) => ({ env, session: detectSession(env) })) }];

const finalDir = join(FIXTURES_ROOT, 'linux-session-cases');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), { note: `Node's detectSession at ${NODE_COMMIT}`, test: TEST, cases });
writeSetManifest(stage, {
  set: 'linux-session-cases',
  recorder: RECORDER,
  command: `node ${RECORDER} --tree <exact export of ${NODE_COMMIT}>`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    compared: "per environment: the session Node names ('wayland' or 'x11') against the core's wayland_session()",
    excluded: { ':82-:412': 'gaps-tools row 75: up-front readiness and requiredCapabilities are not ported (GAP), not a replay exclusion' },
  },
});
commitStage(stage, finalDir);
console.log(`linux-session-cases: ${envs.length} environment(s)`);

#!/usr/bin/env node
// The workflow-surface fixture set as one recording: its four files come from four recorders run in turn on the same
// tree, and the manifest states the whole run (the product commit, the Node fix the tree carries, every recorder with
// its helpers by sha256, the Node version).
//
//   node benchmarks/rust-core/recorders/record-workflow-surface-set.mjs --tree <git archive of b6f10295a with the patch applied, with node_modules>
//        --patch benchmarks/rust-core/recorders/node-patches/node-fix-spawn-model-settings.patch
// (the patch is the one that adds `fast` to the agent tool's schema, which surface.json carries).
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, nodeTreeIdentity, parseArgs, resolveTree, writeSetManifest } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const REF = 'b6f10295a2f698afc85332467192de28500bd146';
const HERE = 'benchmarks/rust-core/recorders';
const RECORDERS = ['record-workflow-context.mjs', 'record-workflow-lead-parts.mjs', 'record-workflow-orchestration-text.mjs', 'record-workflow-surface.mjs'];
const args = parseArgs();
const tree = resolveTree(args);
const identity = nodeTreeIdentity(args, tree, REF);
const patchArgs = identity.patch ? ['--patch', identity.patch.file] : [];
for (const name of RECORDERS) {
  execFileSync(process.execPath, [join(HERE, name), '--tree', tree, ...patchArgs], { stdio: 'inherit', windowsHide: true, timeout: 280_000 });
}
const parts = RECORDERS.map((name) => recorderProvenance(pathToFileURL(join(process.cwd(), HERE, name))));
const inputs = new Map();
for (const part of parts) {
  inputs.set(part.recorder, part.recorderSha256);
  for (const input of part.inputs) inputs.set(input.path, input.sha256);
}
const own = recorderProvenance(import.meta.url);
for (const input of own.inputs) inputs.set(input.path, input.sha256);
const finalDir = join(FIXTURES_ROOT, 'workflow-surface');
// The recorders write their files into the set; the manifest then lists what they wrote.
writeSetManifest(finalDir, {
  set: 'workflow-surface',
  recorder: own.recorder,
  command: `node ${own.recorder} --tree <tree>${identity.patch ? ` --patch ${identity.patch.file}` : ''}`,
  identity,
  extra: {
    recorder: own.recorder,
    recorderSha256: own.recorderSha256,
    nodeVersion: own.nodeVersion,
    inputs: [...inputs].sort(([a], [b]) => (a < b ? -1 : 1)).map(([path, sha256]) => ({ path, sha256 })),
  },
});
console.log('workflow-surface: recorded');

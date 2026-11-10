// Records what Node's own `normalizeGrokToolSchemas` (b6f10295a) returns for every input of
// `native/core/fixtures/grok-tool-schema/inputs.json`, all of them in this one run, into `node-recorded.json`: the
// `JSON.stringify` text of the flattened schema (the bytes the request carries), or the error it threw. It writes the set's
// MANIFEST.json (the command, the identity of the tree this ran on, this recorder's sha256, the sha256 of every file of
// the directory). The recorder refuses a tree that is not exactly b6f10295a.
// Usage: node record.mjs --tree <git archive export of b6f10295a, with node_modules>
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..', '..', '..', '..', '..', '..');
const { commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, sha256, stageSet, writeJson, writeSetManifest } = await import(`file:///${join(repo, 'benchmarks/rust-core/recorders/lib/common.mjs').replaceAll('\\', '/')}`);

const COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const finalDir = join(repo, 'native/core/fixtures/grok-tool-schema');
const recorder = relative(repo, fileURLToPath(import.meta.url)).replaceAll('\\', '/');
const tree = resolveTree(parseArgs());
const identity = exactProductIdentity(tree, COMMIT);
const { normalizeGrokToolSchemas } = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/lib/grok-tool-schema.mjs');

// `-0` is part of an input: the file is read as text by JSON.parse, which keeps it.
const inputs = JSON.parse(readFileSync(join(finalDir, 'inputs.json'), 'utf8')).cases;
const cases = inputs.map(({ source, name, input }) => {
  try {
    const out = normalizeGrokToolSchemas([{ name, inputSchema: input }])[0].inputSchema;
    return { source, name, json: JSON.stringify(out) };
  } catch (error) {
    return { source, name, threw: `${error.name}: ${error.message}` };
  }
});

const stage = stageSet(finalDir, ['node-recorded.json', 'MANIFEST.json']);
writeJson(join(stage, 'node-recorded.json'), { cases });
const extra = {
  scripts: { 'benchmarks/rust-core/recorders/lib/common.mjs': sha256(readFileSync(join(repo, 'benchmarks/rust-core/recorders/lib/common.mjs'))) },
  recorderSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
  runtime: { node: process.version, electron: process.versions.electron ?? null },
};
writeSetManifest(stage, { set: 'grok-tool-schema', recorder, command: `node ${recorder} --tree <b6f10295a export>`, identity, extra });
commitStage(stage, finalDir);
console.log(`${cases.length} cases recorded from ${COMMIT}`);
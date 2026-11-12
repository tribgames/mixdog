// Scaffold shared by the session-runtime recorders (record-session-*.mjs): the Node tree, the staged fixture set, the
// manifest with its provenance, and two helpers every recorder uses to describe what it saw.
//
//   await runSessionRecorder(import.meta.url, { set, testFile, entry, replay, exclusions }, async ({ imp, tree }) => ({ cases }));
import { rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, nodeTreeIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './common.mjs';
import { exact } from './exact.mjs';
import { recorderProvenance } from './provenance.mjs';

export async function runSessionRecorder(recorderUrl, meta, build) {
  const cli = parseArgs();
  const tree = resolveTree(cli);
  const outDir = cli.get('out') ?? join(FIXTURES_ROOT, meta.set);
  // `--commit <full id>`: the tree must be exactly that commit's export (with `--patch`, the commit with that fix), checked before
  // anything runs; the manifest then names the commit. Without it the identity is the closest commit of this repository's history.
  const commit = cli.get('commit');
  const identity = commit ? nodeTreeIdentity(cli, cli.get('identity-tree') ?? tree, commit) : null;
  const stage = stageSet(outDir);
  const provenance = recorderProvenance(recorderUrl, meta.dataFiles ?? []);
  const recorder = provenance.recorder;
  const recording = await build({ tree, imp: (rel) => importFrom(tree, rel), importFrom });
  writeJson(join(stage, 'recording.json'), { domain: meta.set, recorder, testFile: meta.testFile, ...recording });
  writeSetManifest(stage, {
    set: meta.set,
    recorder,
    command: `node ${recorder} --tree <tree>${commit ? ` --commit ${commit}` : ''}`,
    identityTree: cli.get('identity-tree') ?? tree,
    identity,
    extra: { ...provenance, testFile: meta.testFile, entry: meta.entry, replay: meta.replay, ...(meta.values ? { values: meta.values } : {}), exclusions: meta.exclusions, ...(meta.patch ? { patch: meta.patch } : {}) },
  });
  commitStage(stage, outDir);
  console.log(`${basename(recorder)}: ${recording.cases.length} cases -> ${outDir}`);
  return recording;
}

/** Every error as a replay compares it: constructor name, code and text (and the cause's text). */
export const errorOf = (error) => ({
  name: error?.name ?? null,
  code: error?.code ?? null,
  message: String(error?.message ?? error),
  ...(error?.cause ? { cause: String(error.cause?.message ?? error.cause) } : {}),
});

/** `{ ok }` / `{ error }` of one call with both encoded through `exact` at the moment the call returns or throws. */
export async function outcomeExact(fn) {
  try {
    return { ok: exact(await fn()) };
  } catch (error) {
    return { error: exact(error) };
  }
}

/** `{ ok }` or `{ error }` of one call, sync or async. */
export async function outcome(fn) {
  try {
    return { ok: await fn() };
  } catch (error) {
    return { error: errorOf(error) };
  }
}

/** Replaces every occurrence of each `[needle, label]` in all strings of a JSON-like value. */
export function mask(value, pairs) {
  if (typeof value === 'string') return pairs.reduce((text, [needle, label]) => text.split(needle).join(label), value);
  if (Array.isArray(value)) return value.map((item) => mask(item, pairs));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mask(item, pairs)]));
  return value;
}

export const cleanup = (...dirs) => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true }));

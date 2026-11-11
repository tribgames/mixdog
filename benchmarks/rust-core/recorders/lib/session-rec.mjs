// Scaffold shared by the session-runtime recorders (record-session-*.mjs): the Node tree, the staged fixture set, the
// manifest with its provenance, and two helpers every recorder uses to describe what it saw.
//
//   await runSessionRecorder(import.meta.url, { set, testFile, entry, replay, exclusions }, async ({ imp, tree }) => ({ cases }));
import { rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './common.mjs';
import { recorderProvenance } from './provenance.mjs';

export async function runSessionRecorder(recorderUrl, meta, build) {
  const cli = parseArgs();
  const tree = resolveTree(cli);
  const outDir = cli.get('out') ?? join(FIXTURES_ROOT, meta.set);
  const stage = stageSet(outDir);
  const provenance = recorderProvenance(recorderUrl);
  const recorder = provenance.recorder;
  const recording = await build({ tree, imp: (rel) => importFrom(tree, rel) });
  writeJson(join(stage, 'recording.json'), { domain: meta.set, recorder, testFile: meta.testFile, ...recording });
  writeSetManifest(stage, {
    set: meta.set,
    recorder,
    command: `node ${recorder} --tree <tree>`,
    identityTree: cli.get('identity-tree') ?? tree,
    extra: { ...provenance, testFile: meta.testFile, entry: meta.entry, replay: meta.replay, exclusions: meta.exclusions },
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

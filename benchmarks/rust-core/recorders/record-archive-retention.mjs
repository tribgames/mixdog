#!/usr/bin/env node
// The desktop's auto-retention record on archive and restore (`apps/desktop/src/main/
// session-auto-retention.ts` `createSessionRetentionState(...).noteArchived`): the real TypeScript
// is bundled with esbuild, unchanged, and driven over a temporary `session-auto-retention.json`
// with a fixed clock per step. Each step records the file as it stands afterwards (`null`: none).
//
//   node benchmarks/rust-core/recorders/record-archive-retention.mjs --tree <tree w/ node_modules>
// Output: native/core/fixtures/archive-retention/golden.json
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const sandbox = mkdtempSync(join(tmpdir(), 'archive-retention-'));
process.env.MIXDOG_DATA_DIR = sandbox;
process.env.MIXDOG_HOME = sandbox;
process.on('exit', () => rmSync(sandbox, { recursive: true, force: true }));
const tree = resolveTree(parseArgs());

const esbuild = await importFrom(tree, 'node_modules/esbuild/lib/main.js');
const main = join(tree, 'apps/desktop/src/main');
const outfile = join(sandbox, 'retention.mjs');
await esbuild.build({
  entryPoints: [join(main, 'session-auto-retention.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  logLevel: 'error',
});
const { createSessionRetentionState } = await import(pathToFileURL(outfile).href);

let fileNo = 0;
async function run(name, initial, steps) {
  fileNo += 1;
  const file = join(sandbox, `retention-${fileNo}.json`);
  if (initial !== null) writeFileSync(file, JSON.stringify(initial));
  let now = 0;
  const state = createSessionRetentionState(file, () => now);
  const after = [];
  for (const step of steps) {
    now = step.at;
    await state.noteArchived(step.session, step.archived);
    after.push(existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null);
  }
  return { name, initial, steps, after };
}

const cases = [
  await run('a restore with no record yet creates it', null, [
    { session: 's1', archived: false, at: 1000 },
    { session: 's2', archived: true, at: 1100 },
    { session: 's2', archived: false, at: 2000 },
    { session: 's1', archived: true, at: 3000 },
    { session: 's1', archived: true, at: 3100 },
    { session: 's2', archived: false, at: 4000 },
  ]),
  await run('an archive with no record yet still creates the record', null, [{ session: 's1', archived: true, at: 1000 }]),
  await run('a valid record with bad stamps is left as it is until it changes', { enabledAt: 5, restored: { a: 0, b: -1, c: 'x', d: 7 } }, [
    { session: 'zz', archived: true, at: 1000 },
    { session: 'd', archived: true, at: 2000 },
  ]),
  await run('a record with no enabledAt is normalized on the next note', { restored: { a: 0, d: 7 } }, [
    { session: 'zz', archived: true, at: 1000 },
    { session: 'e', archived: false, at: 2000 },
  ]),
  await run('a record that is not an object starts over', [1, 2], [{ session: 's1', archived: false, at: 1000 }]),
];

const finalOut = join(FIXTURES_ROOT, 'archive-retention');
const out = stageSet(finalOut);
writeJson(join(out, 'golden.json'), {
  note: 'what the real 1.4.5 desktop session-auto-retention.ts noteArchived leaves in session-auto-retention.json after each step (null: no file)',
  cases,
});
writeSetManifest(out, {
  set: 'archive-retention',
  recorder: 'benchmarks/rust-core/recorders/record-archive-retention.mjs',
  command: 'node benchmarks/rust-core/recorders/record-archive-retention.mjs --tree <tree>',
  extra: { cases: cases.length },
});
commitStage(out, finalOut);
console.log(`cases=${cases.length}`);

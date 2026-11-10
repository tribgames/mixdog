// Records the tables in ../*.recorded.json from Node's own modules.
//
//   node record.mjs --node-repo <a repository that has the Node commit> [<test file under apps/desktop/src> ...]
//
// The Node modules a test imports are run from an exact `git archive` export of NODE_COMMIT (never from a working tree), and the
// test itself is that commit's own test file with its Node imports wrapped by recorder.mjs. What the wrapped functions are called
// with and answer is written next to the committed tests as <test>.<n>.recorded.json / .recorded.mjs, each naming the full commit.
// A table's `stubs`, `opaque` and `normalize` are settings, not recordings: they are kept from the table being replaced.
// Without test files, every test that imports a recording is recorded again.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { exportNodeTree, REVISION } from '../../../../../../src/tui/components/status-line/footer-golden/node-tree.mjs';
import { callKey } from '../replay.mjs';
import { NODE_COMMIT, NODE_TREE } from './node-source.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..');
const srcDir = resolve(here, '../../..');
const repoRoot = resolve(srcDir, '../../..');
const desktopDir = resolve(srcDir, '..');

const args = process.argv.slice(2);
const flag = args.indexOf('--node-repo');
if (flag < 0 || !args[flag + 1]) throw new Error('usage: node record.mjs --node-repo <repository with ' + REVISION + '> [test files]');
const nodeRepo = resolve(args[flag + 1]);
const requested = args.filter((_, i) => i !== flag && i !== flag + 1);

const git = (...a) => spawnSync('git', ['-C', nodeRepo, ...a], { encoding: 'utf8', maxBuffer: 1 << 28 });
const { tree, commit } = exportNodeTree(nodeRepo);
if (commit !== NODE_COMMIT) throw new Error(`the Node export is ${commit}, the recordings are pinned to ${NODE_COMMIT}`);
const treeId = git('rev-parse', `${commit}^{tree}`).stdout.trim();
if (treeId !== NODE_TREE) throw new Error(`${commit} has tree ${treeId}, expected ${NODE_TREE}`);

const testsImportingRecordings = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'test-recorded' || entry.name === 'node_modules' ? [] : testsImportingRecordings(path);
    return /\.test\.mjs$/.test(entry.name) && /test-recorded\/[^'"]+\.recorded\.mjs/.test(readFileSync(path, 'utf8'))
      ? [posix.normalize(relative(srcDir, path).replace(/\\/g, '/'))]
      : [];
  });
const tests = (requested.length ? requested : testsImportingRecordings(srcDir)).map((t) => t.replace(/\\/g, '/'));

const specRe = /(from\s*|import\s*\(\s*)(['"])(\.{1,2}\/[^'"]+)\2/g;
const failures = [];
for (const rel of tests) {
  const stem = posix.basename(rel).replace(/\.mjs$/, '');
  const testDir = posix.join(srcDir.replace(/\\/g, '/'), posix.dirname(rel));
  const original = git('show', `${commit}:apps/desktop/src/${rel}`);
  if (original.status !== 0) throw new Error(`${commit} has no apps/desktop/src/${rel}: ${original.stderr.trim()}`);
  const text = original.stdout.replace(/\r\n/g, '\n');

  // The Node modules the test imports: relative specifiers that land in <repo>/src.
  const mods = new Map();
  text.replace(specRe, (m, _pre, _q, spec) => {
    const abs = posix.normalize(posix.join(testDir, spec));
    const inRepo = posix.relative(repoRoot.replace(/\\/g, '/'), abs);
    if (inRepo.startsWith('src/')) mods.set(spec, inRepo);
    return m;
  });
  const ids = new Map([...mods.keys()].map((spec, i) => [spec, `${stem}.${i}`]));

  const scratch = mkdtempSync(join(tmpdir(), 'record-'));
  const recordFile = join(scratch, 'record.jsonl');
  const recordingTest = join(srcDir, rel.replace(/\.test\.mjs$/, '.recording.test.mjs'));
  const names = new Map();
  try {
    let recorded = text;
    for (const [spec, modulePath] of mods) {
      const real = pathToFileURL(join(tree, modulePath)).href;
      names.set(spec, Object.keys(await import(real)).filter((k) => k !== 'default'));
      const id = ids.get(spec);
      const shim = join(scratch, `${id}.shim.mjs`);
      writeFileSync(
        shim,
        `import * as real from '${real}';\nimport { wrap } from '${pathToFileURL(join(here, 'recorder.mjs')).href}';\n` +
          names.get(spec).map((n) => `export const ${n} = wrap(${JSON.stringify(id)}, ${JSON.stringify(n)}, real.${n});`).join('\n') + '\n'
      );
      const shimUrl = pathToFileURL(shim).href;
      recorded = recorded.split(`'${spec}'`).join(`'${shimUrl}'`).split(`"${spec}"`).join(`"${shimUrl}"`);
    }
    writeFileSync(recordingTest, recorded);
    const run = spawnSync(
      process.execPath,
      ['../../scripts/test.mjs', '--import', './scripts/test-env.mjs', '--import', './scripts/test-tsx.mjs', '--lane', 'all', `src/${rel.replace(/\.test\.mjs$/, '.recording.test.mjs')}`],
      { cwd: desktopDir, env: { ...process.env, RECORD_FILE: recordFile }, encoding: 'utf8', maxBuffer: 1 << 28 }
    );
    if (run.status !== 0) {
      failures.push(`${rel}: the original test failed against the Node export (exit ${run.status})\n${(run.stdout + run.stderr).split('\n').filter((l) => /✖|Error|ERROR|error:|✘/.test(l)).slice(0, 30).join('\n')}`);
      continue;
    }
    if (!existsSync(recordFile)) {
      failures.push(`${rel}: nothing was recorded`);
      continue;
    }
    const rows = readFileSync(recordFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    for (const [spec, modulePath] of mods) {
      const id = ids.get(spec);
      const file = join(outDir, `${id}.recorded.json`);
      const before = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
      const table = { source: { commit, tree: treeId, module: modulePath, test: `apps/desktop/src/${rel}` }, constants: {}, calls: {}, services: {}, stubs: before.stubs ?? {}, opaque: before.opaque ?? [] };
      if (before.normalize) table.normalize = before.normalize;
      const builtCount = {};
      for (const r of rows.filter((row) => row.mod === id)) {
        if ('constant' in r) table.constants[r.name] = r.constant;
        else if (r.class) continue;
        else if (r.service) {
          table.services[r.name.replace(/#\d+/, '')] = r.service;
          const built = (builtCount[r.name] = (builtCount[r.name] ?? -1) + 1);
          const forKey = ((table.factories ??= {})[r.name] ??= {});
          (forKey[callKey(table, r.name, r.args)] ??= []).push(built);
        } else {
          const key = callKey(table, r.name, r.args);
          (table.calls[key] ??= []).push(r.error ? { error: r.error, async: !!r.async } : { result: r.result, async: !!r.async });
        }
      }
      mkdirSync(outDir, { recursive: true });
      writeFileSync(file, JSON.stringify(table, null, 1) + '\n');
      const exports = names.get(spec).map((n) => `export const ${n} = replay(table, ${JSON.stringify(n)});`).join('\n');
      writeFileSync(
        join(outDir, `${id}.recorded.mjs`),
        `// Node ${commit} (tree ${treeId}) ${modulePath}, recorded from apps/desktop/src/${rel} of that commit run against an exact export of it (record/record.mjs).\n` +
          `import { readFileSync } from 'node:fs';\nimport { replay } from './replay.mjs';\n\n` +
          `const table = JSON.parse(readFileSync(new URL('./${id}.recorded.json', import.meta.url), 'utf8'));\n${exports}\n`
      );
    }
    console.log(`recorded ${rel}: ${[...ids.values()].join(', ')}`);
  } finally {
    rmSync(recordingTest, { force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}

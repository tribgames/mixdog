// The rows tests that moved here from Node assert behavior of Node's own modules. This runs each of them against
// those modules, exported from the b6f10295a commit (node-tree.mjs): the expectations hold for Node itself, and the
// copies in src/rows are tested against the same assertions. The reference repository is MIXDOG_NODE_REFERENCE_REPO
// (default C:/Project/mixdog); without it the check is skipped, never faked.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { exportNodeTree } from '../../../../../src/tui/components/status-line/footer-golden/node-tree.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const rowsTests = join(here, '..');
const repo = process.env.MIXDOG_NODE_REFERENCE_REPO || 'C:/Project/mixdog';
// Replayed against recorded goldens instead (node-oracle.golden.json).
const REPLAYED = /^(tool-result-text|context-measurement)\.test\.mjs$/;

test('every moved rows test passes against the modules of Node b6f10295a', { skip: !existsSync(join(repo, '.git')) && 'no reference repository' }, (t) => {
  const { tree } = exportNodeTree(repo);
  const sources = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.mjs')) sources.push(path.replace(/\\/g, '/'));
    }
  })(join(tree, 'src'));
  const urlOf = (path) => JSON.stringify(pathToFileURL(path).href);
  const out = join(tree, 'oracle');
  mkdirSync(out, { recursive: true });

  const results = [];
  for (const name of readdirSync(rowsTests).filter((file) => file.endsWith('.test.mjs') && !REPLAYED.test(file))) {
    let unresolved = null;
    let text = readFileSync(join(rowsTests, name), 'utf8');
    // The rows module under test → the Node module of the same name.
    text = text.replace(/(['"])\.\.\/\.\.\/src\/rows\/([\w./-]+?)\.mjs\1/g, (match, quote, module) => {
      const hits = sources.filter((source) => source.endsWith(`/${module}.mjs`));
      const pick = hits.find((hit) => /runtime\/shared|transcript-restore|src\/ui/.test(hit)) || hits[0];
      if (!pick) unresolved = module;
      return pick ? urlOf(pick) : match;
    });
    // A shared module imported from the repository's src/ → the same path in the Node tree.
    text = text.replace(/(['"])(?:\.\.\/){4}src\/([\w./-]+\.mjs)\1/g, (match, quote, path) => urlOf(join(tree, 'src', path)));
    // Sibling fixtures stay the repository's own.
    text = text.replace(/(['"])\.\/([\w.-]+)\1/g, (match, quote, file) =>
      existsSync(join(rowsTests, file)) ? urlOf(join(rowsTests, file)) : match
    );
    assert.equal(unresolved, null, `${name}: no Node module named ${unresolved}`);
    const file = join(out, name);
    writeFileSync(file, text);
    // A nested runner must not see this run's test context.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const run = spawnSync(process.execPath, ['--test', file], { cwd: tree, encoding: 'utf8', env });
    const counts = /# pass (\d+)[\s\S]*# fail (\d+)/.exec(run.stdout) || [];
    results.push({ name, pass: Number(counts[1] || 0), fail: Number(counts[2] ?? 1), output: `${run.stdout.slice(-600)}${run.stderr.slice(-600)}` });
  }
  t.diagnostic(results.map((r) => `${r.name}: ${r.pass} pass`).join('; '));
  assert.ok(results.length >= 10, 'the moved tests were found');
  assert.deepEqual(results.filter((r) => r.fail > 0 || r.pass === 0), []);
});

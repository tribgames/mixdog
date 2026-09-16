import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  StructuralEngineUnavailableError,
  createGraphStructuralAdapter,
  graphSupportsScan,
  groupRulePacks,
  groupsForLanguages,
  loadRulePacks,
  normalizeStructuralMatch,
  parseStructuralJsonl,
  resetStructuralProbeCache,
  resolveStructuralAdapter,
} from './structural.mjs';
import { ENGINE_IDS, enginesForLanguages } from './engines.mjs';
import { graphBinaryPath } from '../agent/orchestrator/tools/code-graph/graph-binary.mjs';

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'tidy-rules-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const JSONL = [
  JSON.stringify({
    file: 'src/a.ts',
    lang: 'typescript',
    ruleId: 'no-var',
    severity: 'warning',
    message: 'prefer const',
    range: { start: { line: 4, column: 2 }, end: { line: 4, column: 5 }, byteOffset: [42, 45] },
    fix: { byteOffset: [42, 45], text: 'const' },
  }),
  JSON.stringify({
    file: 'src/b.ts',
    lang: 'typescript',
    ruleId: 'no-debugger',
    severity: 'error',
    message: 'debugger left in source',
    range: { start: { line: 0, column: 0 }, end: { line: 0, column: 8 }, byteOffset: [0, 8] },
    fix: null,
  }),
  JSON.stringify({ summary: { matches: 2, files: 2, rules: 2 } }),
].join('\n');

test('JSONL matches convert to 1-based positions and keep byte offsets', () => {
  const parsed = parseStructuralJsonl(JSONL, { exitCode: 0 });
  assert.equal(parsed.matches.length, 2);
  assert.deepEqual(parsed.summary, { matches: 2, files: 2, rules: 2 });
  const [first, second] = parsed.matches;
  assert.deepEqual(first.range.start, { line: 5, column: 3 });
  assert.deepEqual(first.range.end, { line: 5, column: 6 });
  assert.deepEqual(first.range.byteOffset, [42, 45]);
  assert.deepEqual(first.fix, { byteOffset: [42, 45], text: 'const' });
  assert.equal(first.ruleId, 'no-var');
  assert.equal(second.fix, null);
  assert.equal(second.severity, 'error');
});

test('a missing summary line is synthesized and malformed rows are counted', () => {
  const parsed = parseStructuralJsonl(
    `${JSON.stringify({ file: 'a.ts', range: { start: { line: 0, column: 0 }, end: { line: 0, column: 1 } } })}\n{oops`,
    { exitCode: 0 }
  );
  assert.deepEqual(parsed.summary, { matches: 1, files: 1 });
  assert.equal(parsed.malformedLines, 1);
});

test('exit 0 with no summary and no matches is a protocol error, not a clean scan', () => {
  const parsed = parseStructuralJsonl('', { exitCode: 0 });
  assert.deepEqual(parsed.matches, []);
  assert.equal(parsed.error.kind, 'protocol');
  assert.match(parsed.error.message, /does not own the --scan protocol/);
});

test('exit 2 is a rule/usage error and yields no matches', () => {
  const parsed = parseStructuralJsonl('', { exitCode: 2, stderr: 'rule "no-var": missing `language`' });
  assert.deepEqual(parsed.matches, []);
  assert.equal(parsed.error.exitCode, 2);
  assert.equal(parsed.error.kind, 'rules');
  assert.match(parsed.error.message, /missing `language`/);
});

test('exit 1 is an internal error reported alongside whatever was emitted', () => {
  const parsed = parseStructuralJsonl(JSONL, { exitCode: 1, stderr: 'panic: index out of bounds' });
  assert.equal(parsed.matches.length, 2);
  assert.equal(parsed.error.kind, 'internal');
  assert.match(parsed.error.message, /panic/);
});

test('a record without a file is dropped rather than half-normalized', () => {
  assert.equal(normalizeStructuralMatch({ ruleId: 'x' }), null);
  assert.equal(normalizeStructuralMatch(null), null);
});

test('rule packs load from yml files; an absent directory is simply empty', (t) => {
  const root = workspace(t);
  mkdirSync(join(root, 'javascript'), { recursive: true });
  writeFileSync(
    join(root, 'javascript', 'no-var.yml'),
    'id: no-var\nlanguage: javascript\nrule:\n  pattern: var $A = $B\n'
  );
  writeFileSync(join(root, 'python.yaml'), 'id: no-assert\nlanguage: python\nrule:\n  pattern: assert $A\n');
  writeFileSync(join(root, 'notes.md'), 'ignored');

  const { packs, rulesText } = loadRulePacks({ dir: root });
  assert.deepEqual(
    packs.map((pack) => pack.id),
    ['javascript/no-var', 'python']
  );
  assert.deepEqual(packs[0].rules, ['no-var']);
  assert.deepEqual(packs[0].languages, ['javascript']);
  assert.match(rulesText, /\n---\n/);

  const empty = loadRulePacks({ dir: join(root, 'does-not-exist') });
  assert.deepEqual(empty.packs, []);
  assert.equal(empty.rulesText, '');
});

test('rule-pack test cases are not loaded as rules', (t) => {
  const root = workspace(t);
  mkdirSync(join(root, '__tests__'), { recursive: true });
  writeFileSync(join(root, 'rust.yml'), 'id: no-dbg\nlanguage: rust\nrule:\n  pattern: dbg!($A)\n');
  writeFileSync(join(root, '__tests__', 'no-dbg.yml'), 'id: no-dbg\nvalid:\n  - let a = 1;\ninvalid:\n  - dbg!(a)\n');
  const { packs, rulesText } = loadRulePacks({ dir: root });
  assert.deepEqual(
    packs.map((pack) => pack.id),
    ['rust']
  );
  assert.ok(!rulesText.includes('invalid:'), 'test fixtures must never reach the scan');
});

test('mixdog-graph is the only structural engine: no binary is an explicit error', async (t) => {
  const root = workspace(t);
  // No PATH lookup, no managed install, no ast-grep: there is nothing to fall
  // back to, and the caller has to hear why instead of getting zero matches.
  await assert.rejects(
    () => resolveStructuralAdapter({ cwd: root, graphBinPath: null }),
    (error) => {
      assert.equal(error instanceof StructuralEngineUnavailableError, true);
      assert.match(error.message, /no mixdog-graph binary was found/);
      assert.match(error.message, /cargo build --release --manifest-path native\/mixdog-graph\/Cargo\.toml/);
      assert.match(error.message, /structural:false/);
      return true;
    }
  );
  assert.equal(ENGINE_IDS.includes('ast-grep'), false, 'ast-grep must be gone from the engine catalog');
  assert.equal(enginesForLanguages(['javascript']).includes('ast-grep'), false);
});

test('rule groups follow the scan grammar, so tsx packs run for a typescript project', () => {
  const groups = groupRulePacks([
    { id: 'typescript/no-debugger', languages: ['typescript'], text: 'id: a' },
    { id: 'tsx/no-debugger', languages: ['tsx'], text: 'id: b' },
    { id: 'python/todo-marker', languages: ['python'], text: 'id: c' },
  ]);
  // .tsx files are detected as typescript but parsed with the tsx grammar, so a
  // language filter that drops the tsx group leaves them with no rules at all.
  assert.deepEqual(
    groupsForLanguages(groups, ['typescript']).map((group) => group.language),
    ['typescript', 'tsx']
  );
  assert.deepEqual(
    groupsForLanguages(groups, ['python']).map((group) => group.language),
    ['python']
  );
  assert.equal(groupsForLanguages(groups, []).length, 3);
});

test('a graph binary without the scan mode is refused even though it exits 0', async (t) => {
  const root = workspace(t);
  const windows = process.platform === 'win32';
  // A pre-scan binary reads `--langs` as a symbol search: exit 0, no registry.
  // It answers `--scan` the same way, so adopting it would report every file as
  // clean instead of naming the build that has to be replaced.
  const fake = join(root, windows ? 'graph.cmd' : 'graph.sh');
  writeFileSync(fake, windows ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n', windows ? {} : { mode: 0o755 });
  resetStructuralProbeCache();
  assert.equal(await graphSupportsScan(fake, { cwd: root }), false);
  resetStructuralProbeCache();
  await assert.rejects(
    () => resolveStructuralAdapter({ cwd: root, graphBinPath: fake }),
    (error) => {
      assert.equal(error instanceof StructuralEngineUnavailableError, true);
      // The failing binary is named, so the operator knows which build to replace.
      assert.equal(error.binPath, fake);
      assert.match(error.message, new RegExp(`${windows ? 'graph\\.cmd' : 'graph\\.sh'}" does not answer`));
      assert.match(error.message, /update the packaged mixdog-graph native tool/);
      return true;
    }
  );
  resetStructuralProbeCache();
});

test('an empty langs table does not skip the probe and adopt the binary', async (t) => {
  const root = workspace(t);
  const windows = process.platform === 'win32';
  const fake = join(root, windows ? 'graph.cmd' : 'graph.sh');
  writeFileSync(fake, windows ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n', windows ? {} : { mode: 0o755 });
  resetStructuralProbeCache();
  await assert.rejects(
    () => resolveStructuralAdapter({ cwd: root, graphBinPath: fake, graphLangs: {} }),
    StructuralEngineUnavailableError
  );
  await assert.rejects(
    () => resolveStructuralAdapter({ cwd: root, graphBinPath: fake, graphLangs: { extensions: new Map() } }),
    StructuralEngineUnavailableError
  );
  resetStructuralProbeCache();
});

test('scanning through a binary that exits 0 with empty stdout throws, not zero matches', async (t) => {
  const root = workspace(t);
  const windows = process.platform === 'win32';
  const fake = join(root, windows ? 'graph.cmd' : 'graph.sh');
  writeFileSync(fake, windows ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n', windows ? {} : { mode: 0o755 });
  const adapter = createGraphStructuralAdapter({ binPath: fake });
  await assert.rejects(
    () =>
      adapter.scan({
        cwd: root,
        rulesText: 'id: x\nlanguage: javascript\nrule:\n  pattern: foo\n',
        files: [],
        fix: false,
      }),
    (error) => {
      assert.equal(error instanceof StructuralEngineUnavailableError, true);
      assert.equal(error.binPath, fake);
      assert.match(error.message, /does not answer/);
      return true;
    }
  );
});

test('the local graph binary answers the live scan contract', async (t) => {
  const binPath = graphBinaryPath();
  const root = workspace(t);
  // The probe, not mere existence: an older binary accepts --langs, exits 0 and
  // prints nothing, and must not be mistaken for a scan-capable one.
  if (!binPath || !existsSync(binPath) || !(await graphSupportsScan(binPath, { cwd: root }))) {
    t.skip('no mixdog-graph build with the --langs/--scan modes on this machine');
    return;
  }
  writeFileSync(join(root, 'a.js'), 'function f(){ debugger; }');
  const adapter = await resolveStructuralAdapter({ cwd: root, graphBinPath: binPath });
  assert.equal(adapter?.id, 'graph-binary', 'a binary that answers --langs owns the structural scan');

  // Production sends one language group per scan, so the live check does too.
  const javascript = loadRulePacks().groups.find((group) => group.language === 'javascript');
  assert.ok(javascript, 'the javascript rule group must exist');
  const scan = await adapter.scan({ cwd: root, rulesText: javascript.rulesText, files: ['a.js'], fix: true });
  assert.equal(scan.error, undefined);
  const match = scan.matches.find((entry) => entry.ruleId === 'no-debugger');
  assert.ok(match, `no-debugger should match: ${JSON.stringify(scan.matches).slice(0, 300)}`);
  assert.equal(match.file, 'a.js');
  assert.equal(match.lang, 'javascript');
  // The binary reports zero-based positions; the adapter hands back 1-based.
  assert.deepEqual(match.range.start, { line: 1, column: 15 });
  assert.deepEqual(match.range.byteOffset, [14, 23]);
  assert.deepEqual(match.fix, { byteOffset: [14, 23], text: '' });
  assert.equal(typeof scan.summary.matches, 'number');
  // --fix asks for fix payloads only: the file on disk must be untouched.
  assert.equal(readFileSync(join(root, 'a.js'), 'utf8'), 'function f(){ debugger; }');

  const broken = await adapter.scan({ cwd: root, rulesText: 'nonsense: [', files: [], fix: false });
  assert.equal(broken.error.exitCode, 2);
  assert.equal(broken.error.kind, 'rules');
  assert.deepEqual(broken.matches, []);
});

test('rule packs are grouped per language so one bad pack cannot mute the rest', (t) => {
  const root = workspace(t);
  mkdirSync(join(root, 'javascript'), { recursive: true });
  mkdirSync(join(root, 'lua'), { recursive: true });
  writeFileSync(
    join(root, 'javascript', 'no-debugger.yml'),
    'id: no-debugger\nlanguage: javascript\nrule:\n  kind: debugger_statement\n'
  );
  writeFileSync(
    join(root, 'javascript', 'no-var.yml'),
    'id: no-var\nlanguage: javascript\nrule:\n  pattern: var $A = $B\n'
  );
  writeFileSync(join(root, 'lua', 'todo.yml'), 'id: todo\nlanguage: lua\nrule:\n  kind: comment\n');

  const { groups } = loadRulePacks({ dir: root });
  assert.deepEqual(groups.map((group) => group.language).sort(), ['javascript', 'lua']);
  const javascript = groups.find((group) => group.language === 'javascript');
  assert.deepEqual(javascript.packs, ['javascript/no-debugger', 'javascript/no-var']);
  assert.match(javascript.rulesText, /\n---\n/);
  assert.equal(/language: lua/.test(javascript.rulesText), false, 'groups never mix languages');
});

test('the shipped rule packs load and expose ids and languages', () => {
  const { packs, rulesText } = loadRulePacks();
  if (packs.length === 0) return; // rule packs are authored separately
  for (const pack of packs) {
    assert.ok(pack.rules.length > 0, `${pack.id} must declare rule ids`);
    assert.ok(pack.languages.length > 0, `${pack.id} must declare a language`);
    assert.ok(!pack.id.startsWith('__tests__'), 'test fixtures must not be packs');
  }
  assert.ok(rulesText.includes('---'), 'packs are concatenated as a YAML multi-document');
});

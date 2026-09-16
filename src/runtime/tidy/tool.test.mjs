import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { executeTidyTool } from './tool.mjs';
import { runProcess } from './process.mjs';
import { graphSupportsScan } from './structural.mjs';
import { graphBinaryPath } from '../agent/orchestrator/tools/code-graph/graph-binary.mjs';

/** The resolved graph binary when it owns the --langs/--scan protocol. */
async function scanCapableGraphBinary(cwd) {
  const binPath = graphBinaryPath();
  if (!binPath || !existsSync(binPath)) return null;
  return await graphSupportsScan(binPath, { cwd }) ? binPath : null;
}

function parseResult(result) {
  assert.equal(result.content[0].type, 'text');
  return JSON.parse(result.content[0].text);
}

async function gitProject(t) {
  const root = mkdtempSync(join(tmpdir(), 'tidy-tool-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.py'), 'import os\n');
  writeFileSync(join(root, 'src', 'b.mjs'), 'export const a = 1;\n');
  writeFileSync(join(root, 'notes.md'), '# notes\n');
  for (const args of [['init'], ['add', '.']]) {
    const result = await runProcess('git', args, { cwd: root, timeoutMs: 30_000 });
    if (result.code !== 0) return null;
  }
  return root;
}

test('scan reports detected languages, engine resolution and the download policy', async (t) => {
  const root = await gitProject(t);
  if (!root) {
    t.skip('git is unavailable in this environment');
    return;
  }
  const report = parseResult(await executeTidyTool({ action: 'scan' }, { cwd: root }));
  assert.equal(report.ok, true);
  assert.equal(report.action, 'scan');
  assert.deepEqual(
    report.languages.map((language) => language.id).sort(),
    ['javascript', 'markdown', 'python'],
  );
  assert.ok(Array.isArray(report.engines));
  assert.equal(report.policy.downloads, 'ask');
  for (const engine of report.missing || []) {
    assert.ok(engine.installHint, `${engine.id} must carry an install hint`);
  }
  assert.ok(Number.isFinite(report.elapsedMs));
});

test('scan honors the paths and languages filters', async (t) => {
  const root = await gitProject(t);
  if (!root) {
    t.skip('git is unavailable in this environment');
    return;
  }
  const report = parseResult(await executeTidyTool({ action: 'scan', paths: ['src'], languages: ['python'] }, { cwd: root }));
  assert.deepEqual(report.languages, [{ id: 'python', files: 1 }]);
  assert.deepEqual(report.scope, ['src']);
  assert.ok(report.engines.concat(report.missing || []).every((engine) => engine.languages.includes('python')));
});

test('check runs read-only and reports one result row per runnable engine', async (t) => {
  const root = await gitProject(t);
  if (!root) {
    t.skip('git is unavailable in this environment');
    return;
  }
  const report = parseResult(await executeTidyTool({ action: 'check', structural: false }, { cwd: root }));
  assert.equal(report.action, 'check');
  assert.ok(Array.isArray(report.results));
  assert.equal(report.structural, undefined);
  for (const result of report.results) {
    assert.equal(typeof result.filesChecked, 'number');
    assert.ok(Array.isArray(result.diagnostics));
  }
});

test('language detection uses the graph binary when it answers --langs', async (t) => {
  const root = await gitProject(t);
  if (!root) {
    t.skip('git is unavailable in this environment');
    return;
  }
  const report = parseResult(await executeTidyTool({ action: 'scan' }, { cwd: root }));
  const expected = await scanCapableGraphBinary(root) ? 'graph-binary' : 'git';
  assert.equal(report.languageSource, expected);
});

test('a structural fix dry-run reports graph-binary matches without writing', async (t) => {
  if (!await scanCapableGraphBinary(process.cwd())) {
    t.skip('no mixdog-graph build with the --langs/--scan modes on this machine');
    return;
  }
  const root = await gitProject(t);
  if (!root) {
    t.skip('git is unavailable in this environment');
    return;
  }
  const source = 'export function f() { debugger; }\n';
  const file = join(root, 'src', 'debug.js');
  writeFileSync(file, source);
  const added = await runProcess('git', ['add', '.'], { cwd: root, timeoutMs: 30_000 });
  assert.equal(added.code, 0);

  const report = parseResult(await executeTidyTool({ action: 'fix', paths: ['src'] }, { cwd: root }));
  assert.equal(report.structural.adapter, 'graph-binary');
  const match = report.structural.matches.find((entry) => entry.ruleId === 'no-debugger');
  assert.ok(match, `expected a no-debugger match: ${JSON.stringify(report.structural).slice(0, 400)}`);
  assert.equal(match.file, 'src/debug.js');
  assert.ok(match.fix, 'the dry run must carry the fix payload it would apply');
  assert.ok(report.structural.fixable >= 1);
  assert.deepEqual(report.structural.applied, []);
  assert.ok(report.notes.some((note) => /dry run/.test(note)));
  assert.equal(readFileSync(file, 'utf8'), source, 'a dry run must not write');
});

test('rules lists the structural packs and the adapter that would run them', async (t) => {
  const root = await gitProject(t);
  if (!root) {
    t.skip('git is unavailable in this environment');
    return;
  }
  const report = parseResult(await executeTidyTool({ action: 'rules' }, { cwd: root }));
  assert.equal(report.action, 'rules');
  assert.ok(Array.isArray(report.rules.packs));
  assert.equal(typeof report.rules.adapter, 'string');
  if (report.ok) {
    assert.equal(report.rules.adapter, 'graph-binary');
    assert.equal(report.errors, undefined);
  } else {
    assert.equal(report.rules.adapter, 'none');
    assert.match(report.errors[0], /mixdog-graph/);
    assert.match(report.errors[0], /structural:false/);
  }
});

test('an outdated mixdog-graph fails check/fix/rules instead of reporting zero matches', async (t) => {
  const root = await gitProject(t);
  if (!root) {
    t.skip('git is unavailable in this environment');
    return;
  }
  const windows = process.platform === 'win32';
  const fake = join(root, windows ? 'old-graph.cmd' : 'old-graph.sh');
  writeFileSync(fake, windows ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n', windows ? {} : { mode: 0o755 });
  const childScript = join(root, 'probe-tidy.mjs');
  writeFileSync(childScript, `
    import { executeTidyTool } from ${JSON.stringify(new URL('./tool.mjs', import.meta.url).href)};
    const cwd = ${JSON.stringify(root)};
    async function run(args) {
      const result = await executeTidyTool(args, { cwd });
      return { isError: Boolean(result.isError), body: JSON.parse(result.content[0].text) };
    }
    const out = {
      scan: await run({ action: 'scan' }),
      check: await run({ action: 'check' }),
      fix: await run({ action: 'fix' }),
      rules: await run({ action: 'rules' }),
      checkOff: await run({ action: 'check', structural: false }),
    };
    process.stdout.write(JSON.stringify(out));
  `);
  const result = await runProcess(process.execPath, [childScript], {
    cwd: root,
    env: { ...process.env, MIXDOG_GRAPH_BIN: fake },
    timeoutMs: 120_000,
  });
  assert.equal(result.code, 0, result.stderr.slice(0, 800));
  const out = JSON.parse(result.stdout);
  assert.equal(out.scan.isError, false);
  assert.equal(out.scan.body.ok, true);
  assert.equal(out.scan.body.structural, undefined);
  assert.ok(out.scan.body.notes.some((note) => note.includes(fake) && /does not answer/.test(note)));
  for (const action of ['check', 'fix']) {
    assert.equal(out[action].isError, true, action);
    assert.equal(out[action].body.ok, false, action);
    assert.equal(out[action].body.structural, undefined, `${action} must not report a silent empty structural section`);
    assert.match(out[action].body.error, new RegExp(windows ? 'old-graph\\.cmd' : 'old-graph\\.sh'));
    assert.match(out[action].body.error, /does not answer/);
    assert.match(out[action].body.error, /native\/mixdog-graph\/Cargo\.toml/);
    assert.match(out[action].body.error, /structural:false/);
  }
  assert.equal(out.rules.body.ok, false);
  assert.equal(out.rules.body.rules.adapter, 'none');
  assert.match(out.rules.body.errors[0], /does not answer/);
  assert.equal(out.checkOff.isError, false);
  assert.equal(out.checkOff.body.ok, true);
  assert.equal(out.checkOff.body.structural, undefined);
  assert.ok(Array.isArray(out.checkOff.body.results));
});

test('unsupported actions and escaping paths fail as tool errors, not throws', async () => {
  const bad = await executeTidyTool({ action: 'format' }, { cwd: process.cwd() });
  assert.equal(bad.isError, true);
  assert.match(parseResult(bad).error, /Unsupported tidy action "format"/);

  const escaping = await executeTidyTool({ action: 'scan', paths: ['../../etc'] }, { cwd: process.cwd() });
  assert.equal(escaping.isError, true);
  assert.match(parseResult(escaping).error, /must stay inside the project/);

  const noEngines = await executeTidyTool({ action: 'install' }, { cwd: process.cwd() });
  assert.equal(noEngines.isError, true);
  assert.match(parseResult(noEngines).error, /install requires engines/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  chunkStructuralFiles,
  executeTidyTool,
  MAX_STRUCTURAL_FILE_ARGS,
  rememberTidyRun,
  resetTidyResultCache,
} from './tool.mjs';
import { runProcess } from './process.mjs';
import { graphSupportsScan } from './structural.mjs';
import { graphBinaryPath } from '../agent/orchestrator/tools/code-graph/graph-binary.mjs';

/** The resolved graph binary when it owns the --langs/--scan protocol. */
async function scanCapableGraphBinary(cwd) {
  const binPath = graphBinaryPath();
  if (!binPath || !existsSync(binPath)) return null;
  return (await graphSupportsScan(binPath, { cwd })) ? binPath : null;
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
  assert.deepEqual(report.languages.map((language) => language.id).sort(), ['javascript', 'markdown', 'python']);
  assert.ok(Array.isArray(report.engines));
  assert.equal(report.policy.downloads, 'auto');
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
  const report = parseResult(
    await executeTidyTool({ action: 'scan', paths: ['src'], languages: ['python'] }, { cwd: root })
  );
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
  const expected = (await scanCapableGraphBinary(root)) ? 'graph-binary' : 'git';
  assert.equal(report.languageSource, expected);
});

test('a structural fix dry-run reports graph-binary matches without writing', async (t) => {
  if (!(await scanCapableGraphBinary(process.cwd()))) {
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
  writeFileSync(
    childScript,
    `
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
  `
  );
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

test('structural file chunks never collapse a large scope to an unfiltered walk', () => {
  assert.deepEqual(chunkStructuralFiles([]), []);
  assert.deepEqual(chunkStructuralFiles(['a.js']), [['a.js']]);
  const files = Array.from({ length: MAX_STRUCTURAL_FILE_ARGS + 1 }, (_unused, index) => `f${index}.js`);
  const chunks = chunkStructuralFiles(files);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].length, MAX_STRUCTURAL_FILE_ARGS);
  assert.equal(chunks[1].length, 1);
  assert.ok(chunks.every((chunk) => chunk.length > 0));
  assert.deepEqual(chunks.flat(), files);
});

test('results without a stored run fails closed', async () => {
  resetTidyResultCache();
  const result = await executeTidyTool({ action: 'results' }, { cwd: process.cwd(), sessionId: 'tidy-results-empty' });
  assert.equal(result.isError, true);
  assert.match(parseResult(result).error, /no stored tidy results/);
});

test('results pages stored diagnostics without dropping counts', async () => {
  resetTidyResultCache();
  const cwd = process.cwd();
  const sessionId = 'tidy-results-page';
  rememberTidyRun(cwd, sessionId, {
    languages: [{ id: 'python', files: 12 }],
    languageSource: 'git',
    engines: [{ id: 'ruff', source: 'project-local', kind: ['lint'], languages: ['python'] }],
    results: [
      {
        id: 'ruff',
        source: 'project-local',
        filesChecked: 12,
        filesChanged: [],
        diagnostics: Array.from({ length: 55 }, (_unused, index) => ({
          file: `src/f${index}.py`,
          line: index + 1,
          col: 1,
          code: 'F401',
          message: 'imported but unused',
          severity: 'error',
        })),
      },
    ],
    structural: {
      adapter: 'graph-binary',
      packs: ['javascript/no-debugger'],
      matches: Array.from({ length: 30 }, (_unused, index) => ({
        file: `src/a${index}.js`,
        ruleId: 'no-debugger',
        message: 'debugger',
      })),
    },
    scope: ['src'],
  });
  const report = parseResult(await executeTidyTool({ action: 'results', offset: 20, limit: 10 }, { cwd, sessionId }));
  assert.equal(report.action, 'results');
  assert.equal(report.ok, true);
  assert.equal(report.results[0].diagnostics.length, 10);
  assert.equal(report.results[0].diagnostics[0].file, 'src/f20.py');
  assert.equal(report.results[0].diagnosticsCount, 55);
  assert.equal(report.results[0].more, 25);
  assert.equal(report.results[0].nextOffset, 30);
  assert.equal(report.structural.matches.length, 10);
  assert.equal(report.structural.matchesCount, 30);
  assert.equal(report.structural.matches[0].file, 'src/a20.js');
  assert.match(report.notes.join(' '), /were not re-run/);
  resetTidyResultCache();
});

test('a >200-file scoped check never walks cwd and results pages the stored matches', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'tidy-scope-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src', 'in'), { recursive: true });
  mkdirSync(join(root, 'src', 'out'), { recursive: true });
  mkdirSync(join(root, '.runtime'), { recursive: true });
  const count = MAX_STRUCTURAL_FILE_ARGS + 1;
  for (let index = 0; index < count; index += 1) {
    writeFileSync(join(root, 'src', 'in', `f${String(index).padStart(3, '0')}.js`), `export const n = ${index};\n`);
  }
  writeFileSync(join(root, 'src', 'out', 'leak.js'), 'export const leak = 1;\n');
  writeFileSync(join(root, '.runtime', 'scratch.kt'), 'fun x() {}\n');
  const fakeGraph = join(root, 'fake-graph.mjs');
  const logPath = join(root, 'fake-graph.log');
  writeFileSync(
    fakeGraph,
    `
    import { appendFileSync } from 'node:fs';
    process.stdin.resume();
    const args = process.argv.slice(2);
    const logPath = process.env.FAKE_GRAPH_LOG;
    const files = [];
    const idx = args.indexOf('--files');
    if (idx >= 0) {
      for (let i = idx + 1; i < args.length; i++) {
        if (String(args[i]).startsWith('--')) break;
        files.push(String(args[i]).replaceAll('\\\\', '/'));
      }
    }
    const unscoped = args.includes('--scan') && idx < 0;
    if (logPath) {
      appendFileSync(logPath, JSON.stringify({
        mode: args.includes('--scan') ? 'scan' : args.includes('--langs') ? 'langs' : 'other',
        files,
        unscoped,
      }) + '\\n');
    }
    if (args.includes('--langs')) {
      process.stdout.write(JSON.stringify({
        languages: [{ id: 'javascript', extensions: ['js', 'mjs', 'cjs', 'jsx'], scan: true, extract: true }],
      }));
      process.exit(0);
    }
    if (args.includes('--scan')) {
      const emitted = unscoped ? ['.runtime/scratch.kt', 'src/out/leak.js'] : files;
      for (const file of emitted) {
        process.stdout.write(JSON.stringify({
          file,
          lang: 'javascript',
          ruleId: 'no-debugger',
          severity: 'warning',
          message: 'debugger',
          range: { start: { line: 0, column: 0 }, end: { line: 0, column: 8 }, byteOffset: [0, 8] },
        }) + '\\n');
      }
      process.stdout.write(JSON.stringify({ summary: { files: emitted.length, matches: emitted.length, rules: 1 } }) + '\\n');
      process.exit(0);
    }
    process.exit(0);
    `
  );
  const windows = process.platform === 'win32';
  const wrapper = join(root, windows ? 'fake-graph.cmd' : 'fake-graph.sh');
  writeFileSync(
    wrapper,
    windows
      ? `@echo off\r\n"${process.execPath}" "${fakeGraph}" %*\r\n`
      : `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeGraph)} "$@"\n`,
    windows ? {} : { mode: 0o755 }
  );
  for (const args of [['init'], ['add', '.']]) {
    const git = await runProcess('git', args, { cwd: root, timeoutMs: 30_000 });
    if (git.code !== 0) {
      t.skip('git is unavailable in this environment');
      return;
    }
  }

  const childScript = join(root, 'probe-tidy.mjs');
  writeFileSync(
    childScript,
    `
    import { executeTidyTool } from ${JSON.stringify(new URL('./tool.mjs', import.meta.url).href)};
    const cwd = ${JSON.stringify(root)};
    async function run(args) {
      const result = await executeTidyTool(args, { cwd, sessionId: 'scope-batch' });
      return { isError: Boolean(result.isError), body: JSON.parse(result.content[0].text) };
    }
    const out = {
      big: await run({ action: 'check', paths: ['src/in'], engines: ['__none__'] }),
      page: await run({ action: 'results', offset: 20, limit: 10 }),
      empty: await run({ action: 'check', languages: ['python'], engines: ['__none__'] }),
    };
    process.stdout.write(JSON.stringify(out));
    `
  );
  const result = await runProcess(process.execPath, [childScript], {
    cwd: root,
    env: { ...process.env, MIXDOG_GRAPH_BIN: wrapper, FAKE_GRAPH_LOG: logPath },
    timeoutMs: 120_000,
  });
  assert.equal(result.code, 0, result.stderr.slice(0, 800));
  const out = JSON.parse(result.stdout);
  assert.equal(out.big.isError, false, JSON.stringify(out.big.body).slice(0, 400));
  assert.equal(out.big.body.structural.matchesCount, count);
  assert.equal(out.big.body.structural.matches.length, 20);
  assert.equal(out.big.body.structural.more, count - 20);
  assert.ok(out.big.body.structural.matches.every((match) => match.file.startsWith('src/in/')));
  assert.equal(
    out.big.body.structural.matches.some((match) => match.file.includes('.runtime') || match.file.includes('src/out/')),
    false
  );
  assert.equal(out.page.body.action, 'results');
  assert.equal(out.page.body.structural.matchesCount, count);
  assert.equal(out.page.body.structural.matches.length, 10);
  assert.equal(out.page.body.structural.matches[0].file, 'src/in/f020.js');
  assert.equal(out.empty.body.structural.matchesCount, 0);
  assert.equal(out.empty.body.ok, true);

  const log = readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const scans = log.filter((entry) => entry.mode === 'scan');
  assert.ok(scans.length >= 2, `expected batched scans, got ${scans.length}`);
  assert.ok(scans.every((entry) => entry.unscoped === false));
  assert.ok(scans.every((entry) => entry.files.length > 0 && entry.files.every((file) => file.startsWith('src/in/'))));
  const scanned = scans.flatMap((entry) => entry.files);
  assert.equal(scanned.length, count);
  assert.equal(scanned.includes('src/out/leak.js'), false);
  assert.equal(scanned.includes('.runtime/scratch.kt'), false);
});

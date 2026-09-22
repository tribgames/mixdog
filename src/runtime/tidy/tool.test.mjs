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
  const report = parseResult(await executeTidyTool({ action: 'scan', paths: ['.'] }, { cwd: root }));
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
  const report = parseResult(
    await executeTidyTool({ action: 'check', paths: ['.'], structural: false }, { cwd: root })
  );
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
  const report = parseResult(await executeTidyTool({ action: 'scan', paths: ['.'] }, { cwd: root }));
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
  const match = report.structural.matches.find((entry) => entry.rule === 'no-debugger');
  assert.ok(match, `expected a no-debugger match: ${JSON.stringify(report.structural).slice(0, 400)}`);
  assert.match(match.loc, /^src\/debug\.js:\d+:\d+$/);
  assert.equal(match.fix, true, 'the dry run reports fixability, not the write payload');
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
      const result = await executeTidyTool({ paths: ['src'], ...args }, { cwd });
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

test('scan, check and fix require an explicitly selected scope before doing work', async () => {
  for (const action of ['scan', 'check', 'fix']) {
    for (const paths of [undefined, [], ['  ']]) {
      const result = await executeTidyTool({ action, paths, apply: true });
      assert.equal(result.isError, true);
      assert.match(parseResult(result).error, /user-selected scope/);
    }
  }
});

test('a failed structural group prevents every structural write', async (t) => {
  const root = await gitProject(t);
  assert.ok(root);
  const sources = {
    'src/kept.js': '// Moved from previous.js.\nconst value = 1;\n',
    'src/kept.py': '# Moved from previous.py.\nvalue = 1\n',
  };
  for (const [file, source] of Object.entries(sources)) writeFileSync(join(root, file), source);
  const fake = join(root, 'failing-graph.mjs');
  writeFileSync(
    fake,
    `
    import { readFileSync } from 'node:fs';
    import { join } from 'node:path';
    process.stdin.resume();
    const args = process.argv.slice(2);
    if (args.includes('--langs')) {
      console.log(JSON.stringify({ languages: [
        { id: 'javascript', extensions: ['js'], scan: true },
        { id: 'python', extensions: ['py'], scan: true },
      ] }));
    } else if (args.includes('--scan')) {
      const index = args.indexOf('--files');
      const files = args.slice(index + 1).filter(arg => arg !== '--fix');
      for (const file of files) {
        const source = readFileSync(join(args[0], file), 'utf8');
        const end = source.indexOf('\\n');
        console.log(JSON.stringify({
          file, ruleId: 'no-history-comment', severity: 'warning',
          range: { byteOffset: [0, end] },
          fix: { byteOffset: [0, end], text: '' },
        }));
      }
      console.log(JSON.stringify({ summary: { matches: files.length, files: files.length } }));
      if (files.some(file => file.endsWith('.py'))) {
        process.stderr.write('scan interrupted');
        process.exitCode = 1;
      }
    }
  `
  );
  const windows = process.platform === 'win32';
  const wrapper = join(root, windows ? 'failing-graph.cmd' : 'failing-graph.sh');
  writeFileSync(
    wrapper,
    windows
      ? `@echo off\r\n"${process.execPath}" "${fake}" %*\r\n`
      : `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fake)} "$@"\n`,
    windows ? {} : { mode: 0o755 }
  );
  const child = join(root, 'probe-failure.mjs');
  writeFileSync(
    child,
    `
    import { executeTidyTool } from ${JSON.stringify(new URL('./tool.mjs', import.meta.url).href)};
    const result = await executeTidyTool({
      action: 'fix', apply: true, paths: ${JSON.stringify(Object.keys(sources))}, engines: ['__none__'],
    }, { cwd: ${JSON.stringify(root)} });
    console.log(JSON.stringify(result));
  `
  );
  const result = await runProcess(process.execPath, [child], {
    cwd: root,
    env: { ...process.env, MIXDOG_GRAPH_BIN: wrapper },
    timeoutMs: 30_000,
  });
  assert.equal(result.code, 0, result.stderr);
  const envelope = JSON.parse(result.stdout);
  const report = parseResult(envelope);
  assert.equal(envelope.isError, undefined);
  assert.equal(report.ok, true);
  assert.equal(report.status, 'partial');
  assert.equal(report.structural.matchesCount, 2);
  assert.deepEqual(report.structural.applied, []);
  assert.match(report.structural.errors[0].message, /scan interrupted/);
  assert.match(report.notes.join(' '), /python structural pass did not complete/);
  assert.match(report.notes.join(' '), /structural apply blocked for the entire run/);
  for (const [file, source] of Object.entries(sources)) assert.equal(readFileSync(join(root, file), 'utf8'), source);
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
  assert.equal(report.results[0].diagnostics[0].loc, 'src/f20.py:21:1');
  assert.equal(report.results[0].diagnosticsCount, 55);
  assert.equal(report.results[0].more, 25);
  assert.equal(report.results[0].nextOffset, 30);
  assert.equal(report.structural.matches.length, 10);
  assert.equal(report.structural.matchesCount, 30);
  assert.equal(report.structural.matches[0].loc, 'src/a20.js:0:0');
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
      empty: await run({ action: 'check', paths: ['src/in'], languages: ['python'], engines: ['__none__'] }),
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
  assert.ok(out.big.body.structural.matches.every((match) => match.loc.startsWith('src/in/')));
  assert.equal(
    out.big.body.structural.matches.some((match) => match.loc.includes('.runtime') || match.loc.includes('src/out/')),
    false
  );
  assert.equal(out.page.body.action, 'results');
  assert.equal(out.page.body.structural.matchesCount, count);
  assert.equal(out.page.body.structural.matches.length, 10);
  assert.equal(out.page.body.structural.matches[0].loc, 'src/in/f020.js:1:1');
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

/** A mixdog-graph stand-in that reports one match per scanned file. */
function matchEveryFileGraph(root) {
  const script = join(root, 'match-graph.mjs');
  writeFileSync(
    script,
    `
    process.stdin.resume();
    const args = process.argv.slice(2);
    if (args.includes('--langs')) {
      process.stdout.write(JSON.stringify({
        languages: [{ id: 'javascript', extensions: ['js', 'mjs'], scan: true, extract: true }],
      }));
      process.exit(0);
    }
    if (args.includes('--scan')) {
      const index = args.indexOf('--files');
      const files = index < 0 ? [] : args.slice(index + 1).filter((arg) => !String(arg).startsWith('--'));
      for (const file of files) {
        process.stdout.write(JSON.stringify({
          file,
          lang: 'javascript',
          ruleId: 'no-debugger',
          severity: 'warning',
          message: 'debugger',
          range: { start: { line: 1, column: 1 }, end: { line: 1, column: 9 }, byteOffset: [0, 8] },
        }) + '\\n');
      }
      process.stdout.write(JSON.stringify({ summary: { files: files.length, matches: files.length, rules: 1 } }) + '\\n');
      process.exit(0);
    }
    process.exit(0);
    `
  );
  const windows = process.platform === 'win32';
  const wrapper = join(root, windows ? 'match-graph.cmd' : 'match-graph.sh');
  writeFileSync(
    wrapper,
    windows
      ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
      : `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`,
    windows ? {} : { mode: 0o755 }
  );
  return wrapper;
}

test('fix separates findings in modified files from findings in files that are clean in the repository', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'tidy-worktree-tool-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'touched.js'), 'export const a = 1;\n');
  writeFileSync(join(root, 'src', 'untouched.js'), 'export const b = 2;\n');
  const commands = [
    ['init'],
    ['add', '.'],
    ['-c', 'user.email=tidy@example.invalid', '-c', 'user.name=Tidy', 'commit', '-m', 'init'],
  ];
  for (const args of commands) {
    const git = await runProcess('git', args, { cwd: root, timeoutMs: 30_000 });
    if (git.code !== 0) {
      t.skip('git is unavailable in this environment');
      return;
    }
  }
  // One file the caller is working on, one untracked file, one file that only a
  // directory scope drags in.
  writeFileSync(join(root, 'src', 'touched.js'), 'export const a = 11;\n');
  writeFileSync(join(root, 'src', 'fresh.js'), 'export const c = 3;\n');

  const childScript = join(root, 'probe-worktree.mjs');
  writeFileSync(
    childScript,
    `
    import { executeTidyTool } from ${JSON.stringify(new URL('./tool.mjs', import.meta.url).href)};
    const result = await executeTidyTool(
      { action: 'fix', paths: ['src'], engines: ['__none__'] },
      { cwd: ${JSON.stringify(root)} }
    );
    process.stdout.write(JSON.stringify({ isError: Boolean(result.isError), body: JSON.parse(result.content[0].text) }));
    `
  );
  const result = await runProcess(process.execPath, [childScript], {
    cwd: root,
    env: { ...process.env, MIXDOG_GRAPH_BIN: matchEveryFileGraph(root) },
    timeoutMs: 120_000,
  });
  assert.equal(result.code, 0, result.stderr.slice(0, 800));
  const { isError, body } = JSON.parse(result.stdout);

  assert.equal(isError, false, 'the split is a report, not a failure');
  assert.equal(body.ok, true);
  assert.equal(body.structural.matchesCount, 3);
  assert.deepEqual(body.workingTree.modified.files, ['src/fresh.js', 'src/touched.js']);
  assert.equal(body.workingTree.modified.fileCount, 2);
  assert.equal(body.workingTree.modified.findings, 2);
  assert.deepEqual(body.workingTree.clean.files, ['src/untouched.js']);
  assert.equal(body.workingTree.clean.fileCount, 1);
  assert.equal(body.workingTree.clean.findings, 1);
  assert.match(body.notes.join(' '), /workingTree\.clean: 1 file\(s\)/);
  assert.match(body.notes.join(' '), /apply:true writes them too/);
});

test('scan names a same-named binary the environment resolves but tidy does not run', async (t) => {
  const root = await gitProject(t);
  if (!root) {
    t.skip('git is unavailable in this environment');
    return;
  }
  const windows = process.platform === 'win32';
  const cache = join(root, 'npm-cache');
  const binDir = join(cache, '_npx', 'b040de3f3c289dd6', 'node_modules', '.bin');
  mkdirSync(binDir, { recursive: true });
  const shadowPath = join(binDir, windows ? 'biome.cmd' : 'biome');
  writeFileSync(
    shadowPath,
    windows ? '@echo off\r\necho biome 0.3.3\r\n' : '#!/bin/sh\necho "biome 0.3.3"\n',
    windows ? {} : { mode: 0o755 }
  );

  const childScript = join(root, 'probe-shadow.mjs');
  writeFileSync(
    childScript,
    `
    import { executeTidyTool } from ${JSON.stringify(new URL('./tool.mjs', import.meta.url).href)};
    const result = await executeTidyTool({ action: 'scan', paths: ['.'] }, { cwd: ${JSON.stringify(root)} });
    process.stdout.write(JSON.stringify({ isError: Boolean(result.isError), body: JSON.parse(result.content[0].text) }));
    `
  );
  const result = await runProcess(process.execPath, [childScript], {
    cwd: root,
    env: { ...process.env, npm_config_cache: cache },
    timeoutMs: 120_000,
  });
  assert.equal(result.code, 0, result.stderr.slice(0, 800));
  const { isError, body } = JSON.parse(result.stdout);

  assert.equal(isError, false, 'a shadow is a report, not an error');
  assert.equal(body.ok, true);
  const shadow = (body.shadows || []).find((row) => row.id === 'biome' && row.via === 'npx-cache');
  assert.ok(shadow, `expected a biome shadow: ${JSON.stringify(body.shadows)}`);
  assert.equal(shadow.shadow.path, shadowPath);
  assert.equal(shadow.shadow.version, '0.3.3');
  assert.equal(typeof shadow.engine.source, 'string');
  assert.match(body.notes.join(' '), /not the biome tidy uses/);
});

test('results filters cached rules and directory prefixes before paging without mutating the cache', async () => {
  const cwd = process.cwd();
  const sessionId = 'tidy-filtered-results';
  const files = [
    'src/runtime/a.js',
    'src/runtime/b.js',
    'src/runtime/c.js',
    'src/runtime-more/no.js',
    'apps/desktop/d.js',
  ];
  const matches = files.map((file, index) => ({
    file,
    ruleId: index === 1 ? 'other' : 'no-debugger',
    severity: 'warning',
    message: 'debugger',
    range: { start: { line: 1, column: 2 }, end: { line: 1, column: 10 }, byteOffset: [1, 9] },
    fix: { byteOffset: [1, 9], text: '' },
  }));
  const diagnostics = matches.map(({ file, ruleId }) => ({
    file,
    code: ruleId,
    line: 1,
    col: 2,
    severity: 'warning',
    message: 'debugger',
    fixable: false,
  }));
  const error = { language: 'kotlin', kind: 'rules', message: 'invalid rule' };
  const cached = {
    scope: ['.'],
    languages: [{ id: 'javascript', files: 5 }],
    languageSource: 'git',
    engines: [{ id: 'eslint', kind: ['lint'] }],
    policy: { downloads: 'ask' },
    results: [
      {
        id: 'eslint',
        filesChecked: 5,
        diagnostics,
        filesChanged: files,
        counts: { diagnostics: 5, bySeverity: { warning: 5 } },
      },
    ],
    structural: { matches, error, ruleErrors: [error] },
  };
  const original = structuredClone(cached);
  rememberTidyRun(cwd, sessionId, cached);
  const page = await executeTidyTool(
    {
      action: 'results',
      paths: [join(cwd, 'src/runtime')],
      rules: ['no-debugger'],
      limit: 1,
    },
    { cwd, sessionId }
  );
  const report = parseResult(page);
  assert.equal(page.isError, undefined);
  assert.equal(report.ok, true);
  assert.equal(report.status, 'partial');
  assert.deepEqual(report.structural.errors, [error]);
  assert.deepEqual(report.scope, ['.'], 'filters do not replace the original scope');
  for (const key of ['languages', 'languageSource', 'engines', 'missing', 'policy']) {
    assert.equal(Object.hasOwn(report, key), false);
  }
  assert.equal(report.results[0].diagnosticsCount, 2);
  assert.equal(report.results[0].more, 1);
  assert.equal(report.results[0].nextOffset, 1);
  assert.equal(report.results[0].diagnostics[0].loc, 'src/runtime/a.js:1:2');
  assert.equal(report.counts.diagnostics, 5);
  assert.equal(report.results[0].filesChangedCount, 3);
  assert.deepEqual(report.results[0].byRule, { 'no-debugger': { count: 2, severity: 'warning', fixable: 0 } });
  assert.deepEqual(report.results[0].byDir, { 'src/runtime': 2 });
  assert.equal(report.structural.matchesCount, 2);
  assert.equal(report.structural.more, 1);
  assert.equal(report.structural.nextOffset, 1);
  assert.deepEqual(report.structural.byRule, { 'no-debugger': { count: 2, severity: 'warning', fixable: 2 } });
  assert.deepEqual(report.structural.byDir, { 'src/runtime': 2 });

  const last = parseResult(
    await executeTidyTool(
      {
        action: 'results',
        paths: ['src\\runtime\\'],
        rules: ['no-debugger'],
        offset: 1,
        limit: 1,
      },
      { cwd, sessionId }
    )
  );
  assert.equal(last.results[0].diagnostics[0].loc, 'src/runtime/c.js:1:2');
  assert.equal(last.results[0].more, 0);
  assert.equal(last.results[0].nextOffset, undefined);
  assert.equal(last.structural.matches[0].loc, 'src/runtime/c.js:1:2');
  assert.equal(last.structural.more, 0);
  assert.equal(last.structural.nextOffset, undefined);

  const cases = [
    { args: { rules: ['other'] }, count: 1 },
    { args: { paths: ['src/runtime'] }, count: 3 },
    { args: { rules: ['other', 'no-debugger'], paths: ['./src/runtime/', 'apps/desktop'] }, count: 4 },
    { args: { paths: ['src/runtime/a.js'] }, count: 1 },
    { args: { rules: ['missing'] }, count: 0 },
    { args: { paths: ['.'] }, count: 5 },
    { args: {}, count: 5 },
  ];
  for (const { args, count } of cases) {
    const selected = parseResult(await executeTidyTool({ action: 'results', ...args }, { cwd, sessionId }));
    assert.equal(selected.results[0].diagnosticsCount, count);
    assert.equal(selected.structural.matchesCount, count);
  }
  assert.deepEqual(cached, original, 'projection and filtering must preserve full write payloads');
  const escaping = await executeTidyTool({ action: 'results', paths: ['../outside'] }, { cwd, sessionId });
  assert.equal(escaping.isError, true);
});

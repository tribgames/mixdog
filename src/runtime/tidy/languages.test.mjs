import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AUX_LANGUAGE_EXTENSIONS,
  CODE_LANGUAGE_EXTENSIONS,
  detectLanguages,
  filesForLanguages,
  languageForPath,
  parseGraphLangs,
  withinScope,
} from './languages.mjs';
import { runProcess } from './process.mjs';

test('the static registry agrees with the graph binary capability table', async (t) => {
  // Contract against the shipped binary, not against Rust source text: the ids
  // tidy reports are the ids the structural scan is addressed with, so every
  // code extension here must resolve to the same language in `--langs`. The
  // binary is allowed to know more (extensions and languages); tidy is not
  // allowed to disagree. Aux extensions (jsonc, less, ps1, toml) are
  // formatter-only and simply absent from the table.
  const release = fileURLToPath(
    new URL(
      `../../../native/mixdog-graph/target/release/mixdog-graph${process.platform === 'win32' ? '.exe' : ''}`,
      import.meta.url
    )
  );
  if (!existsSync(release)) {
    t.skip('no local mixdog-graph release build to check the registry against');
    return;
  }
  const result = await runProcess(release, ['.', '--langs'], { cwd: process.cwd(), timeoutMs: 30_000 });
  const table = parseGraphLangs(result.stdout);
  if (!table) {
    t.skip('the local mixdog-graph build predates the --langs capability table');
    return;
  }
  for (const [language, extensions] of Object.entries(CODE_LANGUAGE_EXTENSIONS)) {
    for (const ext of extensions) {
      assert.equal(
        table.extensions.get(ext.toLowerCase()),
        language,
        `.${ext} is ${language} here but ${table.extensions.get(ext.toLowerCase()) || 'unknown'} to the graph binary`
      );
    }
  }
  for (const [language, extensions] of Object.entries(AUX_LANGUAGE_EXTENSIONS)) {
    for (const ext of extensions) {
      const fromGraph = table.extensions.get(ext.toLowerCase());
      if (fromGraph) assert.equal(fromGraph, language, `.${ext} disagrees with the graph binary`);
    }
  }
});

test('languageForPath routes code and formatter-only extensions', () => {
  assert.equal(languageForPath('src/a.mjs'), 'javascript');
  assert.equal(languageForPath('src/a.tsx'), 'typescript');
  assert.equal(languageForPath('build.zig'), 'zig');
  assert.equal(languageForPath('deploy.PS1'), 'powershell');
  assert.equal(languageForPath('data.json'), 'json');
  // Detected without an engine: v1 ships no formatter for these.
  assert.equal(languageForPath('contracts/Token.sol'), 'solidity');
  assert.equal(languageForPath('src/Main.hs'), 'haskell');
  assert.equal(languageForPath('infra/main.tf'), 'hcl');
  assert.equal(languageForPath('LICENSE'), '');
});

test('withinScope keeps directory prefixes and rejects siblings', () => {
  assert.equal(withinScope('src/runtime/a.mjs', []), true);
  assert.equal(withinScope('src/runtime/a.mjs', ['src/runtime']), true);
  assert.equal(withinScope('src/runtime/a.mjs', ['src/runtime/a.mjs']), true);
  assert.equal(withinScope('src/runtimes/a.mjs', ['src/runtime']), false);
  assert.equal(withinScope('docs/a.md', ['src']), false);
});

test('filesForLanguages scopes a file list to the engine languages', () => {
  const files = ['a.mjs', 'b.py', 'c.rs', 'd.md'];
  assert.deepEqual(filesForLanguages(files, ['python', 'rust']), ['b.py', 'c.rs']);
  assert.deepEqual(filesForLanguages(files, []), []);
});

test('engine scoping classifies files with the same table detection used', () => {
  const table = parseGraphLangs('{"languages":[{"id":"python","extensions":["py","bzl"],"scan":true}]}');
  const files = ['BUILD.bzl', 'main.py', 'a.rs'];
  // Detection counts BUILD.bzl as python, so ruff has to be handed it too.
  assert.deepEqual(filesForLanguages(files, ['python'], table.extensions), ['BUILD.bzl', 'main.py']);
  assert.deepEqual(filesForLanguages(files, ['python']), ['main.py']);
});

test('parseGraphLangs reads the binary capability table, first extension wins', () => {
  // Shape observed from `mixdog-graph <cwd> --langs`.
  const table = parseGraphLangs(
    JSON.stringify({
      languages: [
        { id: 'typescript', extensions: ['ts', 'tsx', 'mts', 'cts'], scan: true, extract: true },
        { id: 'python', extensions: ['py', 'pyi', 'bzl'], scan: true, extract: true },
        { id: 'tsx', extensions: ['tsx'], scan: true, extract: false },
        { id: 'yaml', extensions: ['yaml', 'yml'], scan: false, extract: false },
      ],
    })
  );
  assert.equal(table.extensions.get('tsx'), 'typescript', 'the first declaration owns the extension');
  assert.equal(table.extensions.get('bzl'), 'python');
  assert.deepEqual(table.ids, ['typescript', 'python', 'tsx', 'yaml']);
  assert.equal(table.scannable.includes('yaml'), false);
  assert.equal(parseGraphLangs('[{"id":"rust","extensions":["rs"]}]').extensions.get('rs'), 'rust');
  assert.equal(parseGraphLangs('not json at all'), null);
  assert.equal(parseGraphLangs('{"languages":[]}'), null);
  assert.equal(parseGraphLangs(''), null);
});

test('the graph capability table wins over the static registry when present', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'tidy-detect-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'BUILD.bzl'), 'load("x")\n');
  writeFileSync(join(root, 'main.py'), 'x = 1\n');
  for (const args of [['init'], ['add', '.']]) {
    const result = await runProcess('git', args, { cwd: root, timeoutMs: 30_000 });
    if (result.code !== 0) {
      t.skip('git is unavailable in this environment');
      return;
    }
  }
  // .bzl is python to the graph binary; the static registry does not know it.
  const withoutGraph = await detectLanguages({ cwd: root });
  assert.deepEqual(withoutGraph.languages, [{ id: 'python', files: 1 }]);
  assert.equal(withoutGraph.source, 'git');

  const withGraph = await detectLanguages({
    cwd: root,
    graphLangs: parseGraphLangs('{"languages":[{"id":"python","extensions":["py","bzl"],"scan":true}]}'),
  });
  assert.deepEqual(withGraph.languages, [{ id: 'python', files: 2 }]);
  assert.equal(withGraph.source, 'graph-binary');
});

test('explicit scopes include new files without staging and exclude ignored files and siblings', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'tidy-new-files-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, '.gitignore'), 'src/ignored.js\n');
  writeFileSync(join(root, 'src', 'tracked.js'), 'export const old = 1;\n');
  for (const args of [['init'], ['add', '.']]) {
    const result = await runProcess('git', args, { cwd: root, timeoutMs: 30_000 });
    assert.equal(result.code, 0, result.stderr);
  }
  writeFileSync(join(root, 'src', 'new.js'), 'export const fresh = 2;\n');
  writeFileSync(join(root, 'src', 'literal[1].js'), 'export const literal = 3;\n');
  writeFileSync(join(root, 'src', 'ignored.js'), 'export const ignored = 4;\n');
  writeFileSync(join(root, 'outside.js'), 'export const outside = 5;\n');

  const directory = await detectLanguages({ cwd: root, paths: ['src'] });
  assert.deepEqual(directory.files.sort(), ['src/literal[1].js', 'src/new.js', 'src/tracked.js']);
  assert.deepEqual(directory.languages, [{ id: 'javascript', files: 3 }]);
  const explicit = await detectLanguages({ cwd: root, paths: ['src/literal[1].js'] });
  assert.deepEqual(explicit.files, ['src/literal[1].js']);
  const status = await runProcess('git', ['status', '--porcelain', '--', 'src/new.js'], { cwd: root });
  assert.equal(status.stdout.trim(), '?? src/new.js');
});

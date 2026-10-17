// Ruby, PHP, .NET, Elixir and Dart/Flutter against real git with a fake tool
// on PATH: detection from the committed files, the install command, and a
// skip with a note when the tool is missing.
import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { which } from '../../tidy/process.mjs';
import { planDependencySetup } from './dependencies.mjs';
import { samePath } from './paths.mjs';
import { cleanupTempDirs, commitFile, makeRepo, tempDir, useTempDataDir } from './test-support.mjs';

after(() => cleanupTempDirs());
beforeEach(useTempDataDir);

/** A PATH holding fake `names` (no-op tools). */
function fakeTools(names) {
  const bin = tempDir('mixdog-fake-tools-');
  for (const name of names) {
    if (process.platform === 'win32') {
      writeFileSync(join(bin, `${name}.cmd`), '@exit /b 0\r\n');
    } else {
      writeFileSync(join(bin, name), '#!/bin/sh\nexit 0\n');
      chmodSync(join(bin, name), 0o755);
    }
  }
  const env = { ...process.env, PATH: bin, Path: bin };
  return { env, path: (name) => which(name, { env }) };
}

const EMPTY_PATH = () => ({ ...process.env, PATH: tempDir('mixdog-empty-path-'), Path: '' });

// [case, committed files, tool, expected arguments]
const CASES = [
  ['ruby', { Gemfile: 'source "x"\n', 'Gemfile.lock': 'GEM\n' }, 'bundle', 'install --frozen'],
  ['php', { 'composer.json': '{}\n', 'composer.lock': '{}\n' }, 'composer', 'install --no-interaction'],
  [
    'dotnet lockfile',
    { 'App.csproj': '<Project/>\n', 'packages.lock.json': '{}\n' },
    'dotnet',
    'restore --locked-mode',
  ],
  ['dotnet csproj', { 'App.csproj': '<Project/>\n' }, 'dotnet', 'restore'],
  ['elixir', { 'mix.exs': 'x\n', 'mix.lock': '%{}\n' }, 'mix', 'deps.get --check-locked'],
  [
    'dart',
    { 'pubspec.yaml': 'name: a\ndependencies:\n  http: ^1.0.0\n', 'pubspec.lock': 'packages: {}\n' },
    'dart',
    'pub get --enforce-lockfile',
  ],
  [
    'flutter',
    { 'pubspec.yaml': 'name: a\ndependencies:\n  flutter:\n    sdk: flutter\n', 'pubspec.lock': 'packages: {}\n' },
    'flutter',
    'pub get --enforce-lockfile',
  ],
];

for (const [name, files, tool, args] of CASES) {
  test(`${name}: detected from the committed files; installed with the tool on PATH, skipped without it`, async () => {
    const repo = makeRepo();
    for (const [rel, content] of Object.entries(files)) commitFile(repo, rel, content);
    const tools = fakeTools([tool]);
    const plan = await planDependencySetup({ worktreeDir: repo, env: tools.env });
    assert.equal(plan.commands.length, 1, JSON.stringify(plan));
    assert.equal(plan.commands[0].command, `"${tools.path(tool)}" ${args}`);
    assert.ok(samePath(plan.commands[0].cwd, repo));
    assert.deepEqual(plan.notes, []);

    const missing = await planDependencySetup({ worktreeDir: repo, env: EMPTY_PATH() });
    assert.deepEqual(missing.commands, []);
    assert.equal(
      missing.notes[0],
      `${tool} is not on PATH; project root was not prepared (run \`${tool} ${args}\` there if tests need it).`
    );
  });
}

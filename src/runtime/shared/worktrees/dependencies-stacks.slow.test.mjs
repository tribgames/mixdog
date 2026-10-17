// Every supported stack against real git with fake tools on PATH: the
// committed lockfile or manifest selects the install, a tool missing from
// PATH is a skip with a note, nested folders count only when the main
// checkout installed them, and only node_modules is ever linked.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { which } from '../../tidy/process.mjs';
import { planDependencySetup } from './dependencies.mjs';
import { configureWorktreeManager, removeManagedWorktree } from './manager.mjs';
import { samePath } from './paths.mjs';
import { runWorktreeSetupCommands } from './setup-commands.mjs';
import {
  cleanupTempDirs,
  commitFile,
  createTestWorktree,
  makeRepo,
  tempDir,
  useTempDataDir,
  writeFile,
} from './test-support.mjs';

after(() => cleanupTempDirs());
beforeEach(useTempDataDir);

const PYTHON = process.platform === 'win32' ? 'py' : 'python3';
const VENV_PYTHON = process.platform === 'win32' ? '.venv\\Scripts\\python.exe' : '.venv/bin/python';

/** The environment variables a fake tool reports. */
const LOGGED_ENV = [
  'VIRTUAL_ENV',
  'CONDA_PREFIX',
  'UV_PROJECT_ENVIRONMENT',
  'POETRY_VIRTUALENVS_IN_PROJECT',
  'PIPENV_VENV_IN_PROJECT',
];

/** A PATH holding fake `names` that append `{ tool, cwd, args, env }` to the returned log. */
function fakeTools(names) {
  const bin = tempDir('mixdog-fake-tools-');
  const log = join(bin, 'calls.jsonl');
  const script = join(bin, 'tool.cjs');
  writeFileSync(
    script,
    `const env = Object.fromEntries(${JSON.stringify(LOGGED_ENV)}.filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]));\n` +
      `require('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({ tool: process.argv[2], cwd: process.cwd(), args: process.argv.slice(3), env }) + '\\n');\n`
  );
  for (const name of names) {
    if (process.platform === 'win32') {
      writeFileSync(join(bin, `${name}.cmd`), `@"${process.execPath}" "${script}" ${name} %*\r\n`);
    } else {
      writeFileSync(join(bin, name), `#!/bin/sh\nexec "${process.execPath}" "${script}" ${name} "$@"\n`);
      chmodSync(join(bin, name), 0o755);
    }
  }
  const env = { ...process.env, PATH: bin, Path: bin };
  const calls = () =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  return { env, calls, path: (name) => which(name, { env }) };
}

const EMPTY_PATH = () => ({ ...process.env, PATH: tempDir('mixdog-empty-path-'), Path: '' });

function repoWith(files) {
  const repo = makeRepo();
  for (const [rel, content] of Object.entries(files)) commitFile(repo, rel, content);
  return repo;
}

// [case, committed files, tool, expected arguments]
const STACKS = [
  ['uv', { 'pyproject.toml': '[project]\n', 'uv.lock': 'version = 1\n' }, 'uv', 'sync --frozen'],
  ['poetry', { 'pyproject.toml': '[tool.poetry]\n', 'poetry.lock': '# lock\n' }, 'poetry', 'install --no-root'],
  ['pipenv', { Pipfile: '[packages]\n', 'Pipfile.lock': '{}\n' }, 'pipenv', 'sync'],
  [
    'pip requirements',
    { 'requirements-dev.txt': 'pytest\n', 'requirements.txt': 'requests\n' },
    PYTHON,
    '-m venv .venv',
  ],
];

for (const [name, files, tool, args] of STACKS) {
  test(`${name}: detected from the committed files; installed with the tool on PATH, skipped without it`, async () => {
    const repo = repoWith(files);
    const tools = fakeTools([tool]);
    const plan = await planDependencySetup({ worktreeDir: repo, env: tools.env });
    const pip = name === 'pip requirements';
    // The virtualenv and the pip install are separate steps.
    assert.equal(plan.commands.length, pip ? 2 : 1, JSON.stringify(plan));
    assert.equal(plan.commands[0].command, `"${tools.path(tool)}" ${args}`);
    assert.ok(samePath(plan.commands[0].cwd, repo));
    if (pip) {
      assert.deepEqual(plan.commands[1].args, [
        '-m',
        'pip',
        'install',
        '-r',
        'requirements.txt',
        '-r',
        'requirements-dev.txt',
      ]);
      assert.ok(samePath(plan.commands[1].file, join(repo, VENV_PYTHON)));
    }
    assert.deepEqual(plan.notes, []);

    const missing = await planDependencySetup({ worktreeDir: repo, env: EMPTY_PATH() });
    assert.deepEqual(missing.commands, []);
    assert.equal(missing.notes.length, 1);
    assert.ok(
      missing.notes[0].startsWith(`${tool} is not on PATH; project root was not prepared (run \`${tool} ${args}`),
      missing.notes[0]
    );
  });
}

test('requirements file names with shell metacharacters are passed as literal arguments', async () => {
  const name = 'requirements;touch pwned $(id) `id`.txt';
  const repo = repoWith({ [name]: 'requests\n' });
  const tools = fakeTools([PYTHON]);
  const plan = await planDependencySetup({ worktreeDir: repo, env: tools.env });
  assert.equal(plan.commands.length, 2, JSON.stringify(plan));
  assert.deepEqual(plan.commands[1].args, ['-m', 'pip', 'install', '-r', name]);
  // The pip step's arguments, run for real by node in place of the venv python: verbatim, no shell.
  const probe = 'console.log(JSON.stringify(process.argv.slice(1)))';
  const step = { ...plan.commands[1], file: process.execPath, args: ['-e', probe, '--', ...plan.commands[1].args] };
  const report = await runWorktreeSetupCommands({ commands: [step] });
  assert.equal(report.status, 'completed', JSON.stringify(report));
  assert.deepEqual(JSON.parse(report.steps[0].output), plan.commands[1].args);
  assert.equal(existsSync(join(repo, 'pwned')), false);
});

test('Python installs never reuse an activated environment; poetry and pipenv build the project .venv', async () => {
  const active = tempDir('mixdog-active-venv-');
  const saved = Object.fromEntries(LOGGED_ENV.map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    VIRTUAL_ENV: active,
    CONDA_PREFIX: active,
    UV_PROJECT_ENVIRONMENT: active,
    POETRY_VIRTUALENVS_IN_PROJECT: 'false',
    PIPENV_VENV_IN_PROJECT: '0',
  });
  try {
    for (const [name, files, tool] of STACKS) {
      const repo = repoWith(files);
      const tools = fakeTools([tool]);
      const plan = await planDependencySetup({ worktreeDir: repo, env: tools.env });
      await runWorktreeSetupCommands({ commands: plan.commands });
      const [call] = tools.calls();
      assert.deepEqual(call.env, { POETRY_VIRTUALENVS_IN_PROJECT: 'true', PIPENV_VENV_IN_PROJECT: '1' }, name);
    }
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('a .venv that is a link does not count as prepared and is never installed through', async () => {
  const repo = repoWith({ 'pyproject.toml': '[project]\n', 'uv.lock': 'version = 1\n' });
  const elsewhere = tempDir('mixdog-other-venv-');
  symlinkSync(elsewhere, join(repo, '.venv'), process.platform === 'win32' ? 'junction' : 'dir');
  const tools = fakeTools(['uv']);
  const plan = await planDependencySetup({ worktreeDir: repo, env: tools.env });
  assert.deepEqual(plan.commands, []);
  assert.deepEqual(plan.notes, [
    '.venv in project root is a link, not an environment of its own; project root was not prepared (replace it with `uv sync --frozen` there if tests need it).',
  ]);
});

test('Java, Rust and Go need nothing up front: no install, no tool lookup', async () => {
  const repo = repoWith({
    'pom.xml': '<project/>\n',
    'build.gradle': '\n',
    'Cargo.toml': '[package]\n',
    'Cargo.lock': '\n',
    'go.mod': 'module a\n',
    'go.sum': '\n',
  });
  const plan = await planDependencySetup({ worktreeDir: repo, env: EMPTY_PATH() });
  assert.deepEqual(plan, { commands: [], notes: ['No lockfile or dependency manifest found; nothing was installed.'] });
});

test('a nested Python project installed in main is admitted and installed in place; a fixture is not', async () => {
  const repo = repoWith({
    'services/api/pyproject.toml': '[project]\n',
    'services/api/uv.lock': 'version = 1\n',
    'tests/fixtures/py/requirements.txt': 'x\n',
  });
  // Installed in the main checkout: services/api (.venv); the fixture never was.
  writeFile(repo, 'services/api/.venv/pyvenv.cfg', 'home = x\n');
  const tools = fakeTools(['uv', PYTHON]);
  const { entry } = await withManager(() => createTestWorktree(repo));
  const plan = await planDependencySetup({ worktreeDir: entry.path, mainDir: repo, env: tools.env });
  assert.deepEqual(
    plan.commands.map((command) => [command.label, command.command]),
    [['uv (services/api)', `"${tools.path('uv')}" sync --frozen`]]
  );
  // A virtualenv is never linked.
  assert.equal(existsSync(join(entry.path, 'services', 'api', '.venv')), false);
  const report = await runWorktreeSetupCommands({ commands: plan.commands });
  assert.equal(report.status, 'completed');
  const calls = tools.calls();
  assert.deepEqual(
    calls.map((call) => [call.tool, call.args]),
    [['uv', ['sync', '--frozen']]]
  );
  assert.ok(samePath(calls[0].cwd, join(entry.path, 'services', 'api')), 'run in the worktree folder');
});

test('in a mixed repository only node_modules is linked; removal leaves the main checkout intact', async () => {
  const lock = '{"lockfileVersion":3}\n';
  const repo = repoWith({
    '.gitignore': 'node_modules\n.venv\n',
    'package.json': '{"name":"app"}\n',
    'package-lock.json': lock,
    'pyproject.toml': '[project]\n',
    'uv.lock': 'version = 1\n',
  });
  writeFile(repo, 'node_modules/dep/index.js', 'module.exports = 1;\n');
  writeFile(repo, '.venv/pyvenv.cfg', 'home = x\n');
  const tools = fakeTools(['npm', 'uv']);
  await withManager(async () => {
    const { entry, sessionId } = await createTestWorktree(repo);
    assert.equal(lstatSync(join(entry.path, 'node_modules')).isSymbolicLink(), true);
    assert.equal(existsSync(join(entry.path, '.venv')), false, 'a venv is never linked');
    const plan = await planDependencySetup({ worktreeDir: entry.path, mainDir: repo, env: tools.env });
    assert.deepEqual(
      plan.commands.map((command) => command.label),
      ['uv (project root)']
    );
    assert.deepEqual(plan.notes, ['Linked node_modules from the main checkout: project root.']);
    const removed = await removeManagedWorktree({ entryId: entry.id, sessionId, safeOnly: true });
    assert.equal(removed.removed, true, JSON.stringify(removed));
    assert.equal(readFileSync(join(repo, 'node_modules', 'dep', 'index.js'), 'utf8'), 'module.exports = 1;\n');
    assert.equal(lstatSync(join(repo, 'node_modules')).isSymbolicLink(), false);
  });
});

async function withManager(run) {
  const restore = configureWorktreeManager({ settings: {}, freeBytes: async () => Number.MAX_SAFE_INTEGER });
  try {
    return await run();
  } finally {
    restore();
  }
}

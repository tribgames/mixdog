// A new managed worktree starts with the main checkout's local env files:
// every untracked `.env` / `.env.*` file, ignored or not, root and nested, is
// copied (never linked) to the same path; nothing is overwritten, nothing
// inside node_modules comes along, and .worktreeinclude still applies on top.
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { untrackedEnvFiles } from './include.mjs';
import { configureWorktreeManager } from './manager.mjs';
import {
  cleanupTempDirs,
  commitFile,
  createTestWorktree,
  git,
  makeRepo,
  useTempDataDir,
  writeFile,
} from './test-support.mjs';

after(() => cleanupTempDirs());
beforeEach(useTempDataDir);

async function withManager(run) {
  const restore = configureWorktreeManager({ settings: {}, freeBytes: async () => Number.MAX_SAFE_INTEGER });
  try {
    return await run();
  } finally {
    restore();
  }
}

const read = (root, rel) => readFileSync(join(root, ...rel.split('/')), 'utf8');

test('untracked env files are copied at the same paths, root and nested, ignored or not; node_modules stays', async () => {
  const repo = makeRepo();
  commitFile(repo, '.gitignore', '.env\n.env.*\n!.env.example\nnode_modules\n');
  commitFile(repo, '.env.example', 'TRACKED=1\n');
  writeFile(repo, '.env', 'ROOT=1\n');
  writeFile(repo, 'apps/web/.env.local', 'WEB=1\n');
  writeFile(repo, 'services/api/.env.test', 'API=1\n');
  writeFile(repo, 'node_modules/pkg/.env', 'DEP=1\n');
  // Not an env file name: never copied.
  writeFile(repo, 'docs/.envrc', 'export X=1\n');
  // Untracked but not ignored: copied all the same.
  commitFile(repo, '.gitignore', '.env\n.env.*\n!.env.example\n!docs/.env.draft\nnode_modules\n');
  writeFile(repo, 'docs/.env.draft', 'DRAFT=1\n');
  const { entry } = await withManager(() => createTestWorktree(repo));
  for (const rel of ['.env', 'apps/web/.env.local', 'services/api/.env.test', 'docs/.env.draft']) {
    assert.equal(read(entry.path, rel), read(repo, rel), `${rel} copied`);
    assert.equal(lstatSync(join(entry.path, ...rel.split('/'))).isSymbolicLink(), false, `${rel} is a copy`);
  }
  assert.equal(read(entry.path, '.env.example'), 'TRACKED=1\n', 'the tracked file is the checkout’s');
  assert.equal(existsSync(join(entry.path, 'docs', '.envrc')), false);
  assert.equal(existsSync(join(entry.path, 'node_modules')), false, 'nothing from inside node_modules');
  const copied = entry.prepared.copied.sort();
  assert.deepEqual(copied, ['.env', 'apps/web/.env.local', 'docs/.env.draft', 'services/api/.env.test']);
});

test('every untracked env file is listed, with no match cap', async () => {
  const repo = makeRepo();
  const count = 2_050;
  for (let index = 0; index < count; index += 1) {
    mkdirSync(join(repo, 'pkgs', `p${index}`), { recursive: true });
    writeFileSync(join(repo, 'pkgs', `p${index}`, '.env'), 'X=1\n');
  }
  const files = await untrackedEnvFiles(repo);
  assert.equal(files.length, count);
});

test('an env file the new checkout already has is never overwritten', async () => {
  const repo = makeRepo();
  commitFile(repo, '.gitignore', '.env.*\n');
  // The base branch tracks .env.test; the main checkout (on another branch) has its own, ignored.
  git(repo, 'checkout', '-q', '-b', 'feature');
  writeFile(repo, '.env.test', 'FROM_BRANCH=1\n');
  git(repo, 'add', '-f', '.env.test');
  git(repo, 'commit', '-q', '-m', 'tracked env');
  git(repo, 'checkout', '-q', '-');
  writeFile(repo, '.env.test', 'LOCAL=1\n');
  const { entry } = await withManager(() => createTestWorktree(repo, { baseBranch: 'feature' }));
  assert.equal(read(entry.path, '.env.test'), 'FROM_BRANCH=1\n');
  assert.equal(read(repo, '.env.test'), 'LOCAL=1\n');
  assert.ok(entry.warnings.includes('include-exists:.env.test'), JSON.stringify(entry.warnings));
});

test('a `!` exclusion in .worktreeinclude keeps an env file out of the automatic copy', async () => {
  const repo = makeRepo();
  commitFile(repo, '.gitignore', '.env\n.env.*\n');
  commitFile(repo, '.worktreeinclude', '!.env.example\n!apps/web/.env.local\n');
  writeFile(repo, '.env', 'ROOT=1\n');
  writeFile(repo, '.env.example', 'SECRET=\n');
  writeFile(repo, 'apps/web/.env.local', 'WEB=1\n');
  writeFile(repo, 'apps/web/.env.test', 'TEST=1\n');
  const { entry } = await withManager(() => createTestWorktree(repo));
  assert.equal(existsSync(join(entry.path, '.env.example')), false, 'explicitly excluded');
  assert.equal(existsSync(join(entry.path, 'apps', 'web', '.env.local')), false, 'explicitly excluded, nested');
  assert.equal(read(entry.path, '.env'), 'ROOT=1\n');
  assert.equal(read(entry.path, 'apps/web/.env.test'), 'TEST=1\n');
  assert.deepEqual(entry.prepared.copied.sort(), ['.env', 'apps/web/.env.test']);
});

test('.worktreeinclude still applies on top: an explicit entry wins over the automatic copy', async () => {
  const repo = makeRepo();
  commitFile(repo, '.gitignore', '.env\nsecrets/\n');
  commitFile(repo, '.worktreeinclude', 'copy secrets\n');
  writeFile(repo, '.env', 'ROOT=1\n');
  writeFile(repo, 'secrets/key.pem', 'KEY\n');
  writeFile(repo, 'secrets/.env', 'SECRET=1\n');
  const { entry } = await withManager(() => createTestWorktree(repo));
  assert.equal(read(entry.path, '.env'), 'ROOT=1\n');
  assert.equal(read(entry.path, 'secrets/key.pem'), 'KEY\n');
  assert.equal(read(entry.path, 'secrets/.env'), 'SECRET=1\n');
  assert.deepEqual(entry.prepared.copied.sort(), ['.env', 'secrets']);
  assert.deepEqual(
    entry.warnings.filter((warning) => warning.startsWith('include-')),
    [],
    'nothing planned twice'
  );
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { effectiveInstructionFilesMode, loadInstructionFilesContext } from './instruction-files.mjs';

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-instruction-files-'));
  const homeDir = join(root, 'home');
  const cwd = join(root, 'project');
  const paths = {
    globalAgents: join(homeDir, '.codex', 'AGENTS.md'),
    globalClaude: join(homeDir, '.claude', 'CLAUDE.md'),
    projectAgents: join(cwd, 'AGENTS.md'),
    projectClaude: join(cwd, 'CLAUDE.md'),
  };
  for (const [key, content] of Object.entries(files)) {
    mkdirSync(join(paths[key], '..'), { recursive: true });
    writeFileSync(paths[key], content);
  }
  mkdirSync(cwd, { recursive: true });
  return { root, homeDir, cwd, paths, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

const ALL_FILES = {
  globalAgents: 'global agents rule',
  globalClaude: 'global claude rule',
  projectAgents: 'project agents rule',
  projectClaude: 'project claude rule',
};

function withEnv(value, fn) {
  const prior = process.env.MIXDOG_BOOT_INSTRUCTION_FILES;
  if (value === undefined) delete process.env.MIXDOG_BOOT_INSTRUCTION_FILES;
  else process.env.MIXDOG_BOOT_INSTRUCTION_FILES = value;
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env.MIXDOG_BOOT_INSTRUCTION_FILES;
    else process.env.MIXDOG_BOOT_INSTRUCTION_FILES = prior;
  }
}

test('mode all loads global files first, then the project root, under path headings', () => {
  const fx = fixture(ALL_FILES);
  try {
    const block = withEnv(undefined, () =>
      loadInstructionFilesContext({ mode: 'all', cwd: fx.cwd, homeDir: fx.homeDir })
    );
    assert.match(
      block,
      /^# Instruction Files\n\n.*Project files take precedence over global ones when they conflict\./
    );
    const order = [fx.paths.globalAgents, fx.paths.globalClaude, fx.paths.projectAgents, fx.paths.projectClaude].map(
      (path) => block.indexOf(`## ${path}\n\n`)
    );
    assert.ok(order.every((index) => index > 0));
    assert.deepEqual(
      [...order].sort((a, b) => a - b),
      order
    );
    for (const text of Object.values(ALL_FILES)) assert.ok(block.includes(text));
  } finally {
    fx.dispose();
  }
});

test('modes agents and claude load only their file name; off and an invalid value behave as specified', () => {
  const fx = fixture(ALL_FILES);
  try {
    withEnv(undefined, () => {
      const agents = loadInstructionFilesContext({ mode: 'agents', cwd: fx.cwd, homeDir: fx.homeDir });
      assert.ok(agents.includes('global agents rule') && agents.includes('project agents rule'));
      assert.doesNotMatch(agents, /claude rule/);
      const claude = loadInstructionFilesContext({ mode: 'claude', cwd: fx.cwd, homeDir: fx.homeDir });
      assert.ok(claude.includes('global claude rule') && claude.includes('project claude rule'));
      assert.doesNotMatch(claude, /agents rule/);
      assert.equal(loadInstructionFilesContext({ mode: 'off', cwd: fx.cwd, homeDir: fx.homeDir }), '');
      // Absent or invalid falls back to the default, 'off'.
      assert.equal(loadInstructionFilesContext({ mode: 'bogus', cwd: fx.cwd, homeDir: fx.homeDir }), '');
      assert.equal(effectiveInstructionFilesMode(undefined), 'off');
    });
  } finally {
    fx.dispose();
  }
});

test('missing and empty files are skipped; no files yields no block', () => {
  const fx = fixture({ globalClaude: '  \n\t\n', projectAgents: 'only project' });
  try {
    withEnv(undefined, () => {
      const block = loadInstructionFilesContext({ mode: 'all', cwd: fx.cwd, homeDir: fx.homeDir });
      assert.equal((block.match(/^## /gm) || []).length, 1);
      assert.ok(block.includes(`## ${fx.paths.projectAgents}\n\nonly project`));
      assert.equal(loadInstructionFilesContext({ mode: 'claude', cwd: fx.cwd, homeDir: fx.homeDir }), '');
      // No cwd: project files are never looked up.
      assert.equal(loadInstructionFilesContext({ mode: 'agents', homeDir: fx.homeDir }), '');
    });
  } finally {
    fx.dispose();
  }
});

test('a file whose trimmed content repeats an included one is dropped', () => {
  const fx = fixture({ globalAgents: 'shared rules\n', globalClaude: '\nshared rules', projectClaude: 'own rules' });
  try {
    const block = withEnv(undefined, () =>
      loadInstructionFilesContext({ mode: 'all', cwd: fx.cwd, homeDir: fx.homeDir })
    );
    assert.ok(block.includes(`## ${fx.paths.globalAgents}`));
    assert.ok(!block.includes(`## ${fx.paths.globalClaude}`));
    assert.ok(block.includes(`## ${fx.paths.projectClaude}`));
    assert.equal((block.match(/shared rules/g) || []).length, 1);
  } finally {
    fx.dispose();
  }
});

test('a file over the 32 KiB budget is cut on a UTF-8 boundary with a truncation marker', () => {
  const big = '가나다 '.repeat(4000); // 10 bytes per repeat → ~40 KB
  const fx = fixture({ projectAgents: big });
  try {
    const block = withEnv(undefined, () =>
      loadInstructionFilesContext({ mode: 'agents', cwd: fx.cwd, homeDir: fx.homeDir })
    );
    const body = block.slice(
      block.indexOf(`## ${fx.paths.projectAgents}\n\n`) + `## ${fx.paths.projectAgents}\n\n`.length
    );
    assert.ok(body.endsWith('[... truncated]'));
    assert.ok(Buffer.byteLength(body, 'utf8') <= 32 * 1024);
    assert.ok(!body.includes('\uFFFD'));
    assert.ok(body.startsWith('가나다 가나다'));
  } finally {
    fx.dispose();
  }
});

const budgetBytes = 32 * 1024;

function load(fx, mode, extra = {}) {
  return withEnv(undefined, () => loadInstructionFilesContext({ mode, cwd: fx.cwd, homeDir: fx.homeDir, ...extra }));
}

// File symlinks need a privilege on Windows; the test is skipped there when it is missing.
function trySymlink(t, target, path, type) {
  try {
    symlinkSync(target, path, type);
    return true;
  } catch (error) {
    if (error?.code !== 'EPERM') throw error;
    t.skip('symlink creation not permitted');
    return false;
  }
}

test('a project file symlinked outside the project root is rejected; one inside is followed', (t) => {
  const fx = fixture({});
  const outside = join(fx.root, 'outside.md');
  writeFileSync(outside, 'secret outside rules');
  writeFileSync(join(fx.cwd, 'real.md'), 'inside rules');
  try {
    if (!trySymlink(t, outside, fx.paths.projectAgents, 'file')) return;
    assert.equal(load(fx, 'agents'), '');
    rmSync(fx.paths.projectAgents);
    symlinkSync(join(fx.cwd, 'real.md'), fx.paths.projectAgents, 'file');
    const block = load(fx, 'agents');
    assert.ok(block.includes('inside rules') && !block.includes('secret'));
  } finally {
    fx.dispose();
  }
});

test('a global directory junction pointing outside home is followed, with the bounded read', () => {
  const fx = fixture({});
  const elsewhere = join(fx.root, 'elsewhere');
  mkdirSync(elsewhere, { recursive: true });
  writeFileSync(join(elsewhere, 'AGENTS.md'), `dotfiles rules ${'word '.repeat(100_000)}`);
  mkdirSync(fx.homeDir, { recursive: true });
  try {
    symlinkSync(elsewhere, join(fx.homeDir, '.codex'), 'junction');
    const block = load(fx, 'agents');
    assert.ok(block.includes('dotfiles rules'));
    assert.ok(block.endsWith('[... truncated]'));
    assert.ok(Buffer.byteLength(block, 'utf8') < budgetBytes + 512);
  } finally {
    fx.dispose();
  }
});

test('a project directory reached through a symlinked root keeps its own files', (t) => {
  const fx = fixture({ projectAgents: 'linked root rules' });
  const alias = join(fx.root, 'alias');
  try {
    if (!trySymlink(t, fx.cwd, alias, 'junction')) return;
    assert.ok(load(fx, 'agents', { cwd: alias }).includes('linked root rules'));
  } finally {
    fx.dispose();
  }
});

test('only regular files load: a directory or FIFO named like an instruction file is skipped', (t) => {
  const fx = fixture({});
  try {
    mkdirSync(fx.paths.projectAgents);
    assert.equal(load(fx, 'agents'), '');
    if (process.platform !== 'win32') {
      rmSync(fx.paths.projectAgents, { recursive: true });
      if (spawnSync('mkfifo', [fx.paths.projectAgents]).status !== 0) return t.skip('mkfifo unavailable');
      assert.equal(load(fx, 'agents'), '');
    }
  } finally {
    fx.dispose();
  }
});

test('an unreadable file is skipped without throwing', (t) => {
  const fx = fixture({ projectAgents: 'private rules' });
  try {
    if (process.platform === 'win32' || process.getuid?.() === 0) return t.skip('mode bits not enforced');
    chmodSync(fx.paths.projectAgents, 0o000);
    assert.equal(load(fx, 'agents'), '');
  } finally {
    chmodSync(fx.paths.projectAgents, 0o644);
    fx.dispose();
  }
});

test('an oversized file is read only up to the budget and truncated', () => {
  const fx = fixture({ projectAgents: 'word '.repeat(2_000_000) }); // ~10 MB
  try {
    const block = load(fx, 'agents');
    const body = block.slice(
      block.indexOf(`## ${fx.paths.projectAgents}\n\n`) + `## ${fx.paths.projectAgents}\n\n`.length
    );
    assert.ok(body.endsWith('\n\n[... truncated]'));
    assert.ok(Buffer.byteLength(body, 'utf8') <= budgetBytes);
    assert.ok(Buffer.byteLength(body, 'utf8') > budgetBytes - 64);
  } finally {
    fx.dispose();
  }
});

test('a cut inside a multi-byte character never leaves a replacement character', () => {
  // The budget cut falls one byte into the first 3-byte character.
  const cutAt = budgetBytes - Buffer.byteLength('\n\n[... truncated]', 'utf8');
  const fx = fixture({
    projectAgents: `${'ab '.repeat(Math.floor((cutAt - 1) / 3))}${'x'.repeat((cutAt - 1) % 3)}${'가'.repeat(500)}`,
  });
  try {
    const block = load(fx, 'agents');
    assert.ok(block.endsWith('[... truncated]'));
    assert.ok(!block.includes('\uFFFD'));
  } finally {
    fx.dispose();
  }
});

test('a UTF-8 BOM is stripped', () => {
  const fx = fixture({});
  writeFileSync(fx.paths.projectAgents, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('bom rules')]));
  try {
    assert.ok(load(fx, 'agents').endsWith(`${fx.paths.projectAgents}\n\nbom rules`));
  } finally {
    fx.dispose();
  }
});

test('oversized copies dedupe on their bounded content', () => {
  const big = 'shared '.repeat(20_000);
  const fx = fixture({ globalAgents: big, projectAgents: `${big}tail that is past the budget` });
  try {
    assert.equal((load(fx, 'agents').match(/^## /gm) || []).length, 1);
  } finally {
    fx.dispose();
  }
});

test('MIXDOG_BOOT_INSTRUCTION_FILES=0 forces off regardless of the configured mode', () => {
  const fx = fixture(ALL_FILES);
  try {
    withEnv('0', () => {
      assert.equal(effectiveInstructionFilesMode('all'), 'off');
      assert.equal(loadInstructionFilesContext({ mode: 'all', cwd: fx.cwd, homeDir: fx.homeDir }), '');
    });
    withEnv('1', () => {
      assert.equal(effectiveInstructionFilesMode('claude'), 'claude');
    });
  } finally {
    fx.dispose();
  }
});

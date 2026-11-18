// The file-access boundary of Visualize (targets.ts): only the agent tool's `open` may name a supported file anywhere (a page from any
// local folder, rooted in the project when it lies inside it, else in its own folder); a reload, restore or reopen stays inside the
// folders already recorded for the pane; outputs stay inside the working directory.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { OutsideRecordedRootError, OutsideWorkingDirectoryError, resolveProjectOutput, resolveTargetWithin, resolveVisualizeTarget } from './targets.ts';

function tree() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'visualize-targets-')));
  const cwd = join(base, 'project');
  mkdirSync(join(cwd, 'site'), { recursive: true });
  mkdirSync(join(base, 'elsewhere'), { recursive: true });
  writeFileSync(join(cwd, 'site', 'index.html'), '<h1>in</h1>');
  writeFileSync(join(base, 'elsewhere', 'page.html'), '<h1>out</h1>');
  writeFileSync(join(base, 'elsewhere', 'notes.xyz'), 'x');
  return { base, cwd };
}

test('an agent open takes a supported file inside the project, rooted in the project', async () => {
  const { base, cwd } = tree();
  try {
    const target = await resolveVisualizeTarget(cwd, 'site/index.html');
    assert.deepEqual([target.kind, target.path, target.root], ['html', join(cwd, 'site', 'index.html'), cwd]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('an agent open takes a supported file outside the project too, rooted in the file\'s own folder only', async () => {
  const { base, cwd } = tree();
  try {
    const target = await resolveVisualizeTarget(cwd, '../elsewhere/page.html');
    assert.equal(target.path, join(base, 'elsewhere', 'page.html'));
    assert.equal(target.root, join(base, 'elsewhere'), 'assets are served from that folder, never from the project or a parent');
    await assert.rejects(resolveVisualizeTarget(cwd, '../elsewhere/notes.xyz'), /unsupported file type/);
    await assert.rejects(resolveVisualizeTarget(cwd, '../elsewhere/missing.html'), { name: 'TargetNotFoundError' });
    await assert.rejects(resolveVisualizeTarget(cwd, '../elsewhere'), /target is not a file/);
    await assert.rejects(resolveVisualizeTarget(cwd, 'ftp://x/y.html'), /only http\(s\) URLs/);
    assert.equal((await resolveVisualizeTarget(cwd, 'https://example.test/a')).kind, 'url');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a reload, restore or reopen resolves only inside the roots recorded for the pane', async () => {
  const { base, cwd } = tree();
  try {
    const inside = await resolveTargetWithin(cwd, 'site/index.html', [cwd]);
    assert.equal(inside.root, cwd);
    await assert.rejects(resolveTargetWithin(cwd, '../elsewhere/page.html', [cwd]), OutsideRecordedRootError);
    assert.equal((await resolveTargetWithin(cwd, '../elsewhere/page.html', [cwd, join(base, 'elsewhere')])).root, join(base, 'elsewhere'));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('outputs stay inside the working directory', async () => {
  const { base, cwd } = tree();
  try {
    await assert.rejects(resolveProjectOutput(cwd, '../escape.png'), OutsideWorkingDirectoryError);
    await assert.rejects(resolveProjectOutput(cwd, join(base, 'elsewhere', 'o.png')), OutsideWorkingDirectoryError);
    assert.equal(await resolveProjectOutput(cwd, 'shots/o.png'), join(cwd, 'shots', 'o.png'));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

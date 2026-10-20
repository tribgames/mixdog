import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  readMarkdownDefaultView,
  readScopedEditorSettings,
  scopedEditorSettingsFromText,
  writeMarkdownDefaultView,
  writeWorkspaceFile,
} from './workspace-config.ts';

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'mixdog-wc-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function userFile(dir, text) {
  await mkdir(join(dir, 'User'), { recursive: true });
  const file = join(dir, 'User', 'settings.json');
  if (text !== undefined) await writeFile(file, text, 'utf8');
  return file;
}

test('project nested key beats user dotted key', async (t) => {
  const dir = await tempDir(t);
  await userFile(dir, '{"mixdog.markdown.defaultView": "source"}');
  const project = join(dir, 'proj');
  await mkdir(join(project, '.vscode'), { recursive: true });
  await writeFile(
    join(project, '.vscode', 'settings.json'),
    '{"mixdog": {"markdown": {"defaultView": "rich"}}}',
    'utf8'
  );
  const settings = await readScopedEditorSettings(dir, project, 'a.md');
  assert.equal(settings.markdownDefaultView, 'rich');
});

test('concurrent writes serialize, keep external edits, and leave no temp files', async (t) => {
  const dir = await tempDir(t);
  const file = await userFile(dir, '{\n  // keep\n  "a": 1\n}\n');
  await writeFile(file, '{\n  // keep\n  "a": 1,\n  "external": true\n}\n', 'utf8');
  await Promise.all([
    writeMarkdownDefaultView(dir, 'rich'),
    writeMarkdownDefaultView(dir, 'preview'),
    writeMarkdownDefaultView(dir, 'source'),
  ]);
  const text = await readFile(file, 'utf8');
  assert.match(text, /"external": true/);
  assert.match(text, /"a": 1/);
  assert.match(text, /\/\/ keep/);
  assert.match(text, /"mixdog.markdown.defaultView": "source"/);
  assert.deepEqual(await readdir(join(dir, 'User')), ['settings.json']);
});

test('an external edit between read and commit is re-applied on fresh text', async (t) => {
  const dir = await tempDir(t);
  const file = await userFile(dir, '{\n  // keep\n  "a": 1\n}\n');
  let calls = 0;
  await writeMarkdownDefaultView(dir, 'rich', {
    afterRead: async () => {
      if (calls++ === 0) await writeFile(file, '{\n  // keep\n  "a": 1,\n  "external": true\n}\n', 'utf8');
    },
  });
  assert.equal(calls, 2);
  const text = await readFile(file, 'utf8');
  assert.match(text, /"external": true/);
  assert.match(text, /\/\/ keep/);
  assert.match(text, /"mixdog.markdown.defaultView": "rich"/);
  assert.deepEqual(await readdir(join(dir, 'User')), ['settings.json']);
});

test('an unparseable settings file is refused and left untouched', async (t) => {
  const dir = await tempDir(t);
  const broken = '{\n  "a": 1,, oops\n';
  const file = await userFile(dir, broken);
  await assert.rejects(writeMarkdownDefaultView(dir, 'rich'), /refusing to overwrite/);
  assert.equal(await readFile(file, 'utf8'), broken);
  assert.deepEqual(await readdir(join(dir, 'User')), ['settings.json']);
});

test('preserves tab indentation and CRLF; new files use two spaces', async (t) => {
  const dir = await tempDir(t);
  const file = await userFile(dir, '{\r\n\t"a": 1\r\n}\r\n');
  await writeMarkdownDefaultView(dir, 'rich');
  const text = await readFile(file, 'utf8');
  assert.match(text, /\r\n\t"mixdog.markdown.defaultView": "rich"/);
  assert.ok(!/(^|[^\r])\n/.test(text));

  const fresh = await tempDir(t);
  await writeMarkdownDefaultView(fresh, 'source');
  assert.equal(
    await readFile(join(fresh, 'User', 'settings.json'), 'utf8'),
    '{\n  "mixdog.markdown.defaultView": "source"\n}'
  );
});

test('an empty or NUL-filled settings.json means defaults and never rejects the readers', async (t) => {
  const dir = await tempDir(t);
  const file = await userFile(dir, '');
  for (const damaged of ['', '\0\0\0\0', ' \n\0']) {
    await writeFile(file, damaged);
    const settings = await readScopedEditorSettings(dir, join(dir, 'proj'), 'a.md');
    assert.equal(settings.markdownDefaultView, 'preview');
    assert.equal(await readMarkdownDefaultView(dir), 'preview');
  }
  assert.deepEqual(
    await scopedEditorSettingsFromText(dir, 'a.md', '\0\0', '').then((settings) => settings.markdownDefaultView),
    'preview'
  );
});

test('a NUL-filled settings.json takes a write as an empty one', async (t) => {
  const dir = await tempDir(t);
  const file = await userFile(dir, '\0\0\0\0');
  await writeMarkdownDefaultView(dir, 'rich');
  assert.equal(await readFile(file, 'utf8'), '{\n  "mixdog.markdown.defaultView": "rich"\n}');
});

test('saving a Project file over a NUL-filled one replaces it and leaves no temp file', async (t) => {
  const dir = await tempDir(t);
  const file = join(dir, 'p.code-workspace');
  await writeFile(file, '\0\0\0\0');
  const workspace = await writeWorkspaceFile(file, [{ path: join(dir, 'src') }]);
  assert.equal(workspace.folders.length, 1);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { folders: [{ path: 'src' }] });
  assert.deepEqual(await readdir(dir), ['p.code-workspace']);
});

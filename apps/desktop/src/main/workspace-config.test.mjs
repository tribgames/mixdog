import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

import {
  parseWorkspaceFile,
  readScopedEditorSettings,
  writeWorkspaceFile,
} from './workspace-config.ts';

test('code-workspace parsing resolves relative multi-root folders and JSONC', () => {
  const file = resolve('fixtures', 'sample.code-workspace');
  const workspace = parseWorkspaceFile(`{
    // VS Code workspace files are JSONC.
    "folders": [
      { "path": "." },
      { "path": "../shared", "name": "Shared" },
    ],
  }`, file);
  assert.equal(workspace.kind, 'workspace');
  assert.equal(workspace.name, 'sample');
  assert.deepEqual(workspace.folders, [
    { path: dirname(file) },
    { path: resolve(dirname(file), '../shared'), name: 'Shared' },
  ]);
});

test('workspace writing preserves settings and editor scopes merge user, workspace, folder, and language', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-workspace-'));
  const userData = join(root, 'data');
  const project = join(root, 'project');
  const workspaceFile = join(root, 'sample.code-workspace');
  try {
    await mkdir(join(userData, 'User'), { recursive: true });
    await mkdir(join(project, '.vscode'), { recursive: true });
    await writeFile(join(userData, 'User', 'settings.json'), `{
      "editor.fontSize": 13,
      "editor.wordWrap": "on",
    }`);
    await writeFile(workspaceFile, `{
      "folders": [],
      "settings": {
        "editor.fontSize": 15,
        "editor.minimap.enabled": false,
        "[typescript]": { "editor.formatOnSave": true },
      },
    }`);
    await writeFile(join(project, '.vscode', 'settings.json'), `{
      "editor.fontFamily": "Cascadia Code",
      "editor.stickyScroll.enabled": true,
      "editor.tabSize": 2,
    }`);
    await writeWorkspaceFile(workspaceFile, [{ path: project, name: 'App' }]);
    const written = JSON.parse(await readFile(workspaceFile, 'utf8'));
    assert.equal(written.settings['editor.fontSize'], 15);
    assert.deepEqual(written.folders, [{ path: 'project', name: 'App' }]);
    const settings = await readScopedEditorSettings(
      userData,
      project,
      'src/index.ts',
      workspaceFile,
    );
    assert.equal(settings.fontSize, 15);
    assert.equal(settings.wordWrap, 'on');
    assert.equal(settings.minimapEnabled, false);
    assert.equal(settings.stickyScrollEnabled, true);
    assert.equal(settings.formatOnSave, true);
    assert.equal(settings.tabSize, 2);
    assert.equal(settings.fontFamily, 'Cascadia Code');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

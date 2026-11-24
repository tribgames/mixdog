import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { DESKTOP_IPC } from '../shared/contract';
import { registerSourceControlIpc } from './ipc-source-control';

function setup(temp = tmpdir()) {
  const handlers = new Map();
  const opened = [];
  const revealed = [];
  registerSourceControlIpc({
    app: { getPath: () => temp },
    handle: (channel, listener) => handlers.set(channel, listener),
    shell: {
      openPath: async (file) => {
        opened.push(file);
        return '';
      },
      showItemInFolder: (file) => revealed.push(file),
    },
    grantedFile: async () => ({}),
    describeLocalPaths: async () => [],
    core: null,
  });
  return { call: (channel, ...args) => handlers.get(channel)({}, ...args), opened, revealed };
}

test('a link inside the repository that leads outside it is neither opened nor revealed', async () => {
  const base = await mkdtemp(join(tmpdir(), 'scm-link-'));
  try {
    const repo = join(base, 'repo');
    const outside = join(base, 'outside');
    await mkdir(repo);
    await mkdir(outside);
    await writeFile(join(outside, 'secret.txt'), 'x');
    await writeFile(join(repo, 'ok.txt'), 'x');
    await symlink(outside, join(repo, 'link'), 'junction');
    const { call, opened, revealed } = setup();
    await assert.rejects(call(DESKTOP_IPC.openFilePath, repo, 'link/secret.txt'), /outside the project/);
    await assert.rejects(call(DESKTOP_IPC.revealFile, repo, 'link/secret.txt'), /outside the project/);
    assert.deepEqual(opened, []);
    assert.deepEqual(revealed, []);
    await call(DESKTOP_IPC.openFilePath, repo, 'ok.txt');
    await call(DESKTOP_IPC.revealFile, repo, 'gone.txt');
    assert.equal(opened.length, 1);
    assert.equal(revealed.length, 1);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('an attachment image is written into a fresh folder, never one that already exists in the temp folder', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'scm-temp-'));
  try {
    const planted = join(temp, 'mixdog-attachments');
    await mkdir(planted);
    const { call, opened } = setup(temp);
    await call(DESKTOP_IPC.openAttachmentImage, 'data:image/png;base64,iVBORw0KGgo=', 'a');
    assert.equal(opened.length, 1);
    assert.notEqual(dirname(opened[0]), planted);
    assert.deepEqual(await readdir(planted), []);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

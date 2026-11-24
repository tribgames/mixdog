import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DESKTOP_IPC } from '../shared/contract';
import { resolveFilePreview } from './file-preview.ts';
import { registerProjectFileIpc } from './ipc-project-files';

test('a project file preview is bound to its project root so a later swap for a link is refused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'preview-root-'));
  try {
    await writeFile(join(root, 'a.png'), 'x');
    const handlers = new Map();
    registerProjectFileIpc({
      handle: (channel, listener) => handlers.set(channel, listener),
      host: { projectDirectory: async () => root },
      invokeDesktopOperation: async () => ({ mtimeMs: 1, size: 1 }),
      shell: {},
      grantedFile: async () => ({}),
    });
    const { url } = await handlers.get(DESKTOP_IPC.previewProjectFile)({ sender: {} }, root, 'a.png');
    assert.equal(resolveFilePreview(new URL(url).pathname.split('/')[1]).root, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

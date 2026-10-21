import assert from 'node:assert/strict';
import fs, { link, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { sensitivePolicy } from './remote-sensitive-paths.ts';
import { writeWorkspaceFileAuthorized } from './remote-project-files.ts';

// Two hard links are two paths for one workspace file, and its save is a
// read-modify-write through one handle: concurrent saves through the links
// must run one after the other, never interleave.
test('concurrent workspace saves through hard-link aliases do not interleave', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mixdog-workspace-claim-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'ws.code-workspace');
  const alias = join(root, 'ws-link.code-workspace');
  await writeFile(file, '{ "settings": { "keep": true } }\n');
  await link(file, alias);
  const folder = (name) => ({ path: join(root, name), name });
  const first = [folder('one'), folder('two'), folder('three')];
  const second = [folder('only')];

  // The first save writes in two slow halves while holding the file.
  const writing = Promise.withResolvers();
  const open = fs.open;
  const mock = t.mock.method(fs, 'open', async (path, ...args) => {
    const handle = await open(path, ...args);
    if (String(path) !== file) return handle;
    let calls = 0;
    const write = handle.write.bind(handle);
    handle.write = async (buffer, offset, length, position) => {
      writing.resolve();
      await new Promise((resolve) => setTimeout(resolve, 40));
      return write(buffer, offset, calls++ === 0 ? length >> 1 : length, position);
    };
    return handle;
  });
  syncBuiltinESMExports();
  t.after(() => {
    mock.mock.restore();
    syncBuiltinESMExports();
  });

  const policy = sensitivePolicy();
  const saveFirst = writeWorkspaceFileAuthorized(file, first, root, policy);
  await writing.promise;
  const saveSecond = writeWorkspaceFileAuthorized(alias, second, root, policy);
  await Promise.all([saveFirst, saveSecond]);

  const text = await readFile(file, 'utf8');
  const saved = JSON.parse(text);
  assert.deepEqual(
    saved.folders.map((entry) => entry.name),
    ['only'],
    'the second save ran after the first and replaced its folders whole'
  );
  assert.deepEqual(saved.settings, { keep: true });
  assert.equal(await readFile(alias, 'utf8'), text);
});

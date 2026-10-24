import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { readProjectTextFileIn } from './project-files.ts';
import {
  readProjectTextFileAuthorized,
  writeProjectTextFileAuthorized,
  writeProjectTextFilesAuthorized,
} from './remote-project-files.ts';

// A paired device's text reads and saves take exactly what the desktop's do:
// a secret-bearing project file is read and saved like any other, and a path
// out of the project is refused on both.
test('a secret-bearing project file is read and saved through the authorized handle, as on the desktop', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mixdog-remote-project-files-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, '.env'), 'TOKEN=abc');
  await mkdir(join(root, '.ssh'));
  await writeFile(join(root, '.ssh', 'config'), 'Host box');
  // Before parity both reads and both saves were refused as "credentials or secrets".
  assert.deepEqual(await readProjectTextFileAuthorized(root, '.env'), await readProjectTextFileIn(root, '.env'));
  assert.equal((await readProjectTextFileAuthorized(root, '.ssh/config')).content, 'Host box');
  await writeProjectTextFileAuthorized(root, '.env', 'TOKEN=def', 'TOKEN=abc', undefined);
  await writeProjectTextFilesAuthorized(root, [
    { relPath: '.ssh/config', content: 'Host lab', expectedContent: 'Host box' },
  ]);
  assert.equal(await readFile(join(root, '.env'), 'utf8'), 'TOKEN=def');
  assert.equal(await readFile(join(root, '.ssh', 'config'), 'utf8'), 'Host lab');
  // The desktop's project boundary holds on both.
  await assert.rejects(readProjectTextFileIn(root, '../outside.txt'), /outside the project/);
  await assert.rejects(readProjectTextFileAuthorized(root, '../outside.txt'), /outside the project/);
});

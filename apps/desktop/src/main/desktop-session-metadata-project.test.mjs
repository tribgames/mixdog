import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DesktopSessionMetadata } from './desktop-session-metadata.ts';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-desktop-project-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const metadata = new DesktopSessionMetadata(() => root);
  await metadata.load();
  const reload = async () => {
    const next = new DesktopSessionMetadata(() => root);
    await next.load();
    return next;
  };
  return { metadata, reload, target: join(root, 'desktop-session-metadata.json') };
}

test('a project assignment persists, "" means no project, null follows the folder again', async (t) => {
  const { metadata, reload, target } = await fixture(t);
  assert.equal(await metadata.setProject('session-a', 'C:\\Work\\Alpha'), true);
  assert.equal(await metadata.setProject('session-a', 'C:\\Work\\Alpha'), false, 'unchanged request reports no change');
  assert.equal(await metadata.setProject('session-b', ''), true);
  const rows = [{ id: 'session-a' }, { id: 'session-b' }, { id: 'session-c' }];
  assert.deepEqual((await reload()).withProjectAssignments(rows), [
    { id: 'session-a', projectAssignment: 'C:\\Work\\Alpha' },
    { id: 'session-b', projectAssignment: '' },
    { id: 'session-c' },
  ]);

  assert.equal(await metadata.setProject('session-a', null), true);
  assert.equal(await metadata.setProject('session-b', null), true);
  assert.deepEqual((await reload()).withProjectAssignments(rows), rows);
  assert.equal(JSON.parse(await readFile(target, 'utf8')).projects, undefined, 'empty map is omitted from the file');
});

test('deleting a session forgets its project assignment', async (t) => {
  const { metadata, reload } = await fixture(t);
  await metadata.setProject('session-a', 'C:\\Work\\Alpha');
  await metadata.forget('session-a');
  assert.deepEqual((await reload()).withProjectAssignments([{ id: 'session-a' }]), [{ id: 'session-a' }]);
});

test('removing a project clears its assignments but keeps "no project" and other projects', async (t) => {
  const { metadata, reload } = await fixture(t);
  await metadata.setProject('session-a', 'C:\\Work\\Alpha');
  await metadata.setProject('session-b', '');
  await metadata.setProject('session-c', 'C:\\Work\\Beta');
  assert.equal(await metadata.clearProjectAssignments('c:/work/alpha/'), true);
  assert.equal(await metadata.clearProjectAssignments('C:\\Work\\Alpha'), false);
  const rows = [{ id: 'session-a' }, { id: 'session-b' }, { id: 'session-c' }];
  assert.deepEqual((await reload()).withProjectAssignments(rows), [
    { id: 'session-a' },
    { id: 'session-b', projectAssignment: '' },
    { id: 'session-c', projectAssignment: 'C:\\Work\\Beta' },
  ]);
});

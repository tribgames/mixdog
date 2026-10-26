// The desktop operations table (desktop-operations.ts): window events, folder
// watches, terminal queries and the refusal of an unknown name.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { SETTINGS_CHANGED_EVENT, UPDATER_STATE_EVENT } from '../shared/settings-changed.ts';
import { createDesktopOperations } from './desktop-operations.ts';

test('operations emit their window events, watch folders and refuse unknown names', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-desktop-operations-'));
  const events = [];
  const operations = createDesktopOperations({
    userDataPath: directory,
    loadConfig: async () => ({ readConfig: () => ({}), updateConfigAsync: async (update) => update({}) }),
    emit: (event) => events.push(event),
  });
  t.after(async () => {
    await operations.dispose();
    await rm(directory, { recursive: true, force: true });
  });

  await assert.rejects(operations.invoke('noSuchOperation', []), {
    name: 'TypeError',
    message: 'Mixdog desktop service operation is unavailable.',
  });

  assert.equal(await operations.invoke('publishUpdaterState', [{ status: 'idle' }]), undefined);
  assert.deepEqual(events.at(-1), { name: UPDATER_STATE_EVENT, value: { status: 'idle' } });
  await assert.rejects(operations.invoke('notifySettingsChanged', ['no-such-scope']), /settings scope is invalid/);
  assert.equal(await operations.invoke('notifySettingsChanged', ['notifications']), undefined);
  assert.equal(events.at(-1).name, SETTINGS_CHANGED_EVENT);

  assert.equal(await operations.invoke('folderWatch', [directory, false]), null);
  assert.equal(await operations.invoke('folderUnwatch', [directory, false]), null);

  assert.equal(await operations.invoke('termAttach', ['no-such-terminal']), null);
  assert.equal(await operations.invoke('termWrite', ['no-such-terminal', 'x']), null);
  assert.deepEqual(await operations.invoke('termDisposeUnder', [join(directory, 'none')]), []);
});

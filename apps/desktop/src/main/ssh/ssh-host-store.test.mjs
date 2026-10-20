import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  allowedProvidersForHost,
  configureSshHostStore,
  loadSshHostStore,
  parseHostSettings,
  sharedSshHostStore,
} from './ssh-host-store.ts';

const tempDir = () => mkdtemp(join(tmpdir(), 'mixdog-ssh-hosts-'));
const host = (id, name, target, lastConnectedAt = 1) => ({ id, name, target, lastConnectedAt });

test('saved servers persist as id, name, target and lastConnectedAt, newest first', async () => {
  const dir = await tempDir();
  const store = await loadSshHostStore(dir);
  await store.save(host('a', 'vps', 'root@vps.example.com', 10));
  await store.save(host('b', 'gpu-box', 'gpu-box', 20));
  assert.deepEqual(
    store.list().map((entry) => entry.id),
    ['b', 'a']
  );
  const stored = JSON.parse(await readFile(join(dir, 'ssh-hosts.json'), 'utf8'));
  assert.deepEqual(stored.hosts[1], host('a', 'vps', 'root@vps.example.com', 10));
  const reloaded = await loadSshHostStore(dir);
  assert.deepEqual(reloaded.list(), store.list());
  assert.deepEqual(reloaded.findByTarget('gpu-box'), host('b', 'gpu-box', 'gpu-box', 20));
});

test('saving an id again updates the entry in place; rename and remove touch only that entry', async () => {
  const store = await loadSshHostStore(await tempDir());
  await store.save(host('a', 'vps', 'root@vps.example.com', 10));
  await store.save(host('b', 'gpu', 'gpu', 20));
  await store.save(host('a', 'vps', 'root@vps.example.com', 30));
  assert.equal(store.list().length, 2);
  assert.equal(store.get('a').lastConnectedAt, 30);
  await store.rename('a', '  My VPS  ');
  assert.equal(store.get('a').name, 'My VPS');
  await store.rename('a', '   ');
  assert.equal(store.get('a').name, 'My VPS', 'an empty name is ignored');
  await store.remove('a');
  assert.deepEqual(
    store.list().map((entry) => entry.id),
    ['b']
  );
});

test('unreadable files and invalid entries load as an empty or shorter list', async () => {
  const dir = await tempDir();
  assert.deepEqual((await loadSshHostStore(dir)).list(), []);
  await writeFile(join(dir, 'ssh-hosts.json'), '{not json', 'utf8');
  assert.deepEqual((await loadSshHostStore(dir)).list(), []);
  await writeFile(
    join(dir, 'ssh-hosts.json'),
    JSON.stringify({
      hosts: [
        host('a', 'ok', 'root@host'),
        host('b', 'bad', '-oProxyCommand=x'),
        host('', 'noid', 'host'),
        host('c', '', 'host'),
      ],
    }),
    'utf8'
  );
  assert.deepEqual(
    (await loadSshHostStore(dir)).list().map((entry) => entry.id),
    ['a']
  );
});

test('the host part of a target is compared without regard to case; user and port are not', async () => {
  const dir = await tempDir();
  const store = await loadSshHostStore(dir);
  await store.save(host('a', 'vps', 'root@Vps.Example.com', 10));
  assert.equal(store.findByTarget('root@vps.example.com')?.id, 'a');
  assert.equal(store.findByTarget('Root@vps.example.com'), undefined);
  assert.equal(store.findByTarget('root@vps.example.com:2202'), undefined);
  await store.save(host('b', 'vps again', 'root@vps.example.com', 20));
  assert.deepEqual(
    store.list().map((entry) => entry.id),
    ['b'],
    'the same server under another spelling replaces the old entry'
  );
  await writeFile(
    join(dir, 'ssh-hosts.json'),
    JSON.stringify({ hosts: [host('x', 'one', 'u@HOST'), host('y', 'two', 'u@host')] })
  );
  assert.deepEqual(
    (await loadSshHostStore(dir)).list().map((entry) => entry.id),
    ['x']
  );
});

test('per-server settings are validated, saved with the entry and survive a save of the same id', async () => {
  assert.deepEqual(
    parseHostSettings({ remoteCwd: ' /srv/app ', identityFile: ' ~/.ssh/id work ', autoReconnect: true, extra: 1 }),
    {
      remoteCwd: '/srv/app',
      identityFile: '~/.ssh/id work',
      autoReconnect: true,
    }
  );
  assert.deepEqual(parseHostSettings({ remoteCwd: '  ', identityFile: '' }), {});
  assert.throws(() => parseHostSettings({ remoteCwd: 'src' }), /absolute server path/);
  assert.throws(() => parseHostSettings({ identityFile: 'a\nb' }), /not valid/);
  assert.throws(() => parseHostSettings({ identityFile: '-x' }), /must not start/);
  const dir = await tempDir();
  const store = await loadSshHostStore(dir);
  await store.save(host('a', 'vps', 'root@vps.example.com'));
  await store.updateSettings('a', { remoteCwd: '~/work', autoReconnect: false });
  await store.save(host('a', 'renamed', 'root@vps.example.com', 99));
  const reloaded = await loadSshHostStore(dir);
  assert.deepEqual(reloaded.get('a').settings, { remoteCwd: '~/work', autoReconnect: false });
  assert.equal(reloaded.get('a').name, 'renamed');
  await reloaded.updateSettings('a', {});
  assert.equal(reloaded.get('a').settings, undefined);
});

test('the provider lookup honors a saved server’s list even before any store was loaded; unknown servers get none', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mixdog-providers-'));
  await writeFile(
    join(dir, 'ssh-hosts.json'),
    JSON.stringify({
      version: 1,
      hosts: [
        {
          id: 'restricted',
          name: 'a',
          target: 'root@10.0.0.1',
          lastConnectedAt: 1,
          settings: { allowedProviders: ['anthropic'] },
        },
        { id: 'open', name: 'b', target: 'root@10.0.0.2', lastConnectedAt: 1 },
      ],
    })
  );
  configureSshHostStore(dir);
  // Nothing has loaded the store yet: the saved file still decides.
  assert.deepEqual(allowedProvidersForHost('restricted'), ['anthropic']);
  assert.equal(allowedProvidersForHost('open'), null, 'no list: every provider enabled on this PC');
  assert.deepEqual(allowedProvidersForHost('nobody'), [], 'a server that is not saved gets none');
  // Once the store is loaded (by the IPC handlers) its live state is read, including edits not yet re-read from disk.
  const store = await sharedSshHostStore(dir);
  await store.updateSettings('open', { allowedProviders: ['openai'] });
  assert.deepEqual(allowedProvidersForHost('open'), ['openai']);
  assert.equal(await sharedSshHostStore(dir), store, 'one store per folder');
  // A folder without a list, or an unreadable one, denies rather than allows.
  configureSshHostStore(join(dir, 'missing'));
  assert.deepEqual(allowedProvidersForHost('restricted'), []);
});

test('the grace period is a whole number of minutes from 1 to 10080', () => {
  assert.equal(parseHostSettings({ graceMinutes: 45 }).graceMinutes, 45);
  assert.equal(parseHostSettings({ graceMinutes: '' }).graceMinutes, undefined);
  assert.equal(parseHostSettings({}).graceMinutes, undefined);
  for (const bad of [0, 10_081, 2.5, 'x']) assert.throws(() => parseHostSettings({ graceMinutes: bad }), /1 to 10080/);
});

test('a damaged saved-server list is kept aside and the last good copy restored', async () => {
  const dir = await tempDir();
  const store = await loadSshHostStore(dir);
  await store.save(host('a', 'vps', 'root@vps.example.com', 10));
  await store.save(host('b', 'gpu-box', 'gpu-box', 20));
  const file = join(dir, 'ssh-hosts.json');
  await writeFile(file, '\0\0\0\0\0\0');
  const reloaded = await loadSshHostStore(dir);
  assert.deepEqual(
    reloaded.list().map((entry) => entry.id),
    ['a'],
    'the copy kept before the last write is restored'
  );
  const aside = (await readdir(dir)).filter((name) => name.startsWith('ssh-hosts.json.corrupt-'));
  assert.equal(aside.length, 1);
  assert.equal(await readFile(join(dir, aside[0]), 'utf8'), '\0\0\0\0\0\0');
  assert.deepEqual(
    JSON.parse(await readFile(file, 'utf8')).hosts.map((entry) => entry.id),
    ['a']
  );
});

test('a damaged saved-server list with no backup starts empty but keeps its bytes, and the provider lookup copes', async () => {
  const dir = await tempDir();
  await writeFile(join(dir, 'ssh-hosts.json'), '{"hosts": [');
  configureSshHostStore(dir);
  assert.deepEqual(allowedProvidersForHost('a'), []);
  const store = await loadSshHostStore(dir);
  assert.deepEqual(store.list(), []);
  await store.save(host('n', 'new', 'new-box'));
  assert.deepEqual(
    (await loadSshHostStore(dir)).list().map((entry) => entry.id),
    ['n']
  );
  assert.ok((await readdir(dir)).some((name) => name.startsWith('ssh-hosts.json.corrupt-')));
});

import assert from 'node:assert/strict';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import {
  externalLinkTarget,
  isRemoteHostNavigation,
  loadRemoteHostStore,
  parseRemoteHostLink,
  remoteHostId,
  remoteHostPartition,
  remoteWindowTitle,
  remoteWindowUserAgent,
} from './remote-hosts.ts';

import { makeTempDirSync } from '../../../../scripts/lib/scoped-temp.mjs';
const DEVICE = '0123456789abcdef0123456789abcdef';
const LINK = `https://relay.example.com/d/${DEVICE}/`;

test('a pairing link is the relay origin plus the device route, nothing else', () => {
  assert.deepEqual(parseRemoteHostLink(`  ${LINK}?token=x#frag `), { url: LINK, deviceId: DEVICE });
  assert.deepEqual(parseRemoteHostLink(`https://relay.example.com/d/${DEVICE.toUpperCase()}`), {
    url: LINK,
    deviceId: DEVICE,
  });
  assert.equal(parseRemoteHostLink('https://relay.example.com/'), null);
  assert.equal(parseRemoteHostLink(`https://relay.example.com/x/d/${DEVICE}/`), null);
  assert.equal(parseRemoteHostLink(`ftp://relay.example.com/d/${DEVICE}/`), null);
  assert.equal(parseRemoteHostLink(`https://user:pw@relay.example.com/d/${DEVICE}/`), null);
  assert.equal(parseRemoteHostLink('not a url'), null);
  assert.equal(parseRemoteHostLink(undefined), null);
});

test('plain http is accepted for a loopback relay only', () => {
  assert.ok(parseRemoteHostLink(`http://127.0.0.1:8787/d/${DEVICE}/`));
  assert.ok(parseRemoteHostLink(`http://localhost:8787/d/${DEVICE}/`));
  assert.equal(parseRemoteHostLink(`http://relay.example.com/d/${DEVICE}/`), null);
});

test('each host gets its own persistent partition', () => {
  const a = remoteHostId(LINK);
  const b = remoteHostId(`https://relay.example.com/d/${'f'.repeat(32)}/`);
  assert.notEqual(a, b);
  assert.equal(remoteHostId(LINK), a);
  assert.equal(remoteHostPartition(a), `persist:remote-host-${a}`);
  assert.match(remoteWindowTitle('Office PC'), /Connected to Office PC/);
});

test('the window presents an ordinary browser so the page installs the relay shim', () => {
  const ua =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) mixdog/1.0.12 Chrome/140.0.0.0 Electron/41.0.0 Safari/537.36';
  const rewritten = remoteWindowUserAgent(ua, 'mixdog');
  assert.doesNotMatch(rewritten, /Electron/i);
  assert.doesNotMatch(rewritten, /mixdog\/1\.0\.12/);
  assert.match(rewritten, /Chrome\/140/);
  assert.match(rewritten, /MixdogDesktop\/1$/);
});

test('same-origin navigation stays in the window; links leave through the OS', () => {
  assert.equal(isRemoteHostNavigation(LINK, `https://relay.example.com/d/${DEVICE}/assets/x.js`), true);
  assert.equal(isRemoteHostNavigation(LINK, 'https://evil.example.com/'), false);
  assert.equal(isRemoteHostNavigation(LINK, 'garbage'), false);
  assert.equal(externalLinkTarget('https://example.com/a'), 'https://example.com/a');
  assert.equal(externalLinkTarget('mailto:a@example.com'), 'mailto:a@example.com');
  assert.equal(externalLinkTarget('file:///C:/Windows/system32/cmd.exe'), null);
  assert.equal(externalLinkTarget('javascript:alert(1)'), null);
});

test('saved hosts persist, rename on re-save, and forget cleanly', async () => {
  const directory = makeTempDirSync('hosts');
  try {
    const store = await loadRemoteHostStore(directory);
    const link = parseRemoteHostLink(LINK);
    const saved = await store.save(link, '  Office PC ');
    assert.equal(saved.name, 'Office PC');
    assert.equal(saved.id, remoteHostId(LINK));
    assert.equal(saved.lastConnectedAt, null);
    // Without a name the default names the relay and the device.
    const again = await store.save(link, '');
    assert.equal(again.name, 'Office PC');
    await store.touch(saved.id);

    const reloaded = await loadRemoteHostStore(directory);
    assert.equal(reloaded.list().length, 1);
    assert.equal(typeof reloaded.get(saved.id)?.lastConnectedAt, 'number');
    await reloaded.save(link, 'Desk');
    assert.equal(reloaded.get(saved.id)?.name, 'Desk');

    const unnamed = await loadRemoteHostStore(makeTempDirSync('hosts'));
    const other = await unnamed.save(parseRemoteHostLink(`https://relay.example.com/d/${'a'.repeat(32)}/`), '');
    assert.match(other.name, /relay\.example\.com · aaaaaaaa/);

    await reloaded.remove(saved.id);
    assert.equal((await loadRemoteHostStore(directory)).list().length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a damaged saved-computer list is kept aside and the last good copy restored', async () => {
  const directory = makeTempDirSync('hosts');
  try {
    const store = await loadRemoteHostStore(directory);
    const link = parseRemoteHostLink(LINK);
    await store.save(link, 'Office PC');
    await store.touch(remoteHostId(LINK));
    const file = join(directory, 'remote-hosts.json');
    await writeFile(file, '\0\0\0\0\0\0');

    const reloaded = await loadRemoteHostStore(directory);
    assert.deepEqual(
      reloaded.list().map((host) => host.name),
      ['Office PC']
    );
    const aside = (await readdir(directory)).filter((name) => name.startsWith('remote-hosts.json.corrupt-'));
    assert.equal(aside.length, 1);
    assert.equal(await readFile(join(directory, aside[0]), 'utf8'), '\0\0\0\0\0\0');

    // With nothing to restore the list starts empty, and the bytes stay aside.
    await rm(`${file}.bak`);
    await writeFile(file, '{"hosts": [');
    assert.deepEqual((await loadRemoteHostStore(directory)).list(), []);
    assert.equal((await readdir(directory)).filter((name) => name.includes('.corrupt-')).length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { PORT_FORWARDS_FILE, createPortForwardStore } from './port-forward-store.ts';

function profile(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-port-forwards-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const forward = (remotePort) => ({ remotePort, localPort: remotePort });

test('a NUL-filled file loads no forwards, is kept aside, and later saves persist', async (t) => {
  const dir = profile(t);
  writeFileSync(join(dir, PORT_FORWARDS_FILE), Buffer.alloc(90));
  const store = createPortForwardStore(dir);
  assert.deepEqual(await store.load('box'), []);
  assert.equal(
    readdirSync(dir).some((name) => name.startsWith(`${PORT_FORWARDS_FILE}.corrupt-`)),
    true
  );
  await store.save('box', [forward(3000)]);
  assert.deepEqual(await createPortForwardStore(dir).load('box'), [forward(3000)]);
});

test('truncated JSON is damage too', async (t) => {
  const dir = profile(t);
  writeFileSync(join(dir, PORT_FORWARDS_FILE), '{"version":1,"hosts":{"box":[{"remotePo');
  assert.deepEqual(await createPortForwardStore(dir).load('box'), []);
});

test('a save keeps the replaced list, which a damaged file is restored from', async (t) => {
  const dir = profile(t);
  const store = createPortForwardStore(dir);
  await store.save('box', [forward(3000)]);
  await store.save('box', [forward(3000), forward(5173)]);
  writeFileSync(join(dir, PORT_FORWARDS_FILE), Buffer.alloc(90));
  assert.deepEqual(await createPortForwardStore(dir).load('box'), [forward(3000)]);
  assert.equal(
    readdirSync(dir).some((name) => name.endsWith('.tmp') || name.includes('.mixdog-tmp-')),
    false
  );
});

test('a read that fails is not remembered: the next call reads again', async (t) => {
  const dir = profile(t);
  const file = join(dir, PORT_FORWARDS_FILE);
  // A directory where the file belongs cannot be read as a file (EISDIR).
  mkdirSync(file);
  const store = createPortForwardStore(dir);
  await assert.rejects(store.load('box'));
  rmSync(file, { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 1, hosts: { box: [forward(8080)] } }));
  assert.deepEqual(await store.load('box'), [forward(8080)]);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).hosts.box, [forward(8080)]);
});

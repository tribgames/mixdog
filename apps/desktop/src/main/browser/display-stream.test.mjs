import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createBrowserDisplayStream } from './display-stream.ts';

const image = (value, width = 600) => ({ value, getSize: () => ({ width, height: 400 }) });
function fixture() {
  const guest = new EventEmitter();
  guest.invalidate = () => {};
  let encodes = 0;
  const stream = createBrowserDisplayStream(img => { encodes++; return { data: img.value }; });
  return { guest, stream, encodes: () => encodes, paint: img => guest.emit('paint', {}, {}, img) };
}

test('display stream retains only the latest paint and does no repeated encoding on an unchanged page', async () => {
  const { guest, stream, encodes, paint } = fixture();
  try {
    const first = stream(guest, 'document');
    paint(image('first'));
    assert.equal((await first).data, 'first');
    paint(image('discarded'));
    paint(image('latest'));
    assert.equal(encodes(), 1);
    assert.equal((await stream(guest, 'document')).data, 'latest');
    assert.equal((await stream(guest, 'document')).data, 'latest');
    assert.equal(encodes(), 2);
  } finally { guest.emit('destroyed'); }
  assert.equal(guest.listenerCount('paint'), 0);
});

test('document and geometry transitions cannot relabel cached or old-sized pixels', async () => {
  const { guest, stream, paint } = fixture();
  try {
    const first = stream(guest, 'old');
    paint(image('old'));
    await first;
    guest.emit('did-start-navigation', {}, 'https://new', false, true);
    const next = stream(guest, 'new', { width: 390, height: 400 });
    paint(image('old-size'));
    paint(image('new', 390));
    assert.equal((await next).data, 'new');
    assert.equal((await stream(guest, 'new', { width: 390, height: 400 })).data, 'new');
    const changing = stream(guest, 'another');
    guest.emit('did-start-navigation', {}, 'https://another', false, true);
    await assert.rejects(changing, /page changed during capture/);
  } finally { guest.emit('destroyed'); }
});

test('destruction releases a pending display read rather than retaining listeners or pixels', async () => {
  const { guest, stream } = fixture();
  const waiting = stream(guest, 'document');
  guest.emit('destroyed');
  await assert.rejects(waiting, /not ready/);
  assert.equal(guest.listenerCount('paint'), 0);
  assert.equal(guest.listenerCount('did-start-navigation'), 0);
});

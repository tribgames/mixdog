import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createBrowserDisplayStream } from './display-stream.ts';

const image = (value, width = 600) => ({ value, getSize: () => ({ width, height: 400 }) });
function fixture() {
  const guest = new EventEmitter();
  guest.invalidate = () => {};
  let encodes = 0;
  const stream = createBrowserDisplayStream((img) => {
    encodes++;
    return { data: img.value };
  });
  return { guest, stream, encodes: () => encodes, paint: (img) => guest.emit('paint', {}, {}, img) };
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
  } finally {
    guest.emit('destroyed');
  }
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
    paint(image('new', 390));
    assert.equal((await next).data, 'new');
    assert.equal((await stream(guest, 'new', { width: 390, height: 400 })).data, 'new');
    const changing = stream(guest, 'another');
    guest.emit('did-start-navigation', {}, 'https://another', false, true);
    await assert.rejects(changing, /page changed during capture/);
  } finally {
    guest.emit('destroyed');
  }
});

test('a paint at another size releases the waiting read instead of holding it to its deadline', async () => {
  const { guest, stream, paint } = fixture();
  try {
    const waiting = stream(guest, 'document', { width: 600, height: 400 });
    paint(image('resized', 700));
    await assert.rejects(waiting, /page changed during capture/);
    const resized = stream(guest, 'document:700', { width: 700, height: 400 });
    paint(image('settled', 700));
    assert.equal((await resized).data, 'settled');
  } finally {
    guest.emit('destroyed');
  }
});

test('destruction releases a pending display read rather than retaining listeners or pixels', async () => {
  const { guest, stream } = fixture();
  const waiting = stream(guest, 'document');
  guest.emit('destroyed');
  await assert.rejects(waiting, /not ready/);
  assert.equal(guest.listenerCount('paint'), 0);
  assert.equal(guest.listenerCount('did-start-navigation'), 0);
});

test('asynchronous encoding cannot publish pixels across navigation or destruction', async () => {
  for (const event of ['did-start-navigation', 'destroyed']) {
    const guest = new EventEmitter();
    guest.invalidate = () => guest.emit('paint', {}, {}, image('first'));
    let finish;
    const stream = createBrowserDisplayStream(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const waiting = stream(guest, 'document');
    await new Promise((resolve) => setImmediate(resolve));
    guest.emit(event, {}, 'https://new', false, true);
    finish({ data: 'old' });
    await assert.rejects(waiting, /page changed during capture/);
    guest.emit('destroyed');
  }
});

test('a paint arriving during encoding is not cached as the image being encoded', async () => {
  const guest = new EventEmitter();
  guest.invalidate = () => guest.emit('paint', {}, {}, image('first'));
  const pending = [];
  const stream = createBrowserDisplayStream(
    (img) =>
      new Promise((resolve) => {
        pending.push(() => resolve({ data: img.value }));
      })
  );
  try {
    const first = stream(guest, 'document');
    await new Promise((resolve) => setImmediate(resolve));
    guest.emit('paint', {}, {}, image('second'));
    pending.shift()();
    assert.equal((await first).data, 'first');
    const next = stream(guest, 'document');
    pending.shift()();
    assert.equal((await next).data, 'second');
    assert.equal((await stream(guest, 'document')).data, 'second');
    assert.equal(pending.length, 0);
  } finally {
    guest.emit('destroyed');
  }
});

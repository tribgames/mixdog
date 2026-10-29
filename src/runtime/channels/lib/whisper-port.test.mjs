import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import { listenerPidsInclude, selectWhisperPort, whisperListenerOwned } from './whisper-port.mjs';

test('listener pid parsing matches whole lines only', () => {
  assert.equal(listenerPidsInclude('4242\r\n', 4242), true);
  assert.equal(listenerPidsInclude('100\r\n4242\r\n', 4242), true);
  assert.equal(listenerPidsInclude('14242\r\n42420\r\n', 4242), false);
  assert.equal(listenerPidsInclude('', 4242), false);
});

test('occupied preferred port falls back without touching its listener, and ownership rejects another PID', async () => {
  const foreign = net.createServer((socket) => socket.end());
  await new Promise((resolve) => foreign.listen(0, '127.0.0.1', resolve));
  const occupied = foreign.address().port;
  try {
    const selected = await selectWhisperPort('127.0.0.1', occupied);
    assert.notEqual(selected, occupied);
    assert.ok(selected > 0 && selected < 65536);
    assert.equal(foreign.listening, true);
    const owned = whisperListenerOwned('127.0.0.1', occupied, process.pid);
    assert.ok(owned instanceof Promise, 'ownership query is asynchronous');
    assert.equal(await owned, true);
    assert.equal(await whisperListenerOwned('127.0.0.1', occupied, process.pid + 1), false);
    assert.equal(await selectWhisperPort('127.0.0.1', selected), selected);
  } finally {
    await new Promise((resolve) => foreign.close(resolve));
  }
});

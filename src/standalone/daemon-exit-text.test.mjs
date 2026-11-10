import assert from 'node:assert/strict';
import test from 'node:test';
import { daemonUnavailableError } from './session-client/daemon-unavailable.mjs';

function line(exitCode) {
  const error = daemonUnavailableError({
    candidate: { pid: 1, exitedAt: 1, exitCode, exitSignal: null, uptimeMs: 5 },
    spawnAttempts: 1,
    maxSpawnAttempts: 1,
  });
  return error.message.split('\n').find((l) => l.startsWith('last daemon candidate'));
}

test('exit text names OOM and V8 fatal error exits and keeps the number', () => {
  assert.match(line(134), /code=134 \(V8 fatal error \(JavaScript heap out of memory\)\)/);
  assert.match(line(0xe0000008), /code=0xE0000008 \(out of memory\)/);
  assert.match(line(-536870904), /code=-536870904 \(out of memory\)/);
});

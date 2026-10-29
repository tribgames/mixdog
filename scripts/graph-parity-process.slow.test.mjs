import assert from 'node:assert/strict';
import test from 'node:test';
import { runProcess } from './graph-parity.mjs';

// A real hung child and a real deadline: the subject is the process kill.
test('runProcess times out and kills a hung child', async () => {
  await assert.rejects(
    () => runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { timeoutMs: 400 }),
    /timed out after 400ms/
  );
});

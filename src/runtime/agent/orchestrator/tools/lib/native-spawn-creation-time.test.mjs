import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test, { mock } from 'node:test';

// A scripted spawn server: ready with the required lifecycle caps, and every
// spawn request answered with the 'spawned' event of the version under test.
let spawnedFields = {};
const scriptedServer = () => {
  const server = new EventEmitter();
  server.stdin = new PassThrough();
  server.stdout = new PassThrough();
  server.ref = () => {};
  server.unref = () => {};
  server.kill = () => true;
  let buffered = '';
  server.stdin.on('data', (chunk) => {
    buffered += chunk;
    for (let newline = buffered.indexOf('\n'); newline >= 0; newline = buffered.indexOf('\n')) {
      const request = JSON.parse(buffered.slice(0, newline));
      buffered = buffered.slice(newline + 1);
      // Answered on a later turn, as a real server's reply arrives.
      const reply = { id: request.id, event: 'spawned', pid: 4242, ...spawnedFields };
      if (request.program) setImmediate(() => server.stdout.write(`${JSON.stringify(reply)}\n`));
    }
  });
  queueMicrotask(() =>
    server.stdout.write(
      `${JSON.stringify({ ready: true, caps: { trackedForeground: true, promoteTask: true, cancelOwner: true } })}\n`
    )
  );
  return server;
};
mock.module('node:child_process', {
  namedExports: { ...childProcess, spawn: scriptedServer },
  defaultExport: { ...childProcess.default, spawn: scriptedServer },
});
const client = await import('./native-spawn-client.mjs');

async function spawnRoot() {
  const native = client.tryNativeSpawn({ shell: 'cmd.exe', argv: [] });
  await new Promise((resolve) => native.child.once('spawn', resolve));
  return native.child;
}

test('a root carries the kernel creation time its spawn server reports, and none from an older server', async () => {
  client._setNativeSpawnBinaryForTest(process.execPath);
  try {
    await client.ensureNativeSpawnServer();
    spawnedFields = { creationTime: '134062416010000045' };
    assert.equal((await spawnRoot()).creationTime, '134062416010000045');
    spawnedFields = {};
    const fromOlderServer = await spawnRoot();
    assert.equal(fromOlderServer.pid, 4242);
    assert.equal(fromOlderServer.creationTime, null);
  } finally {
    client._resetNativeSpawnClientForTest();
  }
});

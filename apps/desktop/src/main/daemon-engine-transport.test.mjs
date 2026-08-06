import assert from 'node:assert/strict';
import test from 'node:test';

import { DaemonEngineTransport } from './daemon-engine-transport.ts';

const options = {
  userDataPath: 'C:/tmp/mixdog',
  packaged: true,
  resourcesPath: 'C:/tmp/resources',
  appPath: 'C:/tmp/resources/app.asar',
};

function waitFor(predicate, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const value = predicate();
      if (value) return resolve(value);
      if (Date.now() - started > timeoutMs) return reject(new Error('timed out'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

test('failed desktop initialization closes its daemon attachment and preserves the cause', async () => {
  let closeCalls = 0;
  const calls = [];
  const failure = new Error('plain Node could not import the desktop backend');
  const transport = new DaemonEngineTransport(
    'file:///C:/tmp/desktop-backend-daemon.cjs',
    process.cwd(),
    async () => ({
      ensureEngineDaemon: async () => ({ pid: process.pid, port: 1, token: 'test' }),
      attachEngineDaemon: async () => ({
        async call(name) {
          calls.push(name);
          if (name === 'desktop.init') throw failure;
          return { ok: true };
        },
        async close() { closeCalls += 1; },
      }),
    }),
  );
  let exit = null;
  transport.on('exit', (code, cause) => { exit = { code, cause }; });
  transport.postMessage({ kind: 'init', options });

  await waitFor(() => exit);
  assert.equal(exit.code, 1);
  assert.equal(exit.cause, failure);
  assert.equal(closeCalls, 1);
  assert.deepEqual(calls, ['desktop.init', 'desktop.unsubscribe']);
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

// Isolate listener failures: an incorrect bind/stop race can leave an orphan
// socket or an uncaught callback, neither of which may stall the test runner.
function runTransportCase(kind, body) {
  const name = kind === 'session' ? 'createSessionTransport' : 'createChannelTransport';
  const source = `
    import assert from 'node:assert/strict';
    import { setImmediate } from 'node:timers/promises';
    import { ${name} as createTransport } from ${JSON.stringify(new URL(`./${kind}-transport.mjs`, import.meta.url).href)};
    import { SESSION_PROTOCOL, SESSION_REVISION } from ${JSON.stringify(new URL('./session-wire.mjs', import.meta.url).href)};
    ${body}
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
}

for (const kind of ['session', 'channel']) {
  test(`${kind} concurrent starts share one listening socket`, () => {
    runTransportCase(
      kind,
      `
      const transport = createTransport({ handleCall: async () => null });
      const [first, second] = await Promise.all([transport.start(), transport.start()]);
      assert.deepEqual(first, second);
      assert.ok(first.port > 0);
      await transport.stop();
    `
    );
  });

  test(`${kind} stop cancels a pending bind without a late server or callback`, () => {
    runTransportCase(
      kind,
      `
      const transport = createTransport({ handleCall: async () => null });
      const rejected = assert.rejects(transport.start(), /HTTP listener stopped/);
      await transport.stop();
      await rejected;
      await setImmediate();
      await assert.rejects(transport.start(), /transport is closed/);
    `
    );
  });

  test(`${kind} concurrent stops wait for the same active request to drain`, () => {
    runTransportCase(
      kind,
      `
      const entered = Promise.withResolvers();
      const released = Promise.withResolvers();
      const transport = createTransport({
        handleCall: async () => { entered.resolve(); await released.promise; return null; },
      });
      const endpoint = await transport.start();
      const post = async (path, body) => {
        const response = await fetch('http://127.0.0.1:' + endpoint.port + path, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-mixdog-daemon-token': endpoint.token,
            connection: 'close',
          },
          body: JSON.stringify(body),
        });
        const value = await response.json();
        assert.equal(response.ok, true, JSON.stringify(value));
        return value;
      };
      const client = await post('/client/register', {
        leadPid: process.pid, passive: true, protocol: SESSION_PROTOCOL, revision: SESSION_REVISION,
      });
      const request = post('/call', { token: client.token, name: 'hold', args: {} });
      request.catch(entered.reject);
      await entered.promise;
      const first = transport.stop();
      let secondReturned = false;
      const second = transport.stop().then(() => { secondReturned = true; });
      await setImmediate();
      try { assert.equal(secondReturned, false); }
      finally {
        released.resolve();
        await Promise.all([first, second, request]);
      }
    `
    );
  });
}

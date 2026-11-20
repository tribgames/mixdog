// The phone's source-control adapter: every request it writes carries the call's claim, and a connection that ends during a call
// reaches the router as the client's own error, which the router turns into the interruption error.
import assert from 'node:assert/strict';
import test from 'node:test';
import { adapter } from './remote-protocol-scm.ts';
import { runQueued } from './remote-protocol-queue.ts';
import { isRemoteConnectionInterruptedError } from './remote-connection-state.ts';
import { createProtocolRouter } from './remote-shim-protocol.ts';
import { scopeClient } from '../../../mobile/src/phone-send-scope.ts';
import { DIRECT_KEYS } from '../shared/desktop-api-split.ts';

// The API the desktop names as source control (DIRECT_KEYS.scm), plus the GitHub star and LibreOffice calls the phone answers beside it.
const SCM_CALLS = [...DIRECT_KEYS.scm, 'githubStarStatus', 'installLibreOffice', 'libreOfficeStatus', 'starGithub'];

test('the adapter answers exactly the 62 source-control calls, each as a function', () => {
  assert.equal(adapter.group, 'scm');
  assert.equal(new Set(SCM_CALLS).size, 62);
  for (const name of SCM_CALLS) assert.equal(typeof adapter.calls[name], 'function', name);
  assert.deepEqual(Object.keys(adapter.calls).sort(), [...SCM_CALLS].sort());
});
test("phone-scm forwards the call's `sent` claim on every request it writes (the router scopes the client per call)", async () => {
  const claim = () => {};
  const options = [];
  const client = {
    call: async (_method, _params, option) => {
      options.push(option?.sent);
      return null;
    },
  };
  const scoped = scopeClient(client, claim);
  await adapter.calls.gitStage([process.cwd(), ['a.txt']], { ctx: {}, client: () => scoped });
  assert.ok(options.length > 0);
  assert.ok(options.every((sent) => sent === claim));
});

test("a connection that ends during a call reaches the router as the client's own error, for the router to make the interruption error", async () => {
  for (const kind of ['connectionLost', 'clientClosed']) {
    const lost = Object.assign(new Error('connection ended'), { detail: { kind } });
    const host = {
      ctx: {},
      client: () => ({ server: { platformFamily: 'windows' }, call: async () => Promise.reject(lost) }),
    };
    await assert.rejects(
      runQueued({}, 'gitStatus', ['C:\\repo'], async () => adapter.calls.gitStatus(['C:\\repo'], host)),
      (error) => error === lost,
      kind
    );
  }
});

test('the router turns a connection that ends during a scm call into the interruption error', async () => {
  globalThis.window = { setTimeout: () => 0, clearTimeout() {} };
  for (const kind of ['connectionLost', 'clientClosed']) {
    const lost = Object.assign(new Error('connection ended'), { detail: { kind } });
    const host = {
      ctx: {},
      client: () => ({ server: { platformFamily: 'windows' }, call: async () => Promise.reject(lost) }),
      declareLane() {},
    };
    const ready = Promise.resolve();
    const router = createProtocolRouter([adapter], {
      host,
      started: () => ready,
      synced: () => ready,
      probe() {},
      silentSince: () => false,
    });
    await assert.rejects(
      router.call('gitStatus', ['C:\\\\repo']),
      (error) => isRemoteConnectionInterruptedError(error),
      kind
    );
  }
});

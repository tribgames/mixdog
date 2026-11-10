import './test-linux-display.mjs';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { _bridgeDiscoverySettledForTest } from '../bridge-discovery.mjs';
import { holdNextRead } from '../bridge-discovery.test-support.mjs';
import { makeTempEnvDir, writeBridgeDiscovery } from './bridge-env.test-support.mjs';
import {
  executeComputerTool,
  deferComputerSessionRelease,
  releaseComputerSession,
  releaseAllComputerSessions,
} from './client.mjs';

for (const outcome of ['released', 'cancelled', 'unconfirmed', 'cancelled_unconfirmed', 'shutdown']) {
  test(`in-flight cleanup serializes the next command: ${outcome}`, async () => {
    const cancelled = outcome === 'cancelled' || outcome === 'cancelled_unconfirmed';
    const confirmed = outcome !== 'unconfirmed' && outcome !== 'cancelled_unconfirmed';
    const continued = !cancelled && confirmed;
    const { directory, cleanup } = await makeTempEnvDir('MIXDOG_DATA_DIR', 'mixdog-release-race-');
    const originalFetch = globalThis.fetch;
    const calls = [];
    let acknowledge;
    let holdRelease = true;
    let releaseSent;
    const releaseOnWire = new Promise((resolve) => {
      releaseSent = resolve;
    });
    const reply = (ok = true) =>
      new Response(JSON.stringify({ ok, value: { text: 'ok' } }), {
        headers: { 'content-type': 'application/json' },
      });
    globalThis.fetch = async (_url, options) => {
      const command = JSON.parse(options.body);
      calls.push(command.action);
      if (command.action === 'session_release' && holdRelease) {
        releaseSent();
        return await new Promise((resolve) => {
          acknowledge = resolve;
        });
      }
      return reply();
    };
    try {
      await writeBridgeDiscovery(directory, { port: 12345, token: 'fixture-token' });
      const args = { action: 'list', input: { kind: 'windows' } };
      const sessionId = `release-${outcome}`;
      await executeComputerTool(args, { sessionId });
      const first = releaseComputerSession(sessionId);
      const second = releaseComputerSession(sessionId);
      assert.equal(deferComputerSessionRelease(sessionId, 20), false);
      const controller = new AbortController();
      const next = executeComputerTool(args, { sessionId, signal: controller.signal });
      // The release goes out once its fresh discovery read answers.
      await releaseOnWire;
      assert.deepEqual(calls, ['list_windows', 'session_release']);
      if (outcome === 'shutdown') {
        const keepAlive = setTimeout(() => {}, 1_000);
        try {
          assert.equal(await releaseAllComputerSessions(10), 0);
        } finally {
          clearTimeout(keepAlive);
        }
        assert.deepEqual(calls, ['list_windows', 'session_release']);
      }
      if (cancelled) {
        controller.abort(new Error('fixture cancellation'));
        assert.equal((await next).isError, true);
        assert.deepEqual(calls, ['list_windows', 'session_release', 'session_abort']);
      }
      holdRelease = false;
      acknowledge(reply(confirmed));
      assert.equal(await first, confirmed);
      assert.equal(await second, confirmed);
      const result = await next;
      assert.equal(result.isError === true, !continued);
      assert.equal(calls.filter((action) => action === 'list_windows').length, continued ? 2 : 1);
      if (continued) {
        assert.equal(
          deferComputerSessionRelease(sessionId, 60_000),
          true,
          'the old release acknowledgment must not erase the new host binding'
        );
      } else if (cancelled) {
        assert.equal(
          deferComputerSessionRelease(sessionId, 20),
          false,
          'a late failed release must not resurrect a successfully aborted session'
        );
      }
    } finally {
      holdRelease = false;
      acknowledge?.(reply());
      await releaseAllComputerSessions(1_000);
      globalThis.fetch = originalFetch;
      await cleanup();
    }
  });
}

// One session's commands against a fetch fixture; `hold` keeps session_release
// unanswered until `acknowledge(ok)`.
async function releaseFixture(t, prefix) {
  const { directory, cleanup } = await makeTempEnvDir('MIXDOG_DATA_DIR', prefix);
  const originalFetch = globalThis.fetch;
  const calls = [];
  const state = { hold: false, acknowledge: null, sent: null };
  const reply = (ok = true) =>
    new Response(JSON.stringify({ ok, value: { text: 'ok' } }), { headers: { 'content-type': 'application/json' } });
  globalThis.fetch = async (_url, options) => {
    const command = JSON.parse(options.body);
    calls.push(command.action);
    if (command.action === 'session_release') {
      state.sent?.();
      if (state.hold) {
        return await new Promise((resolve) => {
          state.acknowledge = (ok) => resolve(reply(ok));
        });
      }
    }
    return reply();
  };
  t.after(async () => {
    state.hold = false;
    state.acknowledge?.(true);
    await releaseAllComputerSessions(1_000);
    globalThis.fetch = originalFetch;
    await cleanup();
  });
  await writeBridgeDiscovery(directory, { port: 12345, token: 'fixture-token' });
  return { calls, state, discoveryPath: join(directory, 'computer-bridge.json') };
}

const listWindows = { action: 'list', input: { kind: 'windows' } };

test('a release that ends unconfirmed while the next command reads discovery still stops that command', async (t) => {
  const { calls, state, discoveryPath } = await releaseFixture(t, 'mixdog-release-settled-');
  const sessionId = 'release-settled-in-gap';
  await executeComputerTool(listWindows, { sessionId });
  state.hold = true;
  const onWire = new Promise((resolve) => {
    state.sent = resolve;
  });
  const release = releaseComputerSession(sessionId);
  await onWire;
  // No re-read of the watched copy is left to take the held read.
  await _bridgeDiscoverySettledForTest(discoveryPath);
  // The next command is asked for while that release is in flight, and its
  // discovery read is held until the release has failed and been forgotten.
  const { reached, release: answerRead } = holdNextRead(t, discoveryPath);
  const next = executeComputerTool(listWindows, { sessionId });
  await reached;
  state.acknowledge(false);
  assert.equal(await release, false);
  answerRead();
  const result = await next;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /computer_cleanup_pending/);
  assert.deepEqual(calls, ['list_windows', 'session_release'], 'no new input went out');
});

test('an idle release due while the next command reads discovery never releases under it', async (t) => {
  const { calls, discoveryPath } = await releaseFixture(t, 'mixdog-release-idle-');
  const sessionId = 'release-idle-in-gap';
  await executeComputerTool(listWindows, { sessionId });
  await _bridgeDiscoverySettledForTest(discoveryPath);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  assert.equal(deferComputerSessionRelease(sessionId, 5), true);
  const { reached, release: answerRead } = holdNextRead(t, discoveryPath);
  const next = executeComputerTool(listWindows, { sessionId });
  await reached;
  // The idle timer comes due while the command's read is out.
  t.mock.timers.tick(5);
  answerRead();
  assert.equal((await next).isError, undefined);
  assert.deepEqual(calls, ['list_windows', 'list_windows'], 'the session the command uses was not released');
});

test('a command refused before dispatch leaves the idle release due when it was', async (t) => {
  const { calls, state, discoveryPath } = await releaseFixture(t, 'mixdog-release-refused-');
  const sessionId = 'release-refused';
  await executeComputerTool(listWindows, { sessionId });
  await _bridgeDiscoverySettledForTest(discoveryPath);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  assert.equal(deferComputerSessionRelease(sessionId, 50), true);
  const refused = await executeComputerTool({ action: 'not-a-computer-action' }, { sessionId });
  assert.equal(refused.isError, true);
  assert.deepEqual(calls, ['list_windows'], 'the refused command sent nothing');
  const released = new Promise((resolve, reject) => {
    state.sent = resolve;
    // Not a mocked timer: the fixture's clock only moves when ticked.
    AbortSignal.timeout(5_000).addEventListener('abort', () => reject(new Error('the idle release never went out')));
  });
  t.mock.timers.tick(50);
  await released;
  assert.deepEqual(calls, ['list_windows', 'session_release']);
});

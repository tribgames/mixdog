import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
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
    const directory = await mkdtemp(join(tmpdir(), 'mixdog-release-race-'));
    const previousDirectory = process.env.MIXDOG_DATA_DIR;
    const originalFetch = globalThis.fetch;
    process.env.MIXDOG_DATA_DIR = directory;
    const calls = [];
    let acknowledge;
    let holdRelease = true;
    const reply = (ok = true) =>
      new Response(JSON.stringify({ ok, value: { text: 'ok' } }), {
        headers: { 'content-type': 'application/json' },
      });
    globalThis.fetch = async (_url, options) => {
      const command = JSON.parse(options.body);
      calls.push(command.action);
      if (command.action === 'session_release' && holdRelease) {
        return await new Promise((resolve) => {
          acknowledge = resolve;
        });
      }
      return reply();
    };
    try {
      await writeFile(
        join(directory, 'computer-bridge.json'),
        JSON.stringify({
          version: 1,
          port: 12345,
          token: 'fixture-token',
        })
      );
      const args = { action: 'list', input: { kind: 'windows' } };
      const sessionId = `release-${outcome}`;
      await executeComputerTool(args, { sessionId });
      const first = releaseComputerSession(sessionId);
      const second = releaseComputerSession(sessionId);
      assert.equal(deferComputerSessionRelease(sessionId, 20), false);
      const controller = new AbortController();
      const next = executeComputerTool(args, { sessionId, signal: controller.signal });
      await Promise.resolve();
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
      if (previousDirectory === undefined) delete process.env.MIXDOG_DATA_DIR;
      else process.env.MIXDOG_DATA_DIR = previousDirectory;
      await rm(directory, { recursive: true, force: true });
    }
  });
}

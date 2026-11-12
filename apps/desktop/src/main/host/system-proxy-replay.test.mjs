/**
 * Replay of `native/core/fixtures/system-proxy-cases/golden.json` (Node b6f10295a, apps/desktop/src/main/system-proxy.test.mjs)
 * cases 0-2 against the desktop code that does them in K1: `host/systemProxy/resolve` (host/system-proxy.ts), the window's
 * `answerSystemProxyRequest` and the daemon-side `createSystemProxyLease` (system-proxy.ts). Case 3 is replayed in Rust
 * (mixdog-ai netproxy/system_replay_tests.rs). The recording is read at run time and compared whole.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import * as daemonProxy from '../../../../../src/runtime/shared/llm/system-proxy.mjs';
import { answerSystemProxyRequest, createSystemProxyLease, SYSTEM_PROXY_REQUEST_EVENT } from '../system-proxy.ts';
import { HOST_METHOD } from './connection.ts';
import { registerSystemProxyHost } from './system-proxy.ts';

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), '../../../../../native/core/fixtures/system-proxy-cases/golden.json');
const recorded = (name) => JSON.parse(readFileSync(GOLDEN, 'utf8')).cases.find((entry) => entry.case.startsWith(name)).observed;

function hostHandler(resolveProxy) {
  const table = new Map();
  registerSystemProxyHost({ handleRequest: (method, handler) => table.set(method, handler) }, resolveProxy);
  return (params) => table.get(HOST_METHOD.systemProxyResolve)(params, new AbortController().signal);
}

test('case 0: the lookup event the desktop and the daemon module name is the recorded one', () => {
  const observed = recorded('the desktop and the runtime agree');
  assert.deepEqual({ desktopEvent: SYSTEM_PROXY_REQUEST_EVENT, daemonEvent: daemonProxy.SYSTEM_PROXY_REQUEST_EVENT }, observed);
});

test('case 1: the window answers a lookup with Chromium’s answer for its origin, and failures by name only', async () => {
  const observed = recorded('the window answers a lookup');
  const run = async (answer) => {
    const asked = [];
    const resolveProxy = async (url) => {
      if (url === 'https://b.test') throw new Error(observed.r3Throws);
      asked.push(url);
      return observed.chromiumAnswer;
    };
    return { settled: await answer(resolveProxy), asked };
  };

  const window = await run(async (resolveProxy) => {
    const settled = [];
    for (const request of observed.requests) {
      await answerSystemProxyRequest(request, resolveProxy, async (args) => settled.push(args));
    }
    return settled;
  });
  assert.deepEqual(window.asked, observed.chromiumAskedFor);
  assert.deepEqual(window.settled, observed.settled);

  // The host method carries the request's id in JSON-RPC, so a request without one is not a call of it.
  const host = await run(async (resolveProxy) => {
    const call = hostHandler(resolveProxy);
    const settled = [];
    for (const request of observed.requests.filter((entry) => typeof entry.id === 'string')) {
      try {
        settled.push([request.id, true, (await call({ url: request.args[0] })).rules, null]);
      } catch (error) {
        settled.push([request.id, false, null, error.message]);
      }
    }
    return settled;
  });
  assert.deepEqual(host.asked, observed.chromiumAskedFor);
  assert.deepEqual(host.settled, observed.settled);
});

test('case 2: the lease attaches one resolver while any asking client is connected', async () => {
  const observed = recorded('the lease attaches');
  const attached = [];
  let detached = 0;
  const load = async () => ({
    attachSystemProxyResolver: (resolve) => {
      attached.push(resolve);
      return () => {
        detached += 1;
      };
    },
  });
  const request = async () => 'DIRECT';
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const lease = createSystemProxyLease(load, request);
  const log = [];
  log.push({ step: 'attach(1)', answer: await lease.attach(1), attachedCount: attached.length });
  log.push({ step: 'attach(2)', answer: await lease.attach(2), attachedCount: attached.length, attachedIsTheRequestFunction: attached[0] === request });
  lease.release(1);
  log.push({ step: 'release(1): epoch 2 still attached, so nothing is detached', detached });
  lease.release(2);
  await settle();
  log.push({ step: 'release(2)', detached });
  log.push({ step: 'attach(NaN)', answer: await lease.attach(Number.NaN) });
  log.push({ step: 'older daemon without a per-origin resolver: attach(1)', answer: await createSystemProxyLease(() => undefined, request).attach(1) });
  assert.deepEqual({ log }, observed);
});

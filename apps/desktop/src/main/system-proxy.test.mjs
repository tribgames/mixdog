import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as daemonProxy from '../../../../src/runtime/shared/llm/system-proxy.mjs';
import {
  answerSystemProxyRequest,
  createSystemProxyLease,
  SYSTEM_PROXY_REQUEST_EVENT,
} from './system-proxy.ts';

const { adoptSystemProxy, systemProxyRoute } = daemonProxy;

test('the desktop and the runtime agree on the lookup event', () => {
  assert.equal(SYSTEM_PROXY_REQUEST_EVENT, daemonProxy.SYSTEM_PROXY_REQUEST_EVENT);
});

test('the window answers a lookup with Chromium’s answer for its origin, and failures by name only', async () => {
  const settled = [];
  const settle = async (args) => settled.push(args);
  const asked = [];
  const resolveProxy = async (url) => {
    asked.push(url);
    return 'PROXY proxy.corp:8080';
  };
  await answerSystemProxyRequest({ id: 'r1', method: 'resolveProxy', args: ['https://api.openai.com'] }, resolveProxy, settle);
  await answerSystemProxyRequest({ id: 'r2', args: ['file:///etc/passwd'] }, resolveProxy, settle);
  await answerSystemProxyRequest({ args: ['https://a.test'] }, resolveProxy, settle);
  await answerSystemProxyRequest(
    { id: 'r3', args: ['https://b.test'] },
    async () => {
      throw new Error('PAC http://user:pass@pac.corp/p.pac failed');
    },
    settle
  );
  assert.deepEqual(asked, ['https://api.openai.com']);
  assert.deepEqual(settled, [
    ['r1', true, 'PROXY proxy.corp:8080', null],
    ['r2', false, null, 'TypeError'],
    ['r3', false, null, 'Error'],
  ]);
});

test('the lease attaches one resolver while any asking client is connected', async () => {
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
  const lease = createSystemProxyLease(load, request);
  assert.equal(await lease.attach(1), true);
  assert.equal(await lease.attach(2), true);
  assert.deepEqual(attached, [request]);
  lease.release(1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(detached, 0, 'another client still asks');
  lease.release(2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(detached, 1);
  assert.equal(await lease.attach(Number.NaN), false);
  // An older daemon has no per-origin resolver.
  assert.equal(await createSystemProxyLease(() => undefined, request).attach(1), false);
});

test('an attached app routes the daemon per origin; when it leaves the fallback applies again', async () => {
  adoptSystemProxy(
    {},
    {
      platform: 'win32',
      reader: () => ({ proxyEnable: '0x1', proxyServer: '127.0.0.1:7890', proxyOverride: '<local>' }),
      apply: () => {},
      log: () => {},
    }
  );
  const pac = { 'api.openai.com': 'PROXY proxy.corp:8080', 'intranet.corp.example': 'DIRECT' };
  const lease = createSystemProxyLease(
    async () => daemonProxy,
    async (origin) => pac[new URL(origin).hostname] ?? 'PROXY other.corp:3128'
  );
  assert.deepEqual(systemProxyRoute('https://api.openai.com'), { proxy: 'http://127.0.0.1:7890' });
  await lease.attach(1);
  assert.deepEqual(await systemProxyRoute('https://api.openai.com'), { proxy: 'http://proxy.corp:8080' });
  assert.deepEqual(await systemProxyRoute('https://intranet.corp.example'), { proxy: null });
  assert.deepEqual(await systemProxyRoute('https://api.anthropic.com'), { proxy: 'http://other.corp:3128' });
  lease.release(1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(systemProxyRoute('https://intranet.corp.example'), { proxy: 'http://127.0.0.1:7890' });
  adoptSystemProxy({}, { platform: 'linux' });
});

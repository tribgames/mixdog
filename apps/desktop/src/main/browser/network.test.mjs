import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import { BrowserNetworkLedger, formatNetworkHeaders } from './network.ts';
import { BrowserConsoleLedger } from './console.ts';
import {
  browserDownloadExceedsLimit,
  browserDownloadSavePath,
  MAX_BROWSER_DOWNLOAD_BYTES,
  safeBrowserDownloadName,
} from './downloads.ts';
import { createBrowserIntercept } from './intercept.ts';
import { createBrowserInitScripts } from './init-scripts.ts';
import {
  browserStorageKeyIsSensitive,
  createBrowserPageState,
} from './page-state.ts';

test('browser network ledger records request, response, timing, and filters', () => {
  const ledger = new BrowserNetworkLedger();
  const request = ledger.requestWillBeSent({
    requestId: '10.1',
    type: 'Fetch',
    request: {
      method: 'POST',
      url: 'https://example.test/api/items',
      headers: { 'content-type': 'application/json' },
      postData: '{"name":"demo"}',
      hasPostData: true,
    },
  }, undefined, 1_000);
  assert.equal(request.id, 'r1');
  ledger.responseReceived({
    requestId: '10.1',
    type: 'Fetch',
    response: {
      status: 201,
      statusText: 'Created',
      headers: { 'content-type': 'application/json' },
      mimeType: 'application/json',
      protocol: 'h2',
    },
  });
  ledger.loadingFinished({ requestId: '10.1', encodedDataLength: 123 }, undefined, 1_075);

  assert.equal(ledger.pendingCount, 0);
  assert.equal(ledger.get('r1').status, 201);
  assert.equal(ledger.get('r1').finishedAt, 1_075);
  assert.deepEqual(
    ledger.list({ query: 'items', resourceTypes: ['fetch'] }).requests.map((entry) => entry.id),
    ['r1'],
  );
  assert.equal(ledger.list({ resourceTypes: ['image'] }).total, 0);
});

test('browser network reports redact custom credential headers', () => {
  assert.deepEqual(formatNetworkHeaders({
    'X-Auth-Token': 'opaque-value',
    'X-Amz-Security-Token': 'another-secret',
    Accept: 'application/json',
  }), [
    '- X-Auth-Token: [REDACTED]',
    '- X-Amz-Security-Token: [REDACTED]',
    '- Accept: application/json',
  ]);
});

test('browser storage diagnostics classify opaque credential keys', () => {
  assert.equal(browserStorageKeyIsSensitive('access_token'), true);
  assert.equal(browserStorageKeyIsSensitive('session-id'), true);
  assert.equal(browserStorageKeyIsSensitive('theme'), false);
});

test('browser network ledger keeps redirect hops distinct and records failures', () => {
  const ledger = new BrowserNetworkLedger();
  ledger.requestWillBeSent({
    requestId: '20.1',
    type: 'Document',
    request: { method: 'GET', url: 'https://example.test/old', headers: {} },
  }, 'frame', 2_000);
  ledger.requestWillBeSent({
    requestId: '20.1',
    type: 'Document',
    redirectResponse: {
      status: 302,
      statusText: 'Found',
      headers: { location: '/new' },
    },
    request: { method: 'GET', url: 'https://example.test/new', headers: {} },
  }, 'frame', 2_010);
  ledger.loadingFailed({
    requestId: '20.1',
    errorText: 'net::ERR_FAILED',
  }, 'frame', 2_020);

  assert.equal(ledger.get('r1').status, 302);
  assert.equal(ledger.get('r1').redirectedTo, 'https://example.test/new');
  assert.equal(ledger.get('r2').failure, 'net::ERR_FAILED');
  assert.deepEqual(ledger.list().requests.map((entry) => entry.id), ['r2', 'r1']);
});

test('browser network ledger reconciles a completed main document when CDP omits loadingFinished', () => {
  const ledger = new BrowserNetworkLedger();
  ledger.requestWillBeSent({
    requestId: '25.1',
    type: 'Document',
    request: { method: 'GET', url: 'https://example.test/page#old', headers: {} },
  }, undefined, 2_500);
  ledger.responseReceived({
    requestId: '25.1',
    type: 'Document',
    response: { status: 200, mimeType: 'text/html', headers: {} },
  });

  assert.equal(ledger.pendingCount, 1);
  assert.equal(ledger.finishDocument('https://example.test/page#new', 2_550), 1);
  assert.equal(ledger.pendingCount, 0);
  assert.equal(ledger.get('r1').finishedAt, 2_550);
});

test('browser network ledger reports the newest document status for a URL', () => {
  const ledger = new BrowserNetworkLedger();
  ledger.requestWillBeSent({
    requestId: '26.1',
    type: 'Document',
    request: { method: 'GET', url: 'https://example.test/missing', headers: {} },
  }, undefined, 2_600);
  ledger.responseReceived({
    requestId: '26.1',
    type: 'Document',
    response: { status: 404, statusText: 'Not Found', mimeType: 'text/html', headers: {} },
  });
  ledger.requestWillBeSent({
    requestId: '26.2',
    type: 'Fetch',
    request: { method: 'GET', url: 'https://example.test/missing', headers: {} },
  }, undefined, 2_610);
  ledger.responseReceived({
    requestId: '26.2',
    type: 'Fetch',
    response: { status: 500, statusText: 'Boom', headers: {} },
  });

  assert.deepEqual(ledger.documentStatus('https://example.test/missing#section'), {
    status: 404,
    statusText: 'Not Found',
  });
  assert.equal(ledger.documentStatus('https://example.test/other'), null);
  assert.equal(ledger.documentStatus(''), null);
});

test('browser network ledger records WebSocket handshakes and frames', () => {
  const ledger = new BrowserNetworkLedger();
  const socket = ledger.webSocketCreated({
    requestId: '30.1',
    url: 'wss://example.test/socket',
  }, undefined, 3_000);
  ledger.webSocketHandshakeResponse({
    requestId: '30.1',
    response: { status: 101, statusText: 'Switching Protocols', headers: {} },
  });
  ledger.webSocketFrame({
    requestId: '30.1',
    response: { opcode: 1, payloadData: 'hello server' },
  }, 'sent', undefined, 3_010);
  ledger.webSocketFrame({
    requestId: '30.1',
    response: { opcode: 1, payloadData: 'hello client' },
  }, 'received', undefined, 3_020);
  ledger.webSocketClosed({ requestId: '30.1' }, undefined, 3_030);

  assert.equal(socket.resourceType, 'websocket');
  assert.equal(socket.status, 101);
  assert.deepEqual(socket.webSocketFrames.map((frame) => frame.direction), ['sent', 'received']);
  assert.equal(socket.finishedAt, 3_030);
});

test('browser network ledger bounds pending requests and untrusted payload memory', () => {
  const ledger = new BrowserNetworkLedger(2);
  const oversized = 'x'.repeat(100_000);
  for (let index = 1; index <= 3; index += 1) {
    ledger.requestWillBeSent({
      requestId: String(index),
      type: 'Fetch',
      request: {
        method: 'POST',
        url: `https://example.test/${index}${oversized}`,
        headers: Object.fromEntries(
          Array.from({ length: 140 }, (_, header) => [`x-${header}`, oversized]),
        ),
        postData: oversized,
      },
    });
  }
  assert.equal(ledger.get('r1'), undefined);
  assert.equal(ledger.pendingCount, 2);
  const newest = ledger.get('r3');
  assert.ok(newest.url.length <= 16_384);
  assert.ok(newest.requestBody.length <= 64_000);
  assert.equal(Object.keys(newest.requestHeaders).length, 128);
  assert.ok(Object.values(newest.requestHeaders).every((value) => value.length <= 8_192));

  const socket = ledger.webSocketCreated({
    requestId: 'socket',
    url: 'wss://example.test/socket',
  });
  for (let index = 0; index < 120; index += 1) {
    ledger.webSocketFrame({
      requestId: 'socket',
      response: { opcode: 1, payloadData: oversized },
    }, 'received');
  }
  assert.ok(socket.webSocketFrames.length <= 100);
  assert.ok(
    socket.webSocketFrames.reduce((total, frame) => total + frame.data.length, 0) <= 256_000,
  );
});

test('browser console ledger bounds untrusted entries and its formatted report', () => {
  const ledger = new BrowserConsoleLedger();
  const oversized = 'page-console '.repeat(20_000);
  for (let index = 0; index < 30; index += 1) {
    ledger.record('error', `${index}:${oversized}`);
  }
  const report = ledger.format('all', '', 200);
  assert.match(report, /UNTRUSTED CONSOLE DATA/);
  assert.match(report, /\[truncated\]/);
  assert.ok(report.length < 45_000);
});

test('browser intercept mutations roll back when Chromium rejects the new pattern set', async () => {
  const guest = {};
  const intercept = createBrowserIntercept();
  await assert.rejects(
    intercept.interceptResult(
      guest,
      { operation: 'add', url: '*/api/*', body: 'fixture' },
      async () => { throw new Error('CDP unavailable'); },
    ),
    /CDP unavailable/,
  );
  assert.match(
    (await intercept.interceptResult(guest, { operation: 'list' }, async () => {})).text,
    /No intercept rules are active/,
  );

  const added = await intercept.interceptResult(
    guest,
    { operation: 'add', url: '*/api/*', body: 'fixture' },
    async () => {},
  );
  const id = added.text.match(/\[(i\d+)\]/)?.[1];
  assert.ok(id);
  await assert.rejects(
    intercept.interceptResult(
      guest,
      { operation: 'remove', ruleId: id },
      async () => { throw new Error('CDP unavailable'); },
    ),
    /CDP unavailable/,
  );
  assert.match(
    (await intercept.interceptResult(guest, { operation: 'list' }, async () => {})).text,
    new RegExp(`\\[${id}\\]`),
  );
});

test('browser downloads stay inside the download directory with stable collision handling', () => {
  assert.equal(safeBrowserDownloadName('../secrets.txt'), 'secrets.txt');
  assert.equal(safeBrowserDownloadName('..\\..\\NUL.txt'), '_NUL.txt');
  assert.equal(safeBrowserDownloadName('bad:name?.json'), 'bad_name_.json');

  const directory = join('safe', 'downloads');
  const occupied = new Set([
    join(directory, 'report.pdf'),
    join(directory, 'rs-report.pdf'),
  ]);
  const destination = browserDownloadSavePath(directory, '../report.pdf', {
    exists: (path) => occupied.has(path),
    now: () => 1_000,
  });
  assert.equal(destination.file, 'report.pdf');
  assert.equal(destination.path, join(directory, 'rs-1-report.pdf'));
  assert.equal(browserDownloadExceedsLimit(0, MAX_BROWSER_DOWNLOAD_BYTES), false);
  assert.equal(browserDownloadExceedsLimit(MAX_BROWSER_DOWNLOAD_BYTES + 1, -1), true);
  assert.equal(browserDownloadExceedsLimit(0, -1, 3 * 1024 * 1024 * 1024), true);
});

test('clearing init scripts preserves untouched entries when cancellation lands midway', async () => {
  const guest = {};
  const controller = new AbortController();
  let identifiers = 0;
  let removals = 0;
  const scripts = createBrowserInitScripts({
    cdp: {
      call: async (_guest, method) => {
        if (method === 'Page.addScriptToEvaluateOnNewDocument') {
          identifiers += 1;
          return { identifier: `chromium-${identifiers}` };
        }
        removals += 1;
        if (removals === 2) {
          controller.abort(new Error('fixture cancelled'));
          throw controller.signal.reason;
        }
        return {};
      },
    },
  });
  await scripts.initScriptResult(guest, { operation: 'add', script: 'window.one = 1' });
  await scripts.initScriptResult(guest, { operation: 'add', script: 'window.two = 2' });

  await assert.rejects(
    scripts.initScriptResult(guest, { operation: 'clear' }, controller.signal),
    /fixture cancelled/,
  );
  const listed = await scripts.initScriptResult(guest, { operation: 'list' });
  assert.doesNotMatch(listed.text, /\[is1\]/);
  assert.match(listed.text, /\[is2\]/);
});

test('cookie observations redact common tokens and cap oversized profiles', async () => {
  const secret = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890';
  const cookies = Array.from({ length: 205 }, (_, index) => ({
    name: `cookie-${index}`,
    value: index === 0 ? secret : `value-${index}`,
    domain: 'example.test',
    path: '/',
    secure: true,
    httpOnly: true,
    session: true,
    sameSite: 'lax',
  }));
  const pageState = createBrowserPageState({
    partitionSession: {
      cookies: {
        get: async () => cookies,
        set: async () => {},
        remove: async () => {},
      },
    },
    urlPolicy: () => ({}),
    evaluate: async () => undefined,
    invalidateInteractionState() {},
    formatEvaluationValue: () => '',
  });
  const result = await pageState.cookiesResult({
    getURL: () => 'https://example.test/',
  }, { operation: 'list' });
  assert.match(result.text, /UNTRUSTED PAGE DATA/);
  assert.match(result.text, /Cookies \(205; showing 200\)/);
  assert.doesNotMatch(result.text, new RegExp(secret));
  assert.doesNotMatch(result.text, /cookie-204/);
  assert.ok(result.text.length < 25_000);
});

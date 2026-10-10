import assert from 'node:assert/strict';
import test from 'node:test';

import { BROWSER_REMOTE_METHODS, browserParityRemoteMethods, runBrowserRemoteRequest } from './remote-browser-methods.ts';

const CREDENTIAL = 'a'.repeat(24);

test('every parity call is validated, then forwarded to the window process', async () => {
  const requests = [];
  const methods = browserParityRemoteMethods(async (method, args, timeoutMs) => {
    requests.push([method, args, timeoutMs]);
    return method;
  });
  const request = { jobId: 'job12345', sourceId: 'chrome', profileId: 'Default', items: ['history'] };
  await methods.browserRemoteTabOpen(['https://a.test/']);
  await methods.browserRemoteTabClose(['main-browser-a']);
  await methods.browserHistorySearch(['exa']);
  await methods.browserCredentialSuggestions(['main-browser-a']);
  await methods.browserCredentialFill(['main-browser-a', CREDENTIAL]);
  await methods.browserProfileImportSources([]);
  await methods.browserProfileImportStart([request]);
  assert.deepEqual(
    requests.map(([method]) => method),
    ['tabOpen', 'release', 'history', 'credentialSuggestions', 'credentialFill', 'importSources', 'importStart']
  );
  assert.ok(requests.every(([method]) => BROWSER_REMOTE_METHODS.has(method)));
  assert.deepEqual(requests[6][1], [{ ...request, administratorApproved: false }]);
  assert.ok(requests[6][2] > 60_000, 'an import may wait on the host administrator prompt');
  assert.deepEqual(requests[4][1], ['main-browser-a', CREDENTIAL]);
});

test('invalid parity input never reaches the window process', () => {
  const requests = [];
  const methods = browserParityRemoteMethods(async (...args) => requests.push(args));
  assert.throws(() => methods.browserRemoteTabOpen(['']), /url is invalid/);
  assert.throws(() => methods.browserRemoteTabClose(['conversation-1']), /not a main tab page/);
  assert.throws(() => methods.browserHistorySearch(['x'.repeat(501)]), /history query/);
  assert.throws(() => methods.browserCredentialFill(['main-browser-a', 'nope']), /credential id/);
  assert.throws(() => methods.browserProfileImportStart([{ jobId: 'x' }]), /job id/);
  assert.equal(requests.length, 0);
  assert.throws(() => browserParityRemoteMethods(undefined).browserProfileImportSources([]), /unavailable/);
});

test('the window end dispatches each method to the browser host', async () => {
  const calls = [];
  const host = new Proxy(
    {},
    {
      get: (_target, name) => async (...args) => {
        calls.push([name, args]);
        return name;
      },
    }
  );
  await runBrowserRemoteRequest(host, 'tabsWatch', [true]);
  await runBrowserRemoteRequest(host, 'tabOpen', ['https://a.test/']);
  await runBrowserRemoteRequest(host, 'history', ['q']);
  await runBrowserRemoteRequest(host, 'credentialSuggestions', ['main-browser-a']);
  await runBrowserRemoteRequest(host, 'credentialFill', ['main-browser-a', CREDENTIAL]);
  await runBrowserRemoteRequest(host, 'importSources', []);
  await runBrowserRemoteRequest(host, 'release', ['main-browser-a']);
  assert.deepEqual(calls, [
    ['remoteTabsWatch', [true]],
    ['remoteTabOpen', ['https://a.test/']],
    ['browserHistorySearch', ['q']],
    ['browserCredentialSuggestions', ['main-browser-a']],
    ['browserCredentialFill', ['main-browser-a', CREDENTIAL]],
    ['browserImportSources', []],
    ['releaseSession', ['main-browser-a']],
  ]);
});

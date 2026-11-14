import assert from 'node:assert/strict';
import test from 'node:test';

import {
  externalLinkTarget,
  isRemoteHostNavigation,
  remoteHostPartition,
  remoteWindowTitle,
  remoteWindowUserAgent,
  touchesHostLists,
  watchHostListsFeed,
} from './remote-hosts.ts';

test('each host gets its own persistent partition', () => {
  const a = '0123456789abcdef';
  const b = 'fedcba9876543210';
  assert.notEqual(a, b);
  assert.equal(remoteHostPartition(a), `persist:remote-host-${a}`);
  assert.match(remoteWindowTitle('Office PC'), /Connected to Office PC/);
});

test('the window presents an ordinary browser so the page installs the relay shim', () => {
  const ua =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) mixdog/1.0.12 Chrome/140.0.0.0 Electron/41.0.0 Safari/537.36';
  const rewritten = remoteWindowUserAgent(ua, 'mixdog');
  assert.doesNotMatch(rewritten, /Electron/i);
  assert.doesNotMatch(rewritten, /mixdog\/1\.0\.12/);
  assert.match(rewritten, /Chrome\/140/);
  assert.match(rewritten, /MixdogDesktop\/1$/);
});

const DEVICE = '0123456789abcdef0123456789abcdef';
const LINK = `https://relay.example.com/d/${DEVICE}/`;

test('same-origin navigation stays in the window; links leave through the OS', () => {
  assert.equal(isRemoteHostNavigation(LINK, `https://relay.example.com/d/${DEVICE}/assets/x.js`), true);
  assert.equal(isRemoteHostNavigation(LINK, 'https://evil.example.com/'), false);
  assert.equal(isRemoteHostNavigation(LINK, 'garbage'), false);
  assert.equal(externalLinkTarget('https://example.com/a'), 'https://example.com/a');
  assert.equal(externalLinkTarget('mailto:a@example.com'), 'mailto:a@example.com');
  assert.equal(externalLinkTarget('file:///C:/Windows/system32/cmd.exe'), null);
  assert.equal(externalLinkTarget('javascript:alert(1)'), null);
});


test('only a change of the hosts key of the connections feed touches the host lists', () => {
  const update = (section, key) => ({ method: 'connections/updated', params: { section, key } });
  assert.equal(touchesHostLists(update('connections', 'hosts')), true);
  assert.equal(touchesHostLists(update('connections', 'link/srv')), false);
  assert.equal(touchesHostLists(update('other', 'hosts')), false);
  assert.equal(
    touchesHostLists({ method: 'feed/snapshot', params: { state: { sections: [{ section: 'connections', key: 'hosts' }] } } }),
    true
  );
  assert.equal(touchesHostLists({ method: 'feed/snapshot', params: {} }), false);
  assert.equal(touchesHostLists(null), false);
});

test('the host-lists watch notifies on a change, subscribes again after the link returns, and stops cleanly', async () => {
  const calls = [];
  let listener = null;
  const source = {
    call: async (method, params) => {
      calls.push([method, params]);
      return method === 'connections/subscribe' ? { id: `sub-${calls.length}` } : {};
    },
    onEvent: (next) => {
      listener = next;
      return () => {
        listener = null;
      };
    },
  };
  let changes = 0;
  const stop = watchHostListsFeed(source, () => (changes += 1), () => {});
  await new Promise((resolve) => setImmediate(resolve));
  listener({ type: 'notification', notification: { method: 'connections/updated', params: { section: 'connections', key: 'hosts' } } });
  listener({ type: 'notification', notification: { method: 'connections/updated', params: { section: 'connections', key: 'ports/a' } } });
  assert.equal(changes, 1);
  listener({ type: 'status', status: { state: 'down' } });
  listener({ type: 'status', status: { state: 'ready' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.map(([method]) => method), ['connections/subscribe', 'connections/subscribe']);
  stop();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(listener, null);
  assert.deepEqual(calls.at(-1), ['connections/unsubscribe', { subscriptionId: 'sub-2' }], 'the live subscription is released');
});

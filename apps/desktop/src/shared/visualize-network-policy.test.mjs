import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BLOCKED_NETWORK_CSP,
  blockedNetworkMessage,
  blockedResourceType,
  isOutsideNetworkUrl,
  OUTSIDE_NETWORK_URL_PATTERNS,
} from './visualize-network-policy.ts';

test('the outside network is http, https, ws and wss only', () => {
  assert.deepEqual(OUTSIDE_NETWORK_URL_PATTERNS, ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*']);
  for (const url of ['http://a/', 'https://a/x', 'ws://a/', 'wss://a/'])
    assert.equal(isOutsideNetworkUrl(new URL(url)), true, url);
  for (const url of ['data:,x', 'blob:https://a/1', 'file:///x', 'about:blank'])
    assert.equal(isOutsideNetworkUrl(new URL(url)), false, url);
  assert.equal(blockedNetworkMessage('cdn.example', 'script'), 'cdn.example (script)');
});

test('the page CSP lists no network source, keeping inline code, data: and blob:', () => {
  assert.equal(BLOCKED_NETWORK_CSP, "default-src data: blob: 'unsafe-inline' 'unsafe-eval'");
  assert.doesNotMatch(BLOCKED_NETWORK_CSP, /https?:|wss?:|\*/);
});

test('a refusal maps to the Electron resource type the desktop reports', () => {
  const http = new URL('https://a/x');
  const cases = [
    ['script-src-elem', 'script'],
    ['img-src', 'image'],
    ['style-src-elem', 'stylesheet'],
    ['font-src', 'font'],
    ['media-src', 'media'],
    ['frame-src', 'subFrame'],
    ['connect-src', 'xhr'],
    ['default-src', 'other'],
    ['', 'other'],
  ];
  for (const [directive, type] of cases) assert.equal(blockedResourceType(directive, http), type, directive);
  assert.equal(blockedResourceType('connect-src', new URL('wss://a/s')), 'webSocket');
});

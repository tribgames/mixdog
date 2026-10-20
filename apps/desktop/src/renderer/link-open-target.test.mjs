import test from 'node:test';
import assert from 'node:assert/strict';

import { linkOpenTarget } from './link-open-target.ts';

test('a web link opens in the pane only when a session pane can be revealed', () => {
  assert.equal(linkOpenTarget({ sessionId: 's1', paneAvailable: true }), 'pane');
  assert.equal(linkOpenTarget({ sessionId: 's1', paneAvailable: false }), 'external');
  assert.equal(linkOpenTarget({ sessionId: undefined, paneAvailable: true }), 'external');
  assert.equal(linkOpenTarget({ sessionId: '', paneAvailable: true }), 'external');
  assert.equal(linkOpenTarget({ sessionId: 'new-task', paneAvailable: true }), 'external');
  assert.equal(linkOpenTarget({ sessionId: 's1', paneAvailable: true, external: true }), 'external');
  assert.equal(linkOpenTarget({ sessionId: 's1', paneAvailable: true, external: false }), 'pane');
});

test('a clicked remote http(s) page goes to the system browser; local and preview targets stay in the pane', () => {
  const route = (url, external) => linkOpenTarget({ sessionId: 's1', paneAvailable: true, url, external });
  for (const url of [
    'https://docs.google.com/document/d/abc/edit',
    'http://example.com/',
    'HTTPS://Example.com/x',
    'http://192.168.0.5:3000/',
  ]) {
    assert.equal(route(url), 'external', url);
  }
  for (const url of [
    'http://localhost:5173/',
    'https://localhost/',
    'http://127.0.0.1:4000/page.html',
    'http://[::1]:8080/',
    'file:///C:/work/index.html',
    'mixdog-media://asset/abc?variant=thumb',
  ]) {
    assert.equal(route(url), 'pane', url);
  }
  // Shift-click / "Mixdog Browser" menu entry keep a remote page in the pane.
  assert.equal(route('https://docs.google.com/', false), 'pane');
  assert.equal(route('http://localhost:5173/', true), 'external');
  // No pane to reveal: still the system browser, local or not.
  assert.equal(linkOpenTarget({ sessionId: 's1', paneAvailable: false, url: 'http://localhost:5173/' }), 'external');
});

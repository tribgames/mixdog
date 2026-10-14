import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { followBrowserDisplayScale } from './scale-follower.ts';

function fakeScreen() {
  const screen = new EventEmitter();
  screen.scaleFactor = 1;
  screen.getPrimaryDisplay = () => ({ scaleFactor: screen.scaleFactor });
  return screen;
}

test('refreshes only on a primary scale change and reports the first failure once', () => {
  const screen = fakeScreen();
  let refreshes = 0;
  let fail = false;
  const diagnostics = [];
  const stop = followBrowserDisplayScale(
    screen,
    () => {
      refreshes += 1;
      if (fail) throw new Error('boom');
    },
    (event, data) => diagnostics.push([event, data])
  );
  screen.emit('display-added');
  assert.equal(refreshes, 0);
  screen.scaleFactor = 2;
  screen.emit('display-metrics-changed');
  assert.equal(refreshes, 1);
  fail = true;
  screen.scaleFactor = 1.5;
  screen.emit('display-removed');
  screen.scaleFactor = 1.25;
  screen.emit('display-removed');
  assert.deepEqual(diagnostics, [['browser-scale-refresh-failed', { message: 'boom' }]]);
  stop();
  for (const event of ['display-metrics-changed', 'display-added', 'display-removed']) {
    assert.equal(screen.listenerCount(event), 0);
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { createTurnAttention } from './turn-attention.ts';

function attention({ focused = false, allows = () => true } = {}) {
  const flashes = [];
  const bounces = [];
  const asked = [];
  const instance = createTurnAttention({
    isFocused: () => focused,
    flashFrame: (flag) => flashes.push(flag),
    bounceDock: () => bounces.push(true),
    allows: (sessionId) => {
      asked.push(sessionId);
      return allows(sessionId);
    },
  });
  const finish = (sessionId = 's1') => {
    instance.onSnapshot({ sessionId, busy: true });
    instance.onSnapshot({ sessionId, busy: false });
  };
  return { instance, flashes, bounces, asked, finish };
}

test('a finished turn in an unfocused window flashes and bounces; focus clears it', () => {
  const a = attention();
  a.finish();
  assert.deepEqual(a.flashes, [true]);
  assert.equal(a.bounces.length, 1);
  assert.deepEqual(a.asked, ['s1']);
  a.instance.onFocus();
  assert.deepEqual(a.flashes, [true, false]);
});

test('this PC’s preferences can withhold the flash for that session', () => {
  const a = attention({ allows: (sessionId) => sessionId !== 'muted' });
  a.finish('muted');
  assert.deepEqual(a.flashes, []);
  assert.equal(a.bounces.length, 0);
  a.instance.onFocus();
  assert.deepEqual(a.flashes, [], 'nothing to clear');
  a.finish('open');
  assert.deepEqual(a.flashes, [true]);
});

test('a focused window neither flashes nor asks', () => {
  const a = attention({ focused: true });
  a.finish();
  assert.deepEqual(a.flashes, []);
  assert.deepEqual(a.asked, []);
});

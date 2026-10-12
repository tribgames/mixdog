import assert from 'node:assert/strict';
import test from 'node:test';
import { createGnomeIndicator, indicatorSpec, INDICATOR_REFRESH_MS } from './gnome-indicator.ts';

const presentation = (over = {}) => ({
  visible: true, sessionIds: ['s'], title: 'Computer in use', accent: '#58a6ff', paused: false, resumable: false, generation: 0, attention: false, ...over,
});

function harness({ failSend = false } = {}) {
  const state = { sent: [], timers: [], warns: [] };
  const deps = {
    async send(spec) {
      state.sent.push(spec);
      if (failSend) throw new Error('gdbus: no such object');
    },
    setInterval: (callback, ms) => (state.timers.push({ callback, ms, cleared: false }), state.timers.at(-1)),
    clearInterval: (timer) => (timer.cleared = true),
    warn: (message) => state.warns.push(message),
  };
  return { state, indicator: createGnomeIndicator('en', deps) };
}

test('the pill carries the overlay title, accent, paused/attention state and the Stop hint (Korean wording for ko)', () => {
  assert.deepEqual(indicatorSpec(presentation(), 'en'), {
    visible: true, title: 'Computer in use', hint: 'Stop Ctrl+Alt+Esc', accent: '#58a6ff', paused: false, attention: false,
  });
  assert.equal(indicatorSpec(presentation({ paused: true, title: '대기 중' }), 'ko-KR').hint, '중단 Ctrl+Alt+Esc');
  assert.deepEqual(indicatorSpec(presentation({ visible: false }), 'en'), { visible: false });
});

test('identical presentations are sent once; a change, then a hide, are sent; refresh runs only while visible', async () => {
  const { state, indicator } = harness();
  await indicator.show(presentation());
  await indicator.show(presentation());
  assert.equal(state.sent.length, 1);
  assert.equal(state.timers.length, 1);
  assert.equal(state.timers[0].ms, INDICATOR_REFRESH_MS);
  state.timers[0].callback();
  assert.equal(state.sent.length, 2, 'the refresh re-sends so the extension does not expire the pill');
  await indicator.show(presentation({ attention: true, title: 'Check' }));
  assert.equal(state.sent.at(-1).attention, true);
  await indicator.show(presentation({ visible: false }));
  assert.deepEqual(state.sent.at(-1), { visible: false });
  assert.equal(state.timers[0].cleared, true);
});

test('dispose hides a visible pill and stops the refresh; a failing helper warns once', async () => {
  const live = harness();
  await live.indicator.show(presentation());
  live.indicator.dispose();
  assert.deepEqual(live.state.sent.at(-1), { visible: false });
  assert.equal(live.state.timers[0].cleared, true);

  const broken = harness({ failSend: true });
  await broken.indicator.show(presentation());
  await broken.indicator.show(presentation({ title: 'Check' }));
  assert.equal(broken.state.warns.length, 1);
  assert.match(broken.state.warns[0], /indicator_unavailable gdbus: no such object/);
});
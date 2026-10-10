import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import { useTranscriptReveal } from './use-transcript-reveal';

function mount(t) {
  let now = 0;
  let frameId = 0;
  const frames = new Map();
  const { root, document } = installTestDom(t, {
    html: '<!doctype html><div id="root"></div><section id="scope"><span hidden data-entry-pending></span><div id="viewport"><div id="content" style="height:100px"><div class="transcript-virtual-row" data-index="0" style="top:0px"></div></div></div></section>',
    rootId: 'root',
    globals: {
      requestAnimationFrame(callback) {
        frames.set(++frameId, callback);
        return frameId;
      },
      cancelAnimationFrame(id) {
        frames.delete(id);
      },
    },
  });
  t.mock.method(performance, 'now', () => now);
  const viewport = { current: document.getElementById('viewport') };
  const content = { current: document.getElementById('content') };
  const scope = { current: document.getElementById('scope') };
  Object.defineProperties(viewport.current, {
    clientHeight: { value: 100 },
    scrollHeight: { value: 100 },
  });
  const hasScrollGesture = () => false;
  let revealed = false;
  function Harness() {
    revealed = useTranscriptReveal({
      identity: 'entry',
      enabled: true,
      draft: false,
      viewport,
      content,
      scope,
      hasScrollGesture,
    });
    return null;
  }
  act(() => root.render(React.createElement(Harness)));
  const tick = (time) => {
    now = time;
    act(() => {
      const scheduled = [...frames.values()];
      frames.clear();
      scheduled.forEach((callback) => {
        callback(time);
      });
    });
  };
  return {
    tick,
    revealed: () => revealed,
    ready: () => scope.current.querySelector('[data-entry-pending]').remove(),
    pending: () => {
      const marker = document.createElement('span');
      marker.setAttribute('data-entry-pending', '');
      scope.current.append(marker);
    },
  };
}

test('entry waits past one second for dock chrome, then reveals only after stable frames', (t) => {
  const entry = mount(t);
  entry.tick(16);
  entry.tick(1_100);
  assert.equal(entry.revealed(), false, 'pending diff or Goal still holds the first paint');
  entry.ready();
  entry.tick(1_200);
  assert.equal(entry.revealed(), false, 'the newly committed height needs a stable frame');
  entry.tick(1_216);
  assert.equal(entry.revealed(), true);
  entry.pending();
  entry.tick(1_232);
  assert.equal(entry.revealed(), true, 'live updates never cover an entered conversation again');
});

test('a slow dock stays covered past two seconds and reveals at its settled height', (t) => {
  const entry = mount(t);
  entry.tick(1_999);
  assert.equal(entry.revealed(), false);
  entry.tick(2_000);
  assert.equal(entry.revealed(), false);
  entry.tick(5_000);
  assert.equal(entry.revealed(), false);
  entry.ready();
  entry.tick(5_016);
  assert.equal(entry.revealed(), false);
  entry.tick(5_032);
  assert.equal(entry.revealed(), true);
});

test('row settling still has a bounded wait after dock readiness', (t) => {
  const entry = mount(t);
  entry.tick(3_000);
  entry.ready();
  document.getElementById('content').setAttribute('data-transcript-pending', '');
  entry.tick(3_016);
  assert.equal(entry.revealed(), false);
  entry.tick(5_000);
  assert.equal(entry.revealed(), true);
});

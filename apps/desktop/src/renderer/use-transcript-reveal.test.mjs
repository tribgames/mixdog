import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import { ENTRY_CHROME_MAX_MS, ENTRY_REVEAL_MAX_MS, useTranscriptReveal } from './use-transcript-reveal';

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
  let identity = 'entry';
  function Harness() {
    revealed = useTranscriptReveal({
      identity,
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
    visit: (next) => {
      identity = next;
      act(() => root.render(React.createElement(Harness)));
    },
  };
}

test('returning to a session after an interrupted entry waits for its own reveal again', (t) => {
  const entry = mount(t);
  entry.ready();
  entry.tick(16);
  entry.tick(32);
  assert.equal(entry.revealed(), true);
  entry.pending();
  entry.visit('other');
  entry.tick(48);
  assert.equal(entry.revealed(), false, 'the incoming entry is still pending');
  entry.visit('entry');
  assert.equal(entry.revealed(), false, 'an earlier reveal never carries over to a new visit');
  document.querySelector('[data-entry-pending]').remove();
  entry.tick(64);
  entry.tick(80);
  assert.equal(entry.revealed(), true);
});

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

test('a dock that never answers cannot hold the laid-out transcript past the chrome bound', (t) => {
  const entry = mount(t);
  entry.tick(16);
  entry.tick(ENTRY_CHROME_MAX_MS - 16);
  assert.equal(entry.revealed(), false, 'chrome is still waited on inside the bound');
  entry.tick(ENTRY_CHROME_MAX_MS);
  assert.equal(entry.revealed(), false, 'the bound frame needs one stable sample');
  entry.tick(ENTRY_CHROME_MAX_MS + 16);
  assert.equal(entry.revealed(), true, 'rows are laid out; the review bar may appear late');
  assert.ok(document.querySelector('[data-entry-pending]'), 'chrome never resolved');
});

test('the chrome bound counts total wait, not time since the last pending frame', (t) => {
  const entry = mount(t);
  for (let time = 16; time < ENTRY_CHROME_MAX_MS; time += 250) entry.tick(time);
  assert.equal(entry.revealed(), false);
  entry.tick(ENTRY_CHROME_MAX_MS);
  entry.tick(ENTRY_CHROME_MAX_MS + 16);
  assert.equal(entry.revealed(), true);
});

test('row settling still has a bounded wait after dock readiness', (t) => {
  const entry = mount(t);
  entry.tick(3_000);
  entry.ready();
  const suspended = document.createElement('div');
  suspended.setAttribute('data-transcript-pending', '');
  document.getElementById('content').append(suspended);
  entry.tick(3_016);
  assert.equal(entry.revealed(), false);
  entry.tick(3_000 + ENTRY_REVEAL_MAX_MS - 16);
  assert.equal(entry.revealed(), false);
  entry.tick(3_000 + ENTRY_REVEAL_MAX_MS);
  assert.equal(entry.revealed(), true);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import { ENTRY_CHROME_MAX_MS, ENTRY_REVEAL_MAX_MS, useTranscriptReveal } from './use-transcript-reveal';

function mount(t, { eager = false, scrollHeight = 100 } = {}) {
  let now = 0;
  let frameId = 0;
  const frames = new Map();
  const { root, document } = installTestDom(t, {
    html: '<!doctype html><div id="root"></div><section id="scope"><span hidden data-entry-pending></span><div id="viewport"><div id="content" style="height:100px"><div class="transcript-virtual-row" data-index="0" data-timeline-key="r0" style="top:0px"></div></div></div></section>',
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
  // The viewport rests at scrollTop 0: a taller content is read off its end.
  Object.defineProperties(viewport.current, {
    clientHeight: { value: 100 },
    scrollHeight: { get: () => scrollHeight },
  });
  // What layout reads back for the visible row, against what the timeline
  // remembered it at (size 100 at offset 0).
  const row = document.querySelector('[data-index="0"]');
  let rowHeight = 100;
  row.getBoundingClientRect = () => ({ height: rowHeight, top: 0, bottom: rowHeight, width: 600 });
  const hasScrollGesture = () => false;
  let revealed = false;
  let identity = 'entry';
  let retainedGeometry = [{ key: 'r0', start: 0, size: 100 }];
  let pinned = false;
  function Harness() {
    revealed = useTranscriptReveal({
      identity,
      pinned,
      enabled: true,
      draft: false,
      viewport,
      content,
      scope,
      hasScrollGesture,
      eager,
      retainedGeometry,
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
    scrollOffEnd: () => {
      scrollHeight = 300;
    },
    dropGeometry: () => {
      retainedGeometry = undefined;
    },
    // Whatever changed while away reaches the revisit as a row that reads back
    // differently from what was remembered, or one that was never remembered.
    rowReadsHeight: (height) => {
      rowHeight = height;
    },
    rowMovedTo: (top) => {
      row.style.top = `${top}px`;
    },
    rowForgotten: () => {
      retainedGeometry = [{ key: 'other-row', start: 0, size: 100 }];
    },
    pin: (next) => {
      pinned = next;
    },
  };
}

/** Reveals `entry`, then switches to `other` and reveals it: `entry` is now
 *  a timeline this pane has shown. Returns the next free frame time. */
function revealEntryThenOther(entry) {
  entry.ready();
  entry.tick(16);
  entry.tick(32);
  assert.equal(entry.revealed(), true);
  entry.visit('other');
  entry.tick(48);
  entry.tick(64);
  assert.equal(entry.revealed(), true);
  return 80;
}

const pendingMarker = () => {
  const marker = document.createElement('span');
  marker.hidden = true;
  marker.setAttribute('data-transcript-pending', '');
  return marker;
};

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

test('a visit whose committed geometry is already final reveals in its first frame', async (t) => {
  const entry = mount(t);
  entry.ready();
  entry.tick(16);
  entry.tick(32);
  assert.equal(entry.revealed(), true);
  entry.visit('other');
  assert.equal(entry.revealed(), false);
  // The commit's own sample is taken once its microtasks (the end pin) ran.
  await Promise.resolve();
  entry.tick(48);
  assert.equal(entry.revealed(), true, 'no blank frame is painted before the restored rows');
});

test('a revisit with retained geometry reveals in the commit, before any frame callback', async (t) => {
  const entry = mount(t);
  const time = revealEntryThenOther(entry);
  entry.visit('entry');
  assert.equal(entry.revealed(), false, 'never painted before its microtasks ran');
  await act(async () => {});
  assert.equal(entry.revealed(), true, 'revealed without waiting for a frame');
  assert.ok(time > 0);
});

// The remembered geometry is only valid for what it was measured under:
// anything else settles through the stable-sample path like an entry.
for (const [name, change] of [
  [
    'a visible row that reads back taller (width, zoom, fonts, skin, tool expansion)',
    (entry) => entry.rowReadsHeight(140),
  ],
  ['a visible row that reads back shorter by one pixel', (entry) => entry.rowReadsHeight(99)],
  ['a visible row at another offset (rows above changed)', (entry) => entry.rowMovedTo(8)],
  ['a visible row that was never remembered (rows appended)', (entry) => entry.rowForgotten()],
]) {
  test(`a revisit with ${name} is not revealed in the commit and settles on stable samples`, async (t) => {
    const entry = mount(t);
    const time = revealEntryThenOther(entry);
    change(entry);
    entry.visit('entry');
    await act(async () => {});
    assert.equal(entry.revealed(), false, 'the remembered geometry may be wrong for the current inputs');
    entry.tick(time);
    assert.equal(entry.revealed(), true, "the commit and its next frame agree: today's settling path");
  });
}

test('a pinned revisit whose end has not landed is not revealed in the commit', async (t) => {
  const entry = mount(t);
  entry.pin(true);
  const time = revealEntryThenOther(entry);
  entry.scrollOffEnd();
  entry.visit('entry');
  await act(async () => {});
  assert.equal(entry.revealed(), false, 'the end pin has not placed the tail');
  entry.tick(time);
  assert.equal(entry.revealed(), true);
});

test('a revisit with a relearn of unmeasured estimates pending is not revealed in the commit', async (t) => {
  const entry = mount(t);
  const time = revealEntryThenOther(entry);
  document.getElementById('viewport').setAttribute('data-transcript-relearn', '');
  entry.visit('entry');
  await act(async () => {});
  assert.equal(entry.revealed(), false);
  entry.tick(time);
  assert.equal(entry.revealed(), true);
});

test('a first visit is not revealed in the commit', async (t) => {
  const entry = mount(t);
  entry.ready();
  await act(async () => {});
  assert.equal(entry.revealed(), false, 'a first visit still needs its stable samples');
});

test('a dock still easing to its height holds the entry reveal', async (t) => {
  const entry = mount(t);
  entry.ready();
  const slot = document.createElement('div');
  slot.className = 'composer-island-slot';
  slot.setAttribute('data-motion', '');
  document.getElementById('scope').append(slot);
  await Promise.resolve();
  entry.tick(16);
  entry.tick(32);
  assert.equal(entry.revealed(), false, 'the viewport the tail is pinned to is still moving');
  slot.removeAttribute('data-motion');
  entry.tick(48);
  assert.equal(entry.revealed(), false, 'the settled dock needs a stable frame');
  entry.tick(64);
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

test('a phone entry reveals its rows in the commit, without waiting on dock chrome or a stable frame', async (t) => {
  const entry = mount(t, { eager: true });
  assert.ok(document.querySelector('[data-entry-pending]'), 'the dock chrome is still undecided');
  await act(async () => {});
  assert.equal(entry.revealed(), true, 'the latest messages paint in the frame they arrive');
});

test('a phone entry still holds a row whose Markdown body has not rendered', async (t) => {
  const entry = mount(t, { eager: true });
  const suspended = document.createElement('div');
  suspended.setAttribute('data-transcript-pending', '');
  document.getElementById('content').append(suspended);
  entry.visit('next');
  await act(async () => {});
  entry.tick(16);
  assert.equal(entry.revealed(), false, 'an empty row would grow under the reader a frame later');
  suspended.remove();
  entry.tick(32);
  assert.equal(entry.revealed(), true, 'revealed in the first frame its rows hold content');
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

test('a cold entry resting off its end still waits out the settle bound', (t) => {
  const entry = mount(t, { scrollHeight: 300 });
  entry.ready();
  entry.tick(16);
  entry.tick(32);
  entry.tick(ENTRY_REVEAL_MAX_MS - 16);
  assert.equal(entry.revealed(), false, 'the end anchor may still be landing');
  entry.tick(ENTRY_REVEAL_MAX_MS);
  assert.equal(entry.revealed(), true);
});

test('a warm revisit reveals in its first frame, off its end and with dock segments undecided', async (t) => {
  const entry = mount(t);
  const time = revealEntryThenOther(entry);
  entry.scrollOffEnd();
  entry.pending();
  entry.visit('entry');
  assert.equal(entry.revealed(), false, 'never painted in the switch commit');
  await Promise.resolve();
  entry.tick(time);
  assert.equal(entry.revealed(), true, 'neither the end nor the reads of reserved segments hold a revisit');
  assert.ok(document.querySelector('[data-entry-pending]'), 'the segment is still undecided');
});

// User: 대화창 들어가면 덜컥 한 줄 정도 내려앉는다. The island slot held the
// outgoing pill's height for a chat whose segments were still reading; the
// revisit painted above that room and its tail dropped when the room closed.
test('a warm revisit waits on an island slot still holding a reserved height', async (t) => {
  const entry = mount(t);
  const time = revealEntryThenOther(entry);
  const slot = document.createElement('div');
  slot.className = 'composer-island-slot';
  slot.setAttribute('data-reserved', '');
  document.getElementById('scope').append(slot);
  entry.visit('entry');
  await Promise.resolve();
  entry.tick(time);
  entry.tick(time + 16);
  assert.equal(entry.revealed(), false, 'the reserved room may still close under the tail');
  slot.removeAttribute('data-reserved');
  entry.tick(time + 32);
  entry.tick(time + 48);
  assert.equal(entry.revealed(), true);
});

test('a revisit whose remembered geometry was evicted enters cold', async (t) => {
  const entry = mount(t);
  const time = revealEntryThenOther(entry);
  entry.dropGeometry();
  entry.scrollOffEnd();
  entry.pending();
  entry.visit('entry');
  await Promise.resolve();
  entry.tick(time);
  entry.tick(time + 16);
  assert.equal(entry.revealed(), false, 'undecided chrome holds a timeline remounting from estimates');
  for (const marker of document.querySelectorAll('[data-entry-pending]')) marker.remove();
  entry.tick(time + 32);
  entry.tick(time + 48);
  assert.equal(entry.revealed(), false, 'off its end it waits for the end anchor, like an entry');
  entry.tick(time + 48 + ENTRY_REVEAL_MAX_MS);
  assert.equal(entry.revealed(), true);
});

test('a warm revisit still waits on a visible row body and a moving dock, never on offscreen rows', async (t) => {
  const entry = mount(t);
  const time = revealEntryThenOther(entry);
  const content = document.getElementById('content');
  const offscreen = document.createElement('div');
  offscreen.className = 'transcript-virtual-row';
  offscreen.dataset.index = '1';
  offscreen.style.top = '100px';
  offscreen.append(pendingMarker());
  content.append(offscreen);
  const body = pendingMarker();
  content.querySelector('[data-index="0"]').append(body);
  entry.visit('entry');
  await Promise.resolve();
  entry.tick(time);
  assert.equal(entry.revealed(), false, 'a row on screen would paint empty');
  body.remove();
  const slot = document.createElement('div');
  slot.className = 'composer-island-slot';
  slot.setAttribute('data-motion', '');
  document.getElementById('scope').append(slot);
  entry.tick(time + 16);
  assert.equal(entry.revealed(), false, 'the viewport the tail is pinned to is still moving');
  slot.removeAttribute('data-motion');
  entry.tick(time + 32);
  assert.equal(entry.revealed(), false, 'the settled dock needs a stable frame');
  entry.tick(time + 48);
  assert.equal(entry.revealed(), true, 'a pending row below the viewport holds its remembered box');
  assert.ok(offscreen.querySelector('[data-transcript-pending]'));
});

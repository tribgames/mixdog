import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import { useTranscriptReveal } from './use-transcript-reveal';

// Longer than any wait the reveal once gave up after: no elapsed time presents a view.
const LONG_MS = 60_000;

/** `contentHeight` 124: the one row's box (100) is the extent the list gives it (the content less its 24px end
 *  spacer); 100: the list holds another size for it than layout reads back. */
function mount(t, { eager = false, scrollHeight = 100, contentHeight = 100, pinned = false } = {}) {
  let now = 0;
  let frameId = 0;
  const frames = new Map();
  const { root, document } = installTestDom(t, {
    html: `<!doctype html><div id="root"></div><section id="scope"><span hidden data-entry-pending></span><div id="viewport"><div id="content" style="height:${contentHeight}px"><div class="transcript-virtual-row" data-index="0" data-timeline-key="r0" style="top:0px"></div></div></div></section>`,
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
  // What layout reads back for the visible row.
  const row = document.querySelector('[data-index="0"]');
  let rowHeight = 100;
  row.getBoundingClientRect = () => ({ height: rowHeight, top: 0, bottom: rowHeight, width: 600 });
  const hasScrollGesture = () => false;
  let revealed = false;
  let identity = 'entry';
  let visit = 0;
  let placed = true;
  function Harness() {
    revealed = useTranscriptReveal({
      identity,
      visit,
      pinned,
      placed: () => placed,
      enabled: true,
      draft: false,
      viewport,
      content,
      scope,
      hasScrollGesture,
      eager,
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
    /** The pane puts the same timeline up again. */
    again: () => {
      visit += 1;
      act(() => root.render(React.createElement(Harness)));
    },
    scrollOffEnd: () => {
      scrollHeight = 300;
    },
    scrollToEnd: () => {
      scrollHeight = 100;
    },
    // Whatever changed while away reaches the revisit as a row that reads back
    // at another size than the list holds for it.
    rowReadsHeight: (height) => {
      rowHeight = height;
    },
    pin: (next) => {
      pinned = next;
    },
    place: (next) => {
      placed = next;
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

test('a revisit whose rows in view hold the boxes the list gave them reveals in the commit, before any frame callback', async (t) => {
  const entry = mount(t, { contentHeight: 124 });
  const time = revealEntryThenOther(entry);
  entry.visit('entry');
  assert.equal(entry.revealed(), false, 'never painted before its microtasks ran');
  await act(async () => {});
  assert.equal(entry.revealed(), true, 'revealed without waiting for a frame');
  assert.ok(time > 0);
});

test('the same timeline put up again by its pane is a visit of its own, revealed in its commit when its rows hold their boxes', async (t) => {
  const entry = mount(t, { contentHeight: 124 });
  entry.ready();
  entry.tick(16);
  entry.tick(32);
  assert.equal(entry.revealed(), true);
  entry.again();
  assert.equal(entry.revealed(), false, "an earlier reveal is not this visit's");
  await act(async () => {});
  assert.equal(entry.revealed(), true);
});

// The sizes the list holds are only valid for what they were measured under:
// anything else settles through the stable-sample path like an entry.
for (const [name, change] of [
  [
    'a visible row that reads back taller (width, zoom, fonts, skin, tool expansion)',
    (entry) => entry.rowReadsHeight(140),
  ],
  ['a visible row that reads back shorter by one pixel', (entry) => entry.rowReadsHeight(99)],
]) {
  test(`a revisit with ${name} is not revealed in the commit and settles on stable samples`, async (t) => {
    const entry = mount(t, { contentHeight: 124 });
    const time = revealEntryThenOther(entry);
    change(entry);
    entry.visit('entry');
    await act(async () => {});
    assert.equal(entry.revealed(), false, 'the sizes held may be wrong for the current inputs');
    entry.tick(time);
    assert.equal(entry.revealed(), true, "the commit and its next frame agree: today's settling path");
  });
}

test('a revisit that follows its end is not revealed before its end pin has landed', async (t) => {
  const entry = mount(t, { contentHeight: 124 });
  entry.pin(true);
  const time = revealEntryThenOther(entry);
  entry.scrollOffEnd();
  entry.visit('entry');
  await act(async () => {});
  assert.equal(entry.revealed(), false, 'the end pin has not placed the tail');
  entry.tick(time);
  entry.tick(time + 16);
  assert.equal(entry.revealed(), false, 'rows that arrived while away are still above the end');
  entry.scrollToEnd();
  entry.tick(time + 32);
  entry.tick(time + 48);
  assert.equal(entry.revealed(), true, 'revealed once the end is reached and holds for a frame');
});

test('a visit handed a place off the end is not revealed before its reader is on its row', async (t) => {
  const entry = mount(t, { contentHeight: 124 });
  const time = revealEntryThenOther(entry);
  entry.place(false);
  entry.visit('entry');
  await act(async () => {});
  entry.tick(time);
  entry.tick(time + 16);
  assert.equal(entry.revealed(), false, 'the rows of the place have not been put under the reader');
  entry.place(true);
  entry.tick(time + 32);
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

test('a first visit whose rows are still at estimated sizes is not revealed in the commit', async (t) => {
  const entry = mount(t);
  entry.ready();
  await act(async () => {});
  assert.equal(entry.revealed(), false, 'it needs its stable samples');
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

test('dock chrome still undecided holds the entry however long it takes, and its answer presents it', (t) => {
  const entry = mount(t);
  entry.tick(16);
  for (let time = 250; time <= LONG_MS; time += 5_000) entry.tick(time);
  assert.equal(entry.revealed(), false, 'no clock presents a view its chrome would still move');
  entry.ready();
  entry.tick(LONG_MS + 16);
  entry.tick(LONG_MS + 32);
  assert.equal(entry.revealed(), true, 'presented once the chrome has answered and a frame agrees');
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

test('a row whose body is pending holds the entry however long it takes; a streaming reply never does', (t) => {
  const entry = mount(t);
  entry.tick(3_000);
  entry.ready();
  const suspended = document.createElement('div');
  suspended.setAttribute('data-transcript-pending', '');
  document.getElementById('content').append(suspended);
  entry.tick(3_016);
  entry.tick(3_000 + LONG_MS);
  assert.equal(entry.revealed(), false, 'the row would take its size under the reader after the view was shown');
  // The same marker in a reply that streams is parsed for as long as it streams: nothing to wait for.
  const row = document.createElement('div');
  row.className = 'transcript-virtual-row';
  row.innerHTML = '<article class="message streaming"></article>';
  row.append(suspended);
  document.getElementById('content').append(row);
  entry.tick(3_016 + LONG_MS);
  entry.tick(3_032 + LONG_MS);
  assert.equal(entry.revealed(), true);
});

test('a cold entry that follows its end and rests off it is presented only once its end is reached, however long that takes', (t) => {
  const entry = mount(t, { scrollHeight: 300, pinned: true });
  entry.ready();
  entry.tick(16);
  entry.tick(32);
  entry.tick(LONG_MS);
  entry.tick(3 * LONG_MS);
  assert.equal(entry.revealed(), false, 'no clock presents a view whose reader is not where the visit puts it');
  entry.scrollToEnd();
  entry.tick(3 * LONG_MS + 16);
  assert.equal(entry.revealed(), true, 'the end is reached');
});

test('a visit handed a place is not presented before its reader is on its row, however long that takes', (t) => {
  const entry = mount(t);
  entry.place(false);
  entry.ready();
  entry.tick(16);
  entry.tick(3 * LONG_MS);
  assert.equal(entry.revealed(), false);
  entry.place(true);
  entry.tick(3 * LONG_MS + 16);
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

// A slot that keeps its session's remembered room while segments read is waiting for the core: the read may never
// be answered, so no view waits for it. The room stays as it is until the segments have read.
test('a revisit does not wait on an island slot that keeps a reserved height for segments still reading', async (t) => {
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
  assert.equal(entry.revealed(), true, 'presented above the reserved room');
  assert.ok(slot.hasAttribute('data-reserved'));
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

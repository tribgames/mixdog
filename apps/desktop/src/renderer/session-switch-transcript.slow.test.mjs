// What a reader sees when a pane comes to show a session: in a real Chrome, the real PaneWorkspace and PaneConversation
// over the real lane store, every frame from the switch until the panes are at rest. The rig (test-support/
// session-switch-*) follows a thread only while the panes keep it and resumes it with the default tail, as the core
// lanes do; a pane that comes back to a place asks for the window around it itself.
//
// A frame passes only if it paints rows (a cover, a hidden list, or a session's list with no row fails it) and shows
// either the conversation the pane showed before the switch, exactly as it was, or the one switched to, exactly where
// it comes to rest. Resting is the panes' own signals (the rig's `settle`), never a count of frames.
import assert from 'node:assert/strict';
import test from 'node:test';
import { launchSwitchBrowser, openSwitchPage, paneFrames, seededKeys } from './test-support/session-switch-rig.mjs';

let browser;
test.before(async () => {
  browser = await launchSwitchBrowser();
});
test.after(() => browser?.close());

/** A fresh renderer per case; its page errors fail the case. */
async function rig(t, options) {
  const page = await openSwitchPage(browser, options);
  t.after(async () => {
    const { errors } = page;
    await page.close();
    assert.deepEqual(errors, []);
  });
  return page;
}

const describe = (view) =>
  view.shown === null
    ? `${view.session}: nothing (cover:${view.cover} hidden:${view.hidden} no rows:${view.blank})`
    : `${view.session}: ${view.first?.key}@${view.first?.offset} gap ${view.gap} rows ${view.height}`;

/** Every frame paints rows. */
function assertPainted(frames, label) {
  for (const [index, view] of frames.entries()) {
    assert.ok(view.shown !== null, `${label}: frame ${index + 1} paints ${describe(view)}`);
  }
}

/** Every frame shows the rows `expected` shows, each at the same offset. */
function assertStill(frames, expected, label) {
  assertPainted(frames, label);
  frames.forEach((view, index) => {
    assert.equal(view.session, expected.session, `${label}: frame ${index + 1} paints ${describe(view)}`);
    assert.deepEqual(view.shown, expected.shown, `${label}: frame ${index + 1} paints ${describe(view)}`);
  });
}

/** The frames of a switch from the view `from` to the session `to`: each paints rows; the pane shows `from` as it was
 *  until it shows `to`, and `to` from its first frame as `expected` has it (default: as it rests, the last entry).
 *  Returns the index of the first frame of `to`. */
function assertHandover(frames, from, to, label, expected = frames.at(-1)) {
  assertPainted(frames, label);
  const arrived = frames.findIndex((view) => view.session === to);
  assert.ok(arrived >= 0, `${label}: ${to} is shown`);
  assertStill(frames.slice(0, arrived), from, `${label}, before the handover`);
  assert.equal(expected.session, to);
  // The viewport is as tall as it was when `expected` was taken, or the tab strip above it took a line since: then the
  // rows `expected` shows stand where they did, as far as the viewport reaches.
  if (expected.viewport.height === frames.at(-1).viewport.height) {
    assertStill(frames.slice(arrived), expected, `${label}, from the handover on`);
  } else {
    assertStill(frames.slice(arrived), frames.at(-1), `${label}, from the handover on`);
    assert.equal(frames.at(-1).first.key, expected.first.key, `${label}: the row at the top of the view`);
    assertRowsStayPut(frames.slice(arrived), expected, `${label}, from the handover on`);
  }
  return arrived;
}

/** Every row a frame shares with `expected` is at the same offset, and each frame shares some: the viewport may have
 *  grown or shrunk at its lower edge (the dock under it changed height). */
function assertRowsStayPut(frames, expected, label) {
  assertPainted(frames, label);
  const offsets = new Map(expected.shown.map((entry) => entry.split('@')));
  frames.forEach((view, index) => {
    const shared = view.shown.map((entry) => entry.split('@')).filter(([key]) => offsets.has(key));
    assert.ok(shared.length > 0, `${label}: frame ${index + 1} shows none of the rows that were on screen`);
    for (const [key, offset] of shared)
      assert.equal(offset, offsets.get(key), `${label}: frame ${index + 1} moved ${key}`);
  });
}

/** The mounted rows are one run of the session's rows: none missing, doubled or out of order. */
function assertRowsOf(view, keys, label) {
  const mounted = view.mounted.map((entry) => entry.slice(entry.indexOf(':') + 1));
  const indexes = view.mounted.map((entry) => Number(entry.slice(0, entry.indexOf(':'))));
  assert.ok(mounted.length > 0, `${label}: rows are mounted`);
  assert.equal(new Set(mounted).size, mounted.length, `${label}: no row is doubled`);
  indexes.forEach((index, at) => {
    if (at > 0) assert.equal(index, indexes[at - 1] + 1, `${label}: the mounted rows are consecutive`);
  });
  const from = keys.indexOf(mounted[0]);
  assert.ok(from >= 0, `${label}: ${mounted[0]} is a row of the session`);
  assert.deepEqual(mounted, keys.slice(from, from + mounted.length), `${label}: the rows in order`);
}

/** Every frame shows the session's end, `last` its last row, and follows it. */
function assertAtEnd(frames, last, label) {
  for (const view of frames) {
    assert.equal(view.last.key, last, `${label}: the last row (${describe(view)})`);
    assert.ok(Math.abs(view.gap) <= 1, `${label}: on the end (${describe(view)})`);
    assert.equal(view.following, true, `${label}: the end is followed (${describe(view)})`);
  }
}

/** Whether a pane asked the core for the window around a record of `id`. */
const readAroundAsked = (p, id) =>
  p.run((session) => window.rig.core.moves().some((move) => move.id === session && move.kind === 'at'), id);

const LONG = 300;
const longKeys = seededKeys('A', LONG, { tools: 1 });
const open = (id) => new Function('rig', `rig.ws.open(rig.ws.session('${id}'))`);
const one = (p) => p.act(() => {}).then(([view]) => view);

/** Session A (longer than the default tail) shown and at rest (`scroll`: read from that far above its end), then the
 *  sessions `then` opened in tabs of their own, one after another. The pane keeps the two shown before the current one
 *  mounted and followed: with one session after A, A is kept; with three, A is let go and only its tab remains. */
async function leftLongSession(p, { scroll = 0, then = ['B'] } = {}) {
  await p.act(() => {
    window.rig.core.seed('A', 300, { tools: 1 });
    window.rig.ws.open(window.rig.ws.session('A'));
  });
  if (scroll) await p.run((by) => window.rig.wheel('pane-1', by), scroll);
  const left = await one(p);
  for (const id of then) {
    await p.act((session) => {
      window.rig.core.seed(session, 12);
      window.rig.ws.open(window.rig.ws.session(session));
    }, id);
  }
  return left;
}
const COLD = ['B', 'C', 'D'];

/** The frames of switching the pane to `id`, the core answering each request it is asked three frames after the one
 *  before (the thread followed again, the window around the reader, the pages near it). */
async function switchTo(p, id, { count = 18 } = {}) {
  await p.run(() => window.rig.core.hold());
  const step = ({ core }) => {
    core.release();
    core.hold();
  };
  const at = Object.fromEntries([3, 6, 9, 12].map((frame) => [frame, step]));
  const frames = paneFrames(await p.frames(open(id), { count, at, rest: false }));
  const [rested] = await p.act(() => window.rig.core.release());
  return [...frames, rested];
}

// ───────────────────────────── a session shown for the first time ─────────────────────────────

test('a session opened from New Task: the draft stays as it was until the session is shown at its end, and nothing moves while older pages arrive', async (t) => {
  const p = await rig(t);
  await p.run(() => window.rig.core.seed('A', 300, { tools: 1 }));
  const draft = await one(p);
  assert.equal(draft.session, 'new-task');
  const frames = await switchTo(p, 'A');
  const arrived = assertHandover(frames, draft, 'A', 'first open');
  assert.ok(arrived >= 2, 'the draft is shown while the session is read');
  const rested = frames.at(-1);
  assert.ok(Math.abs(rested.gap) <= 1, 'it opens on the latest row');
  assert.equal(rested.last.key, 'A:A-r300');
  for (const view of frames.slice(arrived)) assertRowsOf(view, longKeys, 'first open');
  assert.deepEqual([rested.viewport.left, rested.viewport.width], [draft.viewport.left, draft.viewport.width]);
  assert.deepEqual([rested.composer.left, rested.composer.width], [draft.composer.left, draft.composer.width]);
});

test('back to New Task from a session: the draft is shown in the frame of the switch, with no row of the session it left', async (t) => {
  const p = await rig(t);
  await p.act(() => {
    window.rig.core.seed('A', 40, { tools: 1 });
    window.rig.ws.open(window.rig.ws.session('A'));
  });
  const shown = await one(p);
  const back = paneFrames(await p.frames(({ ws }) => ws.open(ws.draft()), { count: 8 }));
  for (const [index, view] of back.entries()) {
    assert.equal(view.session, 'new-task', `frame ${index + 1}`);
    assert.ok(!view.cover && !view.hidden, `frame ${index + 1}: a draft has nothing to load`);
    assert.deepEqual(view.mounted, [], `frame ${index + 1}: no row of the session it left`);
  }
  const again = paneFrames(await p.frames(open('A'), { count: 8 }));
  assertStill(again, shown, 'back to the session');
});

// ───────────────────────────── a return ─────────────────────────────

for (const scroll of [0, -3000]) {
  const place = scroll ? 'read from above' : 'at its end';
  test(`back to a session the pane kept, ${place}: the frame of the switch shows it where its reader was`, async (t) => {
    const p = await rig(t);
    const left = await leftLongSession(p, { scroll });
    assert.equal(left.following, !scroll);
    const frames = paneFrames(await p.frames(open('A'), { count: 12 }));
    assertStill(frames, left, 'kept session');
    for (const view of frames) assertRowsOf(view, longKeys, 'kept session');
    assert.equal(await p.run(() => window.rig.core.resumes('A')), 1, 'a session the pane keeps stays followed');
  });

  test(`back to a session the pane let go, ${place}: the pane shows what it showed until the session is read, then its end, followed`, async (t) => {
    const p = await rig(t);
    await leftLongSession(p, { scroll, then: COLD });
    assert.deepEqual(await p.run(() => window.rig.core.followed().sort()), ['B', 'C', 'D'], 'A is no longer followed');
    const before = await one(p);
    const frames = await switchTo(p, 'A');
    const arrived = assertHandover(frames, before, 'A', 'session let go');
    assert.ok(arrived >= 2, 'the session is read again before it is shown');
    assertAtEnd(frames.slice(arrived), 'A:A-r300', 'session let go');
    for (const view of frames.slice(arrived)) assertRowsOf(view, longKeys, 'session let go');
    assert.ok(!(await readAroundAsked(p, 'A')), 'no read around the place the reader left is asked');
    assert.equal(await p.run(() => window.rig.core.resumes('A')), 2);
  });

  test(`back to a session whose kept state was dropped, ${place}: no cover, and its end, followed`, async (t) => {
    const p = await rig(t);
    await leftLongSession(p, { scroll, then: COLD });
    await p.run(() => window.rig.store.evictInactive());
    assert.equal(await p.run(() => window.rig.store.get('A')), null, 'nothing is held of A');
    const before = await one(p);
    const frames = await switchTo(p, 'A');
    const arrived = assertHandover(frames, before, 'A', 'dropped session');
    assertAtEnd(frames.slice(arrived), 'A:A-r300', 'dropped session');
  });
}

test('a conversation the pane keeps mounted: the scroll made just before leaving is the place it shows when it is shown again', async (t) => {
  const p = await rig(t);
  await p.act(() => {
    window.rig.core.seed('A', 300, { tools: 1 });
    window.rig.core.seed('B', 12);
    window.rig.ws.open(window.rig.ws.session('A'));
  });
  await p.run(() => window.rig.wheel('pane-1', -3000));
  const earlier = await one(p);
  // A last notch and the switch in one task: no scroll event, no frame and no report lies between them.
  await p.act(() => {
    window.rig.jump('pane-1', document.querySelector('.transcript').scrollTop - 700);
    window.rig.ws.open(window.rig.ws.session('B'));
  });
  assert.equal((await one(p)).session, 'B');
  const frames = paneFrames(await p.frames(open('A'), { count: 12 }));
  assertPainted(frames, 'kept, last scroll');
  const moved = new Map(
    earlier.shown.map((entry) => entry.split('@')).map(([key, offset]) => [key, Number(offset) + 700])
  );
  for (const view of frames) {
    assert.equal(view.session, 'A', `the kept session is shown from the frame of the switch (${describe(view)})`);
    assert.equal(view.following, false, 'its reader is off the end');
    const shared = view.shown.map((entry) => entry.split('@')).filter(([key]) => moved.has(key));
    assert.ok(shared.length > 0, `rows that were on screen before the last scroll are on screen (${describe(view)})`);
    for (const [key, offset] of shared) assert.equal(Number(offset), moved.get(key), `${key} is 700px lower`);
  }
  assert.equal(await p.run(() => window.rig.core.resumes('A')), 1, 'a session the pane keeps stays followed');
});

test('the chat text size changed while away, the reader above the end: no frame is covered, and the return is the end, followed', async (t) => {
  const p = await rig(t);
  await leftLongSession(p, { scroll: -3000, then: COLD });
  await p.act(() => window.rig.setTextSize('large'));
  const before = await one(p);
  const frames = await switchTo(p, 'A');
  const arrived = assertHandover(frames, before, 'A', 'text size');
  assertAtEnd(frames.slice(arrived), 'A:A-r300', 'text size');
});

test('row sizes learned at another text size, then the size set back: the return is the end, followed, and it stays', async (t) => {
  const p = await rig(t);
  await leftLongSession(p, { scroll: -3000, then: COLD });
  // Sessions read at the large size teach the list sizes that are not those of the rows the reader comes back to.
  await p.act(() => window.rig.setTextSize('large'));
  for (const id of ['E', 'F']) {
    await p.act((session) => {
      window.rig.core.seed(session, 60, { tools: 1 });
      window.rig.ws.open(window.rig.ws.session(session));
    }, id);
    await p.run(() => window.rig.wheel('pane-1', -2000));
  }
  await p.act(() => window.rig.setTextSize('default'));
  const before = await one(p);
  const frames = await switchTo(p, 'A');
  const arrived = assertHandover(frames, before, 'A', 'sizes learned elsewhere');
  assertAtEnd(frames.slice(arrived), 'A:A-r300', 'sizes learned elsewhere');
});

test('a kept session at another text size: the frame of the switch shows the reader on the row it was on', async (t) => {
  const p = await rig(t);
  const left = await leftLongSession(p, { scroll: -3000 });
  await p.act(() => window.rig.setTextSize('large'));
  const before = await one(p);
  const frames = paneFrames(await p.frames(open('A'), { count: 12 }));
  const arrived = assertHandover(frames, before, 'A', 'text size, kept');
  for (const view of frames.slice(arrived)) {
    assert.equal(view.first.key, left.first.key);
    assert.equal(view.first.offset, left.first.offset);
  }
});

// ───────────────────────────── what changed while the session was not shown ─────────────────────────────

/** Session S (`turns` turns, short enough to be held whole) shown and at rest, then other sessions opened. */
async function leftSession(p, { turns = 30, scroll = 0, before = null, then = ['B'] } = {}) {
  await p.act((count) => {
    window.rig.core.seed('S', count, { tools: 1 });
    window.rig.ws.open(window.rig.ws.session('S'));
  }, turns);
  if (before) await p.act(before);
  if (scroll) await p.run((by) => window.rig.wheel('pane-1', by), scroll);
  const left = await one(p);
  for (const id of then) {
    await p.act((session) => {
      window.rig.core.seed(session, 12);
      window.rig.ws.open(window.rig.ws.session(session));
    }, id);
  }
  return left;
}

for (const then of [['B'], COLD]) {
  const kept = then.length === 1 ? 'kept' : 'let go';
  test(`turns ran while away (session ${kept}), the reader at the end: the first frame of the session is its new end, never the old one`, async (t) => {
    const p = await rig(t);
    const left = await leftSession(p, { then });
    await p.run(() => window.rig.core.seed('S', 3, { tools: 1 }));
    const before = await one(p);
    const frames = await switchTo(p, 'S');
    const arrived = assertHandover(frames, before, 'S', 'new end');
    for (const view of frames.slice(arrived)) {
      assert.equal(view.last.key, 'S:S-r33', 'the newest reply is the last row');
      assert.ok(Math.abs(view.gap) <= 1, `on the end (off by ${view.gap})`);
      assertRowsOf(view, seededKeys('S', 33, { tools: 1 }), 'new end');
    }
    assert.notDeepEqual(frames.at(-1).shown, left.shown);
  });

  test(`a turn started while away and still runs (session ${kept}): the session's first frame is the running end, with no gap under it`, async (t) => {
    const p = await rig(t);
    await leftSession(p, { then });
    await p.run(() => {
      const { core } = window.rig;
      core.prompt('S');
      core.tool('S', 'S-t31.0');
      core.reply('S', { storedId: 'S-n31.0', body: 'A short note between two tool calls.' });
      core.tool('S', 'S-t31.1');
      core.reply('S', { storedId: 'S-n31.1', body: 'Another note, before the next call.' });
      core.tool('S', 'S-t31.2');
      core.reply('S', { storedId: 'S-n31.2', body: 'A third note.' });
    });
    const before = await one(p);
    const frames = await switchTo(p, 'S');
    const arrived = assertHandover(frames, before, 'S', 'running on return');
    for (const view of frames.slice(arrived)) {
      assert.ok(view.busy, 'the turn reads as running');
      assert.ok(Math.abs(view.gap) <= 1, `on the end (off by ${view.gap})`);
      assert.ok(
        view.shown.some((entry) => entry.startsWith('S:S-n31.2@')),
        'the rows that ran while away are shown'
      );
    }
  });
}

test('turns ran while away (session kept), the reader scrolled up: the rows on screen stand where they were, the new ones below', async (t) => {
  const p = await rig(t);
  const left = await leftSession(p, { scroll: -2500, then: ['B'] });
  await p.run(() => window.rig.core.seed('S', 3, { tools: 1 }));
  const before = await one(p);
  const frames = await switchTo(p, 'S');
  const arrived = assertHandover(frames, before, 'S', 'rows while away', left);
  for (const view of frames.slice(arrived)) assertRowsOf(view, seededKeys('S', 33, { tools: 1 }), 'rows while away');
  assert.ok(frames.at(-1).height > left.height, 'the turns that ran are in the list');
});

test('more turns ran while away than the tail holds, the reader scrolled up: the return is the new end, followed', async (t) => {
  const p = await rig(t);
  await leftSession(p, { scroll: -2500, then: COLD });
  await p.run(() => window.rig.core.seed('S', 20, { tools: 1 }));
  const before = await one(p);
  const frames = await switchTo(p, 'S');
  const arrived = assertHandover(frames, before, 'S', 'a tail longer than held');
  assertAtEnd(frames.slice(arrived), 'S:S-r50', 'a tail longer than held');
  for (const view of frames.slice(arrived))
    assertRowsOf(view, seededKeys('S', 50, { tools: 1 }), 'a tail longer than held');
});

test('a reply streaming when the session was left and finished while away: one reply row under the key it streamed with, then its end', async (t) => {
  const p = await rig(t);
  const left = await leftSession(p, {
    before: () => {
      window.rig.core.prompt('S');
      window.rig.core.stream('S', 'The first line of the reply.\nThe second line of it.\n');
    },
  });
  assert.ok(left.busy && left.liveBand, 'the turn was running when the session was left');
  await p.run(() => {
    window.rig.core.stream('S', 'A third line, written while away.\n');
    window.rig.core.reply('S');
    window.rig.core.end('S');
  });
  const before = await one(p);
  const frames = await switchTo(p, 'S');
  assertHandover(frames, before, 'S', 'finished while away');
  const rested = frames.at(-1);
  assert.equal(rested.busy, false);
  assert.equal(rested.liveBand, false, 'no activity band under a finished turn');
  assert.equal(rested.last.key, 'S:S-r31', 'the reply keeps its row');
  assert.ok(Math.abs(rested.gap) <= 1);
  assertRowsOf(
    rested,
    [...seededKeys('S', 30, { tools: 1 }), 'S:gap:S-u31', 'S:S-u31', 'S:S-r31'],
    'finished while away'
  );
});

for (const kind of ['question', 'approval']) {
  test(`a ${kind} raised while away: it waits on return, and the transcript column is where it was`, async (t) => {
    const p = await rig(t);
    const left = await leftSession(p, { scroll: -2500 });
    await p.run((asked) => {
      window.rig.core.prompt('S');
      window.rig.core.ask('S', asked);
    }, kind);
    const before = await one(p);
    const frames = await switchTo(p, 'S');
    assertPainted(frames, kind);
    const arrived = frames.findIndex((view) => view.session === 'S');
    assertStill(frames.slice(0, arrived), before, `${kind}, before the handover`);
    // A question is brought into view when it arrives (question-card-keys.ts); an approval waits in the dock, which
    // takes its height from the lower edge of the transcript.
    if (kind === 'approval') assertRowsStayPut(frames.slice(arrived), left, kind);
    for (const view of frames.slice(arrived)) {
      assert.deepEqual(view.column, left.column, 'the transcript column does not move');
      assert.deepEqual([view.viewport.left, view.viewport.width], [left.viewport.left, left.viewport.width]);
    }
    assert.ok(await p.run(() => window.rig.store.get('S').toolApproval), 'the lane holds the pending request');
    if (kind === 'question') assert.ok(frames.at(-1).question, 'the question card is shown');
  });
}

// ───────────────────────────── the window ─────────────────────────────

test('older records loaded by scrolling up: the rows on screen stand still while the page lands above them', async (t) => {
  const p = await rig(t);
  await p.act(() => {
    window.rig.core.seed('A', 300, { tools: 1 });
    window.rig.ws.open(window.rig.ws.session('A'));
  });
  await p.run(() => {
    window.rig.core.hold();
    return window.rig.wheel('pane-1', -100000);
  });
  const before = await one(p);
  assert.ok(await p.run(() => window.rig.core.pendingCount()), 'a page above was asked for');
  const frames = paneFrames(await p.frames(({ core }) => core.release(), { count: 12 }));
  assertRowsStayPut(frames, before, 'page above');
  for (const view of frames) {
    for (const entry of before.shown) assert.ok(view.shown.includes(entry), `${entry} is still on screen`);
    assertRowsOf(view, longKeys, 'page above');
  }
  assert.ok(frames.at(-1).height > before.height, 'the page is in the list');
});

test('scrolling back through a long session: every row of it is reached in order, and the window never holds more than its bound', async (t) => {
  const p = await rig(t);
  await p.act(() => {
    window.rig.core.seed('A', 300, { tools: 1 });
    window.rig.ws.open(window.rig.ws.session('A'));
  });
  let held = 0;
  let view = await one(p);
  for (let step = 0; step < 400 && view.first.key !== longKeys[0]; step += 1) {
    [view] = await p.act(() => window.rig.wheel('pane-1', -2400));
    assert.ok(view.shown !== null, `step ${step + 1} paints ${describe(view)}`);
    assertRowsOf(view, longKeys, `step ${step + 1}`);
    held = Math.max(held, await p.run(() => window.rig.laneRows('A')));
  }
  assert.equal(view.first.key, longKeys[0], 'the first row of the session is reached');
  t.diagnostic(`rows held while scrolling back through ${longKeys.length} rows: at most ${held}`);
  assert.ok(held <= 2_048 + 96 + 400, `the window holds ${held} rows`);
});

test('a session followed for a thousand turns: the rows held stay within the tail bound, and the reader going back reaches every row in order', async (t) => {
  const p = await rig(t);
  await p.act(() => {
    window.rig.core.seed('A', 12, { tools: 1 });
    window.rig.ws.open(window.rig.ws.session('A'));
  });
  const BOUND = 2_048;
  const turns = (n) =>
    p.act((count) => {
      for (let k = 0; k < count; k += 1) window.rig.core.turn('A', { tools: 1 });
    }, n);
  const rows = () => p.run(() => window.rig.laneRows('A'));
  // The reader at the end as turns run, twenty-five between looks, up to the bound.
  let most = 0;
  let total = 12;
  for (; (await rows()) < BOUND - 60; total += 25) {
    const [view] = await turns(25);
    assert.ok(
      view.shown !== null && Math.abs(view.gap) <= 1,
      `at the end after ${total + 25} turns (${describe(view)})`
    );
    most = Math.max(most, await rows());
  }
  // Across the bound a turn a frame: every frame is the end of the session, whatever the window lets go.
  const turn = ({ core }) => core.turn('A', { tools: 1 });
  const at = Object.fromEntries(Array.from({ length: 60 }, (_, n) => [n + 2, turn]));
  const frames = paneFrames(await p.frames(() => {}, { count: 64, at }));
  total += 60;
  assertPainted(frames, 'across the tail bound');
  for (const view of frames) {
    assert.ok(Math.abs(view.gap) <= 1, `the reader stays at the end (${describe(view)})`);
    assertMountedWithinMargin(view, 'across the tail bound');
  }
  most = Math.max(most, await rows());
  for (; total < 1000; total += 25) {
    await turns(25);
    most = Math.max(most, await rows());
  }
  const keys = seededKeys('A', total, { tools: 1 });
  const rested = await one(p);
  assert.equal(rested.last.key, keys.at(-1));
  assert.ok(Math.abs(rested.gap) <= 1);
  const held = [await rows()];
  assert.ok(most <= BOUND + 400, `at most ${most} rows held of ${keys.length} while following`);
  assert.ok(held[0] < most, 'the tail was read anew');
  // The reader goes back: the rows let go are read again from the core.
  let view = rested;
  for (let step = 0; step < 900 && view.first.key !== keys[0]; step += 1) {
    [view] = await p.act(() => window.rig.wheel('pane-1', -3200));
    assert.ok(view.shown !== null, `step ${step + 1} paints ${describe(view)}`);
    assertRowsOf(view, keys, `step ${step + 1}`);
    held.push(await p.run(() => window.rig.laneRows('A')));
  }
  assert.equal(view.first.key, keys[0], 'the first row of the session is reached');
  t.diagnostic(
    `a session of ${keys.length} rows followed as it grew: ${held[0]} rows held at the end, at most ${Math.max(...held)} on the way back`
  );
  assert.ok(Math.max(...held) <= 2 * 2_048 + 96 + 400, `the window holds ${Math.max(...held)} rows`);
});

test('the tail read anew by the core, the reader at the end: the rows on screen stand still', async (t) => {
  const p = await rig(t);
  await p.act(() => {
    window.rig.core.seed('A', 300, { tools: 1 });
    window.rig.ws.open(window.rig.ws.session('A'));
  });
  const before = await one(p);
  const frames = paneFrames(await p.frames(({ core }) => core.reread('A'), { count: 12 }));
  assertStill(frames, before, 'tail read anew');
});

test('the window let go under a reader far above the end (the core reads the tail anew): the rows on screen stay, and the next scroll reads around them', async (t) => {
  const p = await rig(t);
  await p.act(() => {
    window.rig.core.seed('A', 300, { tools: 1 });
    window.rig.ws.open(window.rig.ws.session('A'));
  });
  await p.act(() => window.rig.openAt('A', 'A-u40'));
  const before = await one(p);
  assert.ok(
    before.shown.some((entry) => entry.startsWith('A:A-u40@')),
    `the record is on screen (${describe(before)})`
  );
  const frames = paneFrames(await p.frames(({ core }) => core.reread('A'), { count: 10 }));
  assertStill(frames, before, 'window let go');
  const [after] = await p.act(() => window.rig.wheel('pane-1', -300));
  assert.ok(after.shown !== null);
  assertRowsOf(after, longKeys, 'after the next scroll');
  assert.ok(await p.run(() => window.rig.laneRows('A') > 200), 'the rows around the reader are held again');
});

// ───────────────────────────── a record opened from outside ─────────────────────────────

test('a search hit in old history of a session not shown: the pane shows what it showed until the hit is on screen', async (t) => {
  const p = await rig(t);
  await p.act(() => {
    window.rig.core.seed('A', 300, { tools: 1 });
    window.rig.core.seed('B', 12);
    window.rig.ws.open(window.rig.ws.session('B'));
  });
  const before = await one(p);
  await p.run(() => window.rig.core.hold());
  const step = ({ core }) => {
    core.release();
    core.hold();
  };
  const frames = paneFrames(
    await p.frames(({ openAt }) => openAt('A', 'A-u40'), { count: 16, at: { 3: step, 6: step, 9: step }, rest: false })
  );
  const [rested] = await p.act(() => window.rig.core.release());
  const arrived = assertHandover([...frames, rested], before, 'A', 'search hit');
  for (const view of [...frames, rested].slice(arrived)) {
    assert.ok(
      view.shown.some((entry) => entry.startsWith('A:A-u40@')),
      `the hit is on screen (${describe(view)})`
    );
    assert.equal(view.following, false);
    assertRowsOf(view, longKeys, 'search hit');
  }
  assert.ok(
    (await p.run(() => window.rig.laneRows('A'))) < 700,
    'the rows around the hit and the tail are held, not the session'
  );
});

test('a search hit in old history of the session on screen: its rows stay until the hit is shown, and a later return is to the end, followed', async (t) => {
  const p = await rig(t);
  await p.act(() => {
    window.rig.core.seed('A', 300, { tools: 1 });
    window.rig.ws.open(window.rig.ws.session('A'));
  });
  const before = await one(p);
  await p.run(() => window.rig.core.hold());
  const frames = paneFrames(
    await p.frames(({ openAt }) => openAt('A', 'A-u40'), { count: 10, at: { 4: ({ core }) => core.release() } })
  );
  assertPainted(frames, 'hit in the session shown');
  const arrived = frames.findIndex((view) => view.shown.some((entry) => entry.startsWith('A:A-u40@')));
  assert.ok(arrived >= 3, 'the hit is shown when its rows are read');
  assertStill(frames.slice(0, arrived), before, 'until the hit is read');
  const hit = frames.at(-1);
  assertStill(frames.slice(arrived), hit, 'once the hit is shown');
  for (const id of COLD) {
    await p.act((session) => {
      window.rig.core.seed(session, 12);
      window.rig.ws.open(window.rig.ws.session(session));
    }, id);
  }
  const away = await one(p);
  const back = await switchTo(p, 'A');
  const returned = assertHandover(back, away, 'A', 'back after the hit');
  assertAtEnd(back.slice(returned), 'A:A-r300', 'back after the hit');
});

/** Session A opened from session B at the hit `A-u40` while the core holds its answers: A is followed in frame 3, which
 *  sends the read around the hit, and `ending` runs in frame 6 with that read out. `before` runs before the switch.
 *  Returns the view before the switch and every frame after it, the last one at rest. */
async function hitEndedBy(p, ending, before = () => {}) {
  await p.act(() => {
    window.rig.core.seed('A', 300, { tools: 1 });
    window.rig.core.seed('B', 12);
    window.rig.ws.open(window.rig.ws.session('B'));
  });
  await p.run(before);
  const away = await one(p);
  await p.run(() => window.rig.core.hold());
  const followed = ({ core }) => {
    core.release();
    core.hold();
  };
  const frames = paneFrames(
    await p.frames(({ openAt }) => openAt('A', 'A-u40'), { count: 16, at: { 3: followed, 6: ending }, rest: false })
  );
  assert.ok(await readAroundAsked(p, 'A'), 'the read around the hit was asked');
  const [rested] = await p.act(() => {});
  return { away, all: [...frames, rested] };
}

test('a search hit whose read around it is out when the connection drops: the outgoing view goes in that frame, and the session is shown at its end, followed', async (t) => {
  const p = await rig(t);
  const { away, all } = await hitEndedBy(p, ({ core }) => core.cut());
  const arrived = assertHandover(all, away, 'A', 'connection lost under a hit');
  assert.ok(arrived >= 5 && arrived <= 8, `the hold ends with the read (frame ${arrived + 1})`);
  assertAtEnd(all.slice(arrived), 'A:A-r300', 'connection lost under a hit');
});

test('a search hit whose read is granted with no row of its record: the outgoing view goes when the window lands, and the session is shown at its end, followed', async (t) => {
  const p = await rig(t);
  const { away, all } = await hitEndedBy(
    p,
    ({ core }) => core.release(),
    () => {
      // Every record around the hit is gone from the history.
      for (let n = 30; n <= 50; n += 1) {
        for (const key of [`A-u${n}`, `A-t${n}.0`, `A-r${n}`]) window.rig.core.forget('A', key);
      }
      window.rig.core.grantAnything();
    }
  );
  const arrived = assertHandover(all, away, 'A', 'granted without the hit');
  assert.ok(arrived >= 5 && arrived <= 8, `the hold ends with the window (frame ${arrived + 1})`);
  assertAtEnd(all.slice(arrived), 'A:A-r300', 'granted without the hit');
});

test('a reader on a record the history no longer holds: the return is to the end, not to a pane that waits', async (t) => {
  const p = await rig(t);
  await p.act(() => {
    window.rig.core.seed('A', 300, { tools: 1 });
    window.rig.ws.open(window.rig.ws.session('A'));
  });
  await p.act(() => window.rig.openAt('A', 'A-u40'));
  const at = await one(p);
  for (const id of COLD) {
    await p.act((session) => {
      window.rig.core.seed(session, 12);
      window.rig.ws.open(window.rig.ws.session(session));
    }, id);
  }
  // Every record around the reader is gone.
  await p.run((keys) => {
    for (const key of keys) window.rig.core.forget('A', key);
  }, Array.from({ length: 120 }, (_, n) => [`A-u${n + 1}`, `A-t${n + 1}.0`, `A-r${n + 1}`]).flat());
  assert.ok(at.shown.length > 0);
  const away = await one(p);
  const frames = await switchTo(p, 'A');
  assertHandover(frames, away, 'A', 'record gone');
  assert.ok(Math.abs(frames.at(-1).gap) <= 1, 'the reader is at the end');
  assert.equal(frames.at(-1).last.key, 'A:A-r300');
});

// ───────────────────────────── a return ending each way ─────────────────────────────

/** A long session left far above its end and let go, then opened again while the core holds its answers: `ending` runs
 *  in frame 2 with the session's read out. Returns the view before the switch and every frame after it, the last one at
 *  rest. */
async function returnEndedBy(p, ending) {
  await leftLongSession(p, { scroll: -3000, then: COLD });
  const away = await one(p);
  await p.run(() => window.rig.core.hold());
  const frames = paneFrames(await p.frames(open('A'), { count: 16, at: { 2: ending }, rest: false }));
  assert.ok(!(await readAroundAsked(p, 'A')), 'no read around the place the reader left is asked');
  return { away, frames };
}

test('the session is deleted with its read out on a return: the pane says it cannot be read, and never keeps the outgoing view', async (t) => {
  const p = await rig(t);
  const { away, frames } = await returnEndedBy(p, ({ core }) => core.delete('A'));
  const arrived = frames.findIndex((view) => view.session !== away.session || view.unavailable);
  assert.ok(
    arrived >= 1,
    `the outgoing view stands until the session is gone (frame ${arrived + 1}: ${frames.map((view) => `${view.session}${view.unavailable ? '!' : ''}${view.preparing ? `>${view.preparing}` : ''}`).join(' ')})`
  );
  assertStill(frames.slice(0, arrived), away, 'deleted, before the handover');
  for (const view of frames.slice(arrived))
    assert.equal(view.unavailable, true, `the notice stays (${describe(view)})`);
  assert.equal(await p.run(() => document.querySelectorAll('.persistent-pane-surface[data-preparing]').length), 0);
});

test('the tab is closed with the session read out on a return: the pane goes on to the tab it then shows, with no frame of the closed one', async (t) => {
  const p = await rig(t);
  const { away, frames } = await returnEndedBy(p, ({ ws }) => ws.close(ws.session('A')));
  const [rested] = await p.act(() => window.rig.core.release());
  const all = [...frames, rested];
  assertPainted(all, 'tab closed');
  for (const view of all) assert.notEqual(view.session, 'A', `the closed session is never shown (${describe(view)})`);
  const arrived = all.findIndex((view) => view.session === rested.session);
  assertStill(all.slice(0, arrived), away, 'tab closed, before the handover');
  assertStill(all.slice(arrived), rested, 'tab closed, from the handover on');
  assert.equal(await p.run(() => document.querySelectorAll('.persistent-pane-surface[data-preparing]').length), 0);
});

// ───────────────────────────── reads that arrive late ─────────────────────────────

test('a read of the session answered after its window is shown (its newest rows, no window): a reader in old history keeps its rows', async (t) => {
  const p = await rig(t);
  await p.act(() => {
    window.rig.core.seed('A', 300, { tools: 1 });
    window.rig.ws.open(window.rig.ws.session('A'));
  });
  await p.act(() => window.rig.openAt('A', 'A-u40'));
  const before = await one(p);
  const frames = paneFrames(await p.frames(({ core }) => core.read('A'), { count: 10 }));
  assertStill(frames, before, 'late read');
  assert.ok(await p.run(() => window.rig.store.get('A').transcriptPositioned), 'the lane still shows the window');
});

test('a read of the session answered while a pane comes back to it from old history: every frame from the handover is its end, followed', async (t) => {
  const p = await rig(t);
  await leftLongSession(p, { scroll: -3000, then: COLD });
  const away = await one(p);
  await p.run(() => window.rig.core.hold());
  const step = ({ core }) => {
    core.release();
    core.hold();
  };
  const read = ({ core }) => core.read('A');
  const frames = paneFrames(
    await p.frames(open('A'), { count: 16, at: { 2: read, 3: step, 4: read, 6: step, 7: read, 9: step }, rest: false })
  );
  const [rested] = await p.act(() => window.rig.core.release());
  const all = [...frames, rested];
  const arrived = assertHandover(all, away, 'A', 'read during a return');
  assertAtEnd(all.slice(arrived), 'A:A-r300', 'read during a return');
});

// ───────────────────────────── a switch during a switch ─────────────────────────────

test('A to B and back to A before B answers: A is shown where it was in every frame', async (t) => {
  const p = await rig(t);
  await p.act(() => {
    window.rig.core.seed('A', 300, { tools: 1 });
    window.rig.core.seed('B', 40);
    window.rig.ws.open(window.rig.ws.session('A'));
  });
  await p.run(() => window.rig.wheel('pane-1', -3000));
  const left = await one(p);
  await p.run(() => window.rig.core.hold());
  const frames = paneFrames(
    await p.frames(open('B'), {
      count: 14,
      at: { 2: open('A'), 5: ({ core }) => core.release(), 8: ({ core }) => core.release() },
      rest: false,
    })
  );
  const [rested] = await p.act(() => window.rig.core.release());
  assertStill([...frames, rested], left, 'there and back');
});

test('a page of A still out when the pane goes back to B, left read from above: A stands while B is read, and B is shown at its end, followed', async (t) => {
  const p = await rig(t);
  await p.act(() => {
    window.rig.core.seed('A', 300, { tools: 1 });
    window.rig.core.seed('B', 300, { tools: 1 });
    window.rig.ws.open(window.rig.ws.session('B'));
  });
  await p.run(() => window.rig.wheel('pane-1', -3000));
  // B is let go: two other sessions are shown after it, then A.
  for (const id of ['C', 'D', 'A']) {
    await p.act((session) => {
      if (session !== 'A') window.rig.core.seed(session, 12);
      window.rig.ws.open(window.rig.ws.session(session));
    }, id);
  }
  // The reader scrolls A to where a page above is asked for, and the core does not answer yet.
  await p.run(() => {
    window.rig.core.hold();
    return window.rig.wheel('pane-1', -100000);
  });
  assert.ok(await p.run(() => window.rig.core.pendingCount()), 'a page of A is out');
  const away = await one(p);
  const step = ({ core }) => {
    core.release();
    core.hold();
  };
  const frames = paneFrames(
    await p.frames(open('B'), { count: 18, at: { 3: step, 6: step, 9: step, 12: step }, rest: false })
  );
  const [rested] = await p.act(() => window.rig.core.release());
  assert.ok(!(await readAroundAsked(p, 'B')), 'no read around the place the reader left in B is asked');
  // A's page lands above its rows while it is still shown: they stand where they were, as when it is the session read.
  const all = [...frames, rested];
  assertPainted(all, 'back to B');
  const arrived = all.findIndex((view) => view.session === 'B');
  assert.ok(arrived >= 2, 'A is shown while B is read');
  for (const view of all.slice(0, arrived)) assert.equal(view.session, 'A');
  assertRowsStayPut(all.slice(0, arrived), away, 'back to B, before the handover');
  assertStill(all.slice(arrived), rested, 'back to B, from the handover on');
  assertAtEnd(all.slice(arrived), 'B:B-r300', 'back to B');
});

test('A to B to C before either answers: A stays until C is shown, B never is, and C lands where it stays', async (t) => {
  const p = await rig(t);
  await p.act(() => {
    for (const id of ['A', 'B', 'C']) window.rig.core.seed(id, 40, { tools: 1 });
    window.rig.ws.open(window.rig.ws.session('A'));
  });
  const left = await one(p);
  await p.run(() => window.rig.core.hold());
  const frames = paneFrames(
    await p.frames(open('B'), {
      count: 16,
      at: { 2: open('C'), 5: ({ core }) => core.release(), 8: ({ core }) => core.release() },
      rest: false,
    })
  );
  const [rested] = await p.act(() => window.rig.core.release());
  assertHandover([...frames, rested], left, 'C', 'A to B to C');
  assertRowsOf(rested, seededKeys('C', 40, { tools: 1 }), 'C');
});

test('four sessions, two of them read from above, switched between every few frames: each frame shows one of them where its reader left it while the pane keeps it, and at its end, followed, once the pane enters it anew', async (t) => {
  const p = await rig(t);
  const ids = ['A', 'B', 'C', 'D'];
  const left = {};
  await p.run(() => {
    window.rig.core.seed('A', 300, { tools: 1 });
    for (const id of ['B', 'C', 'D']) window.rig.core.seed(id, 40, { tools: 1 });
  });
  for (const id of ids) {
    await p.act((session) => window.rig.ws.open(window.rig.ws.session(session)), id);
    if (id === 'A' || id === 'C') await p.run(() => window.rig.wheel('pane-1', -2200));
    left[id] = await one(p);
  }
  // C, read from above, is kept and shown again three times; A, read from above and let go, is entered anew twice.
  const order = ['C', 'A', 'B', 'C', 'D', 'A', 'C'];
  // What each open gives the session it shows: the pane keeps the session shown and the two shown before it mounted
  // (leftLongSession), and those show their reader's place; any other is entered anew and from then on is at its end.
  let kept = ['D', 'C', 'B'];
  const rule = { A: 'place', B: 'place', C: 'place', D: 'place' };
  const rules = order.map((id) => {
    if (!kept.includes(id)) rule[id] = 'end';
    kept = [id, ...kept.filter((other) => other !== id)].slice(0, 3);
    return { ...rule };
  });
  // The k-th open runs in frame 4k + 1, before that frame is sampled.
  const at = Object.fromEntries(order.slice(1).map((id, index) => [(index + 1) * 4 + 1, open(id)]));
  const frames = paneFrames(await p.frames(open(order[0]), { count: order.length * 4 + 6, at }));
  assertPainted(frames, 'quick switches');
  frames.forEach((view, index) => {
    const given = rules[Math.min(Math.floor(index / 4), order.length - 1)][view.session];
    if (given === 'place') {
      assert.deepEqual(view.shown, left[view.session].shown, `frame ${index + 1}, kept: its place (${describe(view)})`);
    } else {
      assert.ok(view.following && Math.abs(view.gap) <= 1, `frame ${index + 1}, entered: its end (${describe(view)})`);
    }
  });
  assert.ok(
    frames.some((view) => view.session === 'C' && !view.following),
    'C, kept, is shown at its place off the end'
  );
  assert.equal(frames.at(-1).session, 'C');
});

// ───────────────────────────── split panes ─────────────────────────────

test('two panes on one session, each read from a place of its own, both let go: each comes back to the end, followed, and neither moves the other', async (t) => {
  const p = await rig(t);
  await p.act((others) => {
    window.rig.core.seed('A', 300, { tools: 1 });
    for (const id of others) window.rig.core.seed(id, 12);
    window.rig.ws.open(window.rig.ws.session('A'));
  }, COLD);
  await p.act(() => window.rig.ws.split(window.rig.ws.session('A')));
  await p.run(() => window.rig.wheel('pane-1', -2000));
  await p.run(() => window.rig.wheel('pane-2', -5200));
  const panes = await p.act(() => {});
  const left = Object.fromEntries(panes.map((view) => [view.pane, view]));
  assert.notDeepEqual(left['pane-1'].shown, left['pane-2'].shown, 'the two panes read different rows');
  // Both panes leave the session, far enough that neither keeps it; then each comes back.
  for (const id of COLD) {
    await p.act((session) => {
      window.rig.ws.open(window.rig.ws.session(session), 'pane-1');
      window.rig.ws.open(window.rig.ws.session(session), 'pane-2');
    }, id);
  }
  assert.ok(!(await p.run(() => window.rig.core.followed())).includes('A'), 'no pane keeps the session');
  const first = await p.frames(({ ws }) => ws.open(ws.session('A'), 'pane-2'), { count: 14 });
  const second = await p.frames(({ ws }) => ws.open(ws.session('A'), 'pane-1'), { count: 14 });
  assertPainted(paneFrames(first, 'pane-2'), 'the pane that returned first');
  const returned = paneFrames(first, 'pane-2').at(-1);
  assertAtEnd([returned], 'A:A-r300', 'the pane that returned first');
  assertPainted(paneFrames(second, 'pane-1'), 'the pane that returned second');
  assertAtEnd([paneFrames(second, 'pane-1').at(-1)], 'A:A-r300', 'the pane that returned second');
  assertStill(paneFrames(second, 'pane-2'), returned, 'the other pane, meanwhile');
});

test('two panes on one session: switching one away and back moves nothing in the other, and the thread stays followed', async (t) => {
  const p = await rig(t);
  await p.act(() => {
    window.rig.core.seed('A', 300, { tools: 1 });
    window.rig.core.seed('B', 40);
    window.rig.ws.open(window.rig.ws.session('A'));
  });
  await p.act(() => window.rig.ws.split(window.rig.ws.session('A')));
  await p.run(() => window.rig.wheel('pane-1', -2000));
  const panes = await p.act(() => {});
  const [first, second] = ['pane-1', 'pane-2'].map((pane) => panes.find((view) => view.pane === pane));
  const away = await p.frames(({ ws }) => ws.open(ws.session('B'), 'pane-2'), { count: 12 });
  assertStill(paneFrames(away, 'pane-1'), first, 'the other pane');
  const back = await p.frames(({ ws }) => ws.open(ws.session('A'), 'pane-2'), { count: 12 });
  assertStill(paneFrames(back, 'pane-1'), first, 'the other pane');
  assertStill(paneFrames(back, 'pane-2'), second, 'the pane that returned');
  assert.equal(await p.run(() => window.rig.core.resumes('A')), 1, 'a session a pane still shows is not followed anew');
});

test('a pane narrowed by a split beside it, its reader in old history: the row at the top of the view keeps its place in every frame', async (t) => {
  const p = await rig(t);
  await p.act(() => {
    window.rig.core.seed('A', 300, { tools: 1 });
    window.rig.core.seed('B', 12);
    window.rig.ws.open(window.rig.ws.session('A'));
  });
  await p.run(() => window.rig.wheel('pane-1', -3000));
  const before = await one(p);
  const frames = paneFrames(await p.frames(({ ws }) => ws.split(ws.session('B')), { count: 12 }));
  assertPainted(frames, 'narrowed');
  assert.ok(frames.at(-1).viewport.width < before.viewport.width, 'the pane is narrower');
  frames.forEach((view, index) => {
    assert.equal(view.first.key, before.first.key, `frame ${index + 1}: the row at the top (${describe(view)})`);
    assert.ok(
      Math.abs(view.first.offset - before.first.offset) <= 1,
      `frame ${index + 1}: its offset (${describe(view)})`
    );
  });
});

test('two panes on different sessions: a switch in one moves nothing in the other', async (t) => {
  const p = await rig(t);
  await p.act(() => {
    for (const id of ['A', 'B', 'C']) window.rig.core.seed(id, 40, { tools: 1 });
    window.rig.ws.open(window.rig.ws.session('A'));
  });
  await p.act(() => window.rig.ws.split(window.rig.ws.session('B')));
  await p.run(() => window.rig.wheel('pane-1', -1500));
  const panes = await p.act(() => {});
  const [first, second] = ['pane-1', 'pane-2'].map((pane) => panes.find((view) => view.pane === pane));
  const frames = await p.frames(({ ws }) => ws.open(ws.session('C'), 'pane-2'), { count: 14 });
  assertStill(paneFrames(frames, 'pane-1'), first, 'the other pane');
  assertHandover(paneFrames(frames, 'pane-2'), second, 'C', 'the pane that switched');
});

// ───────────────────────────── memory ─────────────────────────────

/** What a list mounts: the rows in view and, on each side, those within a viewport height of it
 *  (transcript-list-virtualizer.ts `transcriptMountMargin`): at most a viewport of the shortest row per side. At rest
 *  none lies wholly farther than that but the rows held mounted for what they run (`far`); the rows a frame's records
 *  pushed past it leave in the next. */
function assertMountedWithinMargin(view, label) {
  const perSide = Math.ceil(view.viewport.height / 24);
  assert.ok(
    view.mounted.length <= view.shown.length + 2 * perSide + 2,
    `${label}: ${view.mounted.length} rows mounted with ${view.shown.length} in view`
  );
}

test('a session followed while turns run: every frame mounts the rows in view and the margin, however long it grows', async (t) => {
  const p = await rig(t);
  await p.act(() => {
    window.rig.core.seed('A', 300, { tools: 1 });
    window.rig.ws.open(window.rig.ws.session('A'));
  });
  const turn = ({ core }) => core.turn('A', { tools: 2 });
  const tool = ({ core }) => {
    core.prompt('A');
    core.tool('A', `A-live-${core.threads.get('A').turn}`, { done: false });
  };
  const close = ({ core }) => {
    core.tool('A', `A-live-${core.threads.get('A').turn}`);
    core.reply('A');
    core.end('A');
  };
  const at = {};
  for (let frame = 2; frame <= 90; frame += 1) at[frame] = frame % 6 === 2 ? tool : frame % 6 === 4 ? close : turn;
  const frames = paneFrames(await p.frames(() => {}, { count: 92, at }));
  assertPainted(frames, 'followed');
  assert.ok(frames.at(-1).far <= 2, `at rest ${frames.at(-1).far} rows are mounted more than a viewport from the view`);
  const most = Math.max(...frames.map((view) => view.mounted.length));
  t.diagnostic(
    `a session followed over ${frames.length} frames of running turns: at most ${most} rows mounted, ${Math.max(...frames.map((view) => view.shown.length))} in view`
  );
  frames.forEach((view, index) => {
    assertMountedWithinMargin(view, `frame ${index + 1}`);
    assert.ok(Math.abs(view.gap) <= 1, `frame ${index + 1} is ${view.gap}px from the end`);
  });
});

test('a session followed from its first turn through forty turns of streamed text and tool rounds: the rows mounted do not grow with the turns', async (t) => {
  const p = await rig(t);
  await p.act(() => {
    window.rig.core.seed('A', 1);
    window.rig.ws.open(window.rig.ws.session('A'));
  });
  // One step of a turn per frame: the prompt, two rounds of streamed text stored and two tool calls run, the reply
  // streamed and stored, the end.
  const step = ({ core }) => {
    const t = core.threads.get('A');
    const s = (window.__step = (window.__step ?? 0) + 1) % 14;
    const round = s < 6 ? 0 : 1;
    const call = (k) => `A-c${t.turn}.${round}.${k}`;
    if (s === 1) core.prompt('A');
    else if (s === 2 || s === 7) core.stream('A', 'Reading the files the change touches. ');
    else if (s === 3 || s === 8) core.reply('A', { storedId: `A-m${t.turn}.${round}` });
    else if (s === 4 || s === 9) for (const k of [0, 1]) core.tool('A', call(k), { done: false });
    else if (s === 5 || s === 10) for (const k of [0, 1]) core.tool('A', call(k));
    else if (s === 11 || s === 12) core.stream('A', 'The change is in place and its tests pass. ');
    else if (s === 13) core.reply('A');
    else if (s === 0) core.end('A');
  };
  const count = 40 * 14 + 2;
  const at = Object.fromEntries(Array.from({ length: count - 2 }, (_, n) => [n + 2, step]));
  const frames = paneFrames(await p.frames(() => {}, { count, at }));
  assertPainted(frames, 'followed from the start');
  const mounted = frames.map((view) => view.mounted.length);
  const all = await p.run(() => document.querySelectorAll('.transcript-virtual-row').length);
  t.diagnostic(
    `forty turns followed: ${Math.max(...mounted)} rows mounted at most, ${mounted.at(-1)} at rest (${all} in the document), ${frames.at(-1).shown.length} in view`
  );
  frames.forEach((view, index) => {
    assertMountedWithinMargin(view, `frame ${index + 1}`);
  });
  assert.equal(all, mounted.at(-1), 'no row is mounted outside the list shown');
});

test('what is held: a long session by the window around its reader, many sessions by the conversations the panes keep', async (t) => {
  const p = await rig(t);
  await p.act(() => {
    window.rig.core.seed('A', 3000, { tools: 1 });
    window.rig.ws.open(window.rig.ws.session('A'));
  });
  const atEnd = await p.run(() => window.rig.memory());
  await p.run(() => window.rig.wheel('pane-1', -4000));
  const reading = await p.run(() => window.rig.memory());
  t.diagnostic(
    `a session of 11,999 rows: ${atEnd.windowRows.A} rows held at its end, ${reading.windowRows.A} read from above; ${reading.mountedRows} rows mounted`
  );
  assert.ok(atEnd.windowRows.A <= 400, `${atEnd.windowRows.A} rows at the end`);
  assert.ok(reading.windowRows.A <= 2_048 + 96 + 400, `${reading.windowRows.A} rows read from above`);
  assert.ok(reading.mountedRows <= 120, `${reading.mountedRows} rows mounted`);
  // Forty sessions shown in turn, each left read from above.
  for (let n = 0; n < 40; n += 1) {
    await p.act((id) => {
      window.rig.core.seed(id, 120, { tools: 1 });
      window.rig.ws.open(window.rig.ws.session(id));
    }, `M${n}`);
    await p.run(() => window.rig.wheel('pane-1', -1500));
  }
  const many = await p.run(() => window.rig.memory());
  await p.run(() => window.rig.store.sweepHidden());
  const swept = await p.run(() => window.rig.memory());
  t.diagnostic(
    `41 sessions shown in turn: ${many.followed.length} followed (${Object.values(many.windowRows).reduce((a, b) => a + b, 0)} rows), ` +
      `${many.conversations} conversations and ${many.mountedRows} rows mounted, sizes of ${many.measuredRows.rows} rows in ${many.measuredRows.sessions} sessions, ` +
      `${many.places} places; rows of sessions not shown: ${many.hiddenRows} before a sweep, ${swept.hiddenRows} after (${swept.hiddenBytes} bytes estimated)`
  );
  assert.equal(many.followed.length, 3, 'the session shown and the two before it');
  assert.equal(many.conversations, 3);
  assert.ok(many.mountedRows <= 120);
  assert.equal(many.places, 41, 'one place per tab read from above');
  assert.ok(many.measuredRows.sessions <= 16);
  assert.ok(
    swept.hiddenRows <= (swept.lanes - 3) * 512,
    `${swept.hiddenRows} rows of ${swept.lanes - 3} sessions not shown`
  );
  // The first session comes back at its end.
  const before = await one(p);
  const frames = await switchTo(p, 'A');
  const arrived = assertHandover(frames, before, 'A', 'after forty sessions');
  assertAtEnd(frames.slice(arrived), 'A:A-r3000', 'after forty sessions');
});

test('a cold return after forty sessions whose rows parse late, a minute and more on every clock: the session shown stays, and the first frame of the return is its end, final', async (t) => {
  const p = await rig(t);
  await p.act(() => {
    window.rig.core.seed('A', 300, { tools: 1, long: true });
    window.rig.ws.open(window.rig.ws.session('A'));
  });
  await p.run(() => window.rig.wheel('pane-1', -4000));
  for (let n = 0; n < 40; n += 1) {
    await p.act((id) => {
      window.rig.core.seed(id, 12);
      window.rig.ws.open(window.rig.ws.session(id));
    }, `M${n}`);
  }
  // No parsed reply is kept, and none is parsed until the rig says so.
  await p.run(() => {
    window.rig.reclaim();
    window.rig.core.holdParses();
    window.rig.core.hold();
  });
  const before = await one(p);
  const step = ({ core }) => {
    core.release();
    core.hold();
  };
  const later = ({ advance }) => advance(90_000);
  let heldAt = 0;
  const frames = paneFrames(
    await p.frames(open('A'), {
      count: 34,
      rest: false,
      at: {
        3: step,
        6: step,
        9: step,
        12: step,
        14: later,
        17: later,
        20: later,
        23: ({ core }) => (window.heldAt = core.heldParses()),
        24: ({ core }) => core.releaseParses(),
      },
    })
  );
  heldAt = await p.run(() => window.heldAt);
  const [rested] = await p.act(() => window.rig.core.release());
  assert.ok(heldAt > 0, 'replies of the return were waiting to be parsed');
  const all = [...frames, rested];
  const arrived = all.findIndex((view) => view.session === 'A');
  assert.ok(
    arrived >= 24,
    `the return is presented once its rows are parsed (frame ${arrived}, ${heldAt} parses held)`
  );
  assertHandover(all, before, 'A', 'after forty sessions, parsed late');
  assertAtEnd(all.slice(arrived), 'A:A-r300', 'after forty sessions, parsed late');
});

// ───────────────────────────── reads of the core that never answer ─────────────────────────────

/** Session A, whose turns around turn 40 and whose last ones each wrote a file: the turn's own `write` call names it,
 *  and the core's read of the turn's changes lists `listed` (the same file, unless given). */
const withChanges = (listed) => {
  const turns = [38, 39, 40, 41, 42, 298, 299, 300];
  window.rig.core.seed('A', 300, { tools: 1, writes: Object.fromEntries(turns.map((n) => [n, 'src/app.ts'])) });
  for (const n of turns) window.rig.core.changes(`A-u${n}`, listed ?? ['src/app.ts']);
};
/** The changes cards in the pane: how many, how many drawn from the turn's own records, and the files each lists. */
const cards = (p) =>
  p.run(() => {
    const all = [...document.querySelectorAll('.pane-cell .turn-changes-card')];
    return {
      count: all.length,
      recorded: all.filter((card) => card.dataset.source === 'records').length,
      files: all.map((card) => Number(card.dataset.fileCount)),
    };
  });
const cardRows = (view) => view.shown.filter((entry) => /A:A-r(38|39|40|41|42)@/.test(entry));

test("a search hit on turns whose changed files are never read: each card is drawn in the first frame from its turn's own records, and the read answered later moves nothing", async (t) => {
  const p = await rig(t);
  await p.act(withChanges);
  await p.act(() => window.rig.ws.open(window.rig.ws.session('A')));
  await p.run(() => {
    window.rig.forgetChanges();
    window.rig.core.holdReads();
  });
  const frames = paneFrames(
    await p.frames(({ openAt }) => openAt('A', 'A-u40'), {
      count: 20,
      at: { 6: ({ advance }) => advance(90_000), 12: ({ advance }) => advance(90_000) },
    })
  );
  assertPainted(frames, 'hit on turns with unread changes');
  const arrived = frames.findIndex((view) => view.shown.some((entry) => entry.startsWith('A:A-u40@')));
  assert.ok(arrived >= 0, 'the hit is presented with its changes unread');
  assert.ok((await p.run(() => window.rig.core.heldReads())) > 0, 'the reads are still out');
  const presented = frames.at(-1);
  assertStill(frames.slice(arrived), presented, 'once the hit is shown');
  assert.ok(cardRows(presented).length > 0, 'a turn that changed a file is in view');
  const drawn = await cards(p);
  assert.ok(
    drawn.count > 0 && drawn.recorded === drawn.count,
    `the cards are drawn from the records (${JSON.stringify(drawn)})`
  );
  // The reads are answered with the files the records named: the cards are filled in, at the size they had.
  const after = paneFrames(await p.frames(({ core }) => core.answerReads(), { count: 12 }));
  assertStill(after, presented, 'the changes read answered after the hit is shown');
  const filled = await cards(p);
  assert.equal(filled.count, drawn.count);
  assert.equal(filled.recorded, 0, 'each card now shows what the core read');
});

test('a cold return to a session whose changed files are no longer held, left in old history: its end comes back once its cards are read, with the cards the core lists', async (t) => {
  const p = await rig(t);
  await p.act(withChanges);
  await p.act(() => window.rig.ws.open(window.rig.ws.session('A')));
  await p.act(() => window.rig.openAt('A', 'A-u40'));
  assert.ok((await cards(p)).count > 0, 'the reader left rows with cards');
  for (let n = 0; n < 4; n += 1) {
    await p.act((id) => {
      window.rig.core.seed(id, 12);
      window.rig.ws.open(window.rig.ws.session(id));
    }, `M${n}`);
  }
  // Nothing of A's cards is held, and the core answers them only after minutes.
  await p.run(() => {
    window.rig.reclaim();
    window.rig.forgetChanges();
    window.rig.core.holdReads();
  });
  const before = await one(p);
  const frames = paneFrames(
    await p.frames(open('A'), {
      count: 30,
      at: {
        8: ({ advance }) => advance(90_000),
        14: ({ advance }) => advance(90_000),
        18: ({ core }) => core.answerReads(),
      },
    })
  );
  const arrived = assertHandover(frames, before, 'A', 'cold return, changes read late');
  assert.ok(arrived >= 18, `no elapsed time presents the return, its reads do (frame ${arrived + 1})`);
  assertAtEnd(frames.slice(arrived), 'A:A-r300', 'cold return, changes read late');
  const drawn = await cards(p);
  assert.ok(drawn.count > 0 && drawn.recorded === 0, `the cards are the core's (${JSON.stringify(drawn)})`);
});

// A read whose card would change the row's height: what the turn's records named and what the core lists differ.
for (const [what, written, listed, before, after] of [
  [
    'a file the records did not name (changed by a shell command): the card grows',
    ['src/app.ts'],
    ['src/app.ts', 'build/out.js'],
    1,
    2,
  ],
  ['files where the records named none: a card appears', [], ['build/out.js'], 0, 1],
  ['no file where the records named one: the card goes', ['src/app.ts'], [], 1, 0],
]) {
  test(`the read lists ${what}, only once its row is out of view; nothing in view moves`, async (t) => {
    const p = await rig(t);
    await p.act(
      ({ written, listed }) => {
        const turns = [38, 39, 40, 41, 42];
        window.rig.core.seed('A', 300, { tools: 1, writes: Object.fromEntries(turns.map((n) => [n, written])) });
        for (const n of turns) window.rig.core.changes(`A-u${n}`, listed);
        window.rig.ws.open(window.rig.ws.session('A'));
      },
      { written, listed }
    );
    await p.run(() => window.rig.core.holdReads());
    await p.act(() => window.rig.openAt('A', 'A-u40'));
    const presented = await one(p);
    const drawn = await cards(p);
    assert.ok(
      drawn.files.every((count) => count === before),
      `from the records: ${before} file (${JSON.stringify(drawn)})`
    );
    if (before === 0) assert.equal(drawn.count, 0);
    else assert.ok(drawn.count > 0);
    // The read answers with another card than the rows were presented with.
    const answered = paneFrames(await p.frames(({ core }) => core.answerReads(), { count: 12 }));
    assertStill(answered, presented, 'the read answered while its rows are in view');
    const inView = () =>
      p.run(() =>
        [...document.querySelectorAll('.pane-cell .transcript-virtual-row')]
          .filter((row) => {
            const box = row.getBoundingClientRect();
            // What shows of the transcript: its shell clips what runs on under the dock.
            const view = row.closest('.transcript-shell').getBoundingClientRect();
            return box.bottom > view.top && box.top < view.bottom;
          })
          .flatMap((row) =>
            [...row.querySelectorAll('.turn-changes-card')].map((card) => [
              Number(card.dataset.fileCount),
              card.dataset.read ?? '',
            ])
          )
      );
    for (const [count, read] of await inView()) {
      assert.equal(count, before, 'a card in view is the one presented');
      assert.equal(read, 'updating', 'and says it is being updated');
    }
    // The reader scrolls the rows out of view and back: each is given the read's card on the way.
    for (let step = 0; step < 8; step += 1) await p.act(() => window.rig.wheel('pane-1', 300));
    for (let step = 0; step < 8; step += 1) await p.act(() => window.rig.wheel('pane-1', -300));
    const back = await inView();
    if (after === 0) assert.deepEqual(back, [], 'no card is left on the rows');
    else {
      assert.ok(back.length > 0, 'the rows in view carry cards');
      for (const [count, read] of back) assert.deepEqual([count, read], [after, ''], 'the card the core read');
    }
  });
}

/** The cards on rows in view, top to bottom: the files each lists, and its read's state. */
const cardsInView = (p) =>
  p.run(() =>
    [...document.querySelectorAll('.pane-cell .transcript-virtual-row')]
      .filter((row) => {
        const box = row.getBoundingClientRect();
        const view = row.closest('.transcript').getBoundingClientRect();
        return box.bottom > view.top && box.top < view.bottom;
      })
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
      .flatMap((row) =>
        [...row.querySelectorAll('.turn-changes-card')].map((card) => [
          Number(card.dataset.fileCount),
          card.dataset.read ?? '',
        ])
      )
  );
test("a session entered at its end whose last turn's read lists more files than its records: it is shown once the read answers, with the core's card from its first frame, and no row moves", async (t) => {
  const p = await rig(t);
  await p.act(() => {
    window.rig.core.seed('B', 12);
    window.rig.ws.open(window.rig.ws.session('B'));
  });
  const before = await one(p);
  await p.run(() => {
    window.rig.core.seed('A', 300, { tools: 1, writes: { 300: ['src/app.ts'] } });
    window.rig.core.changes('A-u300', ['src/app.ts', 'build/out.js']);
    window.rig.core.holdReads();
  });
  const frames = paneFrames(await p.frames(open('A'), { count: 24, at: { 8: ({ core }) => core.answerReads() } }));
  const arrived = assertHandover(frames, before, 'A', 'entry with its last card unread');
  assert.ok(arrived >= 8, `A is shown once the read answered (frame ${arrived + 1})`);
  assert.deepEqual((await cardsInView(p)).at(-1), [2, ''], 'the card the core read, its actions free');
  assert.equal((await cards(p)).recorded, 0, 'no card is drawn from the records');
  const view = await one(p);
  assert.deepEqual(view.shown, frames.at(-1).shown, 'nothing moved after the entry');
  assert.equal(view.following, true);
  assert.ok(Math.abs(view.gap) <= 1, `the view is on the end (${view.gap})`);
  assert.equal(
    await p.run(() =>
      document.querySelector('.pane-cell .turn-changes-card .turn-changes-action').matches(':disabled, [aria-disabled]')
    ),
    false,
    "Undo is the reader's"
  );
});

/** Session A shown at its end, where its last turn then runs and ends, writing one file where the core lists two;
 *  the read is held, so the card the turn's end shows is drawn from its records. */
async function lastTurnEndsReadDiffering(p) {
  await p.act(() => {
    window.rig.core.seed('A', 299, { tools: 1 });
    window.rig.ws.open(window.rig.ws.session('A'));
  });
  await p.act(() => {
    window.rig.core.changes('A-u300', ['src/app.ts', 'build/out.js']);
    window.rig.core.holdReads();
    window.rig.core.turn('A', { tools: 1, writes: { 300: ['src/app.ts'] } });
  });
  const view = await one(p);
  assert.equal(view.following, true);
  assert.deepEqual((await cardsInView(p)).at(-1), [1, ''], "the last turn's card, from its records");
  return view;
}

test('the card of a turn that ended in view, the reader scrolled up from the end: it keeps what it shows; back on the end it takes the read', async (t) => {
  const p = await rig(t);
  await lastTurnEndsReadDiffering(p);
  await p.act(() => window.rig.wheel('pane-1', -40));
  const presented = await one(p);
  assert.equal(presented.following, false);
  assert.deepEqual((await cardsInView(p)).at(-1), [1, ''], 'the card is still in view');
  const frames = paneFrames(await p.frames(({ core }) => core.answerReads(), { count: 12 }));
  assertStill(frames, presented, 'the read answered under a reader off the end');
  assert.deepEqual((await cardsInView(p)).at(-1), [1, 'updating']);
  // The reader goes back to the end: the list follows it again, and the card is the read's.
  for (let step = 0; step < 4 && !(await one(p)).following; step += 1)
    await p.act(() => window.rig.wheel('pane-1', 400));
  const back = await one(p);
  assert.equal(back.following, true);
  assert.deepEqual((await cardsInView(p)).at(-1), [2, '']);
  assert.ok(Math.abs(back.gap) <= 1, `the view is on the end (${back.gap})`);
});

test("a press on Undo of a card kept back gives the read's card and does nothing else: no undo, no diff pane", async (t) => {
  const p = await rig(t);
  await lastTurnEndsReadDiffering(p);
  await p.act(() => window.rig.wheel('pane-1', -40));
  await p.frames(({ core }) => core.answerReads(), { count: 12 });
  assert.deepEqual((await cardsInView(p)).at(-1), [1, 'updating']);
  const state = () =>
    p.run(() => ({
      calls: window.rig.core.capabilityCalls().filter((name) => name !== 'getTurnChanges'),
      panes: document.querySelectorAll('.pane-cell').length,
      // The rig's core answers an undo with a turn that changed nothing: the card is gone after it.
      tip: document.querySelector('.pane-cell .turn-changes-card .turn-changes-action')?.dataset.tooltip,
      title: document.querySelector('.pane-cell .turn-changes-card')?.title,
    }));
  const before = await state();
  assert.match(before.tip, /being updated.*Click it to update it now/);
  assert.match(before.title, /being updated.*Click it to update it now/);
  await p.act(() => document.querySelector('.pane-cell .turn-changes-card .turn-changes-action').click());
  assert.deepEqual((await cardsInView(p)).at(-1), [2, ''], 'the card the core read');
  const after = await state();
  assert.deepEqual(after.calls, before.calls, 'nothing was asked of the core: no undo');
  assert.equal(after.panes, before.panes, 'no pane opened');
  // The same press on the card as it now stands does act.
  await p.act(() => document.querySelector('.pane-cell .turn-changes-card .turn-changes-action').click());
  const acted = await state();
  const asked = acted.calls.slice(before.calls.length);
  assert.equal(
    asked.filter((name) => /revert/i.test(name)).length,
    1,
    `Undo on the read's card asks the core (${asked})`
  );
});

test("two panes on one session: each pane's preview and changes cards stand on what that pane drew, also when the other pane's cards go", async (t) => {
  const p = await rig(t);
  await p.act(() => {
    window.rig.core.seed('A', 30, { tools: 1 });
    window.rig.core.seed('B', 12);
    window.rig.ws.open(window.rig.ws.session('A'));
  });
  await p.act(() => window.rig.ws.split(window.rig.ws.session('A')));
  // The turn writes a page its reply links and a file; the core reads back the file and one a command made, not the
  // page: no card can take that read without a preview going.
  await p.act(() => {
    const { core } = window.rig;
    core.changes('A-u31', ['src/app.ts', 'build/out.js']);
    core.holdReads();
    core.prompt('A');
    core.tool('A', 'A-w31', { name: 'write', input: { path: 'src/page.html', content: '<h1>hi</h1>\n' } });
    core.tool('A', 'A-w31.1', { name: 'write', input: { path: 'src/app.ts', content: 'one\ntwo\n' } });
    core.reply('A', { body: 'Open [the page](src/page.html) to see it.' });
    core.end('A');
  });
  const cardsOf = (pane) =>
    p.run(
      (pane) =>
        [
          ...document.querySelectorAll(
            `#pane-conversation-slot-${pane} > .persistent-pane-surface:not([data-retained]):not([data-preparing]) :is(.transcript-visualize-turn, .turn-changes-card)`
          ),
        ].map((card) =>
          card.dataset.visualizeCount
            ? `previews ${card.dataset.visualizeCount}`
            : `files ${card.dataset.fileCount}${card.dataset.read ? `/${card.dataset.read}` : ''}`
        ),
      pane
    );
  const drawn = ['previews 1', 'files 1'];
  assert.deepEqual(await cardsOf('pane-1'), drawn, 'the turn end draws its records in the first pane');
  assert.deepEqual(await cardsOf('pane-2'), drawn, 'and in the second');
  await p.act(() => window.rig.wheel('pane-1', -40));
  await p.act(() => window.rig.core.answerReads());
  const kept = ['previews 1', 'files 1/updating'];
  assert.deepEqual(await cardsOf('pane-1'), kept, "the first pane's reader keeps what was drawn");
  assert.deepEqual(await cardsOf('pane-2'), kept, 'the second pane would lose a preview: it keeps it too');
  // The second pane shows another session: its cards go, and the first pane's stand as they were.
  await p.act(() => window.rig.ws.replace(window.rig.ws.session('B'), 'pane-2'));
  assert.deepEqual(await cardsOf('pane-1'), kept, "the other pane's cards going takes nothing from this one");
});

test('a turn that wrote several files in a row (one card of calls in the transcript): its changes card lists them from the first frame, the read unanswered', async (t) => {
  const p = await rig(t);
  await p.act(() => {
    const turns = [38, 39, 40, 41, 42];
    window.rig.core.seed('A', 300, {
      tools: 1,
      writes: Object.fromEntries(turns.map((n) => [n, ['src/app.ts', 'src/list.ts', 'src/row.ts']])),
    });
    for (const n of turns) window.rig.core.changes(`A-u${n}`, ['src/app.ts', 'src/list.ts', 'src/row.ts']);
    window.rig.ws.open(window.rig.ws.session('A'));
  });
  await p.run(() => window.rig.core.holdReads());
  const frames = paneFrames(await p.frames(({ openAt }) => openAt('A', 'A-u40'), { count: 16 }));
  assertPainted(frames, 'several writes');
  const arrived = frames.findIndex((view) => view.shown.some((entry) => entry.startsWith('A:A-u40@')));
  const presented = frames.at(-1);
  assertStill(frames.slice(arrived), presented, 'once the hit is shown');
  const drawn = await cards(p);
  assert.ok(drawn.count > 0 && drawn.recorded === drawn.count, `from the records (${JSON.stringify(drawn)})`);
  assert.ok(
    drawn.files.every((count) => count === 3),
    `each card lists the three files (${JSON.stringify(drawn)})`
  );
  const after = paneFrames(await p.frames(({ core }) => core.answerReads(), { count: 12 }));
  assertStill(after, presented, 'the read answered with the same files');
});

test('a session opened while its changes are answered is drawn with the cards of the turns in view', async (t) => {
  const p = await rig(t);
  await p.act(withChanges);
  await p.act(() => window.rig.ws.open(window.rig.ws.session('A')));
  const drawn = await cards(p);
  assert.ok(drawn.count > 0, 'the cards of the turns in view are drawn');
});

test('a switch to a session whose dock reads are never answered: the session is presented, and the reads answered later move no row', async (t) => {
  const p = await rig(t);
  await p.act(() => {
    window.rig.core.seed('A', 300, { tools: 1 });
    window.rig.core.seed('B', 300, { tools: 1 });
    window.rig.ws.open(window.rig.ws.session('A'));
  });
  await p.run(() => window.rig.wheel('pane-1', -3000));
  const left = await one(p);
  // No dock read is answered from here on: B's entry, and A's on its return.
  await p.run(() => window.rig.core.holdReviews());
  const fromA = await one(p);
  const toB = paneFrames(await p.frames(open('B'), { count: 24, at: { 8: ({ advance }) => advance(90_000) } }));
  const inB = assertHandover(toB, fromA, 'B', 'entry with the dock unread');
  assert.ok(inB >= 0 && inB < 8, `B is presented without the read (frame ${inB + 1})`);
  const fromB = toB.at(-1);
  const back = paneFrames(await p.frames(open('A'), { count: 24, at: { 8: ({ advance }) => advance(90_000) } }));
  const inA = assertHandover(back, fromB, 'A', 'return with the dock unread', left);
  assert.ok(inA >= 0 && inA < 8, `A is presented without the read (frame ${inA + 1})`);
  assert.ok((await p.run(() => window.rig.core.heldReviews())) > 0, 'the reads are still out');
  const presented = back.at(-1);
  const after = paneFrames(await p.frames(({ core }) => core.answerReviews(), { count: 16 }));
  assertStill(after, presented, 'the dock reads answered after the return');
});

test('a cold return whose replies fail to parse on the worker and on the page: presented with their text, every row at its place', async (t) => {
  const p = await rig(t);
  await p.act(() => {
    window.rig.core.seed('A', 60, { tools: 1, long: true });
    window.rig.ws.open(window.rig.ws.session('A'));
  });
  for (let n = 0; n < 4; n += 1) {
    await p.act((id) => {
      window.rig.core.seed(id, 12);
      window.rig.ws.open(window.rig.ws.session(id));
    }, `M${n}`);
  }
  await p.run(() => {
    window.rig.reclaim();
    window.rig.core.failParses();
  });
  const before = await one(p);
  const frames = paneFrames(await p.frames(open('A'), { count: 24, at: { 8: ({ advance }) => advance(90_000) } }));
  const arrived = assertHandover(frames, before, 'A', 'replies that fail to parse');
  assert.ok(arrived >= 0, 'the session is presented');
  const text = await p.run(() => {
    const rows = [...document.querySelectorAll('.pane-cell .transcript-virtual-row .markdown')];
    return {
      rows: rows.length,
      pending: document.querySelectorAll('.pane-cell [data-transcript-pending]').length,
      shown: rows.filter((row) => row.textContent.includes('Reply')).length,
    };
  });
  assert.equal(text.pending, 0, 'no reply is left waiting');
  assert.ok(text.shown > 0 && text.shown === text.rows, `each reply shows its text (${text.shown} of ${text.rows})`);
});

/** Session A shown in two panes, pane-1 read from `scroll` above its end, then `leave` run on it; pane-2 follows a run
 *  of `turns` turns. What the core holds for the window: before the run, and the most during it. */
async function followedBesideAReader(p, { scroll, leave, turns = 700 }) {
  await p.act(() => {
    window.rig.core.seed('A', 300, { tools: 1 });
    window.rig.core.seed('B', 12);
    window.rig.ws.open(window.rig.ws.session('A'));
  });
  await p.act(() => window.rig.ws.split(window.rig.ws.session('A')));
  await p.run((by) => window.rig.wheel('pane-1', by), scroll);
  const panes = await p.act(() => {});
  const reader = panes.find((view) => view.pane === 'pane-1');
  if (leave) await p.act(leave);
  const held = () => p.run(() => window.rig.core.windowRows('A'));
  const start = await held();
  let most = start;
  const views = [];
  for (let done = 0; done < turns; done += 20) {
    const now = await p.act(() => {
      for (let k = 0; k < 20; k += 1) window.rig.core.turn('A', { tools: 1 });
    });
    views.push(now);
    most = Math.max(most, await held());
  }
  return { reader, start, most, end: await held(), views, rows: turns * 4 };
}

for (const [how, leave] of [
  ['shows another session', () => window.rig.ws.open(window.rig.ws.session('B'), 'pane-1')],
  ['closes the session', () => window.rig.ws.close(window.rig.ws.session('A'), 'pane-1')],
]) {
  test(`a pane that read above the end and then ${how}: the pane that follows a long run holds a bounded window`, async (t) => {
    const p = await rig(t);
    const { start, most, end, rows } = await followedBesideAReader(p, { scroll: -2600, leave });
    t.diagnostic(`${rows} rows stored while followed: ${start} rows held before, at most ${most} during, ${end} after`);
    assert.ok(start + rows > 2_048 + 800, 'the run is longer than the bound');
    assert.ok(most <= 2_048 + 400, `at most ${most} rows held: nothing is kept for a reader that left`);
    assert.ok(end < most, 'the tail was read anew');
  });
}

test('a pane that sits a screen above the end and does not move, beside one that follows a long run: the window is bounded and its rows stay put', async (t) => {
  const p = await rig(t);
  const { reader, start, most, end, views, rows } = await followedBesideAReader(p, { scroll: -700 });
  t.diagnostic(`${rows} rows stored while followed: ${start} rows held before, at most ${most} during, ${end} after`);
  assert.ok(most <= 2_048 + 800, `at most ${most} rows held: the tail and the rows around the reader who stands still`);
  assert.ok(end < most, 'the tail was read anew under the reader who stands still');
  for (const [n, panes] of views.entries()) {
    const still = panes.find((view) => view.pane === 'pane-1');
    assert.deepEqual(
      still.shown,
      reader.shown,
      `after ${(n + 1) * 20} turns the standing reader's rows are where they were`
    );
    const following = panes.find((view) => view.pane === 'pane-2');
    assert.ok(Math.abs(following.gap) <= 1, 'the other pane is at the end');
  }
});

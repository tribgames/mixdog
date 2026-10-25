import assert from 'node:assert/strict';
import test from 'node:test';
import { act } from 'react';
import { installPhonePaneDom, laneSnapshot } from './test-support/phone-pane-dom.mjs';

// The real PaneConversation, Conversation, transcript and composer dock on a
// phone. Only the stored-session read and the host callbacks are stubbed;
// animation frames and lane delivery are driven by the test.
async function phone(t, { strict = false } = {}) {
  const { dom, root, element, defaultSessionLaneStore, frames, origins, sampling } = await installPhonePaneDom(t);
  const { rememberTranscriptVirtualMeasurements } = await import('./transcript-virtual-cache.ts');
  const doc = dom.window.document;
  const api = {
    dom,
    root,
    frames,
    // Queued frames requested by the pane itself (the list handoff).
    // Queued reveal sample frames: they read the list, so none may wait on an unmounted one.
    revealFrames: () => [...frames.keys()].filter((id) => sampling.get(id)).length,
    paneFrames: () => [...frames.keys()].filter((id) => origins.get(id)).length,
    show: (sessionId) => act(async () => root.render(element(sessionId, strict))),
    // One animation frame: every callback queued before it, in order.
    frame: () =>
      act(async () => {
        const due = [...frames.values()];
        frames.clear();
        for (const callback of due) callback(0);
      }),
    deliver: (sessionId) =>
      act(async () => {
        defaultSessionLaneStore.apply(laneSnapshot(sessionId));
      }),
    remember: rememberTranscriptVirtualMeasurements,
    // Frames until the loading cover is gone (the reveal bound runs on a clock the test advances).
    uncover: async (clock = 500) => {
      const now = performance.now.bind(performance);
      let skew = 0;
      performance.now = () => now() + skew;
      try {
        for (let step = 0; step < 40 && doc.querySelector('.pane-surface-cover'); step++) {
          skew += clock;
          await api.frame();
          await act(async () => new Promise((resolve) => dom.window.setTimeout(resolve, 5)));
        }
      } finally {
        performance.now = now;
      }
    },
    clearLanes: () => defaultSessionLaneStore.clear(),
    state: () => {
      const shell = doc.querySelector('.transcript-shell');
      const composer = doc.querySelector('.composer');
      const list = doc.querySelector('.transcript-virtual-space');
      const covers = doc.querySelectorAll('.pane-surface-cover');
      // The cover never uncovers a transcript with no list mounted.
      if (!list) assert.equal(covers.length, 1, 'an unmounted list is always behind the cover');
      assert.equal(doc.querySelectorAll('.composer').length, 1, 'exactly one real composer');
      assert.equal(doc.querySelector('.transcript-skeleton-composer'), null, 'no fake composer bar');
      return { shell, composer, list, covers };
    },
  };
  return api;
}

test('the loading cover sits in the transcript shell, beside a real composer that survives a session switch', async (t) => {
  const p = await phone(t);
  await p.show('a');
  const entry = p.state();
  assert.ok(entry.shell, 'the transcript shell mounts');
  assert.ok(entry.composer, 'the real composer is mounted while the session loads');
  assert.equal(entry.covers.length, 1, 'the loading cover is up');
  assert.ok(entry.shell.contains(entry.covers[0]), 'the cover is inside the transcript shell');
  assert.equal(entry.shell.contains(entry.composer), false, 'the composer is outside the shell');
  assert.equal(entry.composer.closest('.conversation'), entry.shell.closest('.conversation'), 'sibling regions');

  await p.show('b');
  const next = p.state();
  assert.equal(next.composer, entry.composer, 'the composer keeps its DOM node across the session switch');
  assert.ok(entry.composer.isConnected);
  assert.ok(next.shell.contains(next.covers[0]), 'the switch cover is in the transcript shell too');
  assert.equal(next.shell.contains(next.composer), false);
  await act(async () => p.root.render(null));
});

test('a cold entry mounts the composer and cover in the tap commit and the list one frame later', async (t) => {
  const p = await phone(t);
  await p.show('a');
  const tap = p.state();
  assert.ok(tap.composer, 'the real composer is in the tap commit');
  assert.equal(tap.list, null, 'no transcript list in the tap commit');
  // The lane lands before the frame: the list still waits for it.
  await p.deliver('a');
  assert.equal(p.state().list, null, 'a lane arriving before the frame does not mount the list early');
  await p.frame();
  const next = p.state();
  assert.ok(next.list, 'the next frame mounts the list');
  assert.equal(next.composer, tap.composer, 'the composer is the same node');
  for (const cover of next.covers) assert.ok(next.shell.contains(cover), 'any cover left is in the shell');
});

test('a lane arriving after the frame mounts the list as it lands', async (t) => {
  const p = await phone(t);
  await p.show('a');
  await p.frame();
  p.state();
  await p.deliver('a');
  assert.ok(p.state().list, 'the list mounts with the lane');
});

test('a warm lane mounts its list in the tap commit, with no extra frame', async (t) => {
  const p = await phone(t);
  await p.deliver('a');
  await p.show('a');
  assert.ok(p.state().list);
});

test('rapid A to B to A switches follow the incoming session and never open a stale gate', async (t) => {
  const p = await phone(t);
  await p.show('a');
  const composer = p.state().composer;
  await p.show('b');
  await p.show('a');
  assert.equal(p.state().list, null, 'A re-enters cold, so its list is held again');
  await p.deliver('a');
  assert.equal(p.state().list, null, 'its lane landing mid-switch does not open the gate early');
  await p.frame();
  const settled = p.state();
  assert.ok(settled.list, 'the frame opens the gate for A');
  assert.equal(settled.composer, composer, 'one composer node through the whole sequence');
  // B is cold and A is warm: A -> B holds the list, B -> A (warm) does not.
  await p.show('b');
  assert.equal(p.state().covers.length, 1, 'cold B is covered while A stays painted');
  await p.show('a');
  assert.ok(p.state().list, 'warm A mounts at once');
});

test('unmounting cancels the pending frame', async (t) => {
  const p = await phone(t);
  await p.show('a');
  assert.equal(p.paneFrames(), 1, 'the handoff frame is queued');
  await act(async () => p.root.render(null));
  assert.equal(p.paneFrames(), 0, 'the pane cancelled its handoff frame');
  await p.frame();
});

test('StrictMode keeps one composer and still hands the list over a frame later', async (t) => {
  const p = await phone(t, { strict: true });
  await p.show('a');
  assert.equal(p.state().list, null);
  await p.deliver('a');
  await p.frame();
  assert.ok(p.state().list);
});

test('data arriving while the list is held still uncovers once the list has mounted', async (t) => {
  const p = await phone(t);
  await p.show('a');
  await p.deliver('a');
  assert.equal(p.revealFrames(), 0, 'the reveal does not sample a list that is not mounted');
  // The sample frame the reveal would take runs before the deferred mount.
  await p.frame();
  assert.ok(p.state().list, 'the deferred list is mounted');
  // No clock help: the reveal must start by itself once the list exists.
  for (let step = 0; step < 6; step++) await p.frame();
  const log = p.dom.window.document.querySelector('.transcript');
  assert.equal(log.style.visibility, '', 'the transcript is revealed without waiting out the bound');
  await p.uncover();
  const done = p.state();
  assert.equal(done.covers.length, 0, 'the cover leaves');
  assert.ok(done.list, 'over a mounted list');
});

test('a lane landing after the frame also uncovers', async (t) => {
  const p = await phone(t);
  await p.show('a');
  await p.frame();
  await p.deliver('a');
  await p.uncover();
  assert.equal(p.state().covers.length, 0);
});
test('the deferred mount lands where an immediate one does: the remembered end of a followed session', async (t) => {
  const p = await phone(t);
  const log = () => p.dom.window.document.querySelector('.transcript');
  await p.deliver('w');
  await p.show('w');
  await p.uncover();
  const settled = log().scrollTop;
  assert.ok(settled > 0, 'an immediate mount rests at the end of its rows');
  assert.equal(settled, log().scrollHeight - log().clientHeight);
  await act(async () => p.root.render(null));

  p.clearLanes();
  await p.show('w');
  await p.deliver('w');
  assert.equal(p.state().list, null);
  await p.frame();
  await p.uncover();
  assert.equal(log().scrollTop, settled, 'the deferred mount restores the same end position');
  assert.equal(p.state().covers.length, 0);
});

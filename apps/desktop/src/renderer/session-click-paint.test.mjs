import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installPhonePaneDom, laneSnapshot } from './test-support/phone-pane-dom.mjs';

// A sidebar click through the real session-open hook into the real
// PaneConversation. Commits are recorded in a layout effect, so each entry is
// what the DOM holds when that commit lands, never a render.

async function clickScenario(t, { mobile, warm }) {
  const pane = await installPhonePaneDom(t, { mobile });
  const { flushSync } = await import('react-dom');
  const { useAppSessionOpen } = await import('./app-shell-session-open.ts');
  const doc = pane.dom.window.document;
  pane.defaultSessionLaneStore.apply(laneSnapshot('a'));
  if (warm) pane.defaultSessionLaneStore.apply(laneSnapshot('b'));
  pane.dom.window.mixdogDesktop = {
    prefetchSession: () => new Promise(() => {}),
    // The island's entry read: an empty review, answered at once.
    invokeCapability: async () => ({
      value: { supported: true, authoritative: true, snapshotKind: 'worktree', patch: '', files: [], agents: [] },
    }),
  };
  t.after(() => {
    delete pane.dom.window.mixdogDesktop;
  });
  // One animation frame: every callback queued before it, in order.
  const runFrames = () =>
    act(async () => {
      for (const [id, callback] of [...pane.frames]) {
        pane.frames.delete(id);
        callback(performance.now());
      }
    });
  const commits = [];
  let recording = false;
  // What the DOM holds when a commit lands: rows count as painted only when
  // nothing covers or hides them.
  const snapshotOf = (source, selected) => {
    const log = doc.querySelector('.transcript');
    const text = log?.textContent ?? '';
    const cover = Boolean(doc.querySelector('.pane-surface-cover'));
    const shown = Boolean(log) && !cover && log.style.visibility !== 'hidden';
    return {
      source,
      selected,
      hidden: Boolean(log) && log.style.visibility === 'hidden',
      empty: Boolean(log) && !cover && log.style.visibility !== 'hidden' && text === '',
      outgoingRows: shown && text.includes('answer a'),
      incomingRows: shown && text.includes('answer b'),
      cover,
    };
  };
  const record = (source, selected) => {
    if (recording) commits.push(snapshotOf(source, selected));
  };
  const handle = {};
  function Harness() {
    const [selected, setSelected] = React.useState('a');
    const [, setStrip] = React.useState('a');
    const [, setRequested] = React.useState('');
    const navigationEpoch = React.useRef(0);
    const { openSession } = useAppSessionOpen({
      navigationEpoch,
      closeSidebarForNavigation() {},
      setRequestedSessionId: setRequested,
      sessions: [],
      tabs: [],
      finishPendingConversationHandoff() {},
      activateSelection: (selection) => setSelected(selection.id),
      // The previous implementation's urgent tab announcement; ignored once removed.
      announceOpen: (selection) => setStrip(selection.id),
    });
    handle.openSession = openSession;
    handle.select = setSelected;
    React.useLayoutEffect(() => record('harness', selected));
    // Every commit inside the pane, including its own state updates, not only
    // the ones the harness drives.
    return React.createElement(
      React.Profiler,
      { id: 'pane', onRender: () => record('pane', selected) },
      React.createElement(pane.PaneConversation, pane.props(selected))
    );
  }
  await act(async () => pane.root.render(React.createElement(Harness)));
  assert.ok(doc.querySelector('.transcript')?.textContent.includes('answer a'), 'the outgoing session is painted');
  if (warm) {
    // A warm session was shown before: visit it, then come back to the outgoing one.
    const settle = async () => {
      for (let round = 0; round < 30; round += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        await runFrames();
      }
    };
    await act(async () => handle.select('b'));
    await settle();
    await act(async () => handle.select('a'));
    await settle();
    assert.ok(doc.querySelector('.transcript')?.textContent.includes('answer a'), 'back on the outgoing session');
  }
  recording = true;
  await act(async () => {
    flushSync(() => {
      void handle.openSession('b');
    });
  });
  // The first frame: the animation-frame work that runs before the first paint.
  await runFrames();
  return Object.assign(commits, { firstFrame: snapshotOf('frame', 'b') });
}

for (const mobile of [false, true]) {
  const surface = mobile ? 'phone' : 'PC';
  test(`${surface}: a warm sidebar click paints the incoming rows in its first commit and never the outgoing ones`, async (t) => {
    const commits = await clickScenario(t, { mobile, warm: true });
    assert.ok(commits.length > 0, 'the click committed');
    assert.ok(
      commits.some((entry) => entry.source === 'pane'),
      "the pane's own commits are observed"
    );
    // A session shown before is never covered, never paints the outgoing rows
    // and never paints an empty transcript: its rows are either shown or the
    // transcript is held hidden until its frame reveals them.
    assert.ok(
      commits.every((entry) => !entry.cover),
      `no commit covers it: ${JSON.stringify(commits)}`
    );
    assert.ok(
      commits.every((entry) => !entry.outgoingRows),
      `commits: ${JSON.stringify(commits)}`
    );
    assert.ok(
      commits.every((entry) => !entry.empty),
      `no visible empty transcript: ${JSON.stringify(commits)}`
    );
    assert.ok(
      commits.every((entry) => entry.incomingRows || entry.hidden),
      `every commit shows the incoming rows or holds the transcript hidden: ${JSON.stringify(commits)}`
    );
    // And the first frame paints the incoming rows, uncovered.
    assert.ok(
      commits.firstFrame.incomingRows && !commits.firstFrame.cover,
      `first frame: ${JSON.stringify(commits.firstFrame)}`
    );
  });
  test(`${surface}: a cold sidebar click covers the incoming shell in its first commit, never showing the outgoing rows`, async (t) => {
    const commits = await clickScenario(t, { mobile, warm: false });
    assert.ok(commits.length > 0, 'the click committed');
    assert.ok(commits[0].cover, `first commit: ${JSON.stringify(commits[0])}`);
    assert.ok(
      commits.every((entry) => !entry.outgoingRows),
      `commits: ${JSON.stringify(commits)}`
    );
  });
}

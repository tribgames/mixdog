import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CompletionStatus, backgroundWorkCounts } from './transcript-status';
import { EMPTY_SNAPSHOT } from './desktop-types';
import { desktopConversationShellSnapshotsEqual, desktopHeaderSnapshotsEqual } from './desktop-snapshot-store';
import { createSessionLaneStore, useSessionLane } from './session-lane-store';
import { installTestDom } from './test-support/test-dom.mjs';

const item = { kind: 'turndone', status: 'complete', toolCount: 2, elapsedMs: 12_000 };
const render = (props) => {
  document.body.innerHTML = renderToStaticMarkup(React.createElement(CompletionStatus, { item, ...props }));
  return document.querySelector('.turn-status');
};

test('latest completion waits on background work, then returns to completed in place', () => {
  const { restore } = installTestDom(null, { globals: { React } });
  try {
    const waiting = render({ backgroundWork: { shell: 2, agent: 1 } });
    assert.ok(waiting.classList.contains('waiting'));
    assert.equal(waiting.querySelectorAll('.turn-status-dots > span').length, 3);
    assert.ok(!waiting.querySelector('svg'));
    assert.equal(waiting.textContent, 'Waiting on 2 shell jobs · 1 agents');
    assert.equal(render({ backgroundWork: { shell: 1, agent: 0 } }).textContent, 'Waiting on 1 shell jobs');
    assert.equal(render({ backgroundWork: { shell: 0, agent: 1 } }).textContent, 'Waiting on 1 agents');

    const done = render({});
    assert.ok(!done.classList.contains('waiting'));
    assert.ok(done.classList.contains('complete'));
    assert.equal(done.textContent, 'Work complete in 12s');
    assert.ok(waiting.className.includes('turn-status complete'));
  } finally {
    restore();
  }
});

test('backgroundWorkCounts reads shell jobs and running agents', () => {
  assert.equal(backgroundWorkCounts({ shellJobs: { count: 0, jobs: [] } }), undefined);
  assert.deepEqual(backgroundWorkCounts({ shellJobs: { count: 2, jobs: [] } }), { shell: 2, agent: 0 });
});

test('background subscribers update independently and a later completion still reaches the mounted row', async (t) => {
  const { root, document } = installTestDom(t, { rootId: 'root', globals: { React } });
  const store = createSessionLaneStore();
  t.after(() => store.clear());
  let snapshot = { ...EMPTY_SNAPSHOT, sessionId: 's', items: [item], shellJobs: { count: 0, jobs: [] } };
  const publish = async (change) => {
    snapshot = { ...snapshot, ...change };
    await act(async () => {
      store.apply({ sessionId: 's', snapshot });
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
  };
  function Completion() {
    const lane = useSessionLane('s', store, desktopConversationShellSnapshotsEqual);
    return React.createElement(CompletionStatus, { item: lane.items.at(-1) });
  }
  function BackgroundStatus() {
    const lane = useSessionLane('s', store, desktopHeaderSnapshotsEqual);
    return React.createElement(
      'output',
      null,
      `${lane.shellJobs.count}/${lane.agentJobs?.length || 0}/${lane.agentWorkers?.length || 0}`
    );
  }
  await publish({});
  await act(async () =>
    root.render(
      React.createElement(React.Fragment, null, React.createElement(Completion), React.createElement(BackgroundStatus))
    )
  );
  assert.equal(document.querySelector('.turn-status').textContent, 'Work complete in 12s');
  assert.equal(document.querySelector('output').textContent, '0/0/0');
  await publish({ shellJobs: { count: 2, jobs: [] }, agentJobs: [{ id: 'a' }], agentWorkers: [{ id: 'w' }] });
  assert.equal(document.querySelector('output').textContent, '2/1/1');
  assert.equal(document.querySelector('.turn-status').textContent, 'Work complete in 12s');
  await publish({ items: [{ ...item, elapsedMs: 24_000 }] });
  assert.equal(document.querySelector('.turn-status').textContent, 'Work complete in 24s');
  assert.equal(document.querySelector('output').textContent, '2/1/1');
  await publish({ shellJobs: { count: 0, jobs: [] }, agentJobs: [], agentWorkers: [] });
  assert.equal(document.querySelector('output').textContent, '0/0/0');
  assert.equal(document.querySelector('.turn-status').textContent, 'Work complete in 24s');
});

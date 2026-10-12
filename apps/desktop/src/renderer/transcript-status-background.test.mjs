import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CompletionStatus, backgroundWorkCounts } from './transcript-status';
import { EMPTY_SNAPSHOT } from './desktop-types';
import { desktopConversationShellSnapshotsEqual } from './desktop-snapshot-store';
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

test('conversation shell snapshots differ when only background jobs change', () => {
  const base = { ...EMPTY_SNAPSHOT, sessionId: 's', items: [], shellJobs: { count: 1, jobs: [] } };
  assert.equal(desktopConversationShellSnapshotsEqual(base, { ...base, shellJobs: { count: 1, jobs: [] } }), true);
  assert.equal(desktopConversationShellSnapshotsEqual(base, { ...base, shellJobs: { count: 0, jobs: [] } }), false);
  assert.equal(desktopConversationShellSnapshotsEqual(base, { ...base, agentJobs: [{ id: 'a' }] }), false);
  assert.equal(desktopConversationShellSnapshotsEqual(base, { ...base, agentWorkers: [{ id: 'w' }] }), false);
});

import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

// react-dom's one-time event-support detection needs a DOM at import time.
const { restore: restoreBootstrapDom } = installTestDom(null);
after(restoreBootstrapDom);
const [
  { desktopAgentActivityState, desktopAgentFailureReason },
  { agentElapsedText },
  { AgentActivityPane },
  { AGENT_GROUP_EXPANSION_EVENT },
  { ComposerDock },
  { defaultSessionLaneStore },
  { clearBranchSegmentCache },
  { resetDismissedShellJobsCache },
  { quietCueText },
  { LiveActivity },
  { publishAgentModeSessions },
] = await Promise.all([
  import('../shared/agent-activity.ts'),
  import('./agent-row-meta.ts'),
  import('./AgentActivityPane.tsx'),
  import('./agent-group-visibility.tsx'),
  import('./ComposerDock.tsx'),
  import('./session-lane-store.ts'),
  import('./WorktreeIslandSegment.tsx'),
  import('./background-jobs-dismissed-store.ts'),
  import('./quiet-cue.tsx'),
  import('./transcript-status.tsx'),
  import('./agent-chat-mode.ts'),
]);

// The Agents pane lists agent-mode chats only (AgentActivityPane `visibleGroups`
// filters on isAgentChatSession; an ordinary coding session's work stays with
// that session), so the owner session of these pool rows is published as one.
function publishAgentModeOwner(t, id) {
  publishAgentModeSessions([{ id, sessionMode: 'agent' }]);
  t.after(() => publishAgentModeSessions([]));
}

const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();

function mount(t, host) {
  const { dom, root } = installTestDom(t, {
    jsdom: { url: 'http://localhost/' },
    expose: ['HTMLElement', 'Element', 'Node', 'KeyboardEvent', 'MouseEvent', 'MutationObserver', 'navigator'],
    globals: {
      ResizeObserver: class {
        observe() {}
        disconnect() {}
      },
    },
    rootId: 'root',
  });
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  dom.window.requestAnimationFrame = (callback) => dom.window.setTimeout(() => callback(Date.now()), 16);
  dom.window.cancelAnimationFrame = (id) => dom.window.clearTimeout(id);
  let pushPool = () => {};
  let poolRows = [];
  dom.window.mixdogDesktop = {
    listAgentPool: async () => poolRows,
    subscribeAgentPool: (listener) => {
      pushPool = listener;
      return () => {};
    },
    ...host,
  };
  clearBranchSegmentCache();
  resetDismissedShellJobsCache();
  t.after(() => defaultSessionLaneStore.clear());
  const publishPool = (rows) =>
    act(async () => {
      poolRows = rows;
      pushPool(rows);
    });
  return { root, document: dom.window.document, window: dom.window, publishPool };
}

const lead = {
  tag: 'lead:lead-a',
  agent: 'lead',
  sessionId: 'lead-a',
  ownerSessionId: 'lead-a',
  status: 'running',
  stage: 'running',
  startedAt: NOW - 60_000,
};
const worker = (tag, overrides = {}) => ({
  tag,
  agent: 'worker',
  sessionId: `s-${tag}`,
  ownerSessionId: 'lead-a',
  parentSessionId: 'lead-a',
  status: 'idle',
  stage: 'idle',
  startedAt: NOW - 50_000,
  idleSince: iso(NOW - 10_000),
  ...overrides,
});

test('a failed or watchdog-stopped agent is failed with its reason, never a completion or a rest', () => {
  for (const status of ['failed', 'error', 'timeout', 'fail']) {
    assert.equal(desktopAgentActivityState({ status, stage: status }, { unread: true }), 'failed', status);
  }
  // Failure is classified before the generic finished bucket; a cancel still outranks it.
  assert.equal(desktopAgentActivityState({ status: 'cancelled', stage: 'error' }), 'cancelled');
  // The copied runtime phase never fails a worker whose lifecycle still runs.
  assert.equal(desktopAgentActivityState({ status: 'running', stage: 'error' }), 'running');
  assert.equal(desktopAgentFailureReason({ status: 'failed', failureReason: 'process-restart' }), 'process-restart');
  assert.equal(desktopAgentFailureReason({ status: 'failed', failureReason: 'stalled' }), 'stalled');
  assert.equal(desktopAgentFailureReason({ status: 'error' }), 'error');
  assert.equal(desktopAgentFailureReason({ status: 'idle', failureReason: 'stalled' }), '');
  const restarted = { status: 'failed', stage: 'failed', failureReason: 'process-restart' };
  assert.equal(agentElapsedText('failed', restarted, NOW), 'Failed');
  assert.equal(agentElapsedText('failed', { status: 'failed', failureReason: 'stalled' }, NOW), 'Failed');
});

test('the Agents pane shows the failure with its reason, and Clear finished removes settled rows only', async (t) => {
  publishAgentModeOwner(t, 'lead-a');
  const { root, document, window, publishPool } = mount(t);
  const sessions = [{ id: 'lead-a', title: 'Lead A', preview: '', updatedAt: 1, messageCount: 1 }];
  await act(async () => root.render(React.createElement(AgentActivityPane, { active: false, sessions })));
  await publishPool([
    lead,
    worker('crashed', { status: 'failed', stage: 'failed', failureReason: 'process-restart' }),
    worker('stopped', { status: 'cancelled', stage: 'cancelled' }),
    worker('rested'),
    worker('busy', { status: 'running', stage: 'running', idleSince: null }),
  ]);
  await act(async () => window.dispatchEvent(new window.CustomEvent(AGENT_GROUP_EXPANSION_EVENT, { detail: true })));
  const elapsed = (tag) => document.querySelector(`.agent-pool-row[data-agent-tag="${tag}"] .agent-activity-elapsed`);
  assert.equal(elapsed('crashed').dataset.state, 'failed');
  assert.equal(elapsed('crashed').textContent, 'Failed');
  await act(async () => document.querySelector('[data-agent-owner-session-id="lead-a"] .row-overflow-trigger').click());
  await act(async () => document.querySelector('[data-action-id="clear-finished-agents"]').click());
  const tags = () => [...document.querySelectorAll('.agent-pool-row')].map((row) => row.dataset.agentTag);
  assert.deepEqual(tags(), ['lead:lead-a', 'busy']);
  // A cleared agent comes back once it settles again (new work, new outcome).
  await publishPool([lead, worker('rested', { idleSince: iso(NOW) }), worker('busy', { status: 'running' })]);
  assert.deepEqual(tags().sort(), ['busy', 'lead:lead-a', 'rested']);
});

test('the composer island counts failures, and Clear finished leaves only work that is not finished', async (t) => {
  const { root, document, publishPool } = mount(t);
  await act(async () =>
    root.render(
      React.createElement(
        ComposerDock,
        {
          sessionId: 'lead-a',
          goalSubmissionId: '',
          showProjectSelector: false,
          reviewItems: [],
          reviewActive: true,
          reviewBusy: false,
          reviewSessionId: '',
          reviewCwd: '',
        },
        React.createElement('form', { className: 'composer' })
      )
    )
  );
  await publishPool([
    lead,
    worker('stalled', { status: 'failed', stage: 'failed', failureReason: 'stalled' }),
    worker('rested'),
    worker('busy', { status: 'running', stage: 'running', idleSince: null }),
  ]);
  const segment = () => document.querySelector('.composer-island-seg-agents');
  assert.equal(segment().querySelector('.composer-island-seg-state[data-kind="failed"]'), null);
  assert.doesNotMatch(segment().title, /failed/);
  await act(async () => segment().click());
  const row = (tag) => document.querySelector(`.agent-pool-row[data-agent-tag="${tag}"] .agent-activity-elapsed`);
  assert.equal(row('stalled').textContent, 'Failed');
  assert.match(document.querySelector('.composer-island-phead').textContent, /1 failed/);
  const clear = [...document.querySelectorAll('.composer-island-phead-action')].find(
    (button) => button.textContent === 'Clear finished'
  );
  await act(async () => clear.click());
  assert.deepEqual(
    [...document.querySelectorAll('.agent-pool-row')].map((node) => node.dataset.agentTag),
    ['busy']
  );
});

test('agent rows show no quiet or wait-reason line, however long a running agent is quiet', async (t) => {
  publishAgentModeOwner(t, 'lead-a');
  const { root, document, window, publishPool } = mount(t);
  const sessions = [{ id: 'lead-a', title: 'Lead A', preview: '', updatedAt: 1, messageCount: 1 }];
  await act(async () => root.render(React.createElement(AgentActivityPane, { active: false, sessions })));
  const running = (tag, quietMs) =>
    worker(tag, {
      status: 'running',
      stage: 'streaming',
      idleSince: null,
      progressAt: Date.now() - quietMs,
      progressStage: 'streaming',
      stallWarnMs: 300_000,
    });
  await publishPool([lead, running('fresh', 30_000), running('quiet', 150_000), running('stuck', 400_000)]);
  await act(async () => window.dispatchEvent(new window.CustomEvent(AGENT_GROUP_EXPANSION_EVENT, { detail: true })));
  assert.equal(document.querySelectorAll('.agent-pool-row').length, 4);
  assert.equal(document.querySelector('.agent-pool-row .quiet-cue'), null);
  assert.equal(
    quietCueText({ quietMs: 200_000, minutes: 3, wait: 'tool', tool: 'shell', escalated: false }).endsWith(
      'running shell'
    ),
    true
  );
});

test('the live status line shows the published quiet state and escalates with Stop', async (t) => {
  const aborted = [];
  const { root, document } = mount(t, {
    abortSession: async (sessionId) => {
      aborted.push(sessionId);
    },
  });
  const snapshot = (quiet) => ({
    sessionId: 'lead-a',
    busy: true,
    spinner: { active: true, mode: 'requesting', startedAt: Date.now() - 700_000, quiet },
  });
  await act(async () => root.render(React.createElement(LiveActivity, { snapshot: snapshot(null) })));
  assert.equal(document.querySelector('.live-activity-quiet'), null);
  const since = Date.now() - 150_000;
  await act(async () =>
    root.render(React.createElement(LiveActivity, { snapshot: snapshot({ since, wait: 'provider', warnMs: 600_000 }) }))
  );
  const quiet = document.querySelector('.live-activity-quiet');
  assert.match(quiet.textContent, /waiting on provider/);
  assert.equal(quiet.querySelector('.quiet-cue-stop'), null);
  await act(async () =>
    root.render(
      React.createElement(LiveActivity, {
        snapshot: snapshot({ since: Date.now() - 650_000, wait: 'provider', warnMs: 600_000 }),
      })
    )
  );
  assert.equal(document.querySelector('.live-activity-quiet').dataset.escalated, 'true');
  await act(async () => document.querySelector('.live-activity-quiet .quiet-cue-stop').click());
  assert.deepEqual(aborted, ['lead-a']);
});

test('the live status line picks up a quiet state that arrives alone on the lane', async (t) => {
  const { root, document, window } = mount(t);
  const frame = (quiet) => ({
    sessionId: 'lead-q',
    busy: true,
    spinner: { active: true, mode: 'requesting', startedAt: Date.now() - 300_000, quiet },
  });
  const initial = frame(null);
  defaultSessionLaneStore.apply({ sessionId: 'lead-q', snapshot: initial });
  // The parent keeps handing over the first snapshot: a silence changes only
  // `spinner.quiet`, which the transcript shell does not re-render on.
  await act(async () => root.render(React.createElement(LiveActivity, { snapshot: initial })));
  assert.equal(document.querySelector('.live-activity-quiet'), null);
  await act(async () => {
    defaultSessionLaneStore.apply({
      sessionId: 'lead-q',
      snapshot: frame({ since: Date.now() - 150_000, wait: 'provider', warnMs: 600_000 }),
    });
    await new Promise((resolve) => window.setTimeout(resolve, 50));
  });
  assert.match(document.querySelector('.live-activity-quiet')?.textContent || '', /waiting on provider/);
});

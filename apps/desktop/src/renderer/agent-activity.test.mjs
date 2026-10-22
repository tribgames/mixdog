import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

import {
  AGENT_POOL_RECONCILE_MS,
  AgentActivityPane,
  agentActivityGroups,
  flattenAgentActivityNodes,
  liveAgentRows,
} from './AgentActivityPane.tsx';
import { createDesktopCancellationLedger, desktopAgentActivityState } from '../shared/agent-activity.ts';
import { backgroundJobRows } from './background-jobs-model.ts';
import { agentElapsedText } from './agent-row-meta.ts';
import {
  formatGoalDuration,
  goalCompletedTimeLabel,
  goalElapsedLabel,
  goalTimeLabel,
  SessionGoalIsland,
} from './SessionGoalIsland.tsx';
import { CompletionStatus, ContextUsageIndicator } from './transcript-status.tsx';
import { PaneContextIndicator } from './app-snapshot-views.tsx';
import { agentActivitySessionIds } from './desktop-types.ts';
import { defaultSessionLaneStore } from './session-lane-store.ts';
import { desktopHeaderSnapshotsEqual } from './desktop-snapshot-store.ts';
import { shellJobsStatusEqual } from '../shared/shell-jobs-status.ts';
import { AGENT_GROUP_EXPANSION_EVENT, AgentGroupsMenu } from './agent-group-visibility.tsx';
import i18n from './i18n.ts';
import { publishAgentModeSessions } from './agent-chat-mode.ts';

// The pane lists agent-mode sessions' work only; these owners are agent chats
// (`internal-control` stays an ordinary session on purpose).
publishAgentModeSessions(
  [
    'lead-a',
    'lead-b',
    'lead-w',
    'lead-o',
    'lead-shell',
    'lead-empty',
    'child-a',
    'ghost-a',
    'unrelated',
    'older-idle',
    'newest-idle',
    'first',
    'second',
  ].map((id) => ({ id, sessionMode: 'agent' }))
);

function installDom() {
  const { restore } = installTestDom(null, { jsdom: { url: 'http://localhost/' }, expose: ['navigator'] });
  return {
    root: createRoot(document.getElementById('root')),
    close: restore,
  };
}

test('a running row whose start stamp is ahead of the clock reads 0s and never wraps to a day', () => {
  const clock = Date.UTC(2026, 9, 18, 12, 0, 0);
  for (const ahead of [1, 500, 1_500, 60_000, 86_399_500, 86_400_000]) {
    const future = clock + ahead;
    for (const stamp of [future, new Date(future).toISOString(), String(future)]) {
      assert.equal(agentElapsedText('running', { turnStartedAt: stamp, startedAt: 0 }, clock), '0s');
    }
  }
  assert.equal(agentElapsedText('running', { turnStartedAt: clock - 1_500, startedAt: 0 }, clock), '1s');
  // A missing turn start shows nothing: startedAt is the session's creation
  // time (a Lead row would read days), never a run origin.
  assert.equal(agentElapsedText('running', { turnStartedAt: 0, startedAt: 0 }, clock), '');
  assert.equal(agentElapsedText('running', { turnStartedAt: null, startedAt: clock - 154_000_000 }, clock), '');
  // Idle rows still carry no duration.
  assert.equal(agentElapsedText('idle', { turnStartedAt: clock + 500, startedAt: 0 }, clock), 'Idle');
});

test('missing liveness is unknown, and execution capacity waits are queued', () => {
  assert.equal(desktopAgentActivityState({ status: 'unknown', stage: 'unknown' }), 'unknown');
  assert.equal(desktopAgentActivityState({ status: 'running', stage: 'resource_wait' }), 'queued');
});

test('a working agent keeps its lifecycle while the runtime phase reads idle, done or error between steps', () => {
  for (const stage of ['idle', 'done', 'error', 'connecting', 'streaming', 'tool_running']) {
    assert.equal(desktopAgentActivityState({ status: 'running', stage }), 'running', stage);
  }
  // The status still ends the work: a settled agent is idle whatever stale phase it carries.
  assert.equal(desktopAgentActivityState({ status: 'idle', stage: 'streaming' }), 'idle');
  // A turn that ended in an error failed: never a rest, whatever stage it carries.
  assert.equal(desktopAgentActivityState({ status: 'error', stage: 'running' }), 'failed');
  // A cancel in either field is never work.
  assert.equal(desktopAgentActivityState({ status: 'running', stage: 'cancelled' }), 'cancelled');
  // A row with only a stage is judged by it.
  assert.equal(desktopAgentActivityState({ stage: 'streaming' }), 'running');
  assert.equal(desktopAgentActivityState({ stage: 'idle' }), 'idle');
});

test('a completed pool row reads done until seen, a cancel or failure outranks it, and new work reads working', () => {
  assert.equal(desktopAgentActivityState({ status: 'completed', stage: 'completed' }, { unread: true }), 'done');
  assert.equal(desktopAgentActivityState({ status: 'completed', stage: 'completed' }), 'idle');
  assert.equal(
    desktopAgentActivityState({ status: 'completed', stage: 'completed' }, { waitingForTasks: true }),
    'waiting'
  );
  assert.equal(desktopAgentActivityState({ status: 'cancelled', stage: 'completed' }), 'cancelled');
  assert.equal(desktopAgentActivityState({ status: 'failed', stage: 'failed' }), 'failed');
  assert.equal(desktopAgentActivityState({ status: 'running', stage: 'running' }), 'running');
  assert.equal(desktopAgentActivityState({ status: 'idle', stage: 'idle' }), 'idle');
});

test('background shell jobs never change an agent state or count as waiting', () => {
  for (const [status, expected] of [
    ['running', 'running'],
    ['queued', 'queued'],
    ['unknown', 'unknown'],
    ['cancelled', 'cancelled'],
    ['cancel-unconfirmed', 'cancel-unconfirmed'],
  ]) {
    assert.equal(desktopAgentActivityState({ status, stage: status, shellJobCount: 1 }, { unread: true }), expected);
  }
  assert.equal(desktopAgentActivityState({ status: 'idle', shellJobCount: 1 }, { unread: true }), 'done');
  assert.equal(desktopAgentActivityState({ status: 'idle', shellJobCount: 1 }), 'idle');
});

test('an agent parked on its own background work reads waiting, and running again once it resumes', () => {
  // In `task wait`: the turn is in flight but the agent waits.
  assert.equal(
    desktopAgentActivityState({ status: 'running', stage: 'tool_running', awaitingTask: 'wait' }),
    'waiting'
  );
  // Idle with a handed-off background task still running.
  assert.equal(desktopAgentActivityState({ status: 'idle', stage: 'idle', awaitingTask: 'background' }), 'waiting');
  assert.equal(
    desktopAgentActivityState({ status: 'idle', stage: 'idle', awaitingTask: 'background' }, { unread: true }),
    'waiting'
  );
  // Resumed: the mark is gone and the row works again.
  assert.equal(desktopAgentActivityState({ status: 'running', stage: 'requesting' }), 'running');
  // Approval, cancellation and failure still outrank it.
  assert.equal(
    desktopAgentActivityState({ status: 'running', stage: 'running', awaitingTask: 'wait', awaitingUser: 'approval' }),
    'needs-user'
  );
  assert.equal(desktopAgentActivityState({ status: 'cancelled', awaitingTask: 'background' }), 'cancelled');
  assert.equal(desktopAgentActivityState({ status: 'failed', awaitingTask: 'background' }), 'failed');
});

test('the Agents row switches to data-state=waiting on a pool push and back to running', async () => {
  const dom = installDom();
  let push;
  const row = (extra = {}) => ({
    agent: 'lead',
    sessionId: 'lead-w',
    ownerSessionId: 'lead-w',
    status: 'running',
    stage: 'tool_running',
    ...extra,
  });
  window.mixdogDesktop = {
    async listAgentPool() {
      return [row()];
    },
    subscribeAgentPool(listener) {
      push = listener;
      return () => {};
    },
  };
  const sessions = [{ id: 'lead-w', title: 'lead-w', preview: '', updatedAt: 1, messageCount: 1 }];
  const state = () =>
    document.querySelector('[data-agent-session-id="lead-w"] .agent-activity-elapsed')?.getAttribute('data-state');
  try {
    await act(async () => dom.root.render(React.createElement(AgentActivityPane, { active: false, sessions })));
    await expandAllAgentGroups();
    assert.equal(state(), 'running');
    await act(async () => push([row({ awaitingTask: 'wait' })]));
    assert.equal(state(), 'waiting');
    assert.equal(
      document.querySelector('[data-agent-session-id="lead-w"] .agent-activity-elapsed').textContent,
      'Waiting for tasks'
    );
    await act(async () => push([row()]));
    assert.equal(state(), 'running');
    await act(async () => push([row({ status: 'idle', stage: 'idle', awaitingTask: 'background' })]));
    assert.equal(state(), 'waiting');
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test('a Lead row never shows an old origin through running → waiting → woken running and a reconnect resync', async () => {
  const dom = installDom();
  let push;
  const created = Date.now() - 154_000_000;
  const turn1 = Date.now() - 600_000;
  const turn2 = Date.now() - 4_000;
  const row = (extra = {}) => ({
    agent: 'lead',
    sessionId: 'lead-o',
    ownerSessionId: 'lead-o',
    status: 'running',
    stage: 'tool_running',
    startedAt: created,
    createdAt: created,
    ...extra,
  });
  window.mixdogDesktop = {
    async listAgentPool() {
      return [row({ turnStartedAt: turn1 })];
    },
    subscribeAgentPool(listener) {
      push = listener;
      return () => {};
    },
  };
  const sessions = [{ id: 'lead-o', title: 'lead-o', preview: '', updatedAt: 1, messageCount: 1 }];
  const text = () => document.querySelector('[data-agent-session-id="lead-o"] .agent-activity-elapsed')?.textContent;
  try {
    await act(async () => dom.root.render(React.createElement(AgentActivityPane, { active: false, sessions })));
    await expandAllAgentGroups();
    assert.match(text(), /^10m/);
    // Waiting on its own task keeps the same turn clock running.
    await act(async () => push([row({ turnStartedAt: turn1, awaitingTask: 'wait' })]));
    assert.match(text(), /^10m/);
    await act(async () => push([row({ status: 'idle', stage: 'idle', turnStartedAt: null })]));
    assert.equal(text(), 'Idle');
    // Woken by the completion: the first running snapshot has no turn stamp.
    await act(async () => push([row({ turnStartedAt: null })]));
    assert.equal(text(), '');
    await act(async () => push([row({ turnStartedAt: turn2 })]));
    assert.match(text(), /^[0-9]s$/);
    // Reconnect resync: a snapshot without the stamp, then a stale one.
    await act(async () => push([row({ turnStartedAt: null })]));
    assert.match(text(), /^[0-9]s$/);
    await act(async () => push([row({ turnStartedAt: turn1 })]));
    assert.match(text(), /^[0-9]s$/);
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

async function expandAllAgentGroups() {
  await act(async () => window.dispatchEvent(new window.CustomEvent(AGENT_GROUP_EXPANSION_EVENT, { detail: true })));
}

test('Agent groups can be hidden, stay hidden through pool pushes and remounts, and be restored', async () => {
  const dom = installDom();
  let push;
  const touched = [];
  const pool = ['lead-a', 'lead-b'].map((id) => ({
    agent: 'lead',
    sessionId: id,
    ownerSessionId: id,
    status: 'running',
    stage: 'running',
  }));
  window.mixdogDesktop = new Proxy(
    {
      async listAgentPool() {
        return pool;
      },
      subscribeAgentPool(listener) {
        push = listener;
        return () => {};
      },
    },
    {
      get(target, key) {
        touched.push(key);
        return target[key];
      },
    }
  );
  const sessions = pool.map(({ sessionId }) => ({
    id: sessionId,
    title: sessionId,
    preview: '',
    updatedAt: 1,
    messageCount: 1,
  }));
  const renderPane = () =>
    React.createElement(AgentActivityPane, {
      active: false,
      sessions,
      showGroupActions: true,
    });
  const click = async (selector) => {
    const button = document.querySelector(selector);
    assert.ok(button, selector);
    await act(async () => button.click());
  };
  try {
    await act(async () => dom.root.render(renderPane()));
    await click('[data-agent-owner-session-id="lead-a"] .row-overflow-trigger');
    await click('[data-action-id="hide-agent-group"]');
    assert.equal(document.querySelector('[data-agent-owner-session-id="lead-a"]'), null);
    assert.ok(document.querySelector('[data-agent-owner-session-id="lead-b"]'));
    assert.deepEqual(JSON.parse(window.localStorage.getItem('mixdog.agent-hidden-groups')), ['lead-a']);
    await act(async () => push([...pool]));
    await act(async () => dom.root.render(null));
    await act(async () => dom.root.render(renderPane()));
    assert.equal(document.querySelector('[data-agent-owner-session-id="lead-a"]'), null);
    await click('[data-agent-owner-session-id="lead-b"] .row-overflow-trigger');
    await click('[data-action-id="hide-agent-group"]');
    // Mixy is always a contact, so hidden work leaves no empty-state line.
    assert.equal(document.querySelectorAll('[data-agent-owner-session-id]').length, 0);
    assert.doesNotMatch(document.body.textContent, /All agent groups are hidden/);
    await click('.agent-group-toolbar .row-overflow-trigger');
    await click('[data-action-id="restore-agent-groups"]');
    assert.equal(document.querySelectorAll('[data-agent-owner-session-id]').length, 2);
    assert.deepEqual(JSON.parse(window.localStorage.getItem('mixdog.agent-hidden-groups')), []);
    // The contacts read the agent catalog (a read capability); nothing else.
    assert.deepEqual([...new Set(touched)].filter((key) => key !== 'perfLog').sort(), [
      'invokeCapability',
      'listAgentPool',
      'subscribeAgentPool',
    ]);
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test('Agents owner list is independent from the selected session', () => {
  assert.deepEqual(
    agentActivitySessionIds([
      { id: 'lead', leadWorking: true },
      { id: 'children', agentWorking: true },
      { id: 'aggregate-only', working: true },
      { id: 'idle' },
    ]),
    ['lead', 'children']
  );
});

test('shell status equality includes detail fields that arrive after the task id', () => {
  const before = {
    count: 1,
    elapsedLabel: '1s',
    jobs: [{ taskId: 'job-1', command: '', cwd: '', startedAt: null }],
  };
  assert.equal(
    shellJobsStatusEqual(before, {
      ...before,
      jobs: [{ taskId: 'job-1', command: 'npm test', cwd: 'C:\\Project\\mixdog', startedAt: 123 }],
    }),
    false
  );
  assert.equal(
    shellJobsStatusEqual(before, {
      ...before,
      jobs: [{ ...before.jobs[0] }],
    }),
    true
  );
});

test('the context card offers only compaction, also after the model changed', async () => {
  const changed = {
    sessionId: 'lead-inherit',
    provider: 'cursor',
    model: 'gpt-5.6',
    items: [{ kind: 'assistant', provider: 'cursor', model: 'ox-alpha', text: 'done' }],
    stats: { currentEstimatedContextTokens: 50 },
    displayContextWindow: 100,
  };
  const dom = installDom();
  const requests = [];
  window.mixdogDesktop = {
    invokeCapability: async (request) => {
      requests.push(request);
    },
  };
  try {
    await act(async () => {
      dom.root.render(React.createElement(ContextUsageIndicator, { snapshot: changed, open: true }));
    });
    // Forking a session lives in the session row's menu, not here.
    assert.equal(document.querySelector('.context-inherit'), null);
    assert.deepEqual(
      [...document.querySelectorAll('.context-action')].map((button) => button.className),
      ['context-action context-compact']
    );
    await act(async () => {
      document.querySelector('.context-compact').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    assert.deepEqual(requests, [{ capability: 'compact', sessionId: 'lead-inherit' }]);
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test('the live context indicator retains its authoritative reading across incomplete stats frames', async () => {
  const dom = installDom();
  try {
    await act(async () => {
      dom.root.render(
        React.createElement(ContextUsageIndicator, {
          snapshot: {
            sessionId: 'context-sticky',
            stats: { currentContextTokens: 50, currentContextSource: 'last_api_request' },
            displayContextWindow: 100,
          },
        })
      );
    });
    assert.match(document.body.textContent, /50%/);

    await act(async () => {
      dom.root.render(
        React.createElement(ContextUsageIndicator, {
          snapshot: {
            sessionId: 'context-sticky',
            stats: { costUsd: 1 },
            displayContextWindow: 100,
          },
        })
      );
    });
    assert.match(document.body.textContent, /50%/);
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test('header snapshot equality ignores unrelated stats but tracks visible context values', () => {
  const base = {
    sessionId: 'header-session',
    stats: {
      currentContextTokens: 50,
      currentEstimatedContextTokens: 60,
      costUsd: 0.25,
      inputTokens: 100,
    },
  };
  assert.equal(
    desktopHeaderSnapshotsEqual(base, {
      ...base,
      stats: { ...base.stats, inputTokens: 200 },
    }),
    true
  );
  assert.equal(
    desktopHeaderSnapshotsEqual(base, {
      ...base,
      stats: { ...base.stats, currentEstimatedContextTokens: 61 },
    }),
    false
  );
  assert.equal(
    desktopHeaderSnapshotsEqual(base, {
      ...base,
      stats: { ...base.stats, costUsd: 0.5 },
    }),
    false
  );
  assert.equal(
    desktopHeaderSnapshotsEqual(base, {
      ...base,
      goal: { id: 'goal-1', status: 'active', objective: 'Finish it' },
    }),
    false
  );
});

test('Goal island keeps its summary compact and toggles from the capsule', async () => {
  const dom = installDom();
  try {
    await act(async () => {
      dom.root.render(
        React.createElement(SessionGoalIsland, {
          snapshot: {
            sessionId: 'goal-session',
            goal: {
              id: 'goal-simple',
              title: 'Short Goal Title',
              objective: 'A much longer objective that should not consume the progress and elapsed-time regions',
              status: 'active',
              tasks: [
                { id: 'task_1', text: 'Implement the change', status: 'completed' },
                { id: 'task_2', text: 'Check mobile layout', status: 'in_progress' },
                { id: 'task_3', text: 'Verify the objective', status: 'pending' },
              ],
              tasksTotal: 3,
              tasksCompleted: 1,
              timeLimitMs: 60 * 60 * 1000,
              timeUsedMs: 5 * 60 * 1000,
              remainingMs: 60 * 60 * 1000,
              deadlineAt: Date.now() + 60 * 60 * 1000,
            },
          },
        })
      );
    });
    const trigger = document.querySelector('.session-goal-trigger');
    assert.equal(trigger.firstElementChild?.dataset.state, 'active', 'the ring leads the segment');
    // Numbers only: no title, no pips; the drawer carries the title.
    assert.equal(trigger.querySelector('.session-goal-objective'), null);
    assert.equal(trigger.querySelector('.session-goal-pips'), null);
    assert.equal(document.querySelector('.session-goal-title')?.textContent, 'Short Goal Title');
    // The segment reads n/m plus elapsed time, as the island mockup does.
    assert.equal(trigger.querySelector('.session-goal-meta')?.textContent, '1/35m');
    assert.equal(trigger.querySelector('.session-goal-trigger-time')?.textContent, '5m');
    assert.match(document.querySelector('.session-goal-panel .session-goal-time')?.textContent || '', /^\d+m$/);
    assert.match(document.querySelector('.session-goal-panel .session-goal-meta')?.textContent || '', /^1\/3·\d+m$/);
    assert.equal(document.querySelector('.session-goal-toggle'), null);
    assert.equal(trigger?.getAttribute('aria-expanded'), 'false');
    assert.equal(document.querySelector('.session-goal-drawer')?.getAttribute('aria-hidden'), 'true');

    await act(async () => {
      trigger?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    assert.equal(trigger?.getAttribute('aria-expanded'), 'true');
    assert.equal(document.querySelector('.session-goal-drawer')?.getAttribute('aria-hidden'), 'false');
    assert.match(
      document.querySelector('.session-goal-statusline')?.textContent || '',
      /^In progress·\d+m \/ 1h 0m · \d+m remaining$/
    );
    assert.equal(document.querySelectorAll('.session-goal-task-list > li').length, 3);
    assert.equal(document.querySelectorAll('.session-goal-task-list > li .mx-icon').length, 3);
    assert.equal(
      [...document.querySelectorAll('.session-goal-task-list > li > span')].some((marker) =>
        /[✓◐○]/u.test(marker.textContent || '')
      ),
      false
    );
    assert.doesNotMatch(document.body.textContent, /Verification/);
    assert.equal(document.querySelector('.session-goal-popover'), null);
    assert.doesNotMatch(document.body.textContent, /Edit goal|Stop goal|Complete/);
    assert.equal(document.querySelector('.session-goal-menu'), null);
    await act(async () => {
      trigger?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    assert.equal(trigger?.getAttribute('aria-expanded'), 'false');
    assert.equal(document.querySelector('.session-goal-drawer')?.getAttribute('aria-hidden'), 'true');
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test('blocked Goal island renders the specific blocker', async () => {
  const dom = installDom();
  try {
    await act(async () => {
      dom.root.render(
        React.createElement(SessionGoalIsland, {
          snapshot: {
            sessionId: 'goal-session',
            goal: {
              id: 'goal-blocked',
              objective: 'Deploy the verified result',
              status: 'blocked',
              blocker: 'Waiting for deployment credentials',
            },
          },
        })
      );
    });
    await act(async () => {
      document.querySelector('.session-goal-trigger')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    const note = document.querySelector('.session-goal-note');
    assert.equal(note?.textContent, 'Waiting for deployment credentials', 'text only, no heading label');
    assert.equal(note?.getAttribute('data-tone'), 'blocked');
    assert.equal(note?.querySelector('b'), null);
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test('Goal drawer lists remaining tasks first and folds done and dropped ones', async () => {
  const dom = installDom();
  try {
    await act(async () => {
      dom.root.render(
        React.createElement(SessionGoalIsland, {
          snapshot: {
            sessionId: 'goal-session',
            goal: {
              id: 'goal-fold',
              objective: 'Fold the finished work',
              status: 'active',
              tasks: [
                { id: 'a', text: 'Finished', status: 'completed' },
                { id: 'b', text: 'Running', status: 'in_progress' },
                { id: 'c', text: 'Scoped out', status: 'dropped' },
              ],
            },
          },
        })
      );
    });
    await act(async () => {
      document.querySelector('.session-goal-trigger')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    assert.equal(document.querySelector('.session-goal-group-label')?.textContent, 'Remaining 1');
    const fold = document.querySelector('.session-goal-fold');
    assert.equal(fold?.textContent, 'Done 1 · 1 dropped');
    assert.equal(fold?.getAttribute('aria-expanded'), 'false');
    const lists = document.querySelectorAll('.session-goal-task-list');
    assert.equal(lists[0].textContent, 'Running');
    assert.equal(lists[1].hasAttribute('hidden'), true);
    await act(async () => {
      fold?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    assert.equal(fold?.getAttribute('aria-expanded'), 'true');
    assert.equal(lists[1].hasAttribute('hidden'), false);
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test('a blocker on a Goal that is not blocked reads neutrally', async () => {
  const dom = installDom();
  try {
    await act(async () => {
      dom.root.render(
        React.createElement(SessionGoalIsland, {
          snapshot: {
            sessionId: 'goal-session',
            goal: { id: 'goal-paused', objective: 'Pause me', status: 'paused', blocker: 'Earlier note' },
          },
        })
      );
    });
    const block = document.querySelector('.session-goal-note');
    assert.equal(block?.textContent, 'Earlier note');
    assert.equal(block?.getAttribute('data-tone'), null);
    assert.equal(document.querySelector('.session-goal-statusline')?.textContent, 'Paused·0m elapsed');
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

const ringOf = (root) => {
  const svg = root.querySelector('.session-goal-ring');
  const arc = svg.querySelector('.session-goal-ring-arc');
  return {
    size: [svg.getAttribute('width'), svg.getAttribute('height')],
    glyph: svg.querySelector('[data-glyph]')?.getAttribute('data-glyph'),
    arc: arc && {
      r: arc.getAttribute('r'),
      width: arc.getAttribute('stroke-width'),
      cap: arc.getAttribute('stroke-linecap'),
      rotate: arc.getAttribute('transform'),
      dash: arc.getAttribute('stroke-dasharray').split(' ').map(Number),
    },
  };
};

test('the progress ring fills by completed/total and shows one glyph per state', async () => {
  const dom = installDom();
  const tasks = [
    { id: 'a', text: 'One', status: 'completed' },
    { id: 'b', text: 'Two', status: 'completed' },
    { id: 'c', text: 'Three', status: 'pending' },
    { id: 'd', text: 'Four', status: 'pending' },
  ];
  const cases = [
    [{ status: 'active' }, 'active'],
    [{ status: 'paused' }, 'paused'],
    [{ status: 'blocked', blocker: 'No token' }, 'blocked'],
    [{ status: 'paused', pauseReason: 'waiting' }, 'waiting'],
    [{ status: 'stopped' }, 'stopped'],
    [{ status: 'complete' }, 'complete'],
  ];
  try {
    for (const [extra, glyph] of cases) {
      await act(async () => {
        dom.root.render(
          React.createElement(SessionGoalIsland, {
            snapshot: { sessionId: 'ring', goal: { id: `ring-${glyph}`, objective: 'Ring', tasks, ...extra } },
          })
        );
      });
      const trigger = document.querySelector('.session-goal-trigger');
      const ring = ringOf(trigger);
      assert.deepEqual(ring.size, ['16', '16'], glyph);
      assert.equal(ring.glyph, glyph);
      assert.equal(trigger.firstElementChild.dataset.state, glyph);
      assert.deepEqual(
        [ring.arc.r, ring.arc.width, ring.arc.cap, ring.arc.rotate],
        ['6.2', '1.8', 'round', 'rotate(-90 8 8)'],
        "starts at 12 o'clock with a round cap"
      );
      const [filled, length] = ring.arc.dash;
      assert.ok(Math.abs(length - 2 * Math.PI * 6.2) < 0.01);
      const expected = glyph === 'complete' ? 1 : 0.5;
      assert.ok(Math.abs(filled / length - expected) < 0.01, `${glyph}: arc covers ${expected}`);
      assert.equal(trigger.querySelector('.session-goal-meta .session-goal-progress').textContent, '2/4');
      assert.equal(
        ringOf(document.querySelector('.composer-island-tab, .session-goal-panel')).glyph,
        glyph,
        'the tab ring matches'
      );
    }
    await act(async () => {
      dom.root.render(
        React.createElement(SessionGoalIsland, {
          snapshot: { sessionId: 'ring', goal: { id: 'empty', objective: 'Ring', status: 'active' } },
        })
      );
    });
    assert.equal(ringOf(document.querySelector('.session-goal-trigger')).arc, null, 'no tasks, no arc');
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test('task rows carry no badges; five remaining rows show and the rest folds', async () => {
  const dom = installDom();
  try {
    const tasks = [
      { id: 'run', text: 'Running', status: 'in_progress' },
      { id: 'ask', text: 'Asking', status: 'awaiting_approval' },
      ...Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, text: `Pending ${i}`, status: 'pending' })),
    ];
    await act(async () => {
      dom.root.render(
        React.createElement(SessionGoalIsland, {
          snapshot: {
            sessionId: 'rest',
            goal: { id: 'rest', objective: 'Many', status: 'blocked', blocker: 'Stuck', tasks },
          },
        })
      );
    });
    await act(async () => {
      document.querySelector('.session-goal-trigger')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    assert.equal(document.querySelector('.session-goal-badge'), null);
    assert.doesNotMatch(document.body.textContent, /Needs your answer/);
    const rows = [...document.querySelectorAll('.session-goal-task-list')];
    assert.equal(rows[0].children.length, 5, 'first five remaining rows');
    assert.equal(rows[0].querySelector('li[data-stalled="true"] svg')?.getAttribute('data-glyph'), 'stalled');
    assert.equal(
      rows[0].querySelector('li[data-status="awaiting_approval"] svg')?.getAttribute('data-glyph'),
      'awaiting'
    );
    assert.equal(document.querySelector('.session-goal-group-label')?.textContent, 'Remaining 8');
    const rest = document.querySelector('.session-goal-fold[data-fold="rest"]');
    assert.equal(rest?.textContent, 'Rest 3');
    assert.equal(rest?.getAttribute('aria-expanded'), 'false');
    assert.equal(rows[1].hasAttribute('hidden'), true);
    assert.equal(rows[1].children.length, 3);
    await act(async () => {
      rest?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    assert.equal(rows[1].hasAttribute('hidden'), false);
    assert.equal(rest?.getAttribute('aria-expanded'), 'true');
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test('running and awaiting rows always make the five-row cut', async () => {
  const dom = installDom();
  const pending = (n) =>
    Array.from({ length: n }, (_, i) => ({ id: `p${i}`, text: `Pending ${i}`, status: 'pending' }));
  const shown = async (tasks) => {
    await act(async () => {
      dom.root.render(
        React.createElement(SessionGoalIsland, {
          snapshot: {
            sessionId: 'cut',
            goal: { id: `cut-${tasks.length}-${Math.random()}`, objective: 'Cut', status: 'active', tasks },
          },
        })
      );
    });
    // The task text only; an awaiting row also carries spoken (sr-only) status text.
    return [...document.querySelector('.session-goal-task-list').children].map((li) => li.querySelector('div').textContent);
  };
  try {
    // Running first, awaiting beyond the cutoff: both stay, order kept.
    let rows = await shown([
      { id: 'run', text: 'Running', status: 'in_progress' },
      ...pending(6),
      { id: 'ask', text: 'Asking', status: 'awaiting_approval' },
    ]);
    assert.equal(rows.length, 5);
    assert.ok(rows.includes('Running') && rows.includes('Asking'));
    assert.deepEqual(rows, ['Running', 'Pending 0', 'Pending 1', 'Pending 2', 'Asking']);
    // One protected row inside the cutoff, one across it.
    rows = await shown([
      ...pending(3),
      { id: 'run', text: 'Running', status: 'in_progress' },
      { id: 'ask', text: 'Asking', status: 'awaiting_approval' },
      ...pending(2).map((t, i) => ({ ...t, id: `q${i}`, text: `Late ${i}` })),
    ]);
    assert.deepEqual(rows, ['Pending 0', 'Pending 1', 'Pending 2', 'Running', 'Asking']);
    // Both beyond the cutoff.
    rows = await shown([
      ...pending(7),
      { id: 'run', text: 'Running', status: 'in_progress' },
      { id: 'ask', text: 'Asking', status: 'awaiting_approval' },
    ]);
    assert.deepEqual(rows, ['Pending 0', 'Pending 1', 'Pending 2', 'Running', 'Asking']);
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test('stop confirmation moves focus to Cancel and back to Stop', async () => {
  const dom = installDom();
  try {
    await act(async () => {
      dom.root.render(
        React.createElement(SessionGoalIsland, {
          snapshot: { sessionId: 'focus', goal: { id: 'focus', objective: 'Focus', status: 'active' } },
        })
      );
    });
    await act(async () => {
      document.querySelector('.session-goal-trigger')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    const click = (element) =>
      act(async () => {
        element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      });
    await click(document.querySelector('[aria-label="Stop goal"]'));
    const cancel = document.querySelector('.session-goal-actions button:first-child');
    assert.equal(cancel.textContent, 'Cancel');
    assert.equal(document.activeElement, cancel, 'Cancel takes focus when the confirmation opens');
    await click(cancel);
    assert.equal(document.querySelector('.session-goal-confirm'), null);
    assert.equal(
      document.activeElement,
      document.querySelector('[aria-label="Stop goal"]'),
      'Stop regains focus when cancelled'
    );
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test('a failed action on a blocked Goal shows one note, the error first', async () => {
  const dom = installDom();
  window.mixdogDesktop = { invokeCapability: async () => ({ value: { ok: false } }) };
  try {
    await act(async () => {
      dom.root.render(
        React.createElement(SessionGoalIsland, {
          snapshot: { sessionId: 'note', goal: { id: 'note', objective: 'Note', status: 'blocked', blocker: 'Stuck' } },
        })
      );
    });
    assert.equal(document.querySelectorAll('.session-goal-note').length, 1);
    await act(async () => {
      document.querySelector('.session-goal-trigger')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      document.querySelector('[aria-label="Resume"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    const notes = document.querySelectorAll('.session-goal-note');
    assert.equal(notes.length, 1);
    assert.equal(notes[0].getAttribute('role'), 'alert');
    assert.equal(notes[0].getAttribute('data-tone'), 'error');
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test('each state has exactly one filled primary control', async () => {
  const dom = installDom();
  const labels = (selector) => [...document.querySelectorAll(selector)].map((b) => b.textContent);
  try {
    for (const [status, extra, quiet, primary] of [
      ['active', {}, ['Stop', 'Edit'], ['Pause']],
      ['paused', {}, ['Stop', 'Edit'], ['Resume']],
      ['blocked', { blocker: 'x' }, ['Stop', 'Edit'], ['Resume']],
      ['paused', { pauseReason: 'waiting' }, ['Stop', 'Edit'], ['Resume']],
      ['complete', {}, [], ['Dismiss goal']],
      ['stopped', {}, [], ['Dismiss goal']],
    ]) {
      await act(async () => {
        dom.root.render(
          React.createElement(SessionGoalIsland, {
            snapshot: { sessionId: 'prim', goal: { id: `prim-${status}`, objective: 'Go', status, ...extra } },
          })
        );
      });
      const name = `${status}/${extra.pauseReason || ''}`;
      assert.deepEqual(labels('.session-goal-controls [data-primary="true"]'), primary, name);
      assert.deepEqual(labels('.session-goal-controls [data-quiet="true"]'), quiet, name);
    }
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test('completed Goal island keeps the compact elapsed clock and no extra action', async () => {
  const dom = installDom();
  const completedAt = new Date('2026-08-28T14:49:55.000Z').getTime();
  try {
    await act(async () => {
      dom.root.render(
        React.createElement(SessionGoalIsland, {
          snapshot: {
            sessionId: 'goal-session',
            goal: {
              id: 'goal-complete',
              objective: 'Completed Goal',
              status: 'complete',
              timeUsedMs: 60 * 1000,
              completedAt,
            },
          },
        })
      );
    });
    const time = document.querySelector('.session-goal-time')?.textContent || '';
    assert.equal(time, '1m');
    assert.doesNotMatch(time, /in progress/);
    await act(async () => {
      document.querySelector('.session-goal-trigger')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    assert.equal(document.querySelector('.session-goal-trigger')?.getAttribute('aria-expanded'), 'true');
    assert.equal(document.querySelector('.session-goal-popover'), null);
    assert.equal(document.querySelector('.session-goal-panel')?.getAttribute('role'), 'region');
    assert.doesNotMatch(document.body.textContent, /Edit goal|Resume|Stop goal|Clear|Delete/);
    assert.equal(document.querySelector('.session-goal-menu'), null);
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test('Goal completed time and response completion time stay semantically separate', async () => {
  const completedAt = new Date('2026-08-28T14:49:55.000Z').getTime();
  assert.equal(
    goalCompletedTimeLabel({ status: 'complete', completedAt }),
    new Date(completedAt).toLocaleTimeString('en', { timeStyle: 'short' })
  );
  assert.equal(goalCompletedTimeLabel({ status: 'active', completedAt }), '');

  const dom = installDom();
  try {
    await act(async () => {
      dom.root.render(
        React.createElement(CompletionStatus, {
          item: { kind: 'turndone', elapsedMs: 450_000, verb: 'Wrapped' },
        })
      );
    });
    assert.equal(document.querySelector('.turn-status.complete > span')?.textContent, 'Wrapped for 7m 30s');
    assert.ok(document.querySelector('.turn-status.complete .mx-icon.lucide-check'));
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test('Goal clock labels explicit elapsed, total, and remaining time', () => {
  const now = 1_000_000;
  assert.equal(formatGoalDuration(40_619), '0:41');
  assert.equal(formatGoalDuration(3_661_000), '1:01:01');
  assert.equal(
    goalTimeLabel(
      {
        status: 'active',
        timeLimitMs: 300_000,
        timeUsedMs: 40_619,
        remainingMs: 259_381,
        deadlineAt: now + 259_381,
      },
      now
    ),
    '0:41 / 5:00 · 4:19 remaining'
  );
  assert.equal(
    goalElapsedLabel(
      {
        status: 'active',
        timeLimitMs: 300_000,
        timeUsedMs: 40_619,
        remainingMs: 259_381,
        deadlineAt: now + 259_381,
      },
      now
    ),
    '0:41'
  );
  assert.equal(
    goalTimeLabel(
      {
        status: 'active',
        timeLimitMs: 0,
        timeUsedMs: 40_619,
        remainingMs: null,
        snapshotAt: now,
      },
      now + 1_000
    ),
    '0:42 elapsed'
  );
});

test('Agent pane ignores a stale initial list that resolves after a live push', async () => {
  const dom = installDom();
  let resolveInitial;
  let push = () => {};
  window.mixdogDesktop = {
    listAgentPool: () =>
      new Promise((resolve) => {
        resolveInitial = resolve;
      }),
    subscribeAgentPool(listener) {
      push = listener;
      return () => {};
    },
  };
  const sessions = [{ id: 'lead-a', title: 'Lead A', preview: '', updatedAt: 1, messageCount: 1 }];
  try {
    await act(async () => {
      dom.root.render(React.createElement(AgentActivityPane, { active: false, sessions }));
    });
    await act(async () =>
      push([
        {
          tag: 'review',
          agent: 'reviewer',
          status: 'running',
          stage: 'running',
          sessionId: 'worker-new',
          ownerSessionId: 'lead-a',
        },
      ])
    );
    await expandAllAgentGroups();
    assert.ok(document.querySelector('[data-agent-session-id="worker-new"]'));

    await act(async () => resolveInitial([]));
    assert.ok(document.querySelector('[data-agent-session-id="worker-new"]'));
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test('active Agent pane reconciles missed pool pushes and clears departed rows', async () => {
  const dom = installDom();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  const originalSetInterval = window.setInterval.bind(window);
  const originalClearInterval = window.clearInterval.bind(window);
  let reconcile = null;
  let pool = [
    {
      tag: 'review',
      agent: 'reviewer',
      status: 'running',
      stage: 'running',
      sessionId: 'worker-live',
      ownerSessionId: 'lead-a',
    },
  ];
  window.setInterval = (callback, ms) => {
    if (ms === AGENT_POOL_RECONCILE_MS) {
      reconcile = callback;
      return 987654;
    }
    return originalSetInterval(callback, ms);
  };
  window.clearInterval = (id) => {
    if (id !== 987654) originalClearInterval(id);
  };
  window.mixdogDesktop = {
    async listAgentPool() {
      return pool;
    },
    subscribeAgentPool() {
      return () => {};
    },
  };
  const sessions = [{ id: 'lead-a', title: 'Lead A', preview: '', updatedAt: 1, messageCount: 1 }];
  try {
    await act(async () => {
      dom.root.render(React.createElement(AgentActivityPane, { active: true, sessions }));
    });
    await expandAllAgentGroups();
    assert.ok(document.querySelector('[data-agent-session-id="worker-live"]'));
    assert.equal(typeof reconcile, 'function');

    pool = [];
    await act(async () => {
      reconcile();
      await Promise.resolve();
    });
    assert.equal(Boolean(document.querySelector('[data-agent-session-id="worker-live"]')), false);
  } finally {
    await act(async () => dom.root.unmount());
    window.setInterval = originalSetInterval;
    window.clearInterval = originalClearInterval;
    dom.close();
  }
});

test('new task header ignores the previous session lane cache', async () => {
  const dom = installDom();
  const props = {
    hidden: false,
    onOpenContext() {},
  };
  try {
    await act(async () => {
      dom.root.render(
        React.createElement(PaneContextIndicator, {
          ...props,
          sessionId: 'session-context',
        })
      );
    });
    await act(async () =>
      defaultSessionLaneStore.apply({
        sessionId: 'session-context',
        frameSource: 'live',
        snapshot: {
          sessionId: 'session-context',
          stats: { currentContextTokens: 516_956 },
          displayContextWindow: 1_000_000,
        },
      })
    );
    assert.match(document.body.textContent, /51\.7%/);

    // A compact completion can change only the header stats while the
    // transcript frame stays identical. The pane-owned status subscription
    // must invalidate the measurement without waiting for another transcript item.
    await act(async () => {
      defaultSessionLaneStore.apply({
        sessionId: 'session-context',
        frameSource: 'live',
        snapshot: {
          sessionId: 'session-context',
          stats: { currentContextTokens: null, currentContextSource: 'pending', currentEstimatedContextTokens: 18_000 },
          displayContextWindow: 384_000,
        },
      });
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    });
    assert.doesNotMatch(document.body.textContent, /4%|18K/i);

    // routeState republishes the derived window fields as 0 whenever its route
    // comparison misses. A 0 denominator is "unresolved", not "no window": the
    // gauge keeps dividing by the last known limit instead of repainting the
    // whole reading it held before the compaction.
    await act(async () => {
      defaultSessionLaneStore.apply({
        sessionId: 'session-context',
        frameSource: 'live',
        snapshot: {
          sessionId: 'session-context',
          stats: { currentContextTokens: 192_000, currentContextSource: 'last_api_request' },
          contextWindow: 0,
          displayContextWindow: 0,
          autoCompactTokenLimit: 0,
        },
      });
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    });
    assert.match(document.body.textContent, /50%/);

    await act(async () => {
      dom.root.render(
        React.createElement(PaneContextIndicator, {
          ...props,
          sessionId: '',
        })
      );
    });
    assert.doesNotMatch(document.body.textContent, /0%|51\.7%|50%/);
  } finally {
    await act(async () => dom.root.unmount());
    defaultSessionLaneStore.clear();
    dom.close();
  }
});

test("Agents groups every active session and renders each session's live agents", async () => {
  const dom = installDom();
  const opened = [];
  window.mixdogDesktop = {
    async listAgentPool() {
      return [
        {
          tag: 'lead:lead-a',
          agent: 'lead',
          status: 'running',
          stage: 'running',
          sessionId: 'lead-a',
          ownerSessionId: 'lead-a',
          turnStartedAt: Date.now() - 5_000,
          model: 'grok-4.6',
          provider: 'xai',
        },
        {
          tag: 'research',
          agent: 'researcher',
          title: 'Research current behavior',
          status: 'running',
          stage: 'running',
          sessionId: 'child-a',
          ownerSessionId: 'lead-a',
          model: 'gpt-5.6',
          provider: 'openai',
        },
        {
          tag: 'legacy-session',
          agent: 'reviewer',
          title: 'Review dependency update',
          status: 'idle',
          stage: 'idle',
          updatedAt: new Date(Date.now() - 65_000).toISOString(),
          sessionId: 'child-b',
          ownerSessionId: 'lead-b',
          model: 'gpt-5.6',
          provider: 'openai',
        },
        {
          tag: 'memory',
          agent: 'maintainer',
          status: 'running',
          stage: 'running',
          sessionId: 'maintainer-a',
          ownerSessionId: 'lead-a',
        },
        {
          tag: 'native-search',
          agent: 'web_search',
          status: 'running',
          stage: 'running',
          sessionId: 'search-a',
          ownerSessionId: 'lead-a',
        },
        {
          tag: 'lead:internal-control',
          agent: 'lead',
          status: 'idle',
          stage: 'idle',
          sessionId: 'internal-control',
          ownerSessionId: 'internal-control',
          model: 'gpt-5.6',
          provider: 'openai',
        },
      ];
    },
    subscribeAgentPool() {
      return () => {};
    },
  };
  try {
    await act(async () => {
      dom.root.render(
        React.createElement(AgentActivityPane, {
          active: true,
          sessions: [
            {
              id: 'lead-a',
              title: 'First task',
              preview: '',
              updatedAt: 2,
              messageCount: 1,
              cwd: 'C:\\a',
              classification: 'task',
              projectPath: null,
              working: true,
              leadWorking: true,
              agentWorking: true,
            },
            {
              id: 'lead-b',
              title: 'Second task',
              preview: '',
              updatedAt: 1,
              messageCount: 1,
              cwd: 'C:\\b',
              classification: 'task',
              projectPath: null,
              working: true,
              leadWorking: true,
              agentWorking: true,
            },
            {
              id: 'idle',
              title: 'Idle task',
              preview: '',
              updatedAt: 3,
              messageCount: 1,
              cwd: 'C:\\idle',
              classification: 'task',
              projectPath: null,
            },
          ],
          onOpenLeadSession: (sessionId) => opened.push(['lead', sessionId]),
          onOpenSession: (sessionId, title, ownerSessionId) => opened.push(['agent', sessionId, title, ownerSessionId]),
        })
      );
    });

    await expandAllAgentGroups();
    assert.equal(document.querySelectorAll('[data-agent-owner-session-id]').length, 2);
    assert.match(document.body.textContent, /First task/);
    assert.match(document.body.textContent, /Second task/);
    assert.doesNotMatch(document.body.textContent, /internal-control/);
    assert.match(document.body.textContent, /Idle/);
    assert.doesNotMatch(document.body.textContent, /Idle task/);
    assert.match(document.body.textContent, /Lead/);
    assert.match(document.body.textContent, /Researcher · research/);
    assert.ok(document.querySelector('[data-agent-session-id="lead-a"]'));
    assert.ok(document.querySelector('[data-agent-session-id="child-a"]'));
    assert.ok(document.querySelector('[data-agent-session-id="child-b"]'));
    assert.equal(document.querySelector('[data-agent-session-id="maintainer-a"]'), null);
    assert.equal(document.querySelector('[data-agent-session-id="search-a"]'), null);
    const firstHeading = document.querySelector('[data-lead-session-id="lead-a"]');
    assert.equal(firstHeading.getAttribute('aria-expanded'), 'true');
    await act(async () => firstHeading.click());
    assert.equal(firstHeading.getAttribute('aria-expanded'), 'false');
    assert.ok(document.querySelector('[data-agent-session-id="lead-a"]'));
    assert.equal(document.querySelector('[data-agent-session-id="child-a"]'), null);
    assert.ok(document.querySelector('[data-agent-session-id="child-b"]'));
    await act(async () => firstHeading.click());
    assert.equal(firstHeading.getAttribute('aria-expanded'), 'true');
    assert.ok(document.querySelector('[data-agent-session-id="child-a"]'));
    assert.equal(document.querySelectorAll('.workflows-agent-summary-row .projects-row-icon').length, 0);
    const runningRow = document.querySelector('[data-agent-session-id="lead-a"]').closest('.schedules-row');
    assert.equal(runningRow.querySelector('.agent-activity-status [role=status]'), null);
    assert.equal(runningRow.lastElementChild.className, 'agent-activity-status');
    assert.doesNotMatch(runningRow.querySelector('.agent-activity-elapsed').textContent, /Working/);
    assert.match(runningRow.querySelector('.agent-activity-elapsed').textContent, /^\d/);
    const idleRow = document.querySelector('[data-agent-session-id="child-b"]').closest('.schedules-row');
    // A resting agent reports rest only: idle duration carries no information
    // (user decision), so the label is the bare state word.
    assert.equal(idleRow.querySelector('.agent-activity-elapsed').textContent, 'Idle');
    assert.equal(idleRow.querySelector('.agent-activity-spinner-slot'), null);

    await act(async () => document.querySelector('[data-agent-session-id="lead-a"]').click());
    await act(async () => document.querySelector('[data-agent-session-id="child-b"]').click());
    assert.deepEqual(opened, [
      ['lead', 'lead-a'],
      ['agent', 'child-b', 'Review dependency update · legacy-session', 'lead-b'],
    ]);
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test('Agents keep sibling statuses independent under one owner', async () => {
  const dom = installDom();
  window.mixdogDesktop = {
    async listAgentPool() {
      return [
        {
          tag: 'lead:lead-a',
          agent: 'lead',
          status: 'idle',
          stage: 'idle',
          sessionId: 'lead-a',
          ownerSessionId: 'lead-a',
        },
        {
          tag: 'running',
          agent: 'researcher',
          status: 'running',
          stage: 'running',
          startedAt: Date.now() - 2_000,
          sessionId: 'child-running',
          ownerSessionId: 'lead-a',
        },
        {
          tag: 'completed',
          agent: 'reviewer',
          status: 'idle',
          stage: 'idle',
          sessionId: 'child-completed',
          ownerSessionId: 'lead-a',
        },
        {
          tag: 'resting',
          agent: 'worker',
          status: 'idle',
          stage: 'idle',
          sessionId: 'child-idle',
          ownerSessionId: 'lead-a',
        },
      ];
    },
    subscribeAgentPool() {
      return () => {};
    },
  };
  try {
    await act(async () => {
      dom.root.render(
        React.createElement(AgentActivityPane, {
          active: true,
          sessions: [
            {
              id: 'lead-a',
              title: 'Mixed states',
              preview: '',
              updatedAt: 1,
              messageCount: 1,
              cwd: 'C:\\a',
              classification: 'task',
              projectPath: null,
            },
          ],
          unreadSessionIds: new Set(['lead-a', 'child-completed']),
        })
      );
    });

    const state = (sessionId) =>
      document
        .querySelector(`[data-agent-session-id="${sessionId}"] .agent-activity-elapsed`)
        ?.getAttribute('data-state');
    await expandAllAgentGroups();
    assert.equal(state('lead-a'), 'waiting');
    assert.equal(state('child-running'), 'running');
    assert.equal(state('child-completed'), 'done');
    assert.equal(state('child-idle'), 'idle');
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test('Korean Agents pane shows unread completion and idle after reading, regardless of shell jobs', async () => {
  const dom = installDom();
  const previousLanguage = i18n.language;
  i18n.addResourceBundle(
    'ko',
    'translation',
    JSON.parse(readFileSync(new URL('./locales/ko.json', import.meta.url), 'utf8'))
  );
  const agent = (sessionId, parentSessionId, shellJobCount = 0) => ({
    tag: sessionId,
    agent: parentSessionId ? 'worker' : 'lead',
    sessionId,
    ownerSessionId: parentSessionId ? 'lead-shell' : sessionId,
    parentSessionId,
    status: 'idle',
    stage: 'idle',
    shellJobCount,
  });
  let pool = [agent('lead-shell', null), agent('worker-shell', 'lead-shell', 1), agent('unrelated', null)];
  let push;
  window.mixdogDesktop = {
    async listAgentPool() {
      return pool;
    },
    subscribeAgentPool(listener) {
      push = listener;
      return () => {};
    },
  };
  const sessions = ['lead-shell', 'unrelated'].map((id) => ({
    id,
    title: id,
    preview: '',
    updatedAt: 1,
    messageCount: 1,
  }));
  const renderPane = async (unreadSessionIds) => {
    await act(async () =>
      dom.root.render(
        React.createElement(AgentActivityPane, {
          active: false,
          sessions,
          unreadSessionIds,
        })
      )
    );
  };
  const assertStatus = (id, state, text) => {
    const status = document.querySelector(`[data-agent-session-id="${id}"] .agent-activity-elapsed`);
    assert.equal(status.dataset.state, state);
    assert.equal(status.textContent, text);
  };
  const setShellCounts = async (lead, worker) => {
    const shellJobCount = (sessionId) => {
      if (sessionId === 'lead-shell') return lead;
      if (sessionId === 'worker-shell') return worker;
      return 0;
    };
    pool = pool.map((entry) => ({ ...entry, shellJobCount: shellJobCount(entry.sessionId) }));
    await act(async () => push(pool));
  };
  try {
    await i18n.changeLanguage('ko');
    await renderPane(new Set(['lead-shell', 'worker-shell']));
    // A folded child's shell job is not agent work: the parent is complete.
    assertStatus('lead-shell', 'done', '완료');
    assertStatus('unrelated', 'idle', '대기 중');
    await expandAllAgentGroups();
    assertStatus('worker-shell', 'done', '완료');
    await setShellCounts(1, 0);
    assertStatus('lead-shell', 'done', '완료');
    assertStatus('worker-shell', 'done', '완료');
    await setShellCounts(0, 0);
    assertStatus('lead-shell', 'done', '완료');
    await renderPane(new Set());
    assertStatus('lead-shell', 'idle', '대기 중');
    assertStatus('worker-shell', 'idle', '대기 중');
  } finally {
    await act(async () => dom.root.unmount());
    await i18n.changeLanguage(previousLanguage);
    dom.close();
  }
});

for (const outcome of ['idle', 'cancelled']) {
  test(`Agents wait for nested work, including folded rows, until it is ${outcome}`, async () => {
    const dom = installDom();
    const agent = (sessionId, parentSessionId, status) => ({
      tag: sessionId,
      agent: sessionId === 'lead-a' ? 'lead' : 'worker',
      sessionId,
      ownerSessionId: 'lead-a',
      parentSessionId,
      status,
      stage: status,
    });
    let pool = [
      agent('lead-a', null, 'idle'),
      agent('parent-a', 'lead-a', 'idle'),
      agent('worker-a', 'parent-a', 'queued'),
    ];
    let push;
    window.mixdogDesktop = {
      async listAgentPool() {
        return pool;
      },
      subscribeAgentPool(listener) {
        push = listener;
        return () => {};
      },
    };
    const row = (id) => document.querySelector(`[data-agent-session-id="${id}"]`);
    const assertStatus = (id, state, text) => {
      const status = row(id).querySelector('.agent-activity-elapsed');
      assert.equal(status.dataset.state, state);
      assert.equal(status.textContent, text);
    };
    const setWorkerStatus = async (status) => {
      pool = pool.map((entry) => (entry.sessionId === 'worker-a' ? { ...entry, status, stage: status } : entry));
      await act(async () => push(pool));
    };
    const arrow = async (id, key) => {
      await act(async () => row(id).dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true })));
    };
    const sessions = [
      {
        id: 'lead-a',
        title: 'Nested work',
        preview: '',
        updatedAt: 1,
        messageCount: 1,
      },
    ];
    const renderPane = async (unreadSessionIds) => {
      await act(async () =>
        dom.root.render(
          React.createElement(AgentActivityPane, {
            active: false,
            sessions,
            unreadSessionIds,
          })
        )
      );
    };
    try {
      // Waiting is real work, not an unread-message indicator.
      await renderPane(new Set());
      assertStatus('lead-a', 'waiting', 'Waiting for tasks');
      await expandAllAgentGroups();
      assertStatus('parent-a', 'waiting', 'Waiting for tasks');
      assertStatus('worker-a', 'queued', 'Queued');
      await renderPane(new Set(['lead-a', 'parent-a', 'worker-a']));
      assertStatus('lead-a', 'waiting', 'Waiting for tasks');
      assertStatus('parent-a', 'waiting', 'Waiting for tasks');

      await arrow('parent-a', 'ArrowLeft');
      assert.equal(row('worker-a'), null);
      await setWorkerStatus('running');
      assertStatus('lead-a', 'waiting', 'Waiting for tasks');
      assertStatus('parent-a', 'waiting', 'Waiting for tasks');
      // The root and group share one fold; a second collapse remains harmless.
      await arrow('lead-a', 'ArrowLeft');
      await arrow('lead-a', 'ArrowLeft');
      assert.equal(row('parent-a'), null);
      assertStatus('lead-a', 'waiting', 'Waiting for tasks');

      if (outcome === 'cancelled') {
        await setWorkerStatus('cancel-unconfirmed');
        assertStatus('lead-a', 'waiting', 'Waiting for tasks');
      }
      await setWorkerStatus(outcome);
      assertStatus('lead-a', 'done', 'Completed');
      await arrow('lead-a', 'ArrowRight');
      await arrow('lead-a', 'ArrowRight');
      assertStatus('parent-a', 'done', 'Completed');
      await arrow('parent-a', 'ArrowRight');
      assertStatus(
        'worker-a',
        outcome === 'idle' ? 'done' : 'cancelled',
        outcome === 'idle' ? 'Completed' : 'Cancelled'
      );
      await renderPane(new Set());
      assertStatus('lead-a', 'idle', 'Idle');
      assertStatus('parent-a', 'idle', 'Idle');
    } finally {
      await act(async () => dom.root.unmount());
      dom.close();
    }
  });
}

test('Agents order sessions by last idle moment and flag unseen completions', async () => {
  const dom = installDom();
  const poolRow = (owner, idleSince) => ({
    tag: `lead:${owner}`,
    agent: 'lead',
    status: 'idle',
    stage: 'idle',
    sessionId: owner,
    ownerSessionId: owner,
    idleSince: new Date(idleSince).toISOString(),
    model: 'gpt-5.6',
    provider: 'openai',
  });
  window.mixdogDesktop = {
    async listAgentPool() {
      // Session-catalog order is the INVERSE of idle order here: only the pool's
      // idle stamps may decide placement.
      return [poolRow('older-idle', 1_000), poolRow('newest-idle', 9_000)];
    },
    subscribeAgentPool() {
      return () => {};
    },
  };
  const session = (id, title, updatedAt) => ({
    id,
    title,
    preview: '',
    updatedAt,
    activityAt: updatedAt,
    messageCount: 1,
    cwd: 'C:\\a',
    classification: 'task',
    projectPath: null,
  });
  try {
    await act(async () => {
      dom.root.render(
        React.createElement(AgentActivityPane, {
          active: true,
          sessions: [session('newest-idle', 'Newest idle', 1), session('older-idle', 'Older idle', 9)],
          unreadSessionIds: new Set(['newest-idle']),
        })
      );
    });

    const owners = [...document.querySelectorAll('[data-agent-owner-session-id]')].map((node) =>
      node.getAttribute('data-agent-owner-session-id')
    );
    assert.deepEqual(owners, ['newest-idle', 'older-idle']);
    const done = document
      .querySelector('[data-agent-session-id="newest-idle"]')
      .querySelector('.agent-activity-elapsed');
    assert.equal(done.getAttribute('data-state'), 'done');
    assert.equal(done.textContent, 'Completed');
    const idle = document
      .querySelector('[data-agent-session-id="older-idle"]')
      .querySelector('.agent-activity-elapsed');
    assert.equal(idle.getAttribute('data-state'), 'idle');
    assert.equal(idle.textContent, 'Idle');
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test('Agents order by creation, then move on turn start and completion only', async () => {
  const dom = installDom();
  const idleRow = (owner, createdAt, idleSince) => ({
    tag: `lead:${owner}`,
    agent: 'lead',
    status: 'idle',
    stage: 'idle',
    sessionId: owner,
    ownerSessionId: owner,
    createdAt: new Date(createdAt).toISOString(),
    idleSince: new Date(idleSince).toISOString(),
    updatedAt: new Date(idleSince).toISOString(),
    model: 'gpt-5.6',
    provider: 'openai',
  });
  // A working row has NO idle stamp and an advancing updatedAt — the
  // exact shape that used to shove a session to the top on every tick.
  const workingRow = (owner, createdAt, turnStartedAt, updatedAt) => ({
    ...idleRow(owner, createdAt, createdAt),
    status: 'streaming',
    stage: 'streaming',
    idleSince: null,
    turnStartedAt: new Date(turnStartedAt).toISOString(),
    updatedAt: new Date(updatedAt).toISOString(),
  });
  let push = () => {};
  window.mixdogDesktop = {
    async listAgentPool() {
      return [idleRow('first', 2_000, 5_000), idleRow('second', 1_000, 1_000)];
    },
    subscribeAgentPool(listener) {
      push = listener;
      return () => {};
    },
  };
  const session = (id, title) => ({
    id,
    title,
    preview: '',
    updatedAt: 1,
    activityAt: 1,
    messageCount: 1,
    cwd: 'C:\\a',
    classification: 'task',
    projectPath: null,
  });
  const owners = () =>
    [...document.querySelectorAll('[data-agent-owner-session-id]')].map((node) =>
      node.getAttribute('data-agent-owner-session-id')
    );
  try {
    await act(async () => {
      dom.root.render(
        React.createElement(AgentActivityPane, {
          active: true,
          sessions: [session('first', 'First'), session('second', 'Second'), session('third', 'Third')],
        })
      );
    });
    assert.deepEqual(owners(), ['first', 'second']);

    // An older turn start advances the stamp without overtaking the newer
    // completion already holding the top slot.
    await act(async () => push([idleRow('first', 2_000, 50_000), workingRow('second', 1_000, 9_000, 30_000)]));
    assert.deepEqual(owners(), ['first', 'second']);

    // updatedAt runs far past the leader's stamp and still moves nothing.
    await act(async () => push([idleRow('first', 2_000, 50_000), workingRow('second', 1_000, 9_000, 90_000)]));
    assert.deepEqual(owners(), ['first', 'second']);

    // A new turn start promotes the session exactly once.
    await act(async () => push([idleRow('first', 2_000, 50_000), workingRow('second', 1_000, 60_000, 95_000)]));
    assert.deepEqual(owners(), ['second', 'first']);
    await act(async () => push([idleRow('first', 2_000, 50_000), workingRow('second', 1_000, 60_000, 150_000)]));
    assert.deepEqual(owners(), ['second', 'first']);

    // Completion is the other promotion: the newly idle session retakes the top.
    await act(async () => push([idleRow('first', 2_000, 120_000), workingRow('second', 1_000, 60_000, 160_000)]));
    assert.deepEqual(owners(), ['first', 'second']);
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test('cancellation is its own lifecycle state, never queued, running, done or idle', () => {
  // The runtime keeps stage and status apart: a cancel lands on `status` while
  // `stage` still holds the work the agent was doing when it was stopped.
  assert.equal(desktopAgentActivityState({ stage: 'queued', status: 'cancelled' }), 'cancelled');
  assert.equal(desktopAgentActivityState({ stage: 'running', status: 'cancelled' }), 'cancelled');
  assert.equal(desktopAgentActivityState({ status: 'cancelling' }), 'cancel-unconfirmed');
  assert.equal(desktopAgentActivityState({ stage: 'running', status: 'cancel-unconfirmed' }), 'cancel-unconfirmed');
  // The four live/settled states keep their meaning.
  assert.equal(desktopAgentActivityState({ status: 'queued' }), 'queued');
  assert.equal(desktopAgentActivityState({ status: 'running' }), 'running');
  assert.equal(desktopAgentActivityState({ status: 'idle' }, { unread: true }), 'done');
  assert.equal(desktopAgentActivityState({ status: 'idle' }), 'idle');
});

test('a live turn blocked on a user approval needs the user, never running', () => {
  // The row shape the runtime status producer publishes while a PreToolUse
  // `ask` waits for the user (agent-list / job-views awaitingUser).
  const blocked = {
    tag: 'review',
    agent: 'reviewer',
    status: 'running',
    stage: 'tool_running',
    awaitingUser: 'approval',
  };
  assert.equal(desktopAgentActivityState(blocked), 'needs-user');
  assert.equal(desktopAgentActivityState(blocked, { waitingForTasks: true }), 'needs-user');
  // Only a live turn can be blocked; a cancel still outranks it.
  assert.equal(desktopAgentActivityState({ status: 'idle', awaitingUser: 'approval' }), 'idle');
  assert.equal(desktopAgentActivityState({ ...blocked, status: 'cancelled' }), 'cancelled');
  assert.equal(desktopAgentActivityState({ ...blocked, awaitingUser: undefined }), 'running');
  // The live summary carries it whichever twin row reports it.
  assert.deepEqual(
    liveAgentRows({ agentWorkers: [blocked] }).map((row) => [row.tag, row.state]),
    [['review', 'needs-user']]
  );
  assert.deepEqual(
    liveAgentRows({
      agentJobs: [
        { task_id: 'task-1', tag: 'review', status: 'running', stage: 'running' },
        { task_id: 'task-1', tag: 'review', status: 'running', stage: 'tool_running', awaitingUser: 'approval' },
      ],
    }).map((row) => [row.tag, row.state]),
    [['review', 'needs-user']]
  );
});

test("waiting for descendants overrides completion, not the parent's own work or cancellation", () => {
  const options = { unread: true, waitingForTasks: true };
  assert.equal(desktopAgentActivityState({ status: 'idle' }, options), 'waiting');
  assert.equal(desktopAgentActivityState({ status: 'completed' }, options), 'waiting');
  assert.equal(desktopAgentActivityState({ status: 'queued' }, options), 'queued');
  assert.equal(desktopAgentActivityState({ status: 'running' }, options), 'running');
  assert.equal(desktopAgentActivityState({ stage: 'running', status: 'cancelled' }, options), 'cancelled');
  assert.equal(desktopAgentActivityState({ status: 'cancel-unconfirmed' }, options), 'cancel-unconfirmed');
});

test('a cancelled agent leaves the live surfaces whatever its twin row still claims', () => {
  // Worker and job rows settle at different moments, so the cancelled job
  // routinely arrives beside a worker row that still says running.
  const jobCancelled = {
    sessionId: 'lead-a',
    agentWorkers: [{ tag: 'review', agent: 'reviewer', status: 'running', stage: 'running' }],
    agentJobs: [{ task_id: 'task-1', tag: 'review', status: 'cancelled' }],
  };
  assert.deepEqual(liveAgentRows(jobCancelled), []);

  // Same truth with the order reversed: the worker reports the cancel while
  // the job row is still marked running.
  const workerCancelled = {
    sessionId: 'lead-a',
    agentWorkers: [{ tag: 'review', agent: 'reviewer', status: 'cancelled', stage: 'running' }],
    agentJobs: [{ task_id: 'task-1', tag: 'review', status: 'running' }],
  };
  assert.deepEqual(liveAgentRows(workerCancelled), []);

  // Cancelled while still waiting in the queue.
  assert.deepEqual(
    liveAgentRows({
      agentJobs: [{ task_id: 'task-2', tag: 'plan', stage: 'queued', status: 'cancelled' }],
    }),
    []
  );

  // An unrelated live agent is untouched.
  assert.deepEqual(
    liveAgentRows({
      agentWorkers: [
        { tag: 'review', agent: 'reviewer', status: 'cancelled' },
        { tag: 'build', agent: 'builder', status: 'running' },
      ],
    }).map((row) => row.tag),
    ['build']
  );
});

test('the cancellation ledger holds a stopped row against a later running snapshot', () => {
  const ledger = createDesktopCancellationLedger();
  const row = (status, turnStartedAt) => ({
    tag: 'review',
    sessionId: 'worker-a',
    status,
    stage: status,
    turnStartedAt,
  });
  assert.equal(ledger.apply([row('cancelled', 1_000)])[0].status, 'cancelled');
  // The daemon still reports the session running once the durable index
  // drops the cancelled row: a stale report, not new work.
  const resurrected = ledger.apply([{ ...row('running', 1_000), updatedAt: 9_000_000 }])[0];
  assert.equal(resurrected.status, 'cancelled');
  assert.equal(resurrected.stage, 'cancelled');
  assert.equal(desktopAgentActivityState(resurrected), 'cancelled');
  // A genuinely newer frozen turn stamp IS new work and releases the row.
  assert.equal(ledger.apply([row('running', 2_000)])[0].status, 'running');
  assert.equal(ledger.size(), 0);
});

test('an unstamped cancellation survives a running report that invents a start stamp', () => {
  const ledger = createDesktopCancellationLedger();
  // An agent cancelled WHILE QUEUED never ran, so it carries no frozen stamp:
  // its ledger baseline is 0 and any later stamp would outrank it.
  assert.equal(
    ledger.apply([
      {
        tag: 'plan',
        sessionId: 'worker-queued',
        stage: 'queued',
        status: 'cancelled',
      },
    ])[0].status,
    'cancelled'
  );
  // A running report publishes `running` with a SYNTHESIZED startedAt
  // (the session createdAt) and never a turn start.
  const promoted = ledger.apply([
    {
      tag: 'plan',
      sessionId: 'worker-queued',
      stage: 'running',
      status: 'running',
      startedAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  ])[0];
  assert.equal(promoted.status, 'cancelled');
  assert.equal(promoted.stage, 'cancelled');
  assert.equal(desktopAgentActivityState(promoted), 'cancelled');
  // ISO stamps take the same path.
  assert.equal(
    ledger.apply([
      {
        tag: 'plan',
        sessionId: 'worker-queued',
        status: 'running',
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ])[0].status,
    'cancelled'
  );
  // Only a real turn start proves new work under that identity.
  assert.equal(
    ledger.apply([
      {
        tag: 'plan',
        sessionId: 'worker-queued',
        status: 'running',
        turnStartedAt: Date.now(),
      },
    ])[0].status,
    'running'
  );
  assert.equal(ledger.size(), 0);
});

test('an unconfirmed cancel stays on the live surfaces; only a confirmed one drops', () => {
  const unconfirmed = {
    sessionId: 'lead-a',
    agentWorkers: [
      {
        tag: 'build',
        agent: 'builder',
        stage: 'running',
        status: 'cancel-unconfirmed',
      },
    ],
  };
  // Hiding this row is how a Windows git-bash survivor would vanish from the
  // surface while its process may still be alive.
  assert.deepEqual(
    liveAgentRows(unconfirmed).map((row) => [row.tag, row.state, row.queued]),
    [['build', 'cancel-unconfirmed', false]]
  );
  // A worker still winding down is equally unproven.
  assert.deepEqual(
    liveAgentRows({ agentWorkers: [{ tag: 'plan', agent: 'planner', status: 'cancelling' }] }).map((row) => row.state),
    ['cancel-unconfirmed']
  );
  // Twin rows: the live twin must not hide the unproven truth, in either order.
  assert.deepEqual(
    liveAgentRows({
      agentWorkers: [{ tag: 'build', agent: 'builder', status: 'running', stage: 'running' }],
      agentJobs: [{ task_id: 'task-1', tag: 'build', status: 'cancel-unconfirmed' }],
    }).map((row) => [row.tag, row.state]),
    [['build', 'cancel-unconfirmed']]
  );
  assert.deepEqual(
    liveAgentRows({
      agentWorkers: [{ tag: 'build', agent: 'builder', stage: 'running', status: 'cancel-unconfirmed' }],
      agentJobs: [{ task_id: 'task-1', tag: 'build', status: 'running' }],
    }).map((row) => [row.tag, row.state]),
    [['build', 'cancel-unconfirmed']]
  );
  // A confirmed cancel still drops, exactly like `completed`.
  assert.deepEqual(liveAgentRows({ agentWorkers: [{ tag: 'build', agent: 'builder', status: 'cancelled' }] }), []);
});

test('the Agents pane paints a pooled agent blocked on approval as waiting for it, with no timer', async () => {
  const dom = installDom();
  let push = () => {};
  window.mixdogDesktop = {
    async listAgentPool() {
      return [];
    },
    subscribeAgentPool(listener) {
      push = listener;
      return () => {};
    },
  };
  const sessions = [{ id: 'lead-a', title: 'Lead A', preview: '', updatedAt: 1, messageCount: 1 }];
  const elapsedOf = (sessionId) =>
    document.querySelector(`[data-agent-session-id="${sessionId}"] .agent-activity-elapsed`);
  try {
    await act(async () => dom.root.render(React.createElement(AgentActivityPane, { active: false, sessions })));
    // The pool row as the stored worker index projects it while the turn waits.
    const row = (sessionId, extra = {}) => ({
      tag: sessionId,
      agent: 'reviewer',
      stage: 'running',
      status: 'running',
      sessionId,
      ownerSessionId: 'lead-a',
      turnStartedAt: Date.now() - 65_000,
      ...extra,
    });
    await act(async () => push([row('worker-asking', { awaitingUser: 'approval' }), row('worker-busy')]));
    await expandAllAgentGroups();
    const asking = elapsedOf('worker-asking');
    assert.equal(asking.dataset.state, 'needs-user');
    assert.equal(asking.textContent, i18n.t('Waiting for approval'));
    assert.equal(elapsedOf('worker-busy').dataset.state, 'running');
    assert.match(elapsedOf('worker-busy').textContent, /\d/);
    // The released wait returns the row to its working timer.
    await act(async () => push([row('worker-asking'), row('worker-busy')]));
    assert.equal(elapsedOf('worker-asking').dataset.state, 'running');
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test('the Agents pane paints a cancelled agent as cancelled, never completed or idle', async () => {
  const dom = installDom();
  let push = () => {};
  window.mixdogDesktop = {
    async listAgentPool() {
      return [];
    },
    subscribeAgentPool(listener) {
      push = listener;
      return () => {};
    },
  };
  const sessions = [{ id: 'lead-a', title: 'Lead A', preview: '', updatedAt: 1, messageCount: 1 }];
  const stateOf = (sessionId) =>
    document.querySelector(`[data-agent-session-id="${sessionId}"] .agent-activity-elapsed`)?.dataset.state;
  try {
    await act(async () => {
      dom.root.render(
        React.createElement(AgentActivityPane, {
          active: false,
          sessions,
          // Both owners are unseen: the old mapping turned that into
          // "Completed" for a cancelled row.
          unreadSessionIds: new Set(['worker-queued', 'worker-running', 'worker-unconfirmed']),
        })
      );
    });
    await act(async () =>
      push([
        {
          tag: 'plan',
          agent: 'planner',
          stage: 'queued',
          status: 'cancelled',
          sessionId: 'worker-queued',
          ownerSessionId: 'lead-a',
        },
        {
          tag: 'review',
          agent: 'reviewer',
          stage: 'running',
          status: 'cancelled',
          sessionId: 'worker-running',
          ownerSessionId: 'lead-a',
          turnStartedAt: 1_000,
        },
        {
          tag: 'build',
          agent: 'builder',
          stage: 'running',
          status: 'cancel-unconfirmed',
          sessionId: 'worker-unconfirmed',
          ownerSessionId: 'lead-a',
          turnStartedAt: 1_000,
        },
      ])
    );
    await expandAllAgentGroups();
    assert.equal(stateOf('worker-queued'), 'cancelled');
    assert.equal(stateOf('worker-running'), 'cancelled');
    assert.equal(stateOf('worker-unconfirmed'), 'cancel-unconfirmed');
    assert.match(document.body.textContent, /Cancelled/);
    assert.match(document.body.textContent, /Cancel unconfirmed/);
    assert.doesNotMatch(document.body.textContent, /Completed|Idle|Queued/);

    // A later snapshot reporting the same sessions as running again (the
    // daemon has not unwound their turns yet) must not resurrect either of
    // them — including the queued cancellation, which has NO frozen stamp of
    // its own while the report invents startedAt from the session record.
    await act(async () =>
      push([
        {
          tag: 'plan',
          agent: 'planner',
          stage: 'running',
          status: 'running',
          sessionId: 'worker-queued',
          ownerSessionId: 'lead-a',
          startedAt: Date.now(),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        {
          tag: 'review',
          agent: 'reviewer',
          stage: 'running',
          status: 'running',
          sessionId: 'worker-running',
          ownerSessionId: 'lead-a',
          turnStartedAt: 1_000,
          updatedAt: Date.now(),
        },
      ])
    );
    assert.equal(stateOf('worker-queued'), 'cancelled');
    assert.equal(stateOf('worker-running'), 'cancelled');

    // Real new work under the same identity carries a newer turn stamp — the
    // one signal a stale running report never publishes.
    await act(async () =>
      push([
        {
          tag: 'plan',
          agent: 'planner',
          stage: 'running',
          status: 'running',
          sessionId: 'worker-queued',
          ownerSessionId: 'lead-a',
          turnStartedAt: Date.now(),
        },
        {
          tag: 'review',
          agent: 'reviewer',
          stage: 'running',
          status: 'running',
          sessionId: 'worker-running',
          ownerSessionId: 'lead-a',
          turnStartedAt: Date.now(),
        },
      ])
    );
    assert.equal(stateOf('worker-queued'), 'running');
    assert.equal(stateOf('worker-running'), 'running');
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

const hierarchyPool = () => [
  {
    tag: 'lead',
    agent: 'lead',
    status: 'running',
    stage: 'running',
    sessionId: 'lead-a',
    ownerSessionId: 'lead-a',
    turnStartedAt: new Date(Date.now() - 5_000).toISOString(),
  },
  {
    tag: 'research',
    agent: 'researcher',
    status: 'running',
    stage: 'running',
    sessionId: 'child-a',
    ownerSessionId: 'lead-a',
    parentSessionId: 'lead-a',
    turnStartedAt: new Date(Date.now() - 4_000).toISOString(),
  },
  {
    // Producer shape: every descendant carries the ROOT owner session, and the
    // immediate edge is a separate parentSessionId.
    tag: 'review',
    agent: 'reviewer',
    status: 'running',
    stage: 'running',
    sessionId: 'grand-a',
    ownerSessionId: 'lead-a',
    parentSessionId: 'child-a',
    turnStartedAt: new Date(Date.now() - 3_000).toISOString(),
  },
  {
    tag: 'plan',
    agent: 'planner',
    status: 'idle',
    stage: 'idle',
    sessionId: 'great-a',
    ownerSessionId: 'lead-a',
    parentSessionId: 'grand-a',
    updatedAt: new Date(Date.now() - 65_000).toISOString(),
  },
  {
    // Legacy row: no parentSessionId at all, so ownerSessionId is the link.
    tag: 'docs',
    agent: 'writer',
    status: 'running',
    stage: 'running',
    sessionId: 'child-legacy',
    ownerSessionId: 'lead-a',
    turnStartedAt: new Date(Date.now() - 2_000).toISOString(),
  },
  {
    // The immediate parent already finished and left the pool: the row must
    // stay visible as a top-level orphan under its valid root.
    tag: 'audit',
    agent: 'auditor',
    status: 'running',
    stage: 'running',
    sessionId: 'orphan-a',
    ownerSessionId: 'lead-a',
    parentSessionId: 'gone-a',
    turnStartedAt: new Date(Date.now() - 1_000).toISOString(),
  },
];

test('the owner session is the authoritative root and the parent edge only nests', () => {
  const groups = agentActivityGroups(hierarchyPool(), (id) => id === 'lead-a');
  assert.equal(groups.length, 1);
  assert.equal(groups[0].ownerId, 'lead-a');
  assert.equal(groups[0].agents.length, 6);
  const rows = flattenAgentActivityNodes(groups[0].nodes);
  // Lead → direct child → descendant, with the orphan kept at the Lead's own
  // child level rather than dropped or buried.
  assert.deepEqual(
    rows.map((node) => [node.sessionId, node.depth, node.parentSessionId]),
    [
      ['lead-a', 0, ''],
      ['child-a', 1, 'lead-a'],
      ['grand-a', 2, 'child-a'],
      ['great-a', 3, 'grand-a'],
      ['child-legacy', 1, 'lead-a'],
      ['orphan-a', 1, 'lead-a'],
    ]
  );
  assert.deepEqual(
    rows.map((node) => `${node.posInSet}/${node.setSize}`),
    ['1/1', '1/3', '1/1', '1/1', '2/3', '3/3']
  );
  // A group is real only through its root: no catalog row, no surface.
  assert.deepEqual(
    agentActivityGroups(hierarchyPool(), () => false),
    []
  );
});

test('a descendant without a root stamp still resolves through its parent chain', () => {
  // Older producer shape: ownerSessionId is the IMMEDIATE parent, so the root
  // is reached by climbing, and never by adopting a non-catalog id.
  const groups = agentActivityGroups(
    [
      {
        tag: 'research',
        agent: 'researcher',
        status: 'running',
        stage: 'running',
        sessionId: 'child-a',
        ownerSessionId: 'lead-a',
      },
      {
        tag: 'review',
        agent: 'reviewer',
        status: 'running',
        stage: 'running',
        sessionId: 'legacy-grand',
        ownerSessionId: 'child-a',
        parentSessionId: 'child-a',
      },
      {
        // Nothing links this row to a catalog session: an internal reservation.
        tag: 'spare',
        agent: 'reviewer',
        status: 'running',
        stage: 'running',
        sessionId: 'unrooted',
        ownerSessionId: 'ghost-a',
        parentSessionId: 'ghost-a',
      },
    ],
    (id) => id === 'lead-a'
  );
  assert.equal(groups.length, 1);
  assert.deepEqual(
    flattenAgentActivityNodes(groups[0].nodes).map((node) => [node.sessionId, node.depth]),
    [
      ['child-a', 0],
      ['legacy-grand', 1],
    ]
  );
});

test('Agent hierarchy survives a cyclic or self-referencing spawn chain', () => {
  const groups = agentActivityGroups(
    [
      {
        tag: 'lead',
        agent: 'lead',
        status: 'running',
        stage: 'running',
        sessionId: 'lead-a',
        ownerSessionId: 'lead-a',
      },
      {
        // A self-parent still belongs to its owner instead of vanishing.
        tag: 'self',
        agent: 'researcher',
        status: 'running',
        stage: 'running',
        sessionId: 'child-self',
        ownerSessionId: 'lead-a',
        parentSessionId: 'child-self',
      },
      {
        tag: 'x',
        agent: 'reviewer',
        status: 'running',
        stage: 'running',
        sessionId: 'cycle-x',
        ownerSessionId: 'lead-a',
        parentSessionId: 'cycle-y',
      },
      {
        tag: 'y',
        agent: 'reviewer',
        status: 'running',
        stage: 'running',
        sessionId: 'cycle-y',
        ownerSessionId: 'lead-a',
        parentSessionId: 'cycle-x',
      },
    ],
    (id) => id === 'lead-a'
  );
  assert.equal(groups.length, 1);
  // Nothing in a cycle is lost: it re-enters the tree beneath the valid root.
  assert.deepEqual(
    flattenAgentActivityNodes(groups[0].nodes).map((node) => [node.sessionId, node.depth]),
    [
      ['lead-a', 0],
      ['child-self', 1],
      ['cycle-x', 1],
      ['cycle-y', 2],
    ]
  );
});

for (const inlineActions of [false, true]) {
  test(`Agent counts and bulk folds work from the ${inlineActions ? 'pane toolbar' : 'dock header'}`, async () => {
    const dom = installDom();
    const emptyLead = {
      tag: 'empty',
      agent: 'lead',
      status: 'idle',
      stage: 'idle',
      sessionId: 'lead-empty',
      ownerSessionId: 'lead-empty',
    };
    let pool = [...hierarchyPool(), emptyLead];
    let push;
    const opened = [];
    window.mixdogDesktop = {
      async listAgentPool() {
        return pool;
      },
      subscribeAgentPool(listener) {
        push = listener;
        return () => {};
      },
    };
    const sessions = ['lead-a', 'lead-b', 'lead-empty'].map((id) => ({
      id,
      title: id,
      preview: '',
      updatedAt: 1,
      messageCount: 1,
    }));
    const renderPane = () =>
      React.createElement(
        React.Fragment,
        null,
        !inlineActions &&
          React.createElement('header', { className: 'utility-dock-header' }, React.createElement(AgentGroupsMenu)),
        React.createElement(AgentActivityPane, {
          active: false,
          sessions,
          showGroupActions: inlineActions,
          onOpenLeadSession: (id) => opened.push(id),
        })
      );
    const row = (id) => document.querySelector(`[data-agent-session-id="${id}"]`);
    const heading = (id) => document.querySelector(`[data-lead-session-id="${id}"]`);
    const badge = (id) => row(id).querySelector('.dock-review-count');
    const visibleIds = () =>
      [...document.querySelectorAll('[data-agent-session-id]')].map((entry) => entry.dataset.agentSessionId).sort();
    const menuAction = async (action) => {
      const selector = inlineActions ? '.agent-group-toolbar' : '.utility-dock-header';
      await act(async () => document.querySelector(`${selector} .row-overflow-trigger`).click());
      await act(async () => document.querySelector(`[data-action-id="${action}"]`).click());
    };
    try {
      await act(async () => dom.root.render(renderPane()));
      assert.deepEqual(visibleIds(), ['lead-a', 'lead-empty']);
      assert.equal(heading('lead-a').getAttribute('aria-expanded'), 'false');
      assert.equal(row('lead-a').getAttribute('aria-expanded'), 'false');
      // Count all five descendants, including nested and idle rows, not the Lead.
      assert.equal(badge('lead-a').textContent, '5');
      assert.equal(badge('lead-a').previousElementSibling.textContent, 'Lead');
      assert.equal(badge('lead-empty'), null);
      await act(async () => badge('lead-a').click());
      assert.deepEqual(opened, ['lead-a']);
      assert.equal(heading('lead-a').getAttribute('aria-expanded'), 'false');

      await act(async () => heading('lead-a').click());
      assert.ok(row('child-a'));
      assert.equal(row('child-a').getAttribute('aria-expanded'), 'false');
      assert.equal(row('grand-a'), null);
      assert.equal(badge('child-a'), null);
      assert.equal(badge('lead-a').textContent, '5');

      await menuAction('expand-agent-groups');
      assert.equal(visibleIds().length, 7);
      assert.ok(row('great-a'));
      assert.equal(row('child-a').getAttribute('aria-expanded'), 'true');
      await menuAction('collapse-agent-groups');
      assert.deepEqual(visibleIds(), ['lead-a', 'lead-empty']);
      await act(async () => heading('lead-a').click());
      assert.equal(row('child-a').getAttribute('aria-expanded'), 'false');
      assert.equal(row('grand-a'), null);
      // Expand all also clears each nested fold, not only the owner heading.
      await menuAction('expand-agent-groups');
      assert.ok(row('great-a'));

      pool = [
        ...pool,
        {
          tag: 'extra',
          agent: 'reviewer',
          status: 'queued',
          stage: 'queued',
          sessionId: 'extra-a',
          ownerSessionId: 'lead-a',
          parentSessionId: 'great-a',
        },
        {
          ...emptyLead,
          tag: 'lead-b',
          sessionId: 'lead-b',
          ownerSessionId: 'lead-b',
        },
        {
          tag: 'child-b',
          agent: 'worker',
          status: 'running',
          stage: 'running',
          sessionId: 'child-b',
          ownerSessionId: 'lead-b',
          parentSessionId: 'lead-b',
        },
      ];
      await act(async () => push(pool));
      assert.equal(badge('lead-a').textContent, '6');
      assert.equal(heading('lead-a').getAttribute('aria-expanded'), 'true');
      assert.equal(badge('lead-b').textContent, '1');
      assert.equal(heading('lead-b').getAttribute('aria-expanded'), 'false');
      assert.equal(row('child-b'), null);
      pool = pool.filter((entry) => entry.sessionId !== 'extra-a');
      await act(async () => push(pool));
      assert.equal(badge('lead-a').textContent, '5');
      await menuAction('expand-agent-groups');
      assert.ok(row('child-b'));
      await menuAction('collapse-agent-groups');
      assert.deepEqual(visibleIds(), ['lead-a', 'lead-b', 'lead-empty']);
      await menuAction('expand-agent-groups');
      await act(async () => dom.root.render(null));
      await act(async () => dom.root.render(renderPane()));
      assert.deepEqual(visibleIds(), ['lead-a', 'lead-b', 'lead-empty']);
    } finally {
      await act(async () => dom.root.unmount());
      dom.close();
    }
  });
}

test('the Agent window renders the Parent-Child tree and folds every generation', async () => {
  const dom = installDom();
  window.mixdogDesktop = {
    async listAgentPool() {
      return hierarchyPool();
    },
    subscribeAgentPool() {
      return () => {};
    },
  };
  try {
    await act(async () => {
      dom.root.render(
        React.createElement(AgentActivityPane, {
          active: true,
          sessions: [
            {
              id: 'lead-a',
              title: 'First task',
              preview: '',
              updatedAt: 2,
              messageCount: 1,
              cwd: 'C:\\a',
              classification: 'task',
              projectPath: null,
              working: true,
              leadWorking: true,
              agentWorking: true,
            },
          ],
          unreadSessionIds: new Set(['great-a']),
        })
      );
    });

    await expandAllAgentGroups();
    const tree = document.querySelector('.agent-activity-page .schedules-list');
    assert.equal(tree.getAttribute('role'), 'tree');
    assert.equal(tree.getAttribute('aria-label'), 'First task');
    const rowAt = (sessionId) => document.querySelector(`[data-agent-session-id="${sessionId}"]`);
    assert.deepEqual(
      [...document.querySelectorAll('[data-agent-session-id]')].map((node) =>
        node.getAttribute('data-agent-session-id')
      ),
      ['lead-a', 'child-a', 'grand-a', 'great-a', 'child-legacy', 'orphan-a']
    );
    assert.deepEqual(
      [...document.querySelectorAll('[data-agent-session-id]')].map((node) => node.getAttribute('data-agent-depth')),
      ['0', '1', '2', '3', '1', '1']
    );
    assert.equal(rowAt('grand-a').getAttribute('data-agent-parent-session-id'), 'child-a');
    assert.equal(rowAt('great-a').getAttribute('data-agent-parent-session-id'), 'grand-a');
    // A lost parent never hides real work: the orphan stays at the Lead's own
    // child level.
    assert.equal(rowAt('orphan-a').getAttribute('data-agent-parent-session-id'), 'lead-a');
    // Accessibility: one flat tree, hierarchy announced by level and position.
    assert.equal(rowAt('child-a').getAttribute('role'), 'treeitem');
    assert.equal(rowAt('lead-a').getAttribute('aria-level'), '1');
    assert.equal(rowAt('child-a').getAttribute('aria-level'), '2');
    assert.equal(rowAt('grand-a').getAttribute('aria-level'), '3');
    assert.equal(rowAt('lead-a').style.marginInlineStart, '');
    assert.equal(rowAt('child-a').style.marginInlineStart, '');
    assert.equal(rowAt('child-a').style.width, '');
    assert.equal(rowAt('grand-a').style.marginInlineStart, '');
    assert.equal(rowAt('grand-a').style.width, '');
    assert.equal(rowAt('child-a').style.paddingInlineStart, '');
    assert.equal(rowAt('great-a').getAttribute('aria-level'), '4');
    assert.equal(rowAt('child-a').getAttribute('aria-posinset'), '1');
    assert.equal(rowAt('orphan-a').getAttribute('aria-posinset'), '3');
    assert.equal(rowAt('orphan-a').getAttribute('aria-setsize'), '3');
    assert.equal(rowAt('child-a').getAttribute('aria-expanded'), 'true');
    assert.equal(rowAt('great-a').getAttribute('aria-expanded'), null);
    // Roving tab focus: exactly one row per tree is tabbable.
    assert.equal(rowAt('lead-a').getAttribute('tabindex'), '0');
    assert.deepEqual([...document.querySelectorAll('[data-agent-session-id]:not([tabindex="-1"])')].length, 1);
    assert.equal(rowAt('grand-a').getAttribute('aria-label'), 'Reviewer · review');
    // Status, model and timing behavior is unchanged at any depth.
    assert.match(rowAt('grand-a').querySelector('.agent-activity-elapsed').textContent, /^\d/);
    const unreadIdle = rowAt('great-a').querySelector('.agent-activity-elapsed');
    assert.equal(unreadIdle.getAttribute('data-state'), 'done');
    assert.equal(unreadIdle.textContent, 'Completed');

    const heading = document.querySelector('[data-lead-session-id="lead-a"]');
    await act(async () => heading.click());
    assert.equal(heading.getAttribute('aria-expanded'), 'false');
    assert.deepEqual(
      [...document.querySelectorAll('[data-agent-session-id]')].map((node) =>
        node.getAttribute('data-agent-session-id')
      ),
      ['lead-a']
    );
    // Truthful expansion: the surviving row reports the fold that hides its
    // subtree instead of claiming to be open.
    assert.equal(rowAt('lead-a').getAttribute('aria-expanded'), 'false');
    await act(async () => heading.click());
    assert.ok(rowAt('great-a'));
    assert.equal(rowAt('lead-a').getAttribute('aria-expanded'), 'true');
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test('a nested Agent row opens its exact child session without touching session lists', async () => {
  const dom = installDom();
  const touched = [];
  const host = {
    async listAgentPool() {
      return hierarchyPool();
    },
    subscribeAgentPool() {
      return () => {};
    },
  };
  window.mixdogDesktop = new Proxy(host, {
    get(target, key) {
      if (typeof key === 'string') touched.push(key);
      return target[key];
    },
  });
  const sessions = [
    {
      id: 'lead-a',
      title: 'First task',
      preview: '',
      updatedAt: 2,
      messageCount: 1,
      cwd: 'C:\\a',
      classification: 'task',
      projectPath: null,
    },
  ];
  const catalogBefore = JSON.stringify(sessions);
  const opened = [];
  const prefetched = [];
  try {
    await act(async () => {
      dom.root.render(
        React.createElement(AgentActivityPane, {
          active: true,
          sessions,
          onPrefetchSession: (sessionId) => prefetched.push(sessionId),
          onOpenLeadSession: (sessionId) => opened.push(['lead', sessionId]),
          onOpenSession: (sessionId, title, ownerSessionId) => opened.push(['agent', sessionId, title, ownerSessionId]),
        })
      );
    });
    await expandAllAgentGroups();
    // Hidden children are reachable ONLY here: they are absent from the
    // session catalog this pane was handed.
    assert.equal(
      sessions.some((session) => session.id === 'grand-a'),
      false
    );

    const click = (sessionId) =>
      act(async () => {
        const row = document.querySelector(`[data-agent-session-id="${sessionId}"]`);
        row.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true }));
        row.click();
      });
    await click('grand-a');
    await click('great-a');
    await click('lead-a');
    assert.deepEqual(opened, [
      ['agent', 'grand-a', 'review', 'lead-a'],
      ['agent', 'great-a', 'plan', 'lead-a'],
      ['lead', 'lead-a'],
    ]);
    // Opening a child pane never writes to Recent/Resume: the catalog handed
    // in is untouched and no session-catalog host call is made at all.
    assert.equal(JSON.stringify(sessions), catalogBefore);
    assert.deepEqual(
      touched.filter((name) => /session/i.test(name)),
      []
    );
    // The contacts read the agent catalog (a read capability); nothing else.
    assert.deepEqual([...new Set(touched)].sort(), ['invokeCapability', 'listAgentPool', 'subscribeAgentPool']);
    assert.deepEqual(prefetched, ['grand-a', 'great-a', 'lead-a']);
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test('the Agent tree supports arrow, Home/End and expand-collapse keyboard control', async () => {
  const dom = installDom();
  window.mixdogDesktop = {
    async listAgentPool() {
      return hierarchyPool();
    },
    subscribeAgentPool() {
      return () => {};
    },
  };
  const rowAt = (sessionId) => document.querySelector(`[data-agent-session-id="${sessionId}"]`);
  const focusedId = () => document.activeElement?.getAttribute('data-agent-session-id');
  const press = (key) =>
    act(async () => {
      document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true }));
    });
  try {
    await act(async () => {
      dom.root.render(
        React.createElement(AgentActivityPane, {
          active: true,
          sessions: [
            {
              id: 'lead-a',
              title: 'First task',
              preview: '',
              updatedAt: 2,
              messageCount: 1,
              cwd: 'C:\\a',
              classification: 'task',
              projectPath: null,
            },
          ],
        })
      );
    });
    await expandAllAgentGroups();
    await act(async () => rowAt('lead-a').focus());

    await press('ArrowDown');
    assert.equal(focusedId(), 'child-a');
    // Roving focus follows the keyboard, so Tab returns to the same row.
    assert.equal(rowAt('child-a').getAttribute('tabindex'), '0');
    assert.equal(rowAt('lead-a').getAttribute('tabindex'), '-1');
    await press('ArrowRight');
    assert.equal(focusedId(), 'grand-a');
    await press('ArrowUp');
    assert.equal(focusedId(), 'child-a');

    await press('End');
    assert.equal(focusedId(), 'orphan-a');
    await press('Home');
    assert.equal(focusedId(), 'lead-a');

    // Left closes a real subtree, and the row reports the closure.
    await act(async () => rowAt('child-a').focus());
    await press('ArrowLeft');
    assert.equal(rowAt('child-a').getAttribute('aria-expanded'), 'false');
    assert.equal(rowAt('grand-a'), null);
    assert.equal(focusedId(), 'child-a');
    // Left again climbs to the parent row instead of closing anything.
    await press('ArrowLeft');
    assert.equal(focusedId(), 'lead-a');
    // Right reopens exactly what was closed.
    await act(async () => rowAt('child-a').focus());
    await press('ArrowRight');
    assert.equal(rowAt('child-a').getAttribute('aria-expanded'), 'true');
    assert.ok(rowAt('great-a'));

    // At the root row, Left folds the whole group and Right reopens it.
    await act(async () => rowAt('lead-a').focus());
    await press('ArrowLeft');
    assert.equal(rowAt('lead-a').getAttribute('aria-expanded'), 'false');
    await press('ArrowLeft');
    const heading = document.querySelector('[data-lead-session-id="lead-a"]');
    assert.equal(heading.getAttribute('aria-expanded'), 'false');
    assert.equal(document.querySelectorAll('[data-agent-session-id]').length, 1);
    await act(async () => rowAt('lead-a').focus());
    await press('ArrowRight');
    assert.equal(heading.getAttribute('aria-expanded'), 'true');
  } finally {
    await act(async () => dom.root.unmount());
    dom.close();
  }
});

test('live agent rows carry cumulative usage and tool calls through to the background-job pool row', () => {
  const usage = { inputTokens: 900, outputTokens: 100, totalTokens: 1000 };
  const [row] = liveAgentRows({
    agentWorkers: [{ tag: 'build', agent: 'builder', status: 'running', sessionId: 'sess-a', usage, toolCalls: 12 }],
  });
  assert.deepEqual(row.usage, usage);
  assert.equal(row.toolCalls, 12);
  // Unknown or malformed totals are null, never zero or partial.
  const [unknown] = liveAgentRows({
    agentWorkers: [{ tag: 'old', agent: 'builder', status: 'running', usage: { inputTokens: 1 }, toolCalls: 'x' }],
  });
  assert.equal(unknown.usage, null);
  assert.equal(unknown.toolCalls, null);
  // A twin job row without totals does not erase the worker row's.
  const [merged] = liveAgentRows({
    agentWorkers: [{ tag: 'build', agent: 'builder', status: 'queued', stage: 'queued', usage, toolCalls: 3 }],
    agentJobs: [{ task_id: 'task-1', tag: 'build', agent: 'builder', status: 'running', stage: 'running' }],
  });
  assert.deepEqual(merged.usage, usage);
  assert.equal(merged.toolCalls, 3);
  // Background shell rows never carry agents: those come from the pool.
  assert.deepEqual(
    backgroundJobRows({
      agentWorkers: [{ tag: 'build', agent: 'builder', status: 'running', sessionId: 'sess-a', usage, toolCalls: 12 }],
    }),
    []
  );
});

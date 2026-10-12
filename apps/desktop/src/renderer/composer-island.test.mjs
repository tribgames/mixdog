import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import { ComposerDock } from './ComposerDock.tsx';
import { BackgroundJobsPane } from './BackgroundJobsPane.tsx';
import { requestBackgroundJobsTab } from './background-jobs-tab-store.ts';
import { QueueList } from './composer-support.tsx';
import { defaultSessionLaneStore } from './session-lane-store.ts';
import { t as translate } from './i18n.ts';

function mount(t) {
  const { dom, root } = installTestDom(t, {
    expose: ['HTMLElement', 'Element', 'Node', 'KeyboardEvent', 'MouseEvent'],
    rootId: 'root',
  });
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  dom.window.mixdogDesktop = {};
  t.after(() => defaultSessionLaneStore.clear());
  return { root, document: dom.window.document, window: dom.window };
}

const dockProps = (overrides = {}) => ({
  sessionId: 'island-session',
  goalSubmissionId: '',
  showProjectSelector: false,
  reviewItems: [],
  reviewActive: true,
  reviewBusy: false,
  reviewSessionId: '',
  reviewCwd: '',
  children: React.createElement('form', { className: 'composer' }),
  ...overrides,
});

const publish = (snapshot) =>
  act(async () => {
    defaultSessionLaneStore.apply({
      sessionId: 'island-session',
      snapshot: { sessionId: 'island-session', ...snapshot },
    });
  });

test('a draft keeps its context bar; a session reserves the island slot even when empty', async (t) => {
  const { root, document } = mount(t);
  await act(async () =>
    root.render(
      React.createElement(ComposerDock, {
        ...dockProps({ sessionId: '', showProjectSelector: true }),
        contextBar: React.createElement('span', { id: 'context' }),
      })
    )
  );
  assert.ok(document.querySelector('.composer-context-bar #context'));
  assert.equal(document.querySelector('.composer-island-slot'), null);
  await act(async () => root.render(React.createElement(ComposerDock, dockProps())));
  assert.equal(document.querySelector('.composer-context-bar'), null);
  const slot = document.querySelector('.composer-island-slot');
  assert.ok(slot);
  assert.equal(document.querySelectorAll('.composer-island-seg').length, 0, 'nothing to carry, no segment');
  // Order: the slot sits above the queue tray, which sits above the input.
  const children = [...document.querySelector('.composer-region').children].map((node) => node.className);
  assert.deepEqual(children, ['composer-island-slot', 'composer-queue-tray', 'composer']);
});

test('background jobs show as one segment, expand to rows, collapse on Escape and end without a flash', async (t) => {
  const { root, document, window } = mount(t);
  await publish({
    shellJobs: { count: 1, jobs: [{ taskId: 'job-1', command: 'npm test', startedAt: Date.now() - 5_000 }] },
  });
  await act(async () => root.render(React.createElement(ComposerDock, dockProps())));
  const segment = document.querySelector('.composer-island-seg');
  // The count in words with the terminal glyph leading; the command lives in the panel.
  assert.equal(segment.textContent, translate('Island: {{count}} shells', { count: 1 }));
  assert.equal(segment.textContent, '1 shell');
  assert.ok(segment.firstElementChild.classList.contains('composer-island-seg-icon'));
  // Running work is a pulsing dot, not a spinner.
  assert.ok(segment.querySelector('.composer-island-pulse'));
  // The only glyph is the narrow-island icon, never a spinner.
  assert.equal(segment.querySelector('svg:not(.composer-island-seg-icon)'), null);
  await act(async () => segment.click());
  assert.equal(document.querySelector('.composer-island-slot').dataset.mode, 'panel');
  const rows = [...document.querySelectorAll('.composer-island-row')];
  assert.equal(rows.length, 1);
  assert.ok(rows[0].querySelector('.composer-island-pulse'));
  assert.equal(rows[0].querySelector('svg'), null);
  assert.match(rows[0].textContent, /npm test/);
  await act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' })));
  assert.equal(document.querySelector('.composer-island-slot').dataset.mode, 'pill');
  await publish({ shellJobs: { count: 0, jobs: [] } });
  // Finished work leaves quietly: no flash notice.
  assert.equal(document.querySelector('.composer-island-slot').dataset.mode, 'pill');
  assert.equal(document.querySelector('.composer-island-flash'), null);
});

test('agents and shells are counted in separate icon segments that both survive a narrow island', async (t) => {
  const { root, document } = mount(t);
  const agent = (tag) => ({ tag, agent: 'worker', stage: 'running', status: 'running', startedAt: Date.now() - 5_000 });
  const shells = (n) => ({
    count: n,
    jobs: Array.from({ length: n }, (_, i) => ({ taskId: `j${i}`, command: 'npm test', startedAt: Date.now() - 5_000 })),
  });
  const segments = () => ({
    agents: document.querySelector('.composer-island-seg-agents'),
    shell: document.querySelector('.composer-island-seg-shell'),
  });
  await publish({ agentWorkers: [agent('a'), agent('b')] });
  await act(async () => root.render(React.createElement(ComposerDock, dockProps())));
  assert.equal(segments().agents.textContent, '2 agents');
  assert.equal(segments().shell, null);
  await publish({ agentWorkers: [agent('a')] });
  assert.equal(segments().agents.textContent, '1 agent');
  await publish({ agentWorkers: [], shellJobs: shells(2) });
  assert.equal(segments().shell.textContent, '2 shells');
  assert.equal(segments().agents, null);
  await publish({ agentWorkers: [agent('a'), agent('b')], shellJobs: shells(1) });
  const { agents, shell } = segments();
  assert.equal(agents.textContent, '2 agents');
  assert.equal(shell.textContent, '1 shell');
  // Narrow keeps both: each carries its glyph and the bare count; the container
  // query only drops the words.
  for (const [seg, count] of [
    [agents, '2'],
    [shell, '1'],
  ]) {
    assert.ok(seg.querySelector('svg.composer-island-seg-icon'));
    assert.equal(seg.querySelector('.composer-island-seg-num').dataset.count, count);
    assert.ok(seg.querySelector('.composer-island-seg-word'));
    assert.ok(seg.querySelector('.composer-island-pulse'), 'the pulsing dot still says running');
  }
});

test('a queued agent reads Queued while a running one shows elapsed time, never Queued', async (t) => {
  const { root, document } = mount(t);
  await publish({
    agentWorkers: [
      { tag: 'run-a', agent: 'worker', stage: 'running', status: 'running', startedAt: Date.now() - 5_000 },
      { tag: 'wait-b', agent: 'reviewer', stage: 'queued', status: 'queued', startedAt: Date.now() - 1_000 },
    ],
  });
  await act(async () => root.render(React.createElement(ComposerDock, dockProps())));
  await act(async () => document.querySelector('.composer-island-seg').click());
  const rows = [...document.querySelectorAll('.composer-island-row')];
  assert.equal(rows.length, 2);
  const queued = rows.filter((row) => row.textContent.includes(translate('Queued')));
  assert.equal(queued.length, 1);
  assert.match(queued[0].textContent, /wait-b/);
});

test('a continued agent times its current turn, not its session creation', async (t) => {
  const { root, document } = mount(t);
  await publish({
    agentWorkers: [
      {
        tag: 'run-a',
        agent: 'worker',
        stage: 'running',
        status: 'running',
        createdAt: new Date(Date.now() - 7.5 * 3_600_000).toISOString(),
        turnStartedAt: new Date(Date.now() - 5_000).toISOString(),
      },
    ],
  });
  await act(async () => root.render(React.createElement(ComposerDock, dockProps())));
  await act(async () => document.querySelector('.composer-island-seg').click());
  const row = document.querySelector('.composer-island-row');
  assert.match(row.textContent, /[0-9]s$/);
  assert.doesNotMatch(row.textContent, /7h/);
});

test('an agent blocked on a user approval reads as needing the user, not working', async (t) => {
  const { root, document } = mount(t);
  await publish({
    agentWorkers: [
      { tag: 'run-a', agent: 'worker', stage: 'running', status: 'running', startedAt: Date.now() - 5_000 },
      {
        tag: 'ask-b',
        agent: 'reviewer',
        stage: 'tool_running',
        status: 'running',
        startedAt: Date.now() - 65_000,
        awaitingUser: 'approval',
      },
    ],
  });
  await act(async () => root.render(React.createElement(ComposerDock, dockProps())));
  const segment = document.querySelector('.composer-island-seg-agents');
  // Counted apart from the running total, so it is never hidden in it.
  assert.match(segment.textContent, new RegExp(`^2 agents.*${translate('Needs you {{needs}}', { needs: 1 })}`));
  // Glyph + count survive a narrow island (only the words hide there).
  const needs = segment.querySelector('.composer-island-seg-state .composer-island-attention')?.parentElement;
  assert.ok(needs);
  assert.equal(needs.querySelector('.composer-island-seg-num').dataset.count, '1');
  assert.ok(needs.querySelector('.composer-island-seg-word'));
  await act(async () => segment.click());
  const rows = [...document.querySelectorAll('.composer-island-row')];
  assert.equal(rows.length, 2);
  // The blocked agent leads, with the attention mark instead of the working
  // pulse and the label instead of a running timer.
  assert.match(rows[0].textContent, /ask-b/);
  assert.equal(rows[0].querySelector('.composer-island-pulse'), null);
  assert.ok(rows[0].querySelector('svg'));
  assert.equal(rows[0].querySelector('.composer-island-row-sub').textContent, translate('Waiting for approval'));
  assert.ok(rows[1].querySelector('.composer-island-pulse'));
  assert.match(rows[1].querySelector('.composer-island-row-sub').textContent, /\d/);
});

test('an agent row with a session is a button that opens it and closes the panel; others stay inert', async (t) => {
  const { root, document } = mount(t);
  await publish({
    shellJobs: { count: 1, jobs: [{ taskId: 'job-1', command: 'npm test', startedAt: Date.now() - 5_000 }] },
    agentWorkers: [
      {
        tag: 'ask-b',
        agent: 'reviewer',
        sessionId: 'child-1',
        stage: 'tool_running',
        status: 'running',
        startedAt: Date.now() - 65_000,
        awaitingUser: 'approval',
      },
      { tag: 'run-a', agent: 'worker', stage: 'running', status: 'running', startedAt: Date.now() - 5_000 },
    ],
  });
  const opened = [];
  await act(async () =>
    root.render(
      React.createElement(ComposerDock, dockProps({ onOpenAgentSession: (...args) => opened.push(args) }))
    )
  );
  await act(async () => document.querySelector('.composer-island-seg-agents').click());
  const rows = [...document.querySelectorAll('.composer-island-row')];
  assert.equal(rows.length, 2);
  // Needs-user agent with a session: a button named after the agent.
  const button = rows[0].querySelector('button.composer-island-row-open');
  assert.ok(button);
  assert.equal(button.type, 'button');
  assert.match(button.getAttribute('aria-label'), /Reviewer · ask-b/);
  assert.match(button.getAttribute('aria-label'), new RegExp(translate('Waiting for approval')));
  // No session id: inert.
  assert.equal(rows[1].querySelector('button'), null);
  await act(async () => button.click());
  assert.equal(opened.length, 1);
  assert.equal(opened[0][0], 'child-1');
  assert.equal(opened[0][2], 'island-session');
  assert.equal(document.querySelector('.composer-island-slot').dataset.mode, 'pill', 'panel closed');
  // Shell rows are never buttons.
  await act(async () => document.querySelector('.composer-island-seg-shell').click());
  assert.equal(document.querySelector('.composer-island-row button'), null);
});

test('without an open action agent rows stay non-interactive', async (t) => {
  const { root, document } = mount(t);
  await publish({
    agentWorkers: [
      { tag: 'run-a', agent: 'worker', sessionId: 'child-2', stage: 'running', status: 'running', startedAt: Date.now() - 5_000 },
    ],
  });
  await act(async () => root.render(React.createElement(ComposerDock, dockProps())));
  await act(async () => document.querySelector('.composer-island-seg-agents').click());
  assert.equal(document.querySelector('.composer-island-row button'), null);
});

test('a pending approval takes over the island; a flash notice replaces any leftover card', async (t) => {
  const { root, document } = mount(t);
  await act(async () =>
    root.render(
      React.createElement(ComposerDock, {
        ...dockProps(),
        approval: React.createElement('article', { className: 'approval-card' }),
      })
    )
  );
  assert.equal(document.querySelector('.composer-island-slot').dataset.mode, 'approval');
  assert.ok(document.querySelector('.composer-island-approval > .approval-card'));
  assert.equal(document.querySelector('.composer-island-pill').hidden, true);
  await act(async () =>
    root.render(
      React.createElement(ComposerDock, {
        ...dockProps(),
        islandFlash: { key: 'elsewhere:1', text: 'Resolved on another device' },
      })
    )
  );
  assert.equal(document.querySelector('.approval-card'), null);
  assert.equal(document.querySelector('.composer-island-flash').textContent, 'Resolved on another device');
});

test('a model mismatch segment offers revert and continue', async (t) => {
  const { root, document } = mount(t);
  const calls = [];
  await act(async () =>
    root.render(
      React.createElement(ComposerDock, {
        ...dockProps(),
        modelMismatch: {
          sessionModel: 'Claude',
          selectedModel: 'Gemini',
          onRevert: () => calls.push('revert'),
          onContinue: () => calls.push('continue'),
        },
      })
    )
  );
  const segment = document.querySelector('.composer-island-seg-model');
  assert.equal(segment.textContent, translate('Continuing in {{model}}', { model: 'Claude' }));
  // A dot marks the mismatch, not a warning glyph.
  assert.ok(segment.querySelector('.composer-island-dot'));
  assert.equal(segment.querySelector('svg'), null);
  await act(async () => segment.click());
  assert.equal(document.querySelector('.composer-island-model svg'), null, 'the panel header has no glyph');
  const buttons = [...document.querySelectorAll('.composer-island-model button')];
  assert.deepEqual(
    buttons.map((button) => button.textContent),
    [translate('Revert'), translate('Continue in {{model}}', { model: 'Gemini' })]
  );
  await act(async () => buttons[0].click());
  await act(async () => buttons[1].click());
  assert.deepEqual(calls, ['revert', 'continue']);
});

test('queued follow-up rows read icon, text, then Steer now, trash and a menu whose Edit edits', async (t) => {
  const { root, document } = mount(t);
  const edits = [];
  await act(async () =>
    root.render(
      React.createElement(QueueList, {
        queued: [{ id: 'q1', displayText: 'report coverage too' }],
        restoring: false,
        onEdit: (id) => edits.push(id),
        onSteer() {},
        onRemove() {},
      })
    )
  );
  const row = document.querySelector('.queue-item');
  assert.deepEqual(
    [...row.children].map((node) => node.getAttribute('class')),
    [
      'lucide lucide-corner-down-right queue-item-icon',
      'queue-item-text',
      'queue-steer',
      'queue-remove',
      'row-overflow',
    ]
  );
  const text = row.querySelector('.queue-item-text');
  assert.equal(text.textContent, 'report coverage too');
  assert.equal(text.dataset.tooltip, 'report coverage too', 'the full message is in the tooltip');
  assert.equal(text.tabIndex, 0, 'focus reaches the tooltip too');
  const steer = row.querySelector('.queue-steer');
  assert.equal(steer.textContent, translate('Steer now'));
  assert.equal(steer.querySelector('svg'), null);
  assert.ok(row.querySelector('.queue-remove svg'), 'Remove is a trash icon');
  assert.equal(row.querySelector('.queue-remove').textContent, '');
  // No standalone Edit button; Edit lives in the ⋯ menu.
  assert.equal([...row.querySelectorAll('button')].filter((b) => b.textContent === translate('Edit')).length, 0);
  await act(async () => row.querySelector('.row-overflow-trigger').click());
  const items = [...document.querySelectorAll('.row-overflow-menu [role="menuitem"]')];
  assert.deepEqual(
    items.map((item) => item.textContent),
    [translate('Edit')]
  );
  await act(async () => items[0].click());
  assert.deepEqual(edits, ['q1']);
  assert.equal(document.querySelector('.row-overflow-menu'), null, 'the menu closes after Edit');
});

test('with a side dock the agent and shell segments open it on their list instead of the popover', async (t) => {
  const { root, document } = mount(t);
  await publish({
    agentWorkers: [{ tag: 'a', agent: 'worker', stage: 'running', status: 'running', startedAt: Date.now() - 5_000 }],
    shellJobs: { count: 1, jobs: [{ taskId: 'j1', command: 'npm test', startedAt: Date.now() - 5_000 }] },
  });
  const opened = [];
  await act(async () =>
    root.render(React.createElement(ComposerDock, dockProps({ onOpenBackgroundJobs: (kind) => opened.push(kind) })))
  );
  await act(async () => document.querySelector('.composer-island-seg-agents').click());
  await act(async () => document.querySelector('.composer-island-seg-shell').click());
  assert.deepEqual(opened, ['agent', 'shell']);
  // The popover stays the no-dock fallback: nothing expanded here.
  assert.equal(document.querySelector('.composer-island-slot').dataset.mode, 'pill');
  assert.equal(document.querySelector('.composer-island-panel'), null);
});

test('the jobs dock pane lists agents with the sidebar row and shells with command and elapsed time', async (t) => {
  const { root, document } = mount(t);
  const opened = [];
  await publish({
    agentWorkers: [
      {
        tag: 'cart-fix',
        agent: 'worker',
        sessionId: 'w1',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        effort: 'high',
        stage: 'running',
        status: 'running',
        startedAt: Date.now() - 65_000,
      },
      { tag: 'tax-fix', agent: 'worker', sessionId: 'w2', stage: 'queued', status: 'queued', startedAt: Date.now() - 1_000 },
    ],
    shellJobs: { count: 1, jobs: [{ taskId: 'j1', command: 'npm run watch', startedAt: Date.now() - 12_000 }] },
  });
  await act(async () =>
    root.render(
      React.createElement(BackgroundJobsPane, {
        sessionId: 'island-session',
        active: true,
        onOpenAgentSession: (...args) => opened.push(args),
      })
    )
  );
  const tabs = [...document.querySelectorAll('.composer-island-tab')];
  assert.deepEqual(
    tabs.map((tab) => tab.textContent),
    [translate('Agent {{agent}}', { agent: 2 }), translate('Shell {{shell}}', { shell: 1 })]
  );
  const rows = [...document.querySelectorAll('.agent-pool-row')];
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent, /Worker · cart-fix/);
  assert.ok(rows[0].querySelector('.agent-route-summary'), 'the sidebar row paints the model line');
  assert.match(rows[0].querySelector('.agent-activity-elapsed').textContent, /1/);
  assert.equal(rows[1].querySelector('.agent-activity-elapsed').textContent, translate('Queued'));
  await act(async () => rows[0].click());
  assert.deepEqual(opened, [['w1', 'cart-fix', 'island-session']]);
  await act(async () => tabs[1].click());
  const shellRows = [...document.querySelectorAll('.agent-pool-row')];
  assert.equal(shellRows.length, 1);
  assert.match(shellRows[0].textContent, /npm run watch/);
  assert.ok(shellRows[0].querySelector('.agent-activity-elapsed').textContent.length > 0);
  assert.equal(shellRows[0].tagName, 'DIV', 'shell rows open nothing');
});

test('the jobs dock pane keeps the Ultrafast label that Fast alone would lose', async (t) => {
  const { root, document } = mount(t);
  const route = { provider: 'openai-oauth', model: 'gpt-6-sol', effort: 'high', stage: 'running', status: 'running' };
  await publish({
    agentWorkers: [
      { ...route, tag: 'swift', agent: 'worker', sessionId: 'u1', fast: true, modelParameters: { serviceTier: 'ultrafast' }, startedAt: Date.now() - 3_000 },
      { ...route, tag: 'quick', agent: 'worker', sessionId: 'u2', fast: true, startedAt: Date.now() - 2_000 },
    ],
  });
  await act(async () => root.render(React.createElement(BackgroundJobsPane, { sessionId: 'island-session', active: true })));
  const [ultra, fast] = [...document.querySelectorAll('.agent-pool-row')];
  assert.equal(ultra.querySelector('.model-route-label-ultra')?.textContent, 'Ultrafast');
  assert.equal(ultra.querySelector('.model-route-label-fast'), null);
  assert.ok(fast.querySelector('.model-route-label-fast'));
  assert.equal(fast.querySelector('.model-route-label-ultra'), null);
});

test('the jobs dock pane opens a titled agent with the sidebar tab title', async (t) => {
  const { root, document } = mount(t);
  const opened = [];
  await publish({
    agentWorkers: [
      { tag: 'cart-fix', title: 'Fix the cart', agent: 'worker', sessionId: 'w1', stage: 'running', status: 'running', startedAt: Date.now() - 5_000 },
    ],
  });
  await act(async () =>
    root.render(
      React.createElement(BackgroundJobsPane, {
        sessionId: 'island-session',
        active: true,
        onOpenAgentSession: (...args) => opened.push(args),
      })
    )
  );
  await act(async () => document.querySelector('.agent-pool-row').click());
  assert.deepEqual(opened, [['w1', 'Fix the cart · cart-fix', 'island-session']]);
});

test('the jobs dock pane is a roving-focus tree for agents and shells', async (t) => {
  requestBackgroundJobsTab('island-session', 'agent');
  const { root, document, window } = mount(t);
  const opened = [];
  await publish({
    agentWorkers: [
      { tag: 'a', agent: 'worker', sessionId: 'w1', stage: 'running', status: 'running', startedAt: Date.now() - 5_000 },
      { tag: 'b', agent: 'worker', sessionId: 'w2', stage: 'running', status: 'running', startedAt: Date.now() - 4_000 },
      { tag: 'c', agent: 'worker', sessionId: 'w3', stage: 'running', status: 'running', startedAt: Date.now() - 3_000 },
    ],
    shellJobs: {
      count: 2,
      jobs: [
        { taskId: 's1', command: 'npm run a', startedAt: Date.now() - 2_000 },
        { taskId: 's2', command: 'npm run b', startedAt: Date.now() - 1_000 },
      ],
    },
  });
  await act(async () =>
    root.render(
      React.createElement(BackgroundJobsPane, {
        sessionId: 'island-session',
        active: true,
        onOpenAgentSession: (...args) => opened.push(args),
      })
    )
  );
  const press = (key) =>
    act(async () =>
      document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    );
  const items = () => [...document.querySelectorAll('[role="treeitem"]')];
  const tabStops = () => items().filter((item) => item.tabIndex === 0).length;
  assert.equal(document.querySelector('[role="tree"]').getAttribute('aria-label'), translate('Background tasks'));
  assert.equal(tabStops(), 1, 'exactly one row is in the tab order');
  items()[0].focus();
  await press('ArrowDown');
  assert.equal(document.activeElement, items()[1]);
  assert.equal(items()[1].tabIndex, 0);
  await press('End');
  assert.equal(document.activeElement, items()[2]);
  await press('ArrowDown');
  assert.equal(document.activeElement, items()[2], 'clamped at the end');
  await press('Home');
  assert.equal(document.activeElement, items()[0]);
  await press('ArrowUp');
  assert.equal(document.activeElement, items()[0], 'clamped at the start');
  // Enter on a button row opens it (native click on keyboard activation).
  await act(async () => document.activeElement.click());
  assert.equal(opened.length, 1);
  // Shells navigate the same way and their rows are focusable.
  await act(async () => [...document.querySelectorAll('.composer-island-tab')][1].click());
  assert.equal(items().length, 2);
  assert.equal(tabStops(), 1);
  items()[0].focus();
  assert.equal(document.activeElement, items()[0]);
  await press('ArrowDown');
  assert.equal(document.activeElement, items()[1]);
  await press('Home');
  assert.equal(document.activeElement, items()[0]);
});
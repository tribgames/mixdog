import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import { ComposerDock } from './ComposerDock.tsx';
import { QueueList } from './composer-support.tsx';
import { defaultSessionLaneStore } from './session-lane-store.ts';
import { t as translate } from './i18n.ts';

function mount(t) {
  const { dom, root } = installTestDom(t, {
    expose: ['HTMLElement', 'Element', 'Node', 'KeyboardEvent', 'MouseEvent', 'MutationObserver'],
    globals: {
      ResizeObserver: class {
        observe() {}
        disconnect() {}
      },
    },
    rootId: 'root',
  });
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  // The island lists agents from the same pool feed as the Agents window.
  let pushPool = () => {};
  let poolRows = [];
  dom.window.mixdogDesktop = {
    listAgentPool: async () => poolRows,
    subscribeAgentPool: (listener) => {
      pushPool = listener;
    },
  };
  t.after(() => defaultSessionLaneStore.clear());
  const publishPool = (rows) =>
    act(async () => {
      poolRows = rows;
      pushPool(rows);
    });
  return { root, document: dom.window.document, window: dom.window, publishPool };
}

const poolAgent = (tag, overrides = {}) => ({
  tag,
  agent: 'worker',
  ownerSessionId: 'island-session',
  stage: 'running',
  status: 'running',
  startedAt: Date.now() - 5_000,
  ...overrides,
});

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
  assert.ok(rows[0].querySelector('.sidebar-resource-icon svg'));
  assert.match(rows[0].textContent, /npm test/);
  assert.equal(rows[0].querySelector('.agent-activity-elapsed').dataset.state, 'running');
  assert.equal(rows[0].querySelector('button').textContent, translate('Stop'));
  await act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' })));
  assert.equal(document.querySelector('.composer-island-slot').dataset.mode, 'pill');
  await publish({ shellJobs: { count: 0, jobs: [] } });
  // Finished work leaves quietly: no flash notice.
  assert.equal(document.querySelector('.composer-island-slot').dataset.mode, 'pill');
  assert.equal(document.querySelector('.composer-island-flash'), null);
});

test('agents and shells are counted in separate icon segments that both survive a narrow island', async (t) => {
  const { root, document, publishPool } = mount(t);
  const agent = (tag) => poolAgent(tag);
  const shells = (n) => ({
    count: n,
    jobs: Array.from({ length: n }, (_, i) => ({
      taskId: `j${i}`,
      command: 'npm test',
      startedAt: Date.now() - 5_000,
    })),
  });
  const segments = () => ({
    agents: document.querySelector('.composer-island-seg-agents'),
    shell: document.querySelector('.composer-island-seg-shell'),
  });
  await act(async () => root.render(React.createElement(ComposerDock, dockProps())));
  await publishPool([agent('a'), agent('b')]);
  assert.equal(segments().agents.textContent, '2 agents');
  assert.equal(segments().shell, null);
  await publishPool([agent('a')]);
  assert.equal(segments().agents.textContent, '1 agent');
  await publishPool([]);
  await publish({ shellJobs: shells(2) });
  assert.equal(segments().shell.textContent, '2 shells');
  assert.equal(segments().agents, null);
  await publishPool([agent('a'), agent('b')]);
  await publish({ shellJobs: shells(1) });
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
  const { root, document, publishPool } = mount(t);
  await act(async () => root.render(React.createElement(ComposerDock, dockProps())));
  await publishPool([
    poolAgent('run-a'),
    poolAgent('wait-b', { agent: 'reviewer', stage: 'queued', status: 'queued', startedAt: Date.now() - 1_000 }),
  ]);
  await act(async () => document.querySelector('.composer-island-seg').click());
  const rows = [...document.querySelectorAll('.agent-pool-row')];
  assert.equal(rows.length, 2);
  const queued = rows.filter((row) => row.textContent.includes(translate('Queued')));
  assert.equal(queued.length, 1);
  assert.match(queued[0].textContent, /wait-b/);
});

test('a continued agent times its current turn, not its session creation', async (t) => {
  const { root, document, publishPool } = mount(t);
  await act(async () => root.render(React.createElement(ComposerDock, dockProps())));
  await publishPool([
    poolAgent('run-a', {
      createdAt: new Date(Date.now() - 7.5 * 3_600_000).toISOString(),
      turnStartedAt: new Date(Date.now() - 5_000).toISOString(),
    }),
  ]);
  await act(async () => document.querySelector('.composer-island-seg').click());
  const row = document.querySelector('.agent-pool-row');
  assert.match(row.textContent, /[0-9]s$/);
  assert.doesNotMatch(row.textContent, /7h/);
});

test('an agent blocked on a user approval reads as needing the user, not working', async (t) => {
  const { root, document, publishPool } = mount(t);
  await act(async () => root.render(React.createElement(ComposerDock, dockProps())));
  await publishPool([
    poolAgent('run-a'),
    poolAgent('ask-b', {
      agent: 'reviewer',
      stage: 'tool_running',
      startedAt: Date.now() - 65_000,
      awaitingUser: 'approval',
    }),
  ]);
  const segment = document.querySelector('.composer-island-seg-agents');
  // Counted apart from the running total, so it is never hidden in it.
  assert.match(segment.textContent, new RegExp(`^2 agents.*${translate('Needs you {{needs}}', { needs: 1 })}`));
  // Glyph + count survive a narrow island (only the words hide there).
  const needs = segment.querySelector('.composer-island-seg-state .composer-island-attention')?.parentElement;
  assert.ok(needs);
  assert.equal(needs.querySelector('.composer-island-seg-num').dataset.count, '1');
  assert.ok(needs.querySelector('.composer-island-seg-word'));
  await act(async () => segment.click());
  // Same order as the Agents window (spawn order), not re-ranked by state.
  const rows = [...document.querySelectorAll('.agent-pool-row')];
  assert.equal(rows.length, 2);
  assert.equal(rows[0].querySelector('.agent-activity-elapsed').dataset.state, 'running');
  assert.match(rows[0].querySelector('.agent-activity-elapsed').textContent, /\d/);
  assert.match(rows[1].textContent, /ask-b/);
  assert.equal(rows[1].querySelector('.agent-activity-elapsed').textContent, translate('Waiting for approval'));
});

test('idle, finished and cancelled agents drop out; waiting parents stay; the Lead row is not listed', async (t) => {
  const { root, document, publishPool } = mount(t);
  await act(async () => root.render(React.createElement(ComposerDock, dockProps())));
  await publishPool([
    poolAgent('island-session', { agent: 'lead', sessionId: 'island-session', ownerSessionId: 'island-session' }),
    poolAgent('idle-a', { sessionId: 's-idle', stage: 'idle', status: 'idle' }),
    poolAgent('done-b', { sessionId: 's-done', stage: 'done', status: 'done' }),
    poolAgent('stop-c', { sessionId: 's-stop', stage: 'cancelled', status: 'cancelled' }),
    poolAgent('parent-d', { sessionId: 's-parent', stage: 'idle', status: 'idle' }),
    poolAgent('child-e', { sessionId: 's-child', parentSessionId: 's-parent' }),
  ]);
  assert.equal(document.querySelector('.composer-island-seg-agents').textContent.slice(0, 8), '2 agents');
  await act(async () => document.querySelector('.composer-island-seg-agents').click());
  const rows = [...document.querySelectorAll('.agent-pool-row')];
  assert.deepEqual(
    rows.map((row) => row.dataset.agentTag),
    ['parent-d', 'child-e']
  );
  assert.equal(rows[0].querySelector('.agent-activity-elapsed').dataset.state, 'waiting');
  assert.equal(
    document.querySelector('.composer-island-tab').textContent.includes(translate('Shell {{shell}}', { shell: 0 })),
    false
  );
});

test('a working agent stays listed through a transient idle/done phase and an unprovable lease, until it is idle', async (t) => {
  const { root, document, publishPool } = mount(t);
  await act(async () => root.render(React.createElement(ComposerDock, dockProps())));
  const lead = poolAgent('island-session', {
    agent: 'lead',
    sessionId: 'island-session',
    ownerSessionId: 'island-session',
    stage: 'idle',
    status: 'idle',
  });
  // The progress sweep copies the live runtime phase into the worker row: between
  // turns/steps that phase reads idle/done/error while the worker is still running.
  await publishPool([
    lead,
    poolAgent('between-a', { sessionId: 's-a', status: 'running', stage: 'idle' }),
    poolAgent('between-b', { sessionId: 's-b', status: 'running', stage: 'done' }),
    poolAgent('between-c', { sessionId: 's-c', status: 'running', stage: 'error' }),
    poolAgent('lease-d', { sessionId: 's-d', status: 'unknown', stage: 'unknown' }),
    poolAgent('settled-e', { sessionId: 's-e', status: 'idle', stage: 'idle' }),
  ]);
  assert.equal(document.querySelector('.composer-island-seg-agents').textContent.slice(0, 8), '4 agents');
  await act(async () => document.querySelector('.composer-island-seg-agents').click());
  assert.deepEqual(
    [...document.querySelectorAll('.agent-pool-row')].map((row) => row.dataset.agentTag),
    ['between-a', 'between-b', 'between-c', 'lease-d']
  );
  // Only an actual idle ends the listing.
  await publishPool([
    lead,
    poolAgent('between-a', { sessionId: 's-a', status: 'idle', stage: 'idle' }),
    poolAgent('between-b', { sessionId: 's-b', status: 'running', stage: 'streaming' }),
  ]);
  assert.deepEqual(
    [...document.querySelectorAll('.agent-pool-row')].map((row) => row.dataset.agentTag),
    ['between-b']
  );
});

test('with no shells there is no shell segment, tab or row anywhere in the island', async (t) => {
  const { root, document, publishPool } = mount(t);
  await publish({ shellJobs: { count: 0, jobs: [], finished: [] } });
  await act(async () => root.render(React.createElement(ComposerDock, dockProps())));
  await publishPool([poolAgent('run-a', { sessionId: 's-run' })]);
  assert.equal(document.querySelector('.composer-island-seg-shell'), null);
  await act(async () => document.querySelector('.composer-island-seg-agents').click());
  assert.equal(document.querySelectorAll('.composer-island-tab').length, 1);
  assert.equal(
    document
      .querySelector('.composer-island-panel')
      .textContent.includes(translate('Island: {{count}} finished shells', { count: 0 })),
    false
  );
  assert.equal(document.querySelector('.composer-island-row'), null);
  assert.equal(
    document.querySelector('.composer-island-seg-agents').getAttribute('title'),
    translate('Agent {{agent}}', { agent: 1 })
  );
});

test('an agent row with a session is a button that opens it and closes the panel; others stay inert', async (t) => {
  const { root, document, publishPool } = mount(t);
  await publish({
    shellJobs: { count: 1, jobs: [{ taskId: 'job-1', command: 'npm test', startedAt: Date.now() - 5_000 }] },
  });
  const opened = [];
  await act(async () =>
    root.render(React.createElement(ComposerDock, dockProps({ onOpenAgentSession: (...args) => opened.push(args) })))
  );
  await publishPool([
    poolAgent('ask-b', {
      agent: 'reviewer',
      sessionId: 'child-1',
      stage: 'tool_running',
      startedAt: Date.now() - 65_000,
      awaitingUser: 'approval',
    }),
    poolAgent('run-a'),
  ]);
  await act(async () => document.querySelector('.composer-island-seg-agents').click());
  const rows = [...document.querySelectorAll('.agent-pool-row')];
  assert.equal(rows.length, 2);
  // An agent with a session opens it; one without stays disabled.
  assert.equal(rows[0].disabled, false);
  assert.equal(rows[1].disabled, true);
  await act(async () => rows[0].click());
  assert.equal(opened.length, 1);
  assert.equal(opened[0][0], 'child-1');
  assert.equal(opened[0][2], 'island-session');
  assert.equal(document.querySelector('.composer-island-slot').dataset.mode, 'pill', 'panel closed');
  // Shell rows are not openable: their only button is Stop.
  await act(async () => document.querySelector('.composer-island-seg-shell').click());
  assert.equal(document.querySelector('.composer-island-row-open'), null);
  assert.equal(document.querySelector('.composer-island-row button').textContent, translate('Stop'));
});

test('without an open action agent rows stay non-interactive', async (t) => {
  const { root, document, publishPool } = mount(t);
  await act(async () => root.render(React.createElement(ComposerDock, dockProps())));
  await publishPool([poolAgent('run-a', { sessionId: 'child-2' })]);
  await act(async () => document.querySelector('.composer-island-seg-agents').click());
  // Clicking is a no-op without an open action, and the panel stays.
  await act(async () => document.querySelector('.agent-pool-row').click());
  assert.equal(document.querySelector('.composer-island-slot').dataset.mode, 'panel');
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

test('Stop calls stopShellJob once; a refused stop keeps the row running with a retry', async (t) => {
  const { root, document, window } = mount(t);
  const calls = [];
  let result = { stopped: false, error: 'busy' };
  window.mixdogDesktop.stopShellJob = async (...args) => {
    calls.push(args);
    return result;
  };
  await publish({
    shellJobs: {
      count: 1,
      jobs: [{ taskId: 'j1', command: 'npm test', cwd: '/work/cart-service', startedAt: Date.now() - 5_000 }],
    },
  });
  await act(async () => root.render(React.createElement(ComposerDock, dockProps())));
  await act(async () => document.querySelector('.composer-island-seg-shell').click());
  assert.equal(document.querySelector('.composer-island-row small').textContent, 'cart-service');
  await act(async () => document.querySelector('.composer-island-row button').click());
  assert.deepEqual(calls, [['island-session', 'j1']]);
  assert.equal(document.querySelector('.composer-island-row-error').textContent, translate("Island: Couldn't stop"));
  assert.equal(document.querySelector('.composer-island-row .agent-activity-elapsed').dataset.state, 'running');
  const retry = document.querySelector('.composer-island-row button');
  assert.equal(retry.textContent, translate('Retry'));
  result = { stopped: true };
  await act(async () => retry.click());
  assert.equal(calls.length, 2);
  assert.equal(document.querySelector('.composer-island-row-error'), null);
  const button = document.querySelector('.composer-island-row button');
  assert.equal(button.textContent, translate('Island: Stopping…'));
  assert.equal(button.disabled, true);
  // The status feed lists it as finished (cancelled): Stopped + Dismiss.
  await publish({
    shellJobs: {
      count: 0,
      jobs: [],
      finished: [{ taskId: 'j1', command: 'npm test', status: 'cancelled', exitCode: 1, startedAt: 1, finishedAt: 2 }],
    },
  });
  assert.equal(
    document.querySelector('.composer-island-row .agent-activity-elapsed').textContent,
    translate('Island: Stopped')
  );
  assert.equal(document.querySelector('.composer-island-row button').textContent, translate('Dismiss'));
});

test('the agent and shell segments expand the island panel inline', async (t) => {
  const { root, document, publishPool } = mount(t);
  await publish({
    shellJobs: { count: 1, jobs: [{ taskId: 'j1', command: 'npm test', startedAt: Date.now() - 5_000 }] },
  });
  await act(async () => root.render(React.createElement(ComposerDock, dockProps())));
  await publishPool([poolAgent('a')]);
  await act(async () => document.querySelector('.composer-island-seg-agents').click());
  assert.equal(document.querySelector('.composer-island-slot').dataset.mode, 'panel');
  assert.ok(document.querySelector('.composer-island-jobs .agent-pool-name'));
  await act(async () => document.querySelector('.composer-island-seg-shell').click());
  assert.equal(document.querySelector('.composer-island-jobs .composer-island-shell-command').textContent, 'npm test');
});

test('content shown by a child-only update holds the island slot open after it leaves', async (t) => {
  const { root, document } = mount(t);
  const { ComposerIsland } = await import('./ComposerIsland.tsx');
  // The files segment renders from its own async read: the island itself
  // never re-renders when it appears or disappears.
  const control = { show: () => {} };
  function LateFiles() {
    const [shown, setShown] = React.useState(false);
    control.show = setShown;
    return shown ? React.createElement('button', { type: 'button', className: 'composer-island-seg' }, '1 file') : null;
  }
  let islandRenders = 0;
  function CountedIsland(props) {
    islandRenders += 1;
    return React.createElement(ComposerIsland, props);
  }
  await act(async () =>
    root.render(
      React.createElement(CountedIsland, { sessionId: 'island-session', files: React.createElement(LateFiles) })
    )
  );
  const slot = document.querySelector('.composer-island-slot');
  const rendersBefore = islandRenders;
  assert.equal(slot.dataset.held, undefined, 'an empty slot is not held yet');
  await act(async () => control.show(true));
  await act(async () => control.show(false));
  assert.equal(islandRenders, rendersBefore, 'only the child re-rendered');
  assert.equal(document.querySelector('.composer-island-seg'), null);
  assert.equal(slot.dataset.held, 'true', 'the slot stays open instead of collapsing under the transcript');
});

test('content added and removed before the observer runs still holds the slot', async (t) => {
  const { root, document } = mount(t);
  const { ComposerIsland } = await import('./ComposerIsland.tsx');
  await act(async () => root.render(React.createElement(ComposerIsland, { sessionId: 'island-session' })));
  const slot = document.querySelector('.composer-island-slot');
  const pill = slot.querySelector('.composer-island-pill');
  const segment = document.createElement('span');
  segment.className = 'composer-island-seg';
  pill.append(segment);
  segment.remove();
  await act(async () => {});
  assert.equal(slot.dataset.held, 'true');
});

test('the shared poll runs once for all subscribers, pauses while hidden and refreshes on becoming visible', async (t) => {
  const { subscribeSharedPoll } = await import('./shared-pool-poll.ts');
  const saved = { window: globalThis.window, document: globalThis.document };
  const doc = Object.assign(new EventTarget(), { hidden: false });
  const timers = new Map();
  let nextTimer = 1;
  globalThis.document = doc;
  globalThis.window = {
    setInterval: (fn) => {
      timers.set(nextTimer, fn);
      return nextTimer++;
    },
    clearInterval: (id) => timers.delete(id),
  };
  t.after(() => {
    globalThis.window = saved.window;
    globalThis.document = saved.document;
  });
  let refreshes = 0;
  const key = {};
  const refresh = () => void refreshes++;
  const off1 = subscribeSharedPoll(key, refresh, 2000);
  const off2 = subscribeSharedPoll(key, refresh, 2000);
  assert.equal(timers.size, 1, 'two islands share one interval');
  doc.hidden = true;
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(timers.size, 0, 'hidden pauses the poll');
  doc.hidden = false;
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(refreshes, 1, 'becoming visible refreshes at once');
  assert.equal(timers.size, 1);
  off1();
  assert.equal(timers.size, 1, 'poll stays while a subscriber remains');
  off2();
  assert.equal(timers.size, 0);
});

test('the files segment opens a menu: View changes opens Changes, Delete history confirms first', async (t) => {
  const { root, document, window } = mount(t);
  window.mixdogDesktop.setTitleBarDimmed = () => {};
  await import('./TurnReview');
  const calls = [];
  let cleared = false;
  let refuse = '';
  window.mixdogDesktop.invokeCapability = async (request) => {
    calls.push(request);
    if (request.capability === 'clearSessionChangeHistory') {
      if (refuse) throw new Error(refuse);
      cleared = true;
      return { value: { turns: 12 } };
    }
    if (request.capability !== 'getSessionReviewDiff') return { value: { supported: true, files: [], patch: '' } };
    const files = cleared ? [] : [{ path: 'a.ts', status: 'M', additions: 3, deletions: 1 }];
    return {
      value: {
        supported: true,
        authoritative: true,
        complete: true,
        patch: '',
        files,
        uncommittedFiles: files,
        historyTurns: cleared ? 0 : 12,
      },
    };
  };
  let opened = 0;
  await act(async () =>
    root.render(
      React.createElement(
        ComposerDock,
        dockProps({ reviewSessionId: 'island-files', reviewCwd: 'C:/work', onOpenSessionDiff: () => opened++ })
      )
    )
  );
  const segment = () => document.querySelector('.turn-review-segment');
  const menu = () => document.querySelector('.turn-review-files-menu');
  const items = () => [...(menu()?.querySelectorAll('[role="menuitem"]') ?? [])];
  const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  await flush();
  assert.ok(segment(), 'the session has uncommitted files');
  assert.equal(segment().getAttribute('aria-haspopup'), 'menu');

  // Click opens the menu (no Changes yet): View changes, a separator, Delete history.
  await act(async () => segment().click());
  await flush();
  assert.equal(opened, 0);
  assert.equal(segment().getAttribute('aria-expanded'), 'true');
  // Like the island's other tabs it expands the island upward in place: an
  // island panel inside the island, not a popup portaled under it.
  const island = document.querySelector('.composer-island');
  assert.equal(island.dataset.expanded, 'files-menu');
  assert.equal(island.dataset.mode, 'panel');
  assert.ok(island.contains(menu()));
  assert.ok(menu().closest('.composer-island-panel'));
  assert.deepEqual(
    items().map((item) => item.textContent),
    ['View changes', 'Delete history']
  );
  assert.equal(menu().children[1].getAttribute('role'), 'separator');
  assert.ok(items()[1].classList.contains('danger'));
  assert.equal(document.activeElement, items()[0], 'keyboard focus lands on the first item');
  await act(async () =>
    menu().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  );
  assert.equal(document.activeElement, items()[1]);
  await act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' })));
  assert.equal(menu(), null, 'Escape closes the menu');
  assert.equal(island.dataset.expanded, undefined);
  assert.equal(document.activeElement, segment(), 'focus returns to the segment');

  // View changes does what the click used to do.
  await act(async () => segment().click());
  await act(async () => items()[0].click());
  assert.equal(opened, 1);
  assert.equal(menu(), null);

  // Delete history asks first, with Cancel focused; Cancel changes nothing.
  await act(async () => segment().click());
  await act(async () => items()[1].click());
  const dialog = () => document.querySelector('.settings-confirm-dialog');
  assert.equal(dialog().querySelector('h3').textContent, "Delete this session's change history?");
  assert.equal(
    dialog().querySelector('p').textContent,
    'Retained changes and Undo/Reapply for 12 turns will be permanently removed. Current files, conversation and Git history stay unchanged.'
  );
  const buttons = () => [...dialog().querySelectorAll('footer button')];
  assert.deepEqual(
    buttons().map((button) => button.textContent),
    ['Cancel', 'Delete history']
  );
  assert.equal(document.activeElement, buttons()[0], 'Cancel is the default');
  assert.equal(dialog().getAttribute('aria-modal'), 'true');
  // A real modal: Tab and Shift+Tab cycle inside it.
  const controls = () => [...dialog().querySelectorAll('button')];
  const tab = (shiftKey = false) =>
    act(async () =>
      document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true }))
    );
  const [closeButton, , deleteButton] = controls();
  await tab();
  assert.equal(document.activeElement, deleteButton);
  await tab();
  assert.equal(document.activeElement, closeButton, 'Tab wraps inside the dialog');
  await tab(true);
  assert.equal(document.activeElement, deleteButton, 'Shift+Tab wraps back');
  // Escape cancels and focus returns to the Files segment.
  await act(async () => document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(dialog(), null);
  assert.equal(document.activeElement, segment());
  // So does Cancel.
  await act(async () => segment().click());
  await act(async () => items()[1].click());
  await act(async () => buttons()[0].click());
  assert.equal(dialog(), null);
  assert.equal(document.activeElement, segment());
  assert.equal(calls.filter((call) => call.capability === 'clearSessionChangeHistory').length, 0);

  // A refusal (a running turn) shows its reason in the reopened menu.
  refuse = 'Change history cannot be deleted while this session is running a turn';
  await act(async () => segment().click());
  await act(async () => items()[1].click());
  await act(async () => buttons()[1].click());
  await flush();
  assert.match(menu().querySelector('.error-notice').textContent, /while a response is running/);
  assert.ok(segment(), 'nothing was deleted');
  await act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' })));

  // Confirming deletes this session's history and the segment leaves.
  refuse = '';
  await act(async () => segment().click());
  await act(async () => items()[1].click());
  await act(async () => buttons()[1].click());
  await flush();
  const clears = calls.filter((call) => call.capability === 'clearSessionChangeHistory');
  assert.deepEqual(
    clears.map((call) => [call.sessionId, call.args]),
    [
      ['island-files', []],
      ['island-files', []],
    ]
  );
  assert.equal(segment(), null, 'an empty history hides the segment');
});

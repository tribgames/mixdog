import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
const { overrideConfirmAction } = await import('./app-confirm.tsx');

// Transitive component imports load react-dom before mount() runs. Give its
// one-time event-support detection a DOM; each test still owns a fresh window.
const { restore: restoreBootstrapDom } = installTestDom(null);
after(restoreBootstrapDom);
const [
  { ComposerDock },
  { clearBranchSegmentCache },
  { defaultSessionLaneStore },
  { pendingSessionDiffFileRequest },
  { t: translate },
  { parseIslandGitRequestText },
] = await Promise.all([
  import('./ComposerDock.tsx'),
  import('./WorktreeIslandSegment.tsx'),
  import('./session-lane-store.ts'),
  import('./session-diff-focus.ts'),
  import('./i18n.ts'),
  import('./island-git-request.ts'),
]);

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
  dom.window.requestAnimationFrame = (callback) => dom.window.setTimeout(() => callback(Date.now()), 16);
  dom.window.cancelAnimationFrame = (id) => dom.window.clearTimeout(id);
  // The island lists agents from the same pool feed as the Agents window.
  let pushPool = () => {};
  let poolRows = [];
  dom.window.mixdogDesktop = {
    listAgentPool: async () => poolRows,
    subscribeAgentPool: (listener) => {
      pushPool = listener;
    },
  };
  // The branch segment remembers each session's last workspace and menu.
  clearBranchSegmentCache();
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

/** Resolves once the document satisfies the predicate (checked now and on every DOM change). */
const untilDom = (document, ready) =>
  new Promise((resolve) => {
    if (ready()) return resolve();
    const observer = new document.defaultView.MutationObserver(() => {
      if (!ready()) return;
      observer.disconnect();
      resolve();
    });
    observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  });

const publish = (snapshot) =>
  act(async () => {
    defaultSessionLaneStore.apply({
      sessionId: 'island-session',
      snapshot: { sessionId: 'island-session', ...snapshot },
    });
  });

test('text input focus and blur do not raise browser event errors', async (t) => {
  const { root, document, window } = mount(t);
  const errors = [];
  window.addEventListener('error', (event) => errors.push(event.message));
  await act(async () =>
    root.render(
      React.createElement(
        ComposerDock,
        dockProps({
          children: React.createElement('input', { onChange() {} }),
        })
      )
    )
  );
  const input = document.querySelector('input');
  await act(async () => input.focus());
  assert.equal(document.activeElement, input);
  await act(async () => input.blur());
  assert.notEqual(document.activeElement, input);
  assert.deepEqual(errors, []);
});

test('a draft keeps its context bar; a session mounts the island slot even when empty', async (t) => {
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
  // Order: the slot sits right above the input; no tray between them.
  const children = [...document.querySelector('.composer-region').children].map((node) => node.className);
  assert.deepEqual(children, ['composer-island-slot', 'composer']);
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
  assert.equal(segments().agents.textContent, '2 agentsRunning 2');
  assert.equal(segments().shell, null);
  await publishPool([agent('a')]);
  assert.equal(segments().agents.textContent, '1 agentRunning 1');
  await publishPool([]);
  await publish({ shellJobs: shells(2) });
  assert.equal(segments().shell.textContent, '2 shells');
  assert.equal(segments().agents, null);
  await publishPool([agent('a'), agent('b')]);
  const { agents, shell } = segments();
  assert.equal(agents.textContent, '2 agentsRunning 2');
  assert.equal(shell.textContent, '2 shells');
  // Narrow keeps both: each carries its glyph and the bare count; the container
  // query only drops the words.
  for (const [seg, count] of [
    [agents, '2'],
    [shell, '2'],
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
    poolAgent('run-a', { turnStartedAt: new Date(Date.now() - 5_000).toISOString() }),
    poolAgent('ask-b', {
      agent: 'reviewer',
      stage: 'tool_running',
      startedAt: Date.now() - 65_000,
      awaitingUser: 'approval',
    }),
  ]);
  const segment = document.querySelector('.composer-island-seg-agents');
  // The pill counts only running agents; the blocked one is not running.
  assert.equal(segment.textContent, '2 agentsRunning 1');
  assert.equal(segment.querySelector('.composer-island-seg-state[data-kind="needs-user"]'), null);
  await act(async () => segment.click());
  // Same order as the Agents window (spawn order), not re-ranked by state.
  const rows = [...document.querySelectorAll('.agent-pool-row')];
  assert.equal(rows.length, 2);
  assert.equal(rows[0].querySelector('.agent-activity-elapsed').dataset.state, 'running');
  assert.match(rows[0].querySelector('.agent-activity-elapsed').textContent, /\d/);
  assert.match(rows[1].textContent, /ask-b/);
  assert.equal(rows[1].querySelector('.agent-activity-elapsed').textContent, translate('Waiting for approval'));
});

test('finished agents stay counted and listed after the active ones; the Lead row is not listed', async (t) => {
  const { root, document, publishPool } = mount(t);
  await act(async () => root.render(React.createElement(ComposerDock, dockProps())));
  const segment = () => document.querySelector('.composer-island-seg-agents');
  await publishPool([
    poolAgent('island-session', { agent: 'lead', sessionId: 'island-session', ownerSessionId: 'island-session' }),
    poolAgent('idle-a', { sessionId: 's-idle', stage: 'idle', status: 'idle' }),
    poolAgent('done-b', { sessionId: 's-done', stage: 'done', status: 'done' }),
    poolAgent('stop-c', { sessionId: 's-stop', stage: 'cancelled', status: 'cancelled' }),
    poolAgent('parent-d', { sessionId: 's-parent', stage: 'idle', status: 'idle' }),
    poolAgent('child-e', { sessionId: 's-child', parentSessionId: 's-parent' }),
  ]);
  // The total, finished included; the parent waiting on its child is still at
  // work, so both count as running.
  assert.equal(segment().textContent, '5 agentsRunning 2');
  assert.ok(segment().querySelector('svg.composer-island-seg-icon'));
  assert.ok(segment().querySelector('.composer-island-pulse'));
  await act(async () => segment().click());
  const rows = [...document.querySelectorAll('.agent-pool-row')];
  // The active subtree (parent waiting on its running child) leads, whole and indented.
  assert.deepEqual(
    rows.map((row) => row.dataset.agentTag),
    ['parent-d', 'child-e', 'idle-a', 'done-b', 'stop-c']
  );
  assert.equal(rows[1].dataset.agentDepth, String(Number(rows[0].dataset.agentDepth) + 1));
  assert.equal(rows[0].querySelector('.agent-activity-elapsed').dataset.state, 'waiting');
  assert.equal(rows[4].querySelector('.agent-activity-elapsed').dataset.state, 'cancelled');
  // Everything finished: the same total with the idle mark, no pulse.
  await publishPool([
    poolAgent('idle-a', { sessionId: 's-idle', stage: 'idle', status: 'idle' }),
    poolAgent('done-b', { sessionId: 's-done', stage: 'done', status: 'done' }),
  ]);
  assert.equal(segment().textContent, '2 agents');
  assert.equal(segment().querySelector('.composer-island-pulse'), null);
  assert.ok(segment().querySelector('.composer-island-dot-idle'));
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
  assert.equal(document.querySelector('.composer-island-seg-agents').textContent, '5 agentsRunning 3');
  await act(async () => document.querySelector('.composer-island-seg-agents').click());
  assert.deepEqual(
    [...document.querySelectorAll('.agent-pool-row')].map((row) => row.dataset.agentTag),
    ['between-a', 'between-b', 'between-c', 'lease-d', 'settled-e']
  );
  // Only an actual idle moves a row below the active ones.
  await publishPool([
    lead,
    poolAgent('between-a', { sessionId: 's-a', status: 'idle', stage: 'idle' }),
    poolAgent('between-b', { sessionId: 's-b', status: 'running', stage: 'streaming' }),
  ]);
  assert.deepEqual(
    [...document.querySelectorAll('.agent-pool-row')].map((row) => row.dataset.agentTag),
    ['between-b', 'between-a']
  );
});

test('the shell segment counts running shells only; finished ones leave a muted label, then nothing', async (t) => {
  const { root, document } = mount(t);
  const job = (id) => ({ taskId: id, command: 'npm test', startedAt: Date.now() - 5_000 });
  // Failed rows stay until dismissed (a clean exit would dismiss itself).
  const failed = (id) => ({
    taskId: id,
    command: 'npm test',
    status: 'failed',
    exitCode: 1,
    startedAt: 1,
    finishedAt: 2,
  });
  await publish({ shellJobs: { count: 1, jobs: [job('count-a')], finished: [failed('count-b')] } });
  await act(async () => root.render(React.createElement(ComposerDock, dockProps())));
  const seg = () => document.querySelector('.composer-island-seg-shell');
  assert.equal(seg().textContent, translate('Island: {{count}} shells', { count: 1 }));
  assert.equal(seg().getAttribute('title'), translate('Shell {{shell}}', { shell: 1 }));
  assert.ok(seg().querySelector('.composer-island-mark-slot .composer-island-pulse'));
  await publish({ shellJobs: { count: 0, jobs: [], finished: [failed('count-a'), failed('count-b')] } });
  assert.equal(seg().textContent, translate('Shell'), 'the label alone, no number');
  assert.equal(seg().querySelector('.composer-island-seg-num'), null);
  assert.equal(seg().dataset.finished, 'true', 'muted');
  assert.equal(seg().querySelector('.composer-island-pulse'), null);
  await publish({ shellJobs: { count: 0, jobs: [], finished: [] } });
  // Lane publications coalesce per animation frame.
  await act(() => sleep(40));
  assert.equal(seg(), null);
});

test('a clean exit leaves after 60s, a failed one stays; Close all dismisses every finished row', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 5_000_000 });
  const { root, document } = mount(t);
  const now = Date.now();
  const finished = (id, exitCode, status) => ({
    taskId: id,
    command: `run ${id}`,
    status,
    exitCode,
    startedAt: now - 10_000,
    finishedAt: now,
  });
  await act(async () => root.render(React.createElement(ComposerDock, dockProps())));
  await publish({
    shellJobs: {
      count: 1,
      jobs: [{ taskId: 'auto-run', command: 'npm run dev', cwd: '/w/app', startedAt: now - 1_000 }],
      finished: [finished('auto-ok', 0, 'completed'), finished('auto-fail', 2, 'failed')],
    },
  });
  await act(async () => document.querySelector('.composer-island-seg-shell').click());
  const status = () =>
    [...document.querySelectorAll('.composer-island-row')].map((row) => [
      row.querySelector('.composer-island-shell-command').textContent,
      row.querySelector('.agent-activity-elapsed').textContent,
    ]);
  const [running, ...ended] = status();
  // A running row shows its clock in the right column, like an agent row.
  assert.equal(running[0], 'npm run dev');
  assert.match(running[1], /^\d+s$/);
  assert.deepEqual(ended, [
    ['run auto-ok', translate('Island: Exited')],
    ['run auto-fail', translate('Failed')],
  ]);
  assert.equal(document.querySelector('.composer-island-row small').textContent, 'app');
  const head = () => document.querySelector('.composer-island-phead');
  assert.equal(head().querySelector('.composer-island-tab').textContent, translate('Shell {{shell}}', { shell: 1 }));
  assert.equal(
    head().querySelector('.composer-island-phead-meta').textContent,
    translate('Island: Ended {{count}}', { count: 2 })
  );
  await act(async () => t.mock.timers.tick(59_000));
  assert.equal(status().length, 3, 'still listed before the minute is over');
  await act(async () => t.mock.timers.tick(1_100));
  assert.deepEqual(
    status().map(([command]) => command),
    ['npm run dev', 'run auto-fail'],
    'only the clean exit left on its own'
  );
  const closeAll = head().querySelector('.composer-island-phead-action');
  assert.equal(closeAll.textContent, translate('Island: Close all'));
  await act(async () => closeAll.click());
  assert.deepEqual(
    status().map(([command]) => command),
    ['npm run dev'],
    'every finished row dismissed; the running one stays'
  );
  assert.equal(head().querySelector('.composer-island-phead-action'), null);
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
    document.querySelector('.composer-island-panel').textContent.includes(translate('Shell {{shell}}', { shell: 0 })),
    false
  );
  assert.equal(document.querySelector('.composer-island-row'), null);
  assert.equal(
    document.querySelector('.composer-island-seg-agents').getAttribute('title'),
    `${translate('Agent {{agent}}', { agent: 1 })} · ${translate('Island: Running')} 1`
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

test('a shell whose termination is unconfirmed reads so and is released only after confirmation', async (t) => {
  const { root, document, window } = mount(t);
  const releases = [];
  const stops = [];
  window.mixdogDesktop.releaseShellJob = async (...args) => {
    releases.push(args);
    return { released: true };
  };
  window.mixdogDesktop.stopShellJob = async (...args) => {
    stops.push(args);
    return { stopped: true };
  };
  let confirmAnswer = false;
  const prompts = [];
  overrideConfirmAction((message) => {
    prompts.push(message);
    return confirmAnswer;
  });
  await publish({
    shellJobs: {
      count: 1,
      jobs: [
        {
          taskId: 'job_held',
          command: 'node server.js',
          cwd: '/work/cart-service',
          startedAt: Date.now() - 5_000,
          terminationUnconfirmed: true,
        },
      ],
    },
  });
  await act(async () => root.render(React.createElement(ComposerDock, dockProps())));
  await act(async () => document.querySelector('.composer-island-seg-shell').click());
  const status = document.querySelector('.composer-island-row .agent-activity-elapsed');
  assert.equal(status.dataset.state, 'unconfirmed');
  assert.equal(status.textContent, translate('Termination unconfirmed'));
  const button = document.querySelector('.composer-island-row button');
  assert.equal(button.textContent, translate('Release anyway'));
  // Declining the confirmation releases nothing.
  await act(async () => button.click());
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /node server\.js/);
  assert.deepEqual(releases, []);
  confirmAnswer = true;
  await act(async () => document.querySelector('.composer-island-row button').click());
  assert.deepEqual(releases, [['island-session', 'job_held']]);
  assert.deepEqual(stops, [], 'a held shell is released, never re-stopped');
  assert.equal(document.querySelector('.composer-island-row button').textContent, translate('Releasing…'));
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
  assert.match(document.querySelector('.composer-island-row .agent-activity-elapsed').textContent, /^\d+s$/);
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

test('a stop that ends termination-unconfirmed offers release, and the release works', async (t) => {
  const { root, document, window } = mount(t);
  const stops = [];
  const releases = [];
  window.mixdogDesktop.stopShellJob = async (...args) => {
    stops.push(args);
    return { stopped: true };
  };
  window.mixdogDesktop.releaseShellJob = async (...args) => {
    releases.push(args);
    return { released: true };
  };
  overrideConfirmAction(() => true);
  const job = { taskId: 'j9', command: 'npm run dev', cwd: '/work/cart-service', startedAt: Date.now() - 5_000 };
  await publish({ shellJobs: { count: 1, jobs: [job] } });
  await act(async () => root.render(React.createElement(ComposerDock, dockProps())));
  await act(async () => document.querySelector('.composer-island-seg-shell').click());
  await act(async () => document.querySelector('.composer-island-row button').click());
  assert.deepEqual(stops, [['island-session', 'j9']]);
  const stopping = document.querySelector('.composer-island-row button');
  assert.equal(stopping.textContent, translate('Island: Stopping…'));
  assert.equal(stopping.disabled, true);
  // The host later reports the kill unconfirmed: the stop state is moot.
  await publish({ shellJobs: { count: 1, jobs: [{ ...job, terminationUnconfirmed: true }] } });
  await untilDom(document, () => document.querySelector('.composer-island-row button')?.textContent === translate('Release anyway'));
  const release = document.querySelector('.composer-island-row button');
  assert.equal(release.textContent, translate('Release anyway'));
  assert.equal(release.disabled, false);
  await act(async () => release.click());
  assert.deepEqual(releases, [['island-session', 'j9']]);
  assert.equal(stops.length, 1, 'release is not a second stop');
  assert.equal(document.querySelector('.composer-island-row button').textContent, translate('Releasing…'));
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

test('each segment opens its own panel: a title chip and a close button, no tab switcher', async (t) => {
  const { root, document, window, publishPool } = mount(t);
  await publish({
    shellJobs: { count: 1, jobs: [{ taskId: 'j1', command: 'npm test', startedAt: Date.now() - 5_000 }] },
  });
  await act(async () => root.render(React.createElement(ComposerDock, dockProps())));
  await publishPool([poolAgent('a', { sessionId: 's-a' }), poolAgent('b', { sessionId: 's-b' })]);
  const panel = () => document.querySelector('.composer-island-panel');
  const island = () => document.querySelector('.composer-island');
  const agentsSeg = () => document.querySelector('.composer-island-seg-agents');
  const shellSeg = () => document.querySelector('.composer-island-seg-shell');

  await act(async () => agentsSeg().click());
  assert.equal(island().dataset.expanded, 'agents');
  assert.equal(agentsSeg().getAttribute('aria-expanded'), 'true');
  assert.equal(shellSeg().getAttribute('aria-expanded'), 'false');
  // One chip, not a button: nothing to switch to.
  assert.equal(panel().querySelectorAll('.composer-island-tab').length, 1);
  assert.equal(panel().querySelector('button.composer-island-tab'), null);
  assert.equal(panel().querySelector('.composer-island-tab').textContent, translate('Agent {{agent}}', { agent: 2 }));
  assert.ok(panel().querySelector('.composer-island-tab .composer-island-pulse'));
  assert.ok(panel().querySelector('.composer-island-close'));
  assert.equal(panel().querySelectorAll('.agent-pool-row').length, 2);
  assert.equal(panel().querySelector('.composer-island-shell-command'), null, 'no shell row in the agents panel');
  assert.ok(panel().querySelector('.composer-island-phead .composer-island-phead-meta'));
  await act(async () => panel().querySelector('.composer-island-close').click());
  assert.equal(document.querySelector('.composer-island-slot').dataset.mode, 'pill');

  await act(async () => shellSeg().click());
  assert.equal(island().dataset.expanded, 'shells');
  assert.equal(panel().querySelector('button.composer-island-tab'), null);
  assert.equal(panel().querySelector('.composer-island-tab').textContent, translate('Shell {{shell}}', { shell: 1 }));
  assert.equal(panel().querySelectorAll('.agent-pool-row').length, 0, 'no agent row in the shells panel');
  assert.equal(panel().querySelector('.composer-island-summary'), null);
  assert.equal(panel().querySelector('.composer-island-phead-meta'), null);
  assert.equal(panel().querySelector('.composer-island-shell-command').textContent, 'npm test');
  // The same segment toggles its panel shut; Escape closes too.
  await act(async () => shellSeg().click());
  assert.equal(document.querySelector('.composer-island-slot').dataset.mode, 'pill');
  await act(async () => shellSeg().click());
  await act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' })));
  assert.equal(document.querySelector('.composer-island-slot').dataset.mode, 'pill');
  // A panel whose rows all go away closes; it never falls back to the other kind.
  await act(async () => agentsSeg().click());
  await publishPool([]);
  assert.equal(document.querySelector('.composer-island-slot').dataset.mode, 'pill');
  assert.equal(island().dataset.expanded, undefined);
});

/** A getSessionUsage answer in the ledger's terms. */
const ledgerUsage = (
  tokens,
  { cacheRead = 0, input = tokens - cacheRead, costUsd = 0, unpriced = 0, unmeasured = 0 } = {}
) => ({
  turns: 2,
  input,
  output: 0,
  cacheRead,
  cacheWrite: 0,
  tokens,
  unmeasuredTurns: unmeasured,
  costUsd,
  costKnownTurns: 2 - unpriced,
  costUnpricedTurns: unpriced,
});

async function usagePanel(t, answer) {
  const { root, document, window, publishPool } = mount(t);
  const reads = [];
  let onRead = null;
  const read = new Promise((resolve) => {
    onRead = resolve;
  });
  window.mixdogDesktop.invokeCapability = async (request) => {
    if (request.capability !== 'getSessionUsage') return { value: null };
    reads.push(request);
    onRead?.();
    return { value: answer };
  };
  await act(async () => root.render(React.createElement(ComposerDock, dockProps())));
  await publishPool([
    poolAgent('run-a', { sessionId: 's-a' }),
    poolAgent('done-b', { sessionId: 's-b', stage: 'done', status: 'done' }),
    poolAgent('ask-c', { sessionId: 's-c', awaitingUser: 'approval' }),
  ]);
  await act(async () => {
    document.querySelector('.composer-island-seg-agents').click();
    await read;
  });
  const summary = document.querySelector('.composer-island-summary');
  const meta = [...(document.querySelector('.composer-island-phead-meta')?.children ?? [])].map(
    (part) => part.textContent
  );
  const rowTokens = Object.fromEntries(
    [...document.querySelectorAll('.composer-island-agent-item')].map((item) => [
      item.querySelector('.agent-pool-row').dataset.agentTag,
      item.querySelector('.composer-island-agent-tokens')?.textContent ?? null,
    ])
  );
  return { reads, summary, meta, rowTokens, document };
}

// The header counts by state, as the rows read: one running, one blocked on
// approval, and the finished worker idles (waiting for its next message).
const usagePanelMeta = () => [
  `${translate('Island: Running')} 1`,
  translate('Needs you {{needs}}', { needs: 1 }),
  translate('Island: {{waiting}} waiting', { waiting: 1 }),
];

test('the agents summary shows the session totals with the Lead split out, cache and cost', async (t) => {
  const answer = {
    sessionId: 'island-session',
    ...ledgerUsage(1_000_000, { cacheRead: 800_000, costUsd: 1.5 }),
    // Every agent the Lead ran, the closed ones beyond the listed rows included.
    agents: ledgerUsage(800_000, { cacheRead: 200_000, costUsd: 1 }),
    sessions: {
      's-a': ledgerUsage(300_000, { cacheRead: 100_000, costUsd: 0.5 }),
      's-b': ledgerUsage(200_000, { cacheRead: 100_000, costUsd: 0.25 }),
      's-c': ledgerUsage(0),
    },
  };
  const { reads, summary, meta, rowTokens } = await usagePanel(t, answer);
  // One read: the Lead's session, naming its listed agents.
  assert.equal(reads.length, 1);
  assert.equal(reads[0].capability, 'getSessionUsage');
  assert.equal(reads[0].sessionId, 'island-session');
  assert.deepEqual([...reads[0].args[0].sessionIds].sort(), ['s-a', 's-b', 's-c']);
  assert.equal(reads[0].args[0].agents, true);
  assert.deepEqual(meta, usagePanelMeta());
  // The totals are the footer, below the rows.
  assert.equal(summary.previousElementSibling.classList.contains('composer-island-agents'), true);
  const parts = [...summary.children].map((part) => part.textContent);
  assert.equal(
    parts[0],
    `${translate('Island: Total tokens')} 1.8M (${translate('Lead {{lead}} · Agents {{agents}}', { lead: '1M', agents: '800K' })})`
  );
  // (800k + 200k) / 1.8M
  assert.equal(parts[1], `${translate('Island: Cache hit rate')} 55.6%`);
  assert.equal(parts[2], `${translate('Island: Approx. cost')} $2.50`);
  assert.deepEqual(rowTokens, { 'run-a': '300K', 'ask-c': '0', 'done-b': '200K' });
});

test('an unpriced turn drops only the cost from the agents summary', async (t) => {
  const { summary } = await usagePanel(t, {
    ...ledgerUsage(1_000, { cacheRead: 500, costUsd: 1 }),
    agents: ledgerUsage(300, { unpriced: 1 }),
    sessions: { 's-a': ledgerUsage(100, { unpriced: 1 }), 's-b': ledgerUsage(100), 's-c': ledgerUsage(100) },
  });
  // Unpriced stays "-" (never a $0.00); the exact figures are still shown.
  assert.deepEqual(
    [...summary.children].map((part) => part.textContent),
    [
      `${translate('Island: Total tokens')} 1.3K (${translate('Lead {{lead}} · Agents {{agents}}', { lead: '1K', agents: '300' })})`,
      `${translate('Island: Cache hit rate')} 38.5%`,
      `${translate('Island: Approx. cost')} -`,
    ]
  );
});

// Every figure the footer cannot show reads "-" in its reserved slot (the Lead
// and Agents split included), so the three stats exist from the first render.
const unknownSummary = () => [
  `${translate('Island: Total tokens')} - (${translate('Lead {{lead}} · Agents {{agents}}', { lead: '-', agents: '-' })})`,
  `${translate('Island: Cache hit rate')} -`,
  `${translate('Island: Approx. cost')} -`,
];

test('an unmeasured agent turn drops every combined figure; an unmeasured or missing row drops its own', async (t) => {
  const { summary, meta, rowTokens } = await usagePanel(t, {
    ...ledgerUsage(1_000, { costUsd: 1 }),
    agents: ledgerUsage(200, { unmeasured: 1 }),
    sessions: { 's-a': ledgerUsage(100, { unmeasured: 1 }), 's-b': ledgerUsage(100) },
  });
  // The agents' share is unknown: no total, cache rate or cost: the footer
  // keeps its line empty (so the rows never move when figures arrive); the
  // header counts stay.
  assert.deepEqual(
    [...summary.children].map((part) => part.textContent),
    unknownSummary()
  );
  assert.deepEqual(meta, usagePanelMeta());
  assert.deepEqual(rowTokens, { 'run-a': null, 'ask-c': null, 'done-b': '100' });
});

test('without a usage read the footer holds "-" placeholders and the header counts remain', async (t) => {
  const { summary, meta, rowTokens } = await usagePanel(t, null);
  assert.deepEqual(
    [...summary.children].map((part) => part.textContent),
    unknownSummary()
  );
  assert.deepEqual(meta, usagePanelMeta());
  assert.deepEqual(rowTokens, { 'run-a': null, 'ask-c': null, 'done-b': null });
});

test('the footer is laid out with "-" while getSessionUsage is pending, then filled in place', async (t) => {
  const { root, document, window, publishPool } = mount(t);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let asked;
  const read = new Promise((resolve) => {
    asked = resolve;
  });
  let answered;
  const done = new Promise((resolve) => {
    answered = resolve;
  });
  window.mixdogDesktop.invokeCapability = async (request) => {
    if (request.capability !== 'getSessionUsage') return { value: null };
    asked();
    await gate;
    queueMicrotask(answered);
    return {
      value: {
        ...ledgerUsage(1_000, { cacheRead: 500, costUsd: 1 }),
        agents: ledgerUsage(300, { costUsd: 0.5 }),
        sessions: {},
      },
    };
  };
  await act(async () => root.render(React.createElement(ComposerDock, dockProps())));
  await publishPool([poolAgent('run-a', { sessionId: 's-a' })]);
  await act(async () => {
    document.querySelector('.composer-island-seg-agents').click();
    await read;
  });
  const parts = () => [...document.querySelector('.composer-island-summary').children];
  const shapes = () => parts().map((part) => [part.className, part.dataset.reserve, part.querySelector('b') !== null]);
  const before = shapes();
  assert.deepEqual(
    parts().map((part) => part.textContent),
    unknownSummary()
  );
  assert.equal(before.length, 3);
  await act(async () => {
    release();
    await done;
  });
  assert.deepEqual(shapes(), before, 'same elements and reserved boxes before and after the answer');
  assert.deepEqual(
    parts().map((part) => part.querySelector('b').textContent),
    ['1.3K', '38.5%', '$1.50']
  );
});

test('the usage summary model sums exact sessions only', async () => {
  const { islandUsageSummary, islandUsageSessionIds } = await import('./island-session-usage.ts');
  assert.deepEqual(islandUsageSessionIds(['a', 'bad id', 'a', 'b:c', 'd']), ['a', 'd']);
  const lead = ledgerUsage(100, { cacheRead: 50, costUsd: 0.1 });
  // The agents' figure is the ledger's total of every agent, closed ones
  // included; a listed row shows its own.
  const exact = islandUsageSummary(
    { ...lead, agents: ledgerUsage(80, { costUsd: 0.4 }), sessions: { x: ledgerUsage(50, { costUsd: 0.2 }) } },
    ['x']
  );
  assert.equal(exact.totalTokens, 180);
  assert.equal(exact.leadTokens, 100);
  assert.equal(exact.agentTokens, 80);
  assert.equal(exact.cacheHitRate, 50 / 180);
  assert.ok(Math.abs(exact.costUsd - 0.5) < 1e-9);
  assert.deepEqual([...exact.agentRowTokens], [['x', 50]]);
  // No agents: the Lead alone is the session.
  assert.equal(islandUsageSummary({ ...lead, agents: { ...ledgerUsage(0), turns: 0 } }, []).totalTokens, 100);
  // Without an agents total nothing is combined.
  assert.equal(islandUsageSummary(lead, []).totalTokens, null);
  // An unmeasured Lead keeps the agents' exact share, nothing combined.
  const noLead = islandUsageSummary({ ...ledgerUsage(100, { unmeasured: 1 }), agents: ledgerUsage(50) }, []);
  assert.deepEqual(
    [noLead.totalTokens, noLead.leadTokens, noLead.agentTokens, noLead.cacheHitRate, noLead.costUsd],
    [null, null, 50, null, null]
  );
  // A session with no turns at all has no cost to show.
  const idle = { ...ledgerUsage(0), turns: 0, costKnownTurns: 0 };
  assert.equal(islandUsageSummary({ ...idle, agents: idle }, []).costUsd, null);
  assert.equal(islandUsageSummary(null, []).totalTokens, null);
});

/** The real dock stylesheet decides the slot's box; jsdom has no layout, so
 *  the stage reports the pill row's 46px, or 212px with an approval card. */
/** The app's @property registrations (font-faces.css): --island-slot-height
 *  eases only as a registered length. */
function registeredProperties() {
  const sheet = readFileSync(new URL('./font-faces.css', import.meta.url), 'utf8');
  return `${(sheet.match(/@property[^}]*\}/g) ?? []).join('\n')}\n`;
}

function slotFixture(t, window, document) {
  const style = document.createElement('style');
  style.textContent =
    registeredProperties() + readFileSync(new URL('./desktop/15-composer.css', import.meta.url), 'utf8');
  document.head.append(style);
  const proto = window.HTMLElement.prototype;
  const offsetHeight = Object.getOwnPropertyDescriptor(proto, 'offsetHeight');
  Object.defineProperty(proto, 'offsetHeight', {
    configurable: true,
    get() {
      if (!this.classList.contains('composer-island-stage')) return 0;
      return this.querySelector('.composer-island-approval') ? 212 : 46;
    },
  });
  t.after(() => Object.defineProperty(proto, 'offsetHeight', offsetHeight));
  const slot = () => document.querySelector('.composer-island-slot');
  return {
    slot,
    presence: () => slot().getAttribute('data-presence'),
    display: () => window.getComputedStyle(slot()).display,
    moving: () => slot().hasAttribute('data-motion'),
    // The browser ends the slot's height transition.
    finish: () => {
      const event = new window.Event('transitionend');
      Object.defineProperty(event, 'propertyName', { value: '--island-slot-height' });
      slot().dispatchEvent(event);
    },
  };
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// The dock for one session, with or without a pending approval card.
const renderDock = (root, session, approval) =>
  act(async () =>
    root.render(
      React.createElement(ComposerDock, {
        ...dockProps({ reviewSessionId: session }),
        approval: approval ? React.createElement('article', { className: 'approval-card' }) : null,
      })
    )
  );
// Past the mount's first frame: from here on changes animate.
const firstFrame = () => act(() => sleep(40));

test('the island slot opens with its content, holds through the grace, then eases shut and keeps no footprint', async (t) => {
  const { root, document, window } = mount(t);
  const { slot, presence, display, moving, finish } = slotFixture(t, window, document);
  const { ComposerIsland, ISLAND_COLLAPSE_GRACE_MS } = await import('./ComposerIsland.tsx');
  // Segments that render from their own state (the files segment after its
  // async diff read): the island itself never re-renders when they come and go.
  const controls = {};
  function Late({ name }) {
    const [shown, setShown] = React.useState(false);
    controls[name] = setShown;
    return shown ? React.createElement('button', { type: 'button', className: 'composer-island-seg' }, name) : null;
  }
  let islandRenders = 0;
  function CountedIsland(props) {
    islandRenders += 1;
    return React.createElement(ComposerIsland, props);
  }
  await act(async () =>
    root.render(
      React.createElement(CountedIsland, {
        sessionId: 'island-session',
        files: React.createElement(Late, { name: 'files' }),
        goal: React.createElement(Late, { name: 'goal' }),
      })
    )
  );
  const rendersBefore = islandRenders;
  assert.equal(presence(), 'closed');
  assert.equal(display(), 'none', 'an empty slot has no box');
  await firstFrame();
  await act(async () => controls.files(true));
  assert.equal(presence(), 'open', 'a visible segment opens the slot at once');
  assert.notEqual(display(), 'none');
  assert.equal(slot().style.getPropertyValue('--island-slot-height'), '46px', 'to the stage’s real height');
  assert.equal(moving(), true, 'the opening eases');
  finish();
  assert.equal(moving(), false);
  await act(async () => controls.goal(true));
  await act(async () => controls.files(false));
  assert.equal(presence(), 'open', 'the slot stays while any segment is still visible');
  assert.equal(slot().style.getPropertyValue('--island-slot-height'), '46px');
  assert.equal(moving(), false, 'an unchanged height starts no motion');
  await act(async () => controls.goal(false));
  assert.equal(islandRenders, rendersBefore, 'only the children re-rendered');
  assert.equal(document.querySelector('.composer-island-seg'), null);
  assert.equal(presence(), 'grace', 'the last segment leaving holds the slot');
  assert.equal(slot().style.getPropertyValue('--island-slot-height'), '46px', 'at its current height');
  assert.notEqual(display(), 'none');
  await sleep(ISLAND_COLLAPSE_GRACE_MS - 150);
  assert.equal(presence(), 'grace');
  assert.equal(slot().style.getPropertyValue('--island-slot-height'), '46px');
  await sleep(250);
  assert.equal(presence(), 'closing', 'after the grace the slot eases shut');
  assert.equal(slot().style.getPropertyValue('--island-slot-height'), '0px');
  assert.equal(moving(), true);
  finish();
  assert.equal(presence(), 'closed');
  assert.equal(display(), 'none', 'no footprint once closed');
  // Content added and removed again within one task opens nothing.
  const segment = document.createElement('span');
  segment.className = 'composer-island-seg';
  slot().querySelector('.composer-island-pill').append(segment);
  segment.remove();
  await act(async () => {});
  assert.equal(presence(), 'closed');
  assert.equal(display(), 'none');
});

test('content returning within the grace cancels the collapse: the slot never moves', async (t) => {
  const { root, document, window } = mount(t);
  const { slot, presence, moving, finish } = slotFixture(t, window, document);
  const { ComposerIsland, ISLAND_COLLAPSE_GRACE_MS } = await import('./ComposerIsland.tsx');
  let setShown = () => {};
  function Late() {
    const [shown, set] = React.useState(true);
    setShown = set;
    return shown ? React.createElement('button', { type: 'button', className: 'composer-island-seg' }, 'files') : null;
  }
  await act(async () =>
    root.render(React.createElement(ComposerIsland, { sessionId: 'island-session', files: React.createElement(Late) }))
  );
  assert.equal(presence(), 'open', 'content present at mount opens the slot');
  assert.equal(slot().style.getPropertyValue('--island-slot-height'), '46px');
  assert.equal(moving(), false, 'the mount draws at its true state');
  await firstFrame();
  await act(async () => setShown(false));
  assert.equal(presence(), 'grace');
  await sleep(ISLAND_COLLAPSE_GRACE_MS - 200);
  await act(async () => setShown(true));
  assert.equal(presence(), 'open', 'the returning segment cancels the collapse');
  assert.equal(slot().style.getPropertyValue('--island-slot-height'), '46px');
  assert.equal(moving(), false, 'nothing moved');
  await sleep(400);
  assert.equal(presence(), 'open', 'the cancelled collapse never fires');
  assert.equal(slot().style.getPropertyValue('--island-slot-height'), '46px');
  finish();
  assert.equal(presence(), 'open');
});

test('an approval opens the slot without delay and is held no longer than the grace once resolved', async (t) => {
  const { root, document, window } = mount(t);
  const { slot, presence, moving, finish } = slotFixture(t, window, document);
  const { ISLAND_COLLAPSE_GRACE_MS } = await import('./ComposerIsland.tsx');
  const render = (approval) => renderDock(root, 'approval-session', approval);
  await render(false);
  assert.equal(presence(), 'closed');
  await firstFrame();
  await render(true);
  assert.equal(presence(), 'open', 'the approval opens the slot in the same commit');
  assert.equal(slot().style.getPropertyValue('--island-slot-height'), '212px', 'straight to the card’s height');
  assert.equal(moving(), true);
  finish();
  await render(false);
  assert.equal(presence(), 'grace');
  await sleep(ISLAND_COLLAPSE_GRACE_MS + 50);
  assert.equal(presence(), 'closing', 'the resolved card holds no longer than the grace');
  assert.equal(slot().style.getPropertyValue('--island-slot-height'), '0px');
  finish();
  assert.equal(presence(), 'closed');
});

test('a session switch remounts the slot at its true state, with no grace and no motion', async (t) => {
  const { root, document, window } = mount(t);
  const { slot, presence, moving } = slotFixture(t, window, document);
  const render = (session, approval) => renderDock(root, session, approval);
  await render('session-a', true);
  await firstFrame();
  const first = slot();
  assert.equal(presence(), 'open');
  await render('session-b', false);
  assert.notEqual(slot(), first, 'the island remounts per session');
  assert.equal(presence(), 'closed', 'an empty session starts closed, without the grace');
  assert.equal(moving(), false);
  await render('session-c', true);
  assert.equal(presence(), 'open', 'a session with content starts open');
  assert.equal(slot().style.getPropertyValue('--island-slot-height'), '212px');
  assert.equal(moving(), false, 'without easing');
});

test('a revisited session reserves its resting island height until its segments arrive', async (t) => {
  const { root, document, window } = mount(t);
  const { slot, presence, moving } = slotFixture(t, window, document);
  const { ComposerIsland, ISLAND_COLLAPSE_GRACE_MS } = await import('./ComposerIsland.tsx');
  // The specifier ComposerIsland itself uses: one module, one island context.
  const { IslandSegmentPending } = await import('./composer-island-state');
  const segment = React.createElement('button', { type: 'button', className: 'composer-island-seg' }, 'files');
  const pending = React.createElement(IslandSegmentPending, { kind: 'files' });
  const render = (sessionId, files) =>
    act(async () => root.render(React.createElement(ComposerIsland, { key: sessionId, sessionId, files })));
  await render('reserve-a', segment);
  await firstFrame();
  assert.equal(presence(), 'open');
  await render('reserve-b', null);
  assert.equal(presence(), 'closed', 'a session never shown mounts at its true state');
  // Back on the first session before its segments have read their state.
  await render('reserve-a', pending);
  assert.equal(presence(), 'grace', 'the slot holds the session’s resting height');
  assert.equal(slot().style.getPropertyValue('--island-slot-height'), '46px');
  await firstFrame();
  // A cold read outlasts the ordinary grace; the reservation still holds.
  await sleep(ISLAND_COLLAPSE_GRACE_MS + 100);
  assert.equal(presence(), 'grace', 'the reserved height outlasts the ordinary grace');
  await render('reserve-a', segment);
  assert.equal(presence(), 'open');
  assert.equal(slot().style.getPropertyValue('--island-slot-height'), '46px');
  assert.equal(moving(), false, 'the arriving segments move nothing');
});

test('a first entry reserves the resting height of the island it replaces in the dock', async (t) => {
  const { root, document, window } = mount(t);
  const { slot, presence, moving } = slotFixture(t, window, document);
  const { ComposerIsland } = await import('./ComposerIsland.tsx');
  const { IslandSegmentPending } = await import('./composer-island-state');
  const segment = React.createElement('button', { type: 'button', className: 'composer-island-seg' }, 'files');
  const render = (sessionId, files, carriedHeight) =>
    act(async () =>
      root.render(React.createElement(ComposerIsland, { key: sessionId, sessionId, files, carriedHeight }))
    );
  await render('carry-a', segment);
  await firstFrame();
  // Never shown: its segments have not read their state yet.
  await render('carry-b', React.createElement(IslandSegmentPending, { kind: 'files' }), 46);
  assert.equal(presence(), 'grace', 'the outgoing pill’s height is held, not dropped');
  assert.equal(slot().style.getPropertyValue('--island-slot-height'), '46px');
  await firstFrame();
  await render('carry-b', segment, 46);
  assert.equal(presence(), 'open');
  assert.equal(slot().style.getPropertyValue('--island-slot-height'), '46px');
  assert.equal(moving(), false, 'the arriving segments move nothing');
});

// User: 대화창 들어가면 덜컥 한 줄 정도 내려앉는다. Entering a chat from a
// session whose pill showed reserved the pill's height; the transcript
// revealed above that room and dropped by it when the hold ran out.
test('a reserved slot holds the entry reveal only while a segment is undecided', async (t) => {
  const { root, document, window } = mount(t);
  const { slot, presence } = slotFixture(t, window, document);
  const { ComposerIsland } = await import('./ComposerIsland.tsx');
  const { IslandSegmentPending } = await import('./composer-island-state');
  const segment = React.createElement('button', { type: 'button', className: 'composer-island-seg' }, 'main');
  const pending = React.createElement(IslandSegmentPending, { kind: 'branch' });
  const render = (sessionId, branch, carriedHeight) =>
    act(async () =>
      root.render(
        React.createElement(ComposerIsland, { key: sessionId, sessionId, branch: () => branch, carriedHeight })
      )
    );
  const height = () => slot().style.getPropertyValue('--island-slot-height');
  const holdsEntry = () => slot().hasAttribute('data-reserved');
  await render('undecided-a', segment);
  await firstFrame();
  assert.equal(presence(), 'open');
  // A chat with no late segment (a bot chat): nothing can fill the room.
  await render('undecided-bot', null, 46);
  assert.equal(presence(), 'closed', 'the chat mounts at its true state in the entry commit');
  assert.equal(height(), '0px');
  assert.equal(holdsEntry(), false);
  // A segment still reading: the room is reserved and the reveal waits.
  await render('undecided-b', pending, 46);
  assert.equal(presence(), 'grace');
  assert.equal(height(), '46px');
  assert.equal(holdsEntry(), true, 'the reserved room holds the entry reveal');
  await firstFrame();
  // It decides empty: the slot closes now, not when the hold runs out.
  await render('undecided-b', null, 46);
  assert.notEqual(presence(), 'grace');
  assert.equal(height(), '0px');
  assert.equal(holdsEntry(), false, 'the reveal is released with the reservation');
});

test('an undecided files segment keeps the room its last width needs in the pill', async (t) => {
  const { root, document, window } = mount(t);
  slotFixture(t, window, document);
  const proto = window.HTMLElement.prototype;
  const offsetWidth = Object.getOwnPropertyDescriptor(proto, 'offsetWidth');
  Object.defineProperty(proto, 'offsetWidth', {
    configurable: true,
    get() {
      return this.classList.contains('turn-review-segment') ? 180 : 0;
    },
  });
  t.after(() => Object.defineProperty(proto, 'offsetWidth', offsetWidth));
  const { ComposerIsland } = await import('./ComposerIsland.tsx');
  // The specifier ComposerIsland itself uses: one module, one island context.
  const { IslandSegmentPending } = await import('./composer-island-state');
  const branch = () => React.createElement('button', { type: 'button', className: 'composer-island-seg' }, 'main');
  const files = React.createElement('button', { type: 'button', className: 'composer-island-seg turn-review-segment' });
  const pending = React.createElement(IslandSegmentPending, { kind: 'files', holdEntry: true });
  const render = (sessionId, segment, carriedAdvances) =>
    act(async () =>
      root.render(
        React.createElement(ComposerIsland, { key: sessionId, sessionId, branch, files: segment, carriedAdvances })
      )
    );
  const reserve = () => document.querySelector('.composer-island-pill > .composer-island-reserve');
  await render('files-a', files);
  await firstFrame();
  // Nothing known: a hidden marker that takes no room.
  await render('files-b', pending);
  assert.equal(reserve(), null);
  assert.equal(document.querySelector('[data-entry-pending]')?.hidden, true);
  // Back before the segment's read answered: its decided advance (180px plus
  // the 5px separator margin) is held.
  await render('files-a', pending);
  assert.equal(reserve()?.style.width, '185px');
  assert.ok(reserve().hasAttribute('data-entry-pending'), 'the entry reveal still waits on it');
  // Never shown: the advance of the files segment it replaces in the dock.
  await render('files-c', pending, { files: 185 });
  assert.equal(reserve()?.style.width, '185px');
});

test('a dock awaiting its session’s lane keeps the island slot at the reserved height', async (t) => {
  const { root, document, window } = mount(t);
  const { slot, presence } = slotFixture(t, window, document);
  const { ComposerIsland } = await import('./ComposerIsland.tsx');
  const segment = React.createElement('button', { type: 'button', className: 'composer-island-seg' }, 'files');
  await act(async () =>
    root.render(React.createElement(ComposerIsland, { key: 'await-a', sessionId: 'await-a', files: segment }))
  );
  await firstFrame();
  await act(async () =>
    root.render(React.createElement(ComposerDock, dockProps({ sessionId: '', reviewSessionId: 'await-a' })))
  );
  assert.equal(presence(), 'grace', 'the composer does not drop while the lane is read');
  assert.equal(slot().style.getPropertyValue('--island-slot-height'), '46px');
});

test('reduced motion turning on mid-motion lands the slot at once; unmount drops the listener', async (t) => {
  const { root, window, document } = mount(t);
  const { slot, presence, moving } = slotFixture(t, window, document);
  const { ComposerIsland, ISLAND_COLLAPSE_GRACE_MS } = await import('./ComposerIsland.tsx');
  const listeners = new Set();
  const query = {
    matches: false,
    addEventListener: (type, listener) => type === 'change' && listeners.add(listener),
    removeEventListener: (type, listener) => type === 'change' && listeners.delete(listener),
  };
  window.matchMedia = () => query;
  const preferReduced = () =>
    act(async () => {
      query.matches = true;
      for (const listener of [...listeners]) listener({ matches: true });
    });
  const render = (shown) =>
    act(async () =>
      root.render(
        React.createElement(ComposerIsland, {
          sessionId: 'motion-session',
          files: shown
            ? React.createElement('button', { type: 'button', className: 'composer-island-seg' }, 'f')
            : null,
        })
      )
    );
  await render(false);
  assert.equal(listeners.size, 1, 'the slot follows the preference');
  await firstFrame();
  await render(true);
  assert.equal(moving(), true, 'the opening eases');
  await preferReduced();
  assert.equal(moving(), false, 'the running motion is cancelled');
  assert.equal(presence(), 'open');
  assert.equal(slot().style.getPropertyValue('--island-slot-height'), '46px', 'at its target height');
  await render(false);
  assert.equal(presence(), 'grace', 'the grace is a hold, not motion');
  await sleep(ISLAND_COLLAPSE_GRACE_MS + 50);
  assert.equal(presence(), 'closed', 'the collapse is instant under reduced motion');
  assert.equal(moving(), false);
  await act(async () => root.render(null));
  assert.equal(listeners.size, 0, 'unmount removes the listener');
});

/** ComposerIsland on a real page with the real stylesheet. */
function islandPage(t) {
  return realPage(
    t,
    `
        import React from 'react';
        import { flushSync } from 'react-dom';
        import { createRoot } from 'react-dom/client';
        import { ComposerIsland } from './ComposerIsland.tsx';
        window.mixdogDesktop = { listAgentPool: async () => [], subscribeAgentPool: () => {} };
        const root = createRoot(document.getElementById('root'));
        // Keyed by session like ComposerDock: a switch remounts the island.
        window.__render = (session, { approval = false, segment = false } = {}) =>
          flushSync(() =>
            root.render(
              React.createElement(ComposerIsland, {
                key: session,
                sessionId: session,
                approval: approval
                  ? React.createElement('article', { className: 'approval-card', style: { height: '160px' } }, 'Allow?')
                  : null,
                files: segment ? React.createElement('button', { type: 'button', className: 'composer-island-seg' }, 'files') : null,
              })
            )
          );
      `
  );
}

/** Resolves once the island has fitted what the page last changed. Observing
 *  the island's room delivers once at the next rendering step, after the
 *  island's own observer (registered at mount) and every re-fit it caused in
 *  that step. */
const fitted = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        const observer = new ResizeObserver(() => {
          observer.disconnect();
          resolve();
        });
        observer.observe(document.querySelector('.composer-island').parentElement);
      })
  );

/** A full island (13 agents / 2 running, a long branch, many changed files
 *  with big diff numbers, the git action) on a real page with the app's CSS. */
function crowdedIslandPage(t) {
  return realPage(
    t,
    `
        import React from 'react';
        import { flushSync } from 'react-dom';
        import { createRoot } from 'react-dom/client';
        import { ComposerIsland, IslandSegLabel } from './ComposerIsland.tsx';
        const rows = Array.from({ length: 13 }, (_, index) => ({
          tag: 'agent-' + index,
          agent: 'worker',
          ownerSessionId: 'crowded',
          stage: index < 2 ? 'running' : 'done',
          status: index < 2 ? 'running' : 'done',
          startedAt: Date.now() - 5000,
        }));
        window.mixdogDesktop = { listAgentPool: async () => rows, subscribeAgentPool: () => {} };
        const root = createRoot(document.getElementById('root'));
        const h = React.createElement;
        window.__render = () =>
          flushSync(() =>
            root.render(
              h(ComposerIsland, {
                sessionId: 'crowded',
                branch: () =>
                  h('button', { type: 'button', className: 'composer-island-seg composer-island-seg-branch' },
                    h(IslandSegLabel, { text: '', count: 0, icon: 'git-branch' }),
                    h('span', { className: 'composer-island-seg-text' },
                      h('span', { className: 'composer-island-seg-label' },
                        h('span', { className: 'composer-island-seg-prefix' }, 'feature/'), 'island-fits-narrow-phones'))),
                files: h('button', { type: 'button', className: 'composer-island-seg turn-review-segment' },
                  h(IslandSegLabel, { text: '1041 files', count: 1041, icon: 'file-diff' }),
                  h('span', { className: 'diff-stats' }, h('i', null, '+76424'), ' ', h('em', null, '-13245'))),
                git: h('span', { className: 'composer-island-seg composer-island-git' },
                  h('button', { type: 'button', className: 'composer-island-git-main' }, h('span', null, 'Git'))),
              })
            )
          );
      `
  );
}

for (const width of [900, 412, 360, 300]) {
  test(`a crowded island fits its room and never clips at ${width}px`, async (t) => {
    const page = await crowdedIslandPage(t);
    await page.setViewport({ width, height: 800 });
    if (width < 500) await page.evaluate(() => document.documentElement.setAttribute('data-mixdog-mobile-tabs', ''));
    // The island is measured at small type first (a web font still loading, a
    // fallback face), then the real type lands with no content or room change.
    await page.addStyleTag({ content: '.composer-island, .composer-island * { font-size: 3px !important; }' });
    await page.evaluate(() => window.__render());
    await fitted(page);
    await page.evaluate(() => document.head.lastElementChild.remove());
    await fitted(page);
    const fit = await page.evaluate(() => {
      const island = document.querySelector('.composer-island');
      const pill = island.querySelector('.composer-island-pill');
      const edge = island.getBoundingClientRect().right;
      return {
        agents: document.querySelectorAll('.composer-island-seg-agents').length,
        island: [island.scrollWidth, island.clientWidth],
        pill: [pill.scrollWidth, pill.clientWidth],
        pastEdge: [...pill.querySelectorAll('.composer-island-seg')]
          .filter((seg) => seg.getClientRects().length && seg.getBoundingClientRect().right > edge + 0.5)
          .map((seg) => seg.className),
        attrs: [...island.attributes].map((a) => a.name).filter((n) => n.startsWith('data-')),
      };
    });
    if (process.env.ISLAND_SHOT_DIR)
      await page.screenshot({ path: `${process.env.ISLAND_SHOT_DIR}/island-${width}.png` });
    assert.equal(fit.agents, 1);
    assert.ok(fit.island[0] <= fit.island[1], `island clipped: ${JSON.stringify(fit)}`);
    assert.ok(fit.pill[0] <= fit.pill[1], `pill clipped: ${JSON.stringify(fit)}`);
    assert.deepEqual(fit.pastEdge, [], JSON.stringify(fit));
  });
}

test("the overlay bot pinned above the message box takes its width from the island's room: compact where it was full", async (t) => {
  const page = await realPage(
    t,
    `
        import React from 'react';
        import { flushSync } from 'react-dom';
        import { createRoot } from 'react-dom/client';
        import { ComposerIsland, IslandSegLabel } from './ComposerIsland.tsx';
        import { setPetIslandReserve } from './composer-island-state.ts';
        window.mixdogDesktop = { listAgentPool: async () => [], subscribeAgentPool: () => {} };
        const region = document.getElementById('root');
        const elsewhere = document.body.appendChild(document.createElement('div'));
        window.__reserve = (width, here = true) => setPetIslandReserve(here ? region : elsewhere, width);
        const h = React.createElement;
        flushSync(() =>
          createRoot(region).render(
            h(ComposerIsland, {
              sessionId: 'reserve',
              files: h('button', { type: 'button', className: 'composer-island-seg turn-review-segment' },
                h(IslandSegLabel, { text: '12 files changed', count: 12, icon: 'file-diff' }),
                h('span', { className: 'diff-stats' }, h('i', null, '+764'), ' ', h('em', null, '-132'))),
              git: h('span', { className: 'composer-island-seg composer-island-git' },
                h('button', { type: 'button', className: 'composer-island-git-main' }, h('span', null, 'Git'))),
            })
          )
        );
      `
  );
  await page.setViewport({ width: 900, height: 800 });
  await fitted(page);
  const state = (reserve, here) =>
    page.evaluate(
      (width, inRegion) => {
        if (width !== undefined) window.__reserve(width, inRegion);
        const island = document.querySelector('.composer-island');
        return {
          compact: island.hasAttribute('data-compact'),
          room: island.parentElement.clientWidth,
          pill: island.querySelector('.composer-island-pill').offsetWidth,
        };
      },
      reserve,
      here
    );
  const full = await state();
  assert.equal(full.compact, false, `full labels in the room: ${JSON.stringify(full)}`);
  // The pill is centred: it clears the bot while room - 2 x reserve still holds it.
  const slack = full.room - full.pill;
  assert.ok(slack > 2, JSON.stringify(full));
  assert.equal((await state(Math.floor(slack / 2))).compact, false, 'clears the bot: full');
  const pinned = await state(Math.floor(slack / 2) + 1);
  assert.equal(pinned.compact, true, 'would run under the bot: compact');
  assert.ok(pinned.pill < full.pill);
  assert.equal(pinned.room, full.room, 'the room itself is unchanged');
  assert.equal((await state(Math.floor(slack / 2) + 1, false)).compact, false, "another pane's bot: full");
  assert.equal((await state(Math.floor(slack / 2) + 1)).compact, true);
  assert.equal((await state(0)).compact, false, 'unpinned (0): full again');
  // Room for the full pill beside Mixy at 100% (main's reserve: its art from
  // column 1, 52.5px, + the 2px inset + 4px = 59 a side): a room 2 x 59 wider
  // than the pill keeps it full, where the whole sprite box (66) went compact.
  await page.setViewport({ width: full.pill + 2 * 59, height: 800 });
  await fitted(page);
  const beside = await state(59);
  assert.equal(beside.room, full.pill + 2 * 59, JSON.stringify(beside));
  assert.equal(beside.compact, false, `full beside the bot's art: ${JSON.stringify(beside)}`);
  assert.equal((await state(66)).compact, true, 'the whole sprite box would not fit');
  // A pill one px wider each side would reach the art's clearance: compact.
  await page.setViewport({ width: full.pill + 2 * 59 - 2, height: 800 });
  await fitted(page);
  assert.equal((await state(59)).compact, true, 'would reach the visible art');
});

test('labels that change beside an open side panel still go compact under the pinned bot once it closes', async (t) => {
  const page = await realPage(
    t,
    `
        import React from 'react';
        import { flushSync } from 'react-dom';
        import { createRoot } from 'react-dom/client';
        import { ComposerIsland, IslandSegLabel } from './ComposerIsland.tsx';
        import { setPetIslandReserve } from './composer-island-state.ts';
        window.mixdogDesktop = { listAgentPool: async () => [], subscribeAgentPool: () => {} };
        const region = document.getElementById('root');
        window.__reserve = (width) => setPetIslandReserve(region, width);
        const h = React.createElement;
        const root = createRoot(region);
        window.__render = (count) =>
          flushSync(() =>
            root.render(
              h(ComposerIsland, {
                sessionId: 'side-panel',
                branch: () =>
                  h('button', { type: 'button', className: 'composer-island-seg composer-island-seg-branch' },
                    h(IslandSegLabel, { text: '', count: 0, icon: 'git-branch' }),
                    h('span', { className: 'composer-island-seg-text' },
                      h('span', { className: 'composer-island-seg-label' },
                        h('span', { className: 'composer-island-seg-prefix' }, 'feature/'), 'island-fits-narrow-phones'))),
                files: h('button', { type: 'button', className: 'composer-island-seg turn-review-segment' },
                  h(IslandSegLabel, { text: count + ' files changed', count, icon: 'file-diff' }),
                  h('span', { className: 'diff-stats' }, h('i', null, '+764'), ' ', h('em', null, '-132'))),
                git: h('span', { className: 'composer-island-seg composer-island-git' },
                  h('button', { type: 'button', className: 'composer-island-git-main' }, h('span', null, 'Git'))),
              })
            )
          );
      `
  );
  const settle = () => fitted(page);
  const state = () =>
    page.evaluate(() => {
      const island = document.querySelector('.composer-island');
      return {
        compact: island.hasAttribute('data-compact'),
        glyph: island.hasAttribute('data-fit-glyph'),
        room: island.parentElement.clientWidth,
        pill: island.querySelector('.composer-island-pill').offsetWidth,
      };
    });
  await page.evaluate(() => window.__render(12));
  await fitted(page);
  const full = await state();
  assert.equal(full.compact, false, `full labels in the room: ${JSON.stringify(full)}`);
  const reserve = 40;
  await page.evaluate((width) => window.__reserve(width), reserve);
  // A side panel opens: the room is so narrow that even the compact pill
  // gives way (the worktree name down to its glyph).
  await page.setViewport({ width: 140, height: 800 });
  await settle();
  const narrow = await state();
  assert.ok(narrow.compact && narrow.glyph, JSON.stringify(narrow));
  // A count changes meanwhile (labels never laid out before: read, not reused).
  await page.evaluate(() => window.__render(13));
  await settle();
  // The panel closes: room for the full labels, but not beside the bot.
  const room = full.pill + 2 * reserve - 10;
  await page.setViewport({ width: room, height: 800 });
  await settle();
  const wide = await state();
  assert.equal(wide.room, room, JSON.stringify(wide));
  assert.equal(wide.compact, true, `would run under the bot: ${JSON.stringify(wide)}`);
  assert.ok(wide.pill <= room - 2 * reserve, JSON.stringify(wide));
  // A room that clears the bot takes the full labels back.
  await page.setViewport({ width: 900, height: 800 });
  await settle();
  assert.equal((await state()).compact, false);
});

/** ComposerDock on a real page: a New Task draft (context bar) or a session. */
function dockPage(t) {
  return realPage(
    t,
    `
        import React from 'react';
        import { flushSync } from 'react-dom';
        import { createRoot } from 'react-dom/client';
        import { ComposerDock } from './ComposerDock.tsx';
        window.mixdogDesktop = new Proxy({}, {
          get: (_, name) => (String(name).startsWith('subscribe') ? () => () => {} : async () => []),
        });
        const root = createRoot(document.getElementById('root'));
        const chip = (label) => React.createElement('button', { type: 'button', style: { height: '28px' } }, label);
        // draft: the context bar; session: an empty island, or one carrying a flash.
        window.__render = (mode) =>
          flushSync(() =>
            root.render(
              React.createElement(ComposerDock, {
                sessionId: mode === 'draft' ? '' : 'first-session',
                reviewSessionId: mode === 'draft' ? '' : 'first-session',
                goalSubmissionId: '',
                showProjectSelector: mode === 'draft',
                contextBar: [chip('Project'), chip('Workflow')],
                islandFlash: mode === 'flash' ? { key: 'f', text: 'Notice' } : null,
                reviewItems: [],
                reviewActive: true,
                reviewBusy: false,
                reviewCwd: '',
                children: React.createElement('form', { className: 'composer', style: { height: '96px' } }),
              })
            )
          );
      `,
    readFileSync(new URL('./styles.css', import.meta.url), 'utf8')
  );
}

// One Chrome and one bundle per distinct page script for the whole file: every
// browser test gets its own fresh page, but not its own esbuild run and browser
// launch (which, repeated, outlast the file's time budget on a busy machine).
const bundles = new Map();
let sharedBrowser;
after(async () => (await sharedBrowser)?.close());
const bundled = (contents) => {
  if (!bundles.has(contents)) bundles.set(contents, bundleRealPage(contents));
  return bundles.get(contents);
};

async function realPage(t, contents, baseCss = '') {
  const bundle = await bundled(contents);
  const script = bundle.outputFiles.find((file) => file.path.endsWith('.js')).text;
  const css = registeredProperties() + readFileSync(new URL('./desktop/15-composer.css', import.meta.url), 'utf8');
  sharedBrowser ??= puppeteer.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    headless: true,
  });
  const browser = await sharedBrowser;
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.setViewport({ width: 900, height: 700 });
  return await finishRealPage(page, script, css, baseCss);
}

function bundleRealPage(contents) {
  return build({
    plugins: [
      {
        name: 'worker-stub',
        setup(builder) {
          builder.onResolve({ filter: /\?worker$/ }, (args) => ({ path: args.path, namespace: 'worker-stub' }));
          builder.onLoad({ filter: /.*/, namespace: 'worker-stub' }, () => ({
            contents: 'export default class {};',
            loader: 'js',
          }));
        },
      },
    ],
    stdin: {
      contents,
      resolveDir: fileURLToPath(new URL('.', import.meta.url)),
      loader: 'tsx',
    },
    outfile: 'composer-island-page.js',
    bundle: true,
    write: false,
    format: 'iife',
    jsx: 'automatic',
    loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl' },
  });
}

async function finishRealPage(page, script, css, baseCss) {
  await page.setContent(`<!doctype html><html><head><style>
    body { margin: 0; font-family: sans-serif; }
    ${baseCss}
    ${css}
    #root { position: fixed; right: 0; bottom: 0; left: 0; display: flex; flex-direction: column; }
  </style></head><body><div id="root"></div></body></html>`);
  await page.addScriptTag({ content: script });
  await page.evaluate(() => {
    window.__frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
    // The island's own entry fades (pulses and spinners are not entries).
    window.__entry = () => {
      const island = document.querySelector('.composer-island');
      return {
        opacity: Number(getComputedStyle(island).opacity),
        fades: island
          .getAnimations({ subtree: true })
          .filter((animation) => animation.animationName?.startsWith('composer-island-')).length,
      };
    };
  });
  return page;
}

// The bar and the island slot derive their height from one pair of custom
// properties (pill + stage gap); the phone only changes the pill (36px).
for (const { size, viewport, mobile, rest } of [
  { size: 'desktop', viewport: { width: 900, height: 700 }, mobile: false, rest: 46 },
  { size: 'mobile', viewport: { width: 390, height: 800 }, mobile: true, rest: 48 },
]) {
  test(`a draft’s first submit swaps context bar for island without changing the dock height (${size})`, async (t) => {
    const page = await dockPage(t);
    await page.setViewport(viewport);
    if (mobile) await page.evaluate(() => document.documentElement.setAttribute('data-mixdog-mobile-tabs', ''));
    await assertDraftSwapKeepsDockHeight(page, rest);
  });
}

async function assertDraftSwapKeepsDockHeight(page, rest) {
  const result = await page.evaluate(async () => {
    const region = () => document.querySelector('.composer-region');
    const height = () => region().getBoundingClientRect().height;
    const swap = async (mode) => {
      window.__render('draft');
      await window.__frame();
      await window.__frame();
      const bar = document.querySelector('.composer-context-bar').getBoundingClientRect();
      const chip = document.querySelector('.composer-context-bar button').getBoundingClientRect();
      const draft = height();
      window.__render(mode);
      const heights = [height()];
      const start = performance.now();
      // Up to just short of the island's collapse grace.
      while (performance.now() - start < 400) {
        await window.__frame();
        heights.push(height());
      }
      return { draft, heights, bar: bar.height, above: chip.top - bar.top, below: bar.bottom - chip.bottom };
    };
    const flash = await swap('flash');
    const empty = await swap('empty');
    // Past the grace and the eased collapse: the empty island's usual close.
    const slot = document.querySelector('.composer-island-slot');
    await new Promise((resolve) => {
      const closed = () => slot.getAttribute('data-presence') === 'closed';
      if (closed()) return resolve();
      new MutationObserver((_, observer) => {
        if (!closed()) return;
        observer.disconnect();
        resolve();
      }).observe(slot, { attributes: true, attributeFilter: ['data-presence'] });
    });
    await window.__frame();
    return { flash, empty, closed: slot.getAttribute('data-presence'), after: height() };
  });
  for (const [name, swap] of Object.entries({ flash: result.flash, empty: result.empty })) {
    assert.equal(swap.bar, rest, `${name}: the bar is the island slot's resting height`);
    assert.equal(swap.above, swap.below, `${name}: the bar's controls sit centred in its slot`);
    assert.deepEqual(new Set(swap.heights), new Set([swap.draft]), `${name}: the dock keeps the bar's height`);
  }
  assert.equal(result.closed, 'closed', 'an empty island still closes after its grace');
  assert.equal(result.after, result.empty.draft - rest);
}

test('a remounted island with an approval draws at its final state; only later arrivals fade in', async (t) => {
  const page = await islandPage(t);
  const result = await page.evaluate(async () => {
    window.__render('session-a', { approval: true });
    await window.__frame();
    await window.__frame();
    // The session switch: a fresh island that already carries an approval.
    window.__render('session-b', { approval: true });
    await Promise.resolve();
    const atMount = window.__entry();
    const frames = [];
    const start = performance.now();
    while (performance.now() - start < 320) {
      await window.__frame();
      frames.push(window.__entry());
    }
    // Contrast: the same island receiving an approval after its first frame.
    window.__render('session-c');
    await window.__frame();
    await window.__frame();
    window.__render('session-c', { approval: true });
    await Promise.resolve();
    const arrival = window.__entry();
    return { atMount, frames, arrival };
  });
  assert.deepEqual(result.atMount, { opacity: 1, fades: 0 }, 'no entry animation on remount');
  assert.ok(result.frames.length > 5);
  assert.equal(Math.min(...result.frames.map((frame) => frame.opacity)), 1, 'opaque on every painted frame');
  assert.equal(Math.max(...result.frames.map((frame) => frame.fades)), 0);
  assert.equal(result.arrival.fades, 1, 'an approval arriving after mount still fades in');
  assert.ok(result.arrival.opacity < 1);
});

test('reduced motion turning on mid-animation lands the slot at its target height at once', async (t) => {
  const page = await islandPage(t);
  const opening = await page.evaluate(async () => {
    window.__render('motion');
    await window.__frame();
    await window.__frame();
    window.__render('motion', { segment: true });
    await Promise.resolve();
    const slot = document.querySelector('.composer-island-slot');
    const target = Number.parseFloat(slot.style.getPropertyValue('--island-slot-height'));
    // The first painted frame between closed and open: a fixed frame count
    // can land past the end of the transition on a slow runner.
    let mid = 0;
    for (let index = 0; index < 30 && mid === 0; index += 1) {
      await window.__frame();
      mid = slot.offsetHeight;
    }
    return { target, mid, moving: slot.hasAttribute('data-motion') };
  });
  assert.ok(opening.target > 0);
  assert.equal(opening.moving, true);
  assert.ok(opening.mid > 0 && opening.mid < opening.target, `mid-animation (${opening.mid} of ${opening.target})`);
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  const landed = await page.evaluate(async () => {
    const slot = document.querySelector('.composer-island-slot');
    await window.__frame();
    const first = { height: slot.offsetHeight, moving: slot.hasAttribute('data-motion') };
    const later = [];
    for (let index = 0; index < 8; index += 1) {
      await window.__frame();
      later.push(slot.offsetHeight);
    }
    const settled = { moving: slot.hasAttribute('data-motion'), presence: slot.getAttribute('data-presence') };
    // The stylesheet alone also keeps the slot still under reduced motion.
    slot.setAttribute('data-motion', '');
    const transition = getComputedStyle(slot).transitionProperty;
    slot.removeAttribute('data-motion');
    return { first, later, settled, transition };
  });
  assert.equal(landed.first.height, Math.round(opening.target), 'landed in the next frame');
  assert.deepEqual(new Set(landed.later), new Set([Math.round(opening.target)]), 'and stays there');
  assert.deepEqual(landed.settled, { moving: false, presence: 'open' }, 'the media change ended the motion');
  assert.equal(landed.transition, 'none');
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
    // The turn review read carries the retained turn count Delete history removes.
    if (request.capability === 'getTurnReviewDiff') {
      return { value: { supported: true, authoritative: true, files: [], patch: '', historyTurns: cleared ? 0 : 12 } };
    }
    if (request.capability !== 'getSessionReviewDiff') return { value: { supported: true, files: [], patch: '' } };
    // No Git here (no gitReview): the island counts the session diff.
    const files = cleared
      ? []
      : [
          { path: 'src/a.ts', status: 'M', additions: 3, deletions: 1 },
          { path: 'b.ts', status: 'A', additions: 2, deletions: 0 },
        ];
    return { value: { supported: true, authoritative: true, complete: true, patch: '', files } };
  };
  let opened = 0;
  await act(async () =>
    root.render(
      React.createElement(
        ComposerDock,
        dockProps({
          reviewSessionId: 'island-files',
          reviewCwd: 'C:/work',
          reviewItems: [{ kind: 'turndone', id: 'island-done' }],
          onOpenSessionDiff: () => opened++,
        })
      )
    )
  );
  const segment = () => document.querySelector('.turn-review-segment');
  const menu = () => document.querySelector('.turn-review-files-menu');
  const all = () => [...(menu()?.querySelectorAll('[role="menuitem"]') ?? [])];
  const fileRows = () => [...(menu()?.querySelectorAll('.turn-review-files-row') ?? [])];
  // [View changes, Delete history], fixed under the list.
  const items = () => {
    const foot = [...(menu()?.querySelectorAll('.turn-review-files-foot [role="menuitem"]') ?? [])];
    return [foot[1], foot[0]];
  };
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
  // Every file in one list (dir muted, name, counts), then Delete history · View changes.
  assert.deepEqual(
    all().map((item) => item.textContent),
    ['src/a.ts+3 −1', 'b.ts+2', 'Delete history', 'View changes']
  );
  assert.equal(fileRows()[0].querySelector('.turn-review-files-dir').textContent, 'src/');
  assert.equal(fileRows()[0].querySelector('.diff-stats i').textContent, '+3');
  assert.equal(fileRows()[0].querySelector('.diff-stats em').textContent, '−1');
  assert.ok(items()[1].classList.contains('danger'));
  assert.equal(document.activeElement, fileRows()[0], 'keyboard focus lands on the first item');
  await act(async () => menu().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
  assert.equal(document.activeElement, fileRows()[1]);
  await act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' })));
  assert.equal(menu(), null, 'Escape closes the menu');
  assert.equal(island.dataset.expanded, undefined);
  assert.equal(document.activeElement, segment(), 'focus returns to the segment');

  // View changes does what the click used to do.
  await act(async () => segment().click());
  await act(async () => items()[0].click());
  assert.equal(opened, 1);
  assert.equal(menu(), null);
  assert.equal(pendingSessionDiffFileRequest('island-files').path, '', 'the list of every file');

  // A file row opens the session diff on that file.
  await act(async () => segment().click());
  await act(async () => fileRows()[1].click());
  assert.equal(opened, 2);
  assert.equal(menu(), null);
  assert.equal(pendingSessionDiffFileRequest('island-files').path, 'b.ts');

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
  await act(async () =>
    document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  );
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
  await untilDom(document, () => segment() === null);
  assert.equal(segment(), null, 'an empty history hides the segment');
});

test('a Git root picks its Changes source in the files menu; an empty source keeps the open menu', async (t) => {
  const { root, document, window } = mount(t);
  await import('./TurnReview');
  window.localStorage.removeItem('mixdog.session-changes-source.v1');
  window.mixdogDesktop.gitStatus = async () => ({ repository: true, root: 'C:/git-files', files: [] });
  window.mixdogDesktop.gitReview = async () => ({
    repository: true,
    root: 'C:/git-files',
    base: 'HEAD',
    files: [{ path: 'left-over.ts', status: 'M', additions: 4, deletions: 1, untracked: false }],
  });
  window.mixdogDesktop.invokeCapability = async (request) => {
    if (request.capability === 'getTurnReviewDiff') {
      return { value: { supported: true, authoritative: true, files: [], patch: '', historyTurns: 1 } };
    }
    // This session has touched nothing yet.
    return { value: { supported: true, authoritative: true, files: [], patch: '' } };
  };
  await act(async () =>
    root.render(
      React.createElement(
        ComposerDock,
        dockProps({
          reviewSessionId: 'island-source',
          reviewCwd: 'C:/git-files',
          reviewItems: [{ kind: 'turndone', id: 'island-source-done' }],
          onOpenSessionDiff: () => {},
        })
      )
    )
  );
  const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  const segment = () => document.querySelector('.turn-review-segment');
  const panel = () => document.querySelector('.turn-review-files-panel');
  const sourceName = () => panel()?.querySelector('.turn-review-files-source')?.textContent;
  const sourceItems = () => [...document.querySelectorAll('.row-overflow-menu [role="menuitemcheckbox"]')];
  const pick = async (label) => {
    const trigger = panel().querySelector('.row-overflow-trigger');
    await act(async () => {
      trigger.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    });
    const item = sourceItems().find((node) => node.textContent === label);
    // A press inside the portaled picker belongs to it, not outside the island.
    await act(async () => item.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, button: 0 })));
    await act(async () => item.click());
    await flush();
  };
  await flush();
  assert.ok(segment(), 'the Git root has uncommitted files');
  await act(async () => segment().click());
  await flush();
  assert.equal(sourceName(), 'Uncommitted', 'the header names the source');
  const trigger = panel().querySelector('.row-overflow-trigger');
  assert.equal(trigger.getAttribute('aria-label'), 'Changes source');
  assert.equal(trigger.dataset.tooltip, 'Changes source');
  await act(async () => trigger.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, button: 0 })));
  assert.deepEqual(
    sourceItems().map((item) => [
      item.textContent,
      item.getAttribute('aria-checked'),
      item.classList.contains('menu-separator'),
    ]),
    [
      ['Last turn', 'false', false],
      ['Current session', 'false', false],
      ['This branch', 'false', true],
      ['Uncommitted', 'true', false],
      ['Unstaged', 'false', false],
      ['Staged', 'false', false],
    ]
  );
  assert.equal(document.activeElement, sourceItems()[0], 'keyboard focus lands on the first source');
  // Escape closes only the picker.
  await act(async () =>
    document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  );
  assert.equal(document.querySelector('.row-overflow-menu'), null);
  assert.ok(panel(), 'the files menu stays open');

  await pick('Current session');
  assert.equal(window.localStorage.getItem('mixdog.session-changes-source.v1'), 'session');
  assert.ok(panel(), 'an empty source keeps the open menu');
  assert.equal(sourceName(), 'Current session');
  assert.equal(panel().querySelector('.turn-review-files-empty').textContent, 'No changes from this session.');
  assert.equal(panel().querySelectorAll('.turn-review-files-row').length, 0);
  assert.equal(panel().querySelector('.turn-review-files-foot').hidden, true);

  // Back to a source with files, from the same menu.
  await pick('Uncommitted');
  assert.equal(panel().querySelector('.turn-review-files-empty'), null);
  assert.deepEqual(
    [...panel().querySelectorAll('.turn-review-files-row')].map((row) => row.textContent),
    ['left-over.ts+4 −1']
  );

  // Closed on an empty source, the segment hides as before.
  await pick('Current session');
  await act(async () => panel().querySelector('.composer-island-close').click());
  await flush();
  assert.equal(segment(), null);
  window.localStorage.removeItem('mixdog.session-changes-source.v1');
});

const worktreeWorkspace = (overrides = {}) => ({
  projectPath: '/repo',
  repoCommonDir: '/repo/.git',
  cwd: '/data/worktrees/fix-login',
  worktreeId: 'wt-1',
  branch: 'mixdog/fix-login',
  baseCommit: 'abc123',
  mergeTarget: 'main',
  revision: 4,
  transition: { state: 'idle', txId: null },
  ...overrides,
});

const projectWorkspace = (overrides = {}) =>
  worktreeWorkspace({ worktreeId: null, cwd: '/repo', branch: 'main', mergeTarget: null, ...overrides });
const islandBranch = (name, current = false) => ({ name, current, remote: false, upstream: '' });
const projectMenu = () => ({
  workspace: projectWorkspace(),
  branches: [islandBranch('main', true), islandBranch('pr-67'), islandBranch('ext')],
  occupancy: [
    { branch: 'main', kind: 'current' },
    { branch: 'pr-67', kind: 'free' },
    { branch: 'ext', kind: 'external', path: '/elsewhere' },
  ],
  retainedWorktree: null,
});
const worktreeMenu = () => ({
  workspace: worktreeWorkspace(),
  branches: [islandBranch('main', true), islandBranch('mixdog/fix-login')],
  occupancy: [
    { branch: 'main', kind: 'current' },
    { branch: 'mixdog/fix-login', kind: 'session', sessionId: 'island-session' },
  ],
  retainedWorktree: null,
});

test('the branch segment shows for every git session: branch, detached commit, worktree', async (t) => {
  const { root, document, window } = mount(t);
  window.mixdogDesktop.gitStatus = async () => ({ branch: 'HEAD (0123abcd)', detached: true });
  const segment = () => document.querySelector('.composer-island-seg-branch');
  const render = (workspace) =>
    act(async () => root.render(React.createElement(ComposerDock, dockProps({ workspace }))));
  await render(null);
  assert.equal(segment(), null, 'no workspace, no segment');
  await render(projectWorkspace({ repoCommonDir: null, branch: null }));
  assert.equal(segment(), null, 'outside a git repository, no segment');
  // main: the branch glyph and the name; no worktree look.
  await render(projectWorkspace());
  assert.equal(segment().querySelector('.composer-island-seg-text').textContent, 'main');
  assert.ok(segment().querySelector('svg.lucide-git-branch'));
  assert.equal(segment().classList.contains('composer-island-seg-worktree'), false);
  assert.equal(segment().querySelector('.composer-island-seg-sub'), null);
  // A detached HEAD names its short commit.
  await render(projectWorkspace({ branch: null, baseCommit: null, revision: 5 }));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  assert.equal(segment().querySelector('.composer-island-seg-text').textContent, '0123abc');
  // The same session entering its worktree: the branch, its prefix and the base.
  await render(worktreeWorkspace());
  assert.ok(segment().classList.contains('composer-island-seg-worktree'));
  assert.ok(segment().querySelector('svg.lucide-git-fork'));
  assert.equal(segment().querySelector('.composer-island-seg-prefix').textContent, 'mixdog/');
  assert.equal(segment().querySelector('.composer-island-seg-text').textContent, 'mixdog/fix-login');
  assert.equal(segment().querySelector('.composer-island-seg-sub').textContent, 'main');
  assert.equal(segment().getAttribute('aria-expanded'), 'false');
  // A worktree folder that went missing names itself instead.
  await render(worktreeWorkspace({ transition: { state: 'recovery', txId: null } }));
  assert.ok(segment().classList.contains('composer-island-seg-warning'));
  assert.equal(segment().querySelector('.composer-island-seg-text').textContent, 'Worktree missing');
});

test('the worktree menu runs Merge through the confirm popup, shows conflicts in a popup and flashes the result', async (t) => {
  // The flash expires on a timer: tick a mocked clock instead of waiting it out.
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 5_000_000 });
  const { root, document, window } = mount(t);
  const calls = [];
  let reply = { merged: false, target: 'main', commit: null, conflicts: ['src/login.ts', 'src/session.ts'] };
  window.mixdogDesktop.invokeCapability = async (request) => {
    if (request.capability === 'getBranchMenu') return { value: worktreeMenu() };
    // The git action's change read is not a worktree call.
    if (request.capability === 'getSessionReviewDiff') return { value: null };
    calls.push(request);
    return { value: reply };
  };
  await act(async () => root.render(React.createElement(ComposerDock, dockProps({ workspace: worktreeWorkspace() }))));
  const segment = () => document.querySelector('.composer-island-seg-worktree');
  const menu = () => document.querySelector('.composer-island-branch-panel');
  const item = (id) => menu().querySelector(`[data-action-id="${id}"]`);
  await act(async () => segment().click());
  // An island tab like the others: the island expands into the branch panel.
  assert.ok(menu());
  assert.ok(document.querySelector('.composer-island').contains(menu()));
  assert.equal(document.querySelector('.composer-island').dataset.expanded, 'branch');
  assert.equal(segment().getAttribute('aria-expanded'), 'true');
  // Search and branches, then the worktree actions in the footer.
  assert.equal(menu().querySelector('input[type="search"]').placeholder, 'Search branches');
  assert.ok(menu().querySelector('.branch-row-more'), 'branch actions are available inside the island too');
  assert.equal(document.activeElement, item('merge'), 'focus starts on the first action');
  assert.deepEqual(
    [...menu().querySelectorAll('[data-action-id]')].map((node) => [
      node.textContent,
      Boolean(node.querySelector('svg')),
    ]),
    [
      ['Merge into main', true],
      ['Remove worktree', true],
    ]
  );
  assert.equal(item('remove').getAttribute('data-danger'), 'true');
  assert.deepEqual(
    [...menu().querySelectorAll('[data-kind="branch"]')].map((row) => [
      row.querySelector('span').textContent,
      row.querySelector('small')?.textContent ?? '',
    ]),
    [
      ['mixdog/fix-login', ''],
      ['main', 'Project folder'],
    ]
  );
  assert.equal(menu().querySelector('[data-kind="worktree"], [data-kind="create"]'), null);
  const popup = () => document.querySelector('.settings-confirm-dialog');
  const footer = () => [...popup().querySelectorAll('footer button')];
  // Merge closes the menu and asks in the confirm popup: nothing runs yet.
  await act(async () => item('merge').click());
  assert.equal(menu(), null);
  assert.equal(calls.length, 0);
  assert.equal(popup().querySelector('h3').textContent, 'Merge mixdog/fix-login into main?');
  assert.deepEqual(
    footer().map((node) => node.textContent),
    ['Cancel', 'Merge']
  );
  await act(async () => footer()[1].click());
  assert.deepEqual(calls, [
    {
      capability: 'mergeWorkspace',
      args: [{ confirmed: true, target: 'main', expectedRevision: 4, cleanup: true }],
      sessionId: 'island-session',
    },
  ]);
  // A conflicting preflight changed nothing: a popup names the files, with Close only.
  assert.equal(popup().querySelector('h3').textContent, "Couldn't merge");
  assert.match(popup().querySelector('p').textContent, /src\/login\.ts, src\/session\.ts/);
  assert.deepEqual(
    footer().map((node) => node.textContent),
    ['Close']
  );
  await act(async () => footer()[0].click());
  assert.equal(popup(), null);
  // A clean merge flashes the result on the island.
  reply = { merged: true, target: 'main', commit: 'def456' };
  await act(async () => segment().click());
  await act(async () => item('merge').click());
  await act(async () => footer()[1].click());
  assert.equal(popup(), null);
  assert.equal(document.querySelector('.composer-island-flash').textContent, 'Merged mixdog/fix-login into main');
  // A refused cleanup keeps the worktree but the merge still reads as done.
  await act(async () => t.mock.timers.tick(2_700));
  reply = { merged: true, target: 'main', commit: 'fed789', cleanup: { removed: false, code: 'WORKTREE_DIRTY' } };
  await act(async () => segment().click());
  await act(async () => item('merge').click());
  await act(async () => footer()[1].click());
  assert.equal(popup(), null, 'never "Couldn\'t merge"');
  assert.equal(
    document.querySelector('.composer-island-flash').textContent,
    'Merged mixdog/fix-login into main; the worktree was kept'
  );
  // The notice belongs to the merging session: another session in the same
  // pane never shows it, and returning after it expired does not replay it.
  await act(async () =>
    root.render(
      React.createElement(
        ComposerDock,
        dockProps({ workspace: worktreeWorkspace(), sessionId: 'other-session', reviewSessionId: 'other-session' })
      )
    )
  );
  assert.equal(document.querySelector('.composer-island-flash'), null);
  await act(async () => t.mock.timers.tick(2_700));
  await act(async () => root.render(React.createElement(ComposerDock, dockProps({ workspace: worktreeWorkspace() }))));
  assert.equal(document.querySelector('.composer-island-flash'), null);
});

test('removing the worktree asks in a danger popup and a refusal shows in a popup', async (t) => {
  const { root, document, window } = mount(t);
  const calls = [];
  window.mixdogDesktop.invokeCapability = async (request) => {
    if (request.capability === 'getBranchMenu') return { value: worktreeMenu() };
    // The git action's change read is not a worktree call.
    if (request.capability === 'getSessionReviewDiff') return { value: null };
    calls.push(request);
    throw new Error('WORKTREE_DIRTY: The worktree has uncommitted changes.');
  };
  await act(async () => root.render(React.createElement(ComposerDock, dockProps({ workspace: worktreeWorkspace() }))));
  const menu = () => document.querySelector('.composer-island-branch-panel');
  const segment = () => document.querySelector('.composer-island-seg-worktree');
  const popup = () => document.querySelector('.settings-confirm-dialog');
  // Escape closes the menu and hands focus back to the segment.
  await act(async () => segment().click());
  await act(async () =>
    menu()
      .querySelector('[data-action-id]')
      .dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  );
  assert.equal(menu(), null);
  assert.equal(document.activeElement, segment());
  await act(async () => segment().click());
  await act(async () => menu().querySelector('[data-action-id="remove"]').click());
  assert.equal(calls.length, 0);
  assert.equal(popup().querySelector('h3').textContent, 'Remove this worktree?');
  const confirm = popup().querySelector('footer button.danger');
  assert.equal(confirm.textContent, 'Remove');
  await act(async () => confirm.click());
  assert.deepEqual(calls, [
    { capability: 'removeWorktree', args: [{ expectedRevision: 4 }], sessionId: 'island-session' },
  ]);
  assert.equal(popup().querySelector('h3').textContent, "Couldn't remove the worktree");
  assert.equal(popup().querySelector('p').textContent, 'The worktree has uncommitted changes.');
});

test('a merge whose route changes mid-flight still flashes on the merging session only, once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 5_000_000 });
  const { root, document, window } = mount(t);
  let release = () => {};
  window.mixdogDesktop.invokeCapability = async (request) => {
    if (request.capability === 'getBranchMenu') return { value: worktreeMenu() };
    if (request.capability !== 'mergeWorkspace') return { value: null };
    // Gate the merge: it settles only when the test says so.
    await new Promise((resolve) => {
      release = resolve;
    });
    return { value: { merged: true, target: 'main', commit: 'gated1' } };
  };
  const render = (props) =>
    act(async () =>
      root.render(React.createElement(ComposerDock, dockProps({ workspace: worktreeWorkspace(), ...props })))
    );
  const flash = () => document.querySelector('.composer-island-flash');
  await render({});
  await act(async () => document.querySelector('.composer-island-seg-worktree').click());
  await act(async () => document.querySelector('.composer-island-branch-panel [data-action-id="merge"]').click());
  await act(async () => [...document.querySelectorAll('.settings-confirm-dialog footer button')][1].click());
  // The route address of the same session changes while the merge runs: the
  // island remounts under the new key.
  await render({ reviewSessionId: 'island-session-route-2' });
  await act(async () => release());
  await act(async () => t.mock.timers.tick(0));
  assert.equal(flash()?.textContent, 'Merged mixdog/fix-login into main');
  // Another session never shows it, and after it expired a return does not replay it.
  await render({ sessionId: 'other-session', reviewSessionId: 'other-session' });
  assert.equal(flash(), null);
  await act(async () => t.mock.timers.tick(2_700));
  await render({ reviewSessionId: 'island-session-route-2' });
  assert.equal(flash(), null);
});

test('the uncommitted-files choice closes the island branch menu; Cancel leaves it closed', async (t) => {
  const { root, document, window } = mount(t);
  window.mixdogDesktop.invokeCapability = async (request) => {
    if (request.capability === 'getBranchMenu') return { value: projectMenu() };
    throw new Error('WORKTREE_DIRTY_CHOICE: dirty\n[worktree-details] {"count":2,"paths":["a.ts","b.ts"]}');
  };
  await act(async () => root.render(React.createElement(ComposerDock, dockProps({ workspace: projectWorkspace() }))));
  const segment = () => document.querySelector('.composer-island-seg-branch');
  const menu = () => document.querySelector('.composer-island-branch-panel');
  const dialog = () => document.querySelector('.worktree-carry-dialog');
  await act(async () => segment().click());
  await act(async () => menu().querySelector('[data-kind="branch"]:not([data-mark])').click());
  assert.ok(dialog(), 'the choice opened');
  assert.equal(menu(), null, 'the menu closed before the dialog opened');
  assert.equal(segment().getAttribute('aria-expanded'), 'false');
  await act(async () => dialog().querySelector('footer [data-choice="cancel"]').click());
  assert.equal(dialog(), null);
  assert.equal(menu(), null);
  assert.ok(segment(), 'the segment stays');
});

test('the branch segment keeps the last branch while a refused move re-reads the workspace', async (t) => {
  const { root, document, window } = mount(t);
  let menuRead = 0;
  window.mixdogDesktop.invokeCapability = async (request) => {
    if (request.capability === 'getBranchMenu') {
      menuRead += 1;
      // The first read names the branch; later reads fail mid-transition.
      if (menuRead === 1) return { value: projectMenu() };
      throw new Error('WORKTREE_BUSY_JOBS: busy');
    }
    throw new Error(
      'WORKTREE_DIRTY: refused\n[worktree-details] {"reason":"operation-in-progress","operation":"merge"}'
    );
  };
  const segment = () => document.querySelector('.composer-island-seg-branch');
  const render = (props) =>
    act(async () => root.render(React.createElement(ComposerDock, dockProps({ workspace: null, ...props }))));
  // A session that never left its folder publishes no workspace: the menu read names the branch.
  await render({});
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  assert.equal(segment().querySelector('.composer-island-seg-text').textContent, 'main');
  // Work starts and settles (each re-reads the menu, which now fails): never a gap.
  await render({ reviewBusy: true });
  assert.equal(segment()?.querySelector('.composer-island-seg-text').textContent, 'main');
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  assert.equal(segment()?.querySelector('.composer-island-seg-text').textContent, 'main');
  await render({ reviewBusy: false });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  assert.ok(menuRead >= 3);
  assert.equal(segment()?.querySelector('.composer-island-seg-text').textContent, 'main');
  // A live snapshot dropping its workspace mid-move keeps the last one too.
  await render({ workspace: projectWorkspace({ branch: 'pr-67' }) });
  assert.equal(segment().querySelector('.composer-island-seg-text').textContent, 'pr-67');
  await render({ workspace: projectWorkspace({ branch: null, repoCommonDir: null }) });
  // The stub stands aside for the menu's workspace (the last read: main).
  assert.equal(segment()?.querySelector('.composer-island-seg-text').textContent, 'main');
  // Another session starts from its own state.
  await render({ sessionId: 'other-session', reviewSessionId: 'other-session', workspace: null });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  assert.equal(segment(), null);
});

test('on main the segment opens the New Task branch menu; Worktree provisions now', async (t) => {
  const { root, document, window } = mount(t);
  const calls = [];
  window.mixdogDesktop.invokeCapability = async (request) => {
    calls.push(request);
    if (request.capability === 'getBranchMenu') return { value: projectMenu() };
    return { value: { revision: 5, workspace: worktreeWorkspace({ revision: 5 }) } };
  };
  await act(async () => root.render(React.createElement(ComposerDock, dockProps({ workspace: projectWorkspace() }))));
  const segment = () => document.querySelector('.composer-island-seg-branch');
  const menu = () => document.querySelector('.composer-island-branch-panel');
  await act(async () => segment().click());
  assert.equal(menu().querySelector('input[type="search"]').placeholder, 'Search branches');
  assert.ok(menu().querySelector('.branch-row-more'));
  assert.equal(menu().querySelector('.composer-island-pfoot [data-kind="create"]').textContent, 'New branch');
  const rows = [...menu().querySelectorAll('.branch-menu-list .branch-menu-item')];
  assert.deepEqual(
    rows.map((row) => [row.querySelector('span').textContent, row.querySelector('small')?.textContent ?? '']),
    [
      ['Worktree', 'New branch · separate folder'],
      ['main', ''],
      ['pr-67', ''],
      ['ext', 'Worktree'],
    ]
  );
  assert.deepEqual(
    [...menu().querySelectorAll('.branch-menu-check')].map((check) => check.closest('[data-branch]')?.dataset.branch),
    ['main'],
    'without the worktree intent the check marks the current branch alone'
  );
  for (const shell of menu().querySelectorAll('.branch-row-shell')) {
    assert.ok(shell.querySelector(':scope > .branch-menu-item'), 'the row is in its shell');
    assert.ok(shell.querySelector(':scope > .branch-row-more'), 'the … trigger sits in the same row shell');
  }
  await act(async () => rows[0].click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  assert.deepEqual(
    calls.filter((call) => call.capability === 'requestWorktree'),
    [{ capability: 'requestWorktree', args: [{ expectedRevision: 4, provision: true }], sessionId: 'island-session' }]
  );
  assert.equal(menu(), null);
});

test('while work runs the menu opens without a warning and no switch starts', async (t) => {
  const { root, document, window, publishPool } = mount(t);
  const calls = [];
  window.mixdogDesktop.invokeCapability = async (request) => {
    calls.push(request);
    return { value: projectMenu() };
  };
  const render = (props) =>
    act(async () =>
      root.render(React.createElement(ComposerDock, dockProps({ workspace: projectWorkspace(), ...props })))
    );
  const segment = () => document.querySelector('.composer-island-seg-branch');
  const menu = () => document.querySelector('.composer-island-branch-panel');
  const locked = () => menu().querySelector('[data-kind="worktree"]').getAttribute('aria-disabled') === 'true';
  const open = async () => {
    if (menu()) await act(async () => segment().click());
    await act(async () => segment().click());
  };
  // A running turn.
  await render({ reviewBusy: true });
  await open();
  assert.equal(menu().querySelector('.branch-menu-notice[data-kind="locked"]'), null);
  assert.equal(menu().textContent.includes("Can't switch while work is running"), false);
  assert.equal(
    menu().querySelector('.composer-island-pbody').firstElementChild.classList.contains('branch-menu-search-frame'),
    true
  );
  const state = (kind, name) =>
    menu()
      .querySelector(name ? `[data-kind="${kind}"]:has(> span:first-of-type)` : `[data-kind="${kind}"]`)
      .getAttribute('aria-disabled');
  assert.equal(state('worktree'), 'true');
  assert.equal(state('create'), 'true');
  const rows = [...menu().querySelectorAll('[data-kind="branch"]')];
  assert.equal(rows[0].getAttribute('aria-disabled'), null, 'the current branch stays as it is');
  assert.equal(rows[1].getAttribute('aria-disabled'), 'true');
  await act(async () => menu().querySelector('[data-kind="worktree"]').click());
  await act(async () => rows[1].click());
  assert.deepEqual(
    calls.filter((call) => call.capability !== 'getBranchMenu' && call.capability !== 'getSessionReviewDiff'),
    [],
    'nothing is scheduled or sent'
  );
  // An unread message sent behind the turn, a running agent, a running shell: each locks.
  await render({ pendingInput: true });
  await open();
  assert.ok(locked());
  await render({});
  await open();
  assert.equal(locked(), false, 'idle: unlocked');
  await publishPool([poolAgent('run-a')]);
  assert.ok(locked());
  await publishPool([poolAgent('done-a', { stage: 'idle', status: 'idle' })]);
  assert.equal(locked(), false, 'a finished agent does not lock');
  await publish({ shellJobs: { count: 1, jobs: [{ taskId: 'j', command: 'npm run dev', startedAt: Date.now() }] } });
  assert.ok(locked());
});

const tick = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

test('the branch segment paints at once from the last known workspace when a session is shown again', async (t) => {
  const { root, document, window } = mount(t);
  const gate = Promise.withResolvers();
  let gated = false;
  window.mixdogDesktop.invokeCapability = async (request) => {
    if (request.capability !== 'getBranchMenu') return { value: null };
    if (gated) await gate.promise;
    return { value: projectMenu() };
  };
  const segmentText = () =>
    document.querySelector('.composer-island-seg-branch')?.querySelector('.composer-island-seg-text')?.textContent;
  const render = (props) =>
    act(async () => root.render(React.createElement(ComposerDock, dockProps({ workspace: null, ...props }))));
  await render({});
  await tick();
  assert.equal(segmentText(), 'main');
  // Another session shows (the island remounts), then this one again while
  // its workspace read is still outstanding: never a pill without the branch.
  gated = true;
  await render({ sessionId: 'other-session', reviewSessionId: 'other-session' });
  await render({});
  assert.equal(segmentText(), 'main', 'cached branch before the background refresh answers');
  gate.resolve();
  await tick();
  assert.equal(segmentText(), 'main');
});

test('the branch menu opens with its cached list and a fresh list updates in place, keeping the focused row', async (t) => {
  const { root, document, window } = mount(t);
  let gate = null;
  const fresh = () => ({
    ...projectMenu(),
    branches: [islandBranch('aaa-new'), ...projectMenu().branches],
    occupancy: [...projectMenu().occupancy, { branch: 'aaa-new', kind: 'free' }],
  });
  window.mixdogDesktop.invokeCapability = async (request) => {
    if (request.capability !== 'getBranchMenu') return { value: null };
    if (gate) await gate.promise;
    return { value: gate ? fresh() : projectMenu() };
  };
  await act(async () => root.render(React.createElement(ComposerDock, dockProps({ workspace: projectWorkspace() }))));
  const segment = () => document.querySelector('.composer-island-seg-branch');
  const menu = () => document.querySelector('.composer-island-branch-panel');
  const names = () => [...menu().querySelectorAll('[data-kind="branch"]')].map((row) => row.dataset.branch);
  await act(async () => segment().click());
  await tick();
  assert.deepEqual(names(), ['main', 'pr-67', 'ext']);
  await act(async () => segment().click());
  assert.equal(menu(), null);
  // Reopen: the cached list is there at once while the re-read is outstanding.
  gate = Promise.withResolvers();
  await act(async () => segment().click());
  assert.deepEqual(names(), ['main', 'pr-67', 'ext']);
  assert.equal(menu().querySelector('[data-loading]'), null, 'a cached list shows no loading state');
  const row = menu().querySelector('[data-branch="pr-67"]');
  row.focus();
  gate.resolve();
  await tick();
  assert.deepEqual(names(), ['main', 'aaa-new', 'pr-67', 'ext']);
  assert.equal(menu().querySelector('[data-branch="pr-67"]'), row, 'the same row element is kept');
  assert.equal(document.activeElement, row, 'focus stays on the row');
});

test('without a cached list the branch menu shows a loading line until the first list arrives', async (t) => {
  const { root, document, window } = mount(t);
  const gate = Promise.withResolvers();
  window.mixdogDesktop.invokeCapability = async (request) => {
    if (request.capability !== 'getBranchMenu') return { value: null };
    await gate.promise;
    return { value: projectMenu() };
  };
  await act(async () => root.render(React.createElement(ComposerDock, dockProps({ workspace: projectWorkspace() }))));
  await act(async () => document.querySelector('.composer-island-seg-branch').click());
  const menu = () => document.querySelector('.composer-island-branch-panel');
  assert.equal(menu().querySelector('[data-loading]').textContent, 'Loading branches…');
  assert.equal(menu().querySelectorAll('[data-kind="branch"]').length, 0);
  gate.resolve();
  await tick();
  assert.equal(menu().querySelector('[data-loading]'), null);
  assert.equal(menu().querySelectorAll('[data-kind="branch"]').length, 3);
});

test('a chosen branch shows a spinner on its row and a pending mark on the segment until a refusal arrives', async (t) => {
  const { root, document, window } = mount(t);
  const gate = Promise.withResolvers();
  window.mixdogDesktop.invokeCapability = async (request) => {
    if (request.capability === 'getBranchMenu') return { value: projectMenu() };
    await gate.promise;
    throw new Error(
      'WORKTREE_DIRTY: refused\n[worktree-details] {"reason":"operation-in-progress","operation":"merge"}'
    );
  };
  await act(async () => root.render(React.createElement(ComposerDock, dockProps({ workspace: projectWorkspace() }))));
  const segment = () => document.querySelector('.composer-island-seg-branch');
  const menu = () => document.querySelector('.composer-island-branch-panel');
  await act(async () => segment().click());
  await tick();
  const row = menu().querySelector('[data-branch="pr-67"]');
  assert.equal(segment().getAttribute('aria-busy'), null);
  await act(async () => row.click());
  // Nothing has arrived yet: the choice is already visible.
  assert.equal(row.dataset.pending, 'true');
  assert.ok(row.querySelector('.progress-spinner-turn'), 'the chosen row spins');
  assert.equal(menu().querySelector('[data-branch="main"] .progress-spinner-turn'), null, 'other rows do not');
  assert.equal(segment().getAttribute('aria-busy'), 'true');
  assert.ok(segment().querySelector('.progress-spinner-turn'), 'the segment shows a pending mark');
  assert.equal(segment().querySelector('.composer-island-seg-pending'), null, 'a checkout is not a worktree move');
  gate.resolve();
  await tick();
  assert.ok(menu().querySelector('.branch-menu-notice[role="alert"]'), 'the refusal notice');
  assert.equal(menu().querySelector('[data-pending]'), null);
  assert.equal(segment().getAttribute('aria-busy'), null);
  assert.equal(segment().querySelector('.progress-spinner-turn'), null);
});

test('moving into a worktree with carried changes shows a pending line on the segment until it settles', async (t) => {
  const { root, document, window } = mount(t);
  const gate = Promise.withResolvers();
  window.mixdogDesktop.invokeCapability = async (request) => {
    if (request.capability === 'getBranchMenu') return { value: projectMenu() };
    if (!request.args[0].carryChanges) {
      throw new Error('WORKTREE_DIRTY_CHOICE: dirty\n[worktree-details] {"count":2,"paths":["a.ts","b.ts"]}');
    }
    await gate.promise;
    return { value: { revision: 5, workspace: worktreeWorkspace({ revision: 5 }) } };
  };
  await act(async () => root.render(React.createElement(ComposerDock, dockProps({ workspace: projectWorkspace() }))));
  const segment = () => document.querySelector('.composer-island-seg-branch');
  const text = () => segment().querySelector('.composer-island-seg-text');
  await act(async () => segment().click());
  await tick();
  await act(async () => document.querySelector('.composer-island-branch-panel [data-kind="worktree"]').click());
  assert.ok(document.querySelector('.worktree-carry-dialog'));
  assert.equal(segment().querySelector('.composer-island-seg-pending'), null, 'nothing runs while the user chooses');
  assert.equal(segment().getAttribute('aria-busy'), null);
  await act(async () => document.querySelector('.worktree-carry-dialog footer [data-choice="carry"]').click());
  // The width never changes: the label stays the branch, the move is named in the tooltip and aria.
  assert.equal(segment().querySelector('.composer-island-seg-pending'), null);
  assert.equal(segment().title, 'Moving to the worktree…');
  assert.match(segment().getAttribute('aria-label'), /Moving to the worktree…$/);
  assert.ok(segment().querySelector('.progress-spinner-turn'));
  assert.equal(segment().getAttribute('aria-busy'), 'true');
  // The branch name keeps its place in the same cell, so the width holds.
  assert.equal(text().querySelector('.composer-island-seg-label').textContent, 'main');
  gate.resolve();
  await tick();
  assert.equal(segment().querySelector('.composer-island-seg-pending'), null);
  assert.equal(segment().getAttribute('aria-busy'), null);
});

test('a shell finishing never drops out of the segment between the running and finished records', async (t) => {
  const { root, document } = mount(t);
  const job = (id, startedAt) => ({ taskId: id, command: 'npm test', startedAt });
  const segment = () => document.querySelector('.composer-island-seg-shell');
  const done = (id, startedAt) => ({
    taskId: id,
    command: 'npm test',
    startedAt,
    status: 'completed',
    exitCode: 0,
    finishedAt: Date.now(),
  });
  await act(async () => root.render(React.createElement(ComposerDock, dockProps())));
  await publish({ shellJobs: { count: 2, jobs: [job('a', 1000), job('b', 2000)], finished: [done('z', 500)] } });
  assert.equal(segment().textContent, '2 shells', 'running shells only');
  // The host drops "b" from the running list before it lists it as finished.
  await publish({ shellJobs: { count: 1, jobs: [job('a', 1000)], finished: [done('z', 500)] } });
  assert.equal(segment().textContent, '2 shells', 'the count does not dip');
  assert.ok(segment().querySelector('.composer-island-pulse'), 'still running');
  await publish({ shellJobs: { count: 1, jobs: [job('a', 1000)], finished: [done('b', 2000), done('z', 500)] } });
  // Lane publications coalesce per animation frame.
  await act(() => sleep(40));
  assert.equal(segment().textContent, '1 shell');
});

test('a shell whose finished record never comes leaves the segment after the grace', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const { root, document } = mount(t);
  await act(async () => root.render(React.createElement(ComposerDock, dockProps())));
  await publish({ shellJobs: { count: 1, jobs: [{ taskId: 'a', command: 'x', startedAt: 1000 }] } });
  await publish({ shellJobs: { count: 0, jobs: [] } });
  assert.ok(document.querySelector('.composer-island-seg-shell'), 'kept during the grace');
  await act(async () => t.mock.timers.tick(2100));
  assert.equal(document.querySelector('.composer-island-seg-shell'), null);
});

test('the branch segment opens an island tab: ✕, outside press and Escape collapse it; a row selects', async (t) => {
  const { root, document, window } = mount(t);
  const calls = [];
  window.mixdogDesktop.invokeCapability = async (request) => {
    calls.push(request);
    if (request.capability === 'getBranchMenu') return { value: projectMenu() };
    return { value: { revision: 5, workspace: projectWorkspace({ branch: 'pr-67', revision: 5 }) } };
  };
  await act(async () => root.render(React.createElement(ComposerDock, dockProps({ workspace: projectWorkspace() }))));
  const island = () => document.querySelector('.composer-island');
  const segment = () => document.querySelector('.composer-island-seg-branch');
  const panel = () => document.querySelector('.composer-island-branch-panel');
  // No floating popup anywhere: the menu lives in the island.
  await act(async () => segment().click());
  await tick();
  assert.equal(document.querySelector('.branch-menu'), null);
  assert.ok(island().contains(panel()));
  assert.equal(island().dataset.expanded, 'branch');
  assert.equal(document.querySelector('.composer-island-slot').dataset.mode, 'panel');
  assert.equal(panel().querySelector('.composer-island-phead .composer-island-tab').textContent, 'main');
  assert.ok(panel().querySelector('.composer-island-tab svg.lucide-git-branch'));
  assert.equal(panel().querySelector('.branch-menu-search').placeholder, 'Search branches');
  assert.equal(panel().querySelector('[data-kind="worktree"] small').textContent, 'New branch · separate folder');
  assert.ok(panel().querySelector('[data-branch="main"] .branch-menu-check'), '✓ on the current branch');
  assert.equal(panel().querySelector('[data-branch="main"] small'), null, 'the check replaces the label');
  assert.equal(panel().querySelectorAll('.branch-menu-check').length, 1);
  assert.equal(panel().querySelector('[data-branch="ext"] small').textContent, 'Worktree');
  assert.ok(
    panel().querySelector('[data-branch="ext"] svg.lucide-git-fork'),
    'a worktree branch shows the worktree icon'
  );
  // ✕ closes and hands focus back.
  await act(async () => panel().querySelector('.composer-island-close').click());
  assert.equal(panel(), null);
  assert.equal(island().dataset.expanded, undefined);
  assert.equal(document.activeElement, segment());
  // An outside press closes.
  await act(async () => segment().click());
  await act(async () =>
    document.body.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, button: 0 }))
  );
  assert.equal(panel(), null);
  // Escape closes.
  await act(async () => segment().click());
  await act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' })));
  assert.equal(panel(), null);
  // A press inside the tab keeps it; a branch row switches and the tab collapses.
  await act(async () => segment().click());
  await act(async () =>
    panel()
      .querySelector('.branch-menu-search')
      .dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true }))
  );
  assert.ok(panel());
  await act(async () => panel().querySelector('[data-branch="pr-67"]').click());
  await tick();
  assert.deepEqual(
    calls.filter((call) => call.capability === 'selectBranch').map((call) => call.args[0].branch),
    ['pr-67']
  );
  assert.equal(panel(), null);
});

test('an in-use branch row reads Worktree, carries no explanatory tooltip and shares its folder', async (t) => {
  const { root, document, window } = mount(t);
  const base = worktreeMenu();
  const menuWithHolder = {
    ...base,
    branches: [...base.branches, { name: 'held', remote: false }],
    occupancy: [...base.occupancy, { branch: 'held', kind: 'session', sessionId: 'holder-1' }],
  };
  window.mixdogDesktop.invokeCapability = async (request) => ({
    value: request.capability === 'getBranchMenu' ? menuWithHolder : null,
  });
  await act(async () => root.render(React.createElement(ComposerDock, dockProps({ workspace: worktreeWorkspace() }))));
  await act(async () => document.querySelector('.composer-island-seg-worktree').click());
  await tick();
  const row = document.querySelector('.composer-island-branch-panel [data-branch="held"]');
  assert.equal(row.querySelector('small').textContent, 'Worktree');
  assert.equal(row.dataset.tooltip, undefined);
});
test('first frame: a snapshot workspace paints the branch segment at once and the menu is not read until used', async (t) => {
  const { root, document, window } = mount(t);
  const reads = [];
  window.mixdogDesktop.invokeCapability = async (request) => {
    if (request.capability === 'getBranchMenu') reads.push(request.capability);
    return new Promise(() => {});
  };
  await act(async () => root.render(React.createElement(ComposerDock, dockProps({ workspace: projectWorkspace() }))));
  await tick();
  assert.equal(document.querySelector('.composer-island-seg-branch .composer-island-seg-label').textContent, 'main');
  assert.deepEqual(reads, [], 'booting reads no branch menu (it is large over the relay)');
  await act(async () => document.querySelector('.composer-island-seg-branch').click());
  assert.deepEqual(reads, ['getBranchMenu'], 'opening the tab reads it');
});

test('a turn transition re-reads the menu while the tab is open, and not while it is closed', async (t) => {
  const { root, document, window } = mount(t);
  let reads = 0;
  window.mixdogDesktop.invokeCapability = async (request) => {
    if (request.capability !== 'getBranchMenu') return { value: null };
    reads += 1;
    return { value: projectMenu() };
  };
  const render = (reviewBusy) =>
    act(async () =>
      root.render(React.createElement(ComposerDock, dockProps({ workspace: projectWorkspace(), reviewBusy })))
    );
  await render(false);
  await tick();
  // Closed: a turn starting and ending reads nothing.
  await render(true);
  await render(false);
  await tick();
  assert.equal(reads, 0);
  // Open: the next transition keeps the rows current.
  await act(async () => document.querySelector('.composer-island-seg-branch').click());
  await tick();
  const opened = reads;
  assert.ok(opened > 0);
  await render(true);
  await tick();
  assert.ok(reads > opened, 'the open tab follows the turn');
});

test('the branch list is ready before the tab opens: its rows render in the first frame', async (t) => {
  const { root, document, window } = mount(t);
  let reads = 0;
  let gate = null;
  window.mixdogDesktop.invokeCapability = async (request) => {
    if (request.capability !== 'getBranchMenu') return { value: null };
    reads += 1;
    if (gate) await gate.promise;
    return { value: projectMenu() };
  };
  await act(async () => root.render(React.createElement(ComposerDock, dockProps({ workspace: projectWorkspace() }))));
  await tick();
  assert.equal(reads, 0, 'nothing is read at mount');
  const segment = () => document.querySelector('.composer-island-seg-branch');
  // Hover and focus read it ahead of the click.
  await act(async () =>
    segment().dispatchEvent(new window.MouseEvent('pointerover', { bubbles: true, relatedTarget: document.body }))
  );
  await tick();
  assert.equal(reads, 1, 'hover reads ahead');
  await act(async () => segment().focus());
  await tick();
  assert.equal(reads, 2, 'focus reads ahead');
  // Opening while a re-read is outstanding: the rows are there in the very first frame.
  gate = Promise.withResolvers();
  const frames = [];
  const observer = new window.MutationObserver(() => {
    const panel = document.querySelector('.composer-island-branch-panel');
    if (panel) frames.push(panel.querySelectorAll('[data-kind="branch"]').length);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  await act(async () => segment().click());
  observer.disconnect();
  assert.ok(frames.length > 0);
  assert.ok(
    frames.every((count) => count === 3),
    'never an empty or loading panel'
  );
  assert.equal(document.querySelector('.composer-island-branch-panel [data-loading]'), null);
  gate.resolve();
  await tick();
  assert.equal(document.querySelectorAll('.composer-island-branch-panel [data-kind="branch"]').length, 3);
});

test('a stub snapshot workspace falls back to the menu read, which also brings the segment', async (t) => {
  const { root, document, window } = mount(t);
  let reads = 0;
  window.mixdogDesktop.invokeCapability = async (request) => {
    if (request.capability !== 'getBranchMenu') return { value: null };
    reads += 1;
    return { value: projectMenu() };
  };
  const stub = projectWorkspace({ branch: null, repoCommonDir: null });
  await act(async () => root.render(React.createElement(ComposerDock, dockProps({ workspace: stub }))));
  await tick();
  assert.equal(reads, 1);
  assert.equal(document.querySelector('.composer-island-seg-branch .composer-island-seg-label').textContent, 'main');
});

test('a failed read keeps the last good menu and is retried with backoff', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { root, document, window } = mount(t);
  let reads = 0;
  window.mixdogDesktop.invokeCapability = async (request) => {
    if (request.capability !== 'getBranchMenu') return { value: null };
    reads += 1;
    if (reads === 2) throw new Error('WORKTREE_BUSY_JOBS: busy');
    if (reads === 1 || reads === 3) return { value: projectMenu() };
    throw new Error('unexpected read');
  };
  const stub = projectWorkspace({ branch: null, repoCommonDir: null });
  await act(async () =>
    root.render(React.createElement(ComposerDock, dockProps({ workspace: stub, reviewBusy: false })))
  );
  assert.equal(document.querySelector('.composer-island-seg-branch .composer-island-seg-label').textContent, 'main');
  // Work starts and settles: the re-read fails, the segment keeps the last good menu.
  await act(async () =>
    root.render(React.createElement(ComposerDock, dockProps({ workspace: stub, reviewBusy: true })))
  );
  assert.equal(reads, 2);
  assert.equal(document.querySelector('.composer-island-seg-branch .composer-island-seg-label').textContent, 'main');
  await act(async () => t.mock.timers.tick(900));
  assert.equal(reads, 3, 'retried after the first backoff');
  assert.equal(document.querySelector('.composer-island-seg-branch .composer-island-seg-label').textContent, 'main');
});
test('a route session without its first lane snapshot mounts no island; it then mounts whole, branch included', async (t) => {
  const { root, document } = mount(t);
  await act(async () =>
    root.render(
      React.createElement(
        ComposerDock,
        dockProps({ sessionId: '', reviewSessionId: 'island-session', workspace: null })
      )
    )
  );
  assert.equal(document.querySelector('.composer-island'), null, 'no empty island while the snapshot is outstanding');
  const frames = [];
  const observer = new window.MutationObserver(() => {
    const island = document.querySelector('.composer-island');
    if (island) frames.push(Boolean(island.querySelector('.composer-island-seg-branch')));
  });
  observer.observe(document.body, { childList: true, subtree: true });
  await act(async () => root.render(React.createElement(ComposerDock, dockProps({ workspace: projectWorkspace() }))));
  observer.disconnect();
  assert.ok(frames.length > 0);
  assert.ok(frames.every(Boolean), 'every observed island state already has the branch segment');
});

test('with its snapshot a session outside any git repository mounts its island once, without a branch segment', async (t) => {
  const { root, document } = mount(t);
  await act(async () => root.render(React.createElement(ComposerDock, dockProps({ workspace: null }))));
  assert.ok(document.querySelector('.composer-island'));
  assert.equal(document.querySelector('.composer-island-seg-branch'), null);
});

/** A dock on a Git checkout at `cwd` with `files` uncommitted and `ahead`
 *  commits: the files, branch and git segments all read it. */
async function gitDock(t, { cwd, files = [], ahead = 0, repository = true, pool = [], shells = null }) {
  const mounted = mount(t);
  const { root, window, publishPool } = mounted;
  await import('./TurnReview');
  window.localStorage.removeItem('mixdog.session-changes-source.v1');
  const status = {
    repository,
    root: cwd,
    branch: 'main',
    detached: false,
    unborn: false,
    upstream: true,
    upstreamName: 'origin/main',
    remote: true,
    ahead,
    behind: 0,
    operation: '',
    files: files.map((path) => ({ path, status: 'M', additions: 1, deletions: 0 })),
  };
  const sent = [];
  window.mixdogDesktop.gitStatus = async () => status;
  window.mixdogDesktop.gitReview = async () => ({
    repository,
    root: cwd,
    base: 'HEAD',
    files: files.map((path) => ({ path, status: 'M', additions: 1, deletions: 0, untracked: false })),
  });
  window.mixdogDesktop.submitToSession = async (sessionId, _content, options) => {
    sent.push({ sessionId, action: parseIslandGitRequestText(options.displayText)?.action });
    return true;
  };
  window.mixdogDesktop.invokeCapability = async (request) => {
    if (request.capability === 'getBranchMenu')
      return { value: { ...projectMenu(), workspace: projectWorkspace({ cwd }) } };
    if (request.capability === 'getTurnReviewDiff') {
      return { value: { supported: true, authoritative: true, files: [], patch: '', historyTurns: 1 } };
    }
    return { value: { supported: true, authoritative: true, files: [], patch: '' } };
  };
  if (shells) await publish({ shellJobs: shells });
  const props = dockProps({
    workspace: repository ? projectWorkspace({ cwd }) : null,
    reviewSessionId: 'island-session',
    reviewCwd: cwd,
    reviewItems: [{ kind: 'turndone', id: `${cwd}-done` }],
    onOpenSessionDiff: () => {},
  });
  const render = () => act(async () => root.render(React.createElement(ComposerDock, props)));
  await render();
  if (pool.length) await publishPool(pool);
  return { ...mounted, sent, render };
}

const gitMain = (document) => document.querySelector('.composer-island-git-main');

test('pill order: agents · shells │ branch · files · git action', async (t) => {
  const { document } = await gitDock(t, {
    cwd: 'C:/git-order',
    files: ['a.ts'],
    pool: [poolAgent('order-a')],
    shells: { count: 1, jobs: [{ taskId: 'order-j', command: 'npm test', startedAt: Date.now() }] },
  });
  const kinds = [...document.querySelector('.composer-island-pill').children]
    .filter((node) => !node.hidden)
    .map((node) => {
      for (const [kind, selector] of [
        ['agents', '.composer-island-seg-agents'],
        ['shells', '.composer-island-seg-shell'],
        ['divider', '.composer-island-divider'],
        ['branch', '.composer-island-seg-branch'],
        ['files', '.turn-review-segment'],
        ['git', '.composer-island-git'],
      ]) {
        if (node.matches(selector)) return kind;
      }
      return node.className;
    });
  assert.deepEqual(kinds, ['agents', 'shells', 'divider', 'branch', 'files', 'git']);
});

test('the git action shows with files or commits ahead, and never outside a repository', async (t) => {
  await t.test('files', async (t) => {
    const { document } = await gitDock(t, { cwd: 'C:/git-vis-files', files: ['a.ts'] });
    assert.ok(gitMain(document));
    assert.equal(gitMain(document).textContent, translate('Git'));
    // One island segment: a single button, no separate menu chevron.
    const segment = document.querySelector('.composer-island-git');
    assert.ok(segment.classList.contains('composer-island-seg'));
    assert.deepEqual(
      [...segment.children].map((node) => node.className),
      ['composer-island-git-main']
    );
    assert.equal(segment.querySelector('svg.lucide-chevron-down'), null);
  });
  await t.test('ahead only', async (t) => {
    const { document } = await gitDock(t, { cwd: 'C:/git-vis-ahead', ahead: 2 });
    assert.ok(gitMain(document));
  });
  await t.test('nothing to commit or push', async (t) => {
    const { document } = await gitDock(t, { cwd: 'C:/git-vis-clean' });
    assert.ok(document.querySelector('.composer-island-seg-branch'));
    assert.equal(document.querySelector('.composer-island-git'), null);
  });
  await t.test('not a repository', async (t) => {
    const { document } = await gitDock(t, { cwd: 'C:/git-vis-none', files: ['a.ts'], repository: false });
    assert.equal(document.querySelector('.composer-island-git'), null);
  });
});

test('the git button opens the Git tab; each row runs its own action and nothing is pre-selected', async (t) => {
  const cwd = 'C:/git-pick';
  const { document, sent, render } = await gitDock(t, { cwd, files: ['a.ts', 'b.ts'] });
  await render();
  const flush = () => act(async () => {});
  // The button sends nothing itself: it opens the Git tab (chip, branch ·
  // files, three actions each with its own Run, Source Control).
  const panel = () => document.querySelector('.composer-island-git-panel');
  await act(async () => gitMain(document).click());
  await flush();
  assert.deepEqual(sent, [], 'the button only opens the tab');
  assert.equal(gitMain(document).getAttribute('aria-expanded'), 'true');
  assert.equal(document.querySelector('.composer-island').dataset.expanded, 'git');
  assert.ok(document.querySelector('.composer-island').contains(panel()));
  assert.equal(panel().querySelector('.composer-island-tab').textContent, translate('Git'));
  assert.equal(
    panel().querySelector('.composer-island-phead-meta').textContent,
    `main · ${translate('Files {{count}}', { count: 2 })}`
  );
  const labels = () => [...panel().querySelectorAll('.composer-island-git-label')];
  const runs = () => [...panel().querySelectorAll('.composer-island-git-run')];
  assert.deepEqual(
    labels().map((label) => label.textContent),
    [translate('Create PR'), translate('Commit · push'), translate('Commit')]
  );
  // A row is the action's label and its own Run; no ✓, no pressed state.
  const firstRow = panel().querySelector('.composer-island-git-row');
  assert.deepEqual(
    [...firstRow.children].map((node) => node.className),
    ['composer-island-git-label', 'composer-island-button composer-island-git-run']
  );
  assert.equal(panel().querySelector('[aria-pressed], [data-selected], .composer-island-git-check'), null);
  assert.deepEqual(
    runs().map((run) => [run.textContent, run.getAttribute('aria-label')]),
    [
      [translate('Run'), `${translate('Run')}: ${translate('Create PR')}`],
      [translate('Run'), `${translate('Run')}: ${translate('Commit · push')}`],
      [translate('Run'), `${translate('Run')}: ${translate('Commit')}`],
    ]
  );
  assert.equal(
    panel().querySelector('.composer-island-git-foot button').textContent,
    translate('Island: Source Control')
  );
  // Clicking the button again closes the tab without sending.
  await act(async () => gitMain(document).click());
  assert.equal(panel(), null);
  assert.deepEqual(sent, []);
  // A row's Run sends that action at once and collapses the tab; the
  // button stays "Git" — nothing is remembered as a choice.
  await act(async () => gitMain(document).click());
  await act(async () => runs()[2].click());
  await flush();
  assert.equal(panel(), null);
  assert.deepEqual(sent, [{ sessionId: 'island-session', action: 'commit' }]);
  assert.equal(gitMain(document).textContent, translate('Git'));
  await act(async () => gitMain(document).click());
  await act(async () => runs()[0].click());
  await flush();
  assert.deepEqual(
    sent.map((entry) => entry.action),
    ['commit', 'pr']
  );
});

test('the worktree menu prefetches Changes on open and on pressing or focusing View changes', async (t) => {
  const { createRoot } = await import('react-dom/client');
  const { useSessionChanges, setSessionChangesSource } = await import('./session-changes-store.ts');
  const { root, document, window } = mount(t);
  setSessionChangesSource('uncommitted');
  // A workspace no other test read, so no earlier answer is held for it.
  const cwd = '/data/worktrees/prefetch-wt';
  let batches = 0;
  let onBatch = null;
  // Resolves once the mock has been asked `count` times.
  const asked = (count) =>
    batches >= count
      ? Promise.resolve()
      : new Promise((resolve) => {
          onBatch = () => {
            if (batches < count) return;
            onBatch = null;
            resolve();
          };
        });
  // Opening and pressing fail; focusing succeeds: three signals, three reads.
  window.mixdogDesktop.gitReview = async () => ({
    repository: true,
    root: cwd,
    base: 'HEAD',
    files: [{ path: 'a.ts', status: 'M', additions: 1, deletions: 1, untracked: false }],
  });
  window.mixdogDesktop.gitReviewDiffs = async (_cwd, requested) => {
    batches += 1;
    onBatch?.();
    if (batches <= 2) throw new Error('read failed');
    return { patches: requested.map(({ path }) => ({ path, patch: `@@ -1 +1 @@\n-a\n+b\n` })), omitted: [] };
  };
  window.mixdogDesktop.invokeCapability = async (request) => {
    if (request.capability === 'getBranchMenu') return { value: worktreeMenu() };
    return { value: null };
  };
  // Something already reads this session's changes (the files chip), naming its workspace.
  function Reader() {
    useSessionChanges({ cwd, sessionId: 'island-session', active: true });
    return null;
  }
  const host = document.createElement('div');
  document.body.append(host);
  const readerRoot = createRoot(host);
  t.after(() => act(async () => readerRoot.unmount()));
  await act(async () => readerRoot.render(React.createElement(Reader)));
  await act(async () =>
    root.render(
      React.createElement(
        ComposerDock,
        dockProps({ workspace: worktreeWorkspace(), reviewSessionId: 'island-session', onOpenSessionDiff: () => {} })
      )
    )
  );
  const flush = (count) => act(async () => asked(count));
  assert.equal(batches, 0, 'nothing is read before the user signals intent');
  await act(async () => document.querySelector('.composer-island-seg-worktree').click());
  await flush(1);
  assert.equal(batches, 1, 'opening the menu starts the load');
  const viewChanges = () => document.querySelector('[data-action-id="view-changes"]');
  await act(async () => viewChanges().dispatchEvent(new window.Event('pointerdown', { bubbles: true })));
  await flush(2);
  assert.equal(batches, 2,'pressing View changes asks again');
  // The first action already holds focus from the open: leave and return.
  await act(async () => viewChanges().blur());
  await act(async () => viewChanges().focus());
  await flush(3);
  assert.equal(batches, 3,'focusing View changes asks again');
  window.localStorage.removeItem('mixdog.session-changes-source.v1');
});

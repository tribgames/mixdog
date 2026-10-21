import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

// react-dom decides at import time whether a DOM exists, so the globals come first.
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://mixdog.test/' });
for (const key of [
  'window',
  'document',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLButtonElement',
  'Element',
  'Node',
  'navigator',
  'localStorage',
]) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: key === 'window' ? dom.window : key === 'document' ? dom.window.document : dom.window[key],
  });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { default: React, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { routineOwners, routineRows, webhookRoutineRows } = await import('./routines-model.ts');
const {
  agentChatStripGroups,
  codingStripGroups,
  paneRightGroupsFor,
  readRoutinesTilePreference,
  routinesTileOpenAfter,
  withRoutinesPanelDefault,
  writeRoutinesTileOpen,
} = await import('./routines-tile.ts');
const { RoutinesPane } = await import('./RoutinesPane.tsx');
const { invalidateSidebarReferenceForMutation } = await import('./sidebar-reference-cache.ts');
const { routineNoticeText } = await import('./transcript-row.tsx');

const SCHEDULES = [
  {
    name: 'new-issues',
    whenCron: '0 10 * * 1-5',
    cwd: 'C:\\Project\\mixdog',
    enabled: true,
    owner: 'lead',
    nextFireAt: '2030-01-07T10:00:00.000Z',
    lastSuccessAt: '2030-01-03T10:00:00.000Z',
    lastFailedAt: '2030-01-02T10:00:00.000Z',
  },
  // Ownerless (from before ownership): Mixy's.
  {
    name: 'legacy',
    whenCron: '0 9 * * *',
    enabled: false,
    nextFireAt: '2030-01-07T09:00:00.000Z',
    lastFailedAt: '2030-01-04T09:00:00.000Z',
  },
  { name: 'reviews', whenCron: '0 * * * *', enabled: true, owner: 'reviewer' },
];

test('routine rows are the schedules the agent owns, ownerless ones belonging to Mixy', () => {
  const mixy = routineRows(SCHEDULES, 'lead');
  assert.deepEqual(
    mixy.map((row) => [row.name, row.enabled, row.target, row.nextAt, row.last]),
    [
      [
        'new-issues',
        true,
        'mixdog',
        Date.parse('2030-01-07T10:00:00.000Z'),
        { at: Date.parse('2030-01-03T10:00:00.000Z'), ok: true },
      ],
      // A switched-off schedule has no next run; its latest run failed.
      ['legacy', false, '', null, { at: Date.parse('2030-01-04T09:00:00.000Z'), ok: false }],
    ]
  );
  assert.deepEqual(
    routineRows(SCHEDULES, 'reviewer').map((row) => [row.name, row.last]),
    [['reviews', null]]
  );
});

test('the Routines view exists only on an agent home thread', () => {
  const groups = [['routines'], ['session-diff'], ['browser']];
  assert.deepEqual(paneRightGroupsFor(groups, 'sess_home_lead'), groups);
  assert.deepEqual(paneRightGroupsFor(groups, 'sess_0193abc'), [['session-diff'], ['browser']]);
  assert.deepEqual(paneRightGroupsFor(groups, ''), [['session-diff'], ['browser']]);
});

test('pane headers: Visualize takes the Changes slot in agent chats and coding panes', async () => {
  const layout = [['routines'], ['room'], ['session-diff'], ['visualize'], ['browser'], ['terminal']];
  assert.deepEqual(agentChatStripGroups(paneRightGroupsFor(layout, 'sess_home_lead')), [
    ['routines'],
    ['visualize'],
    ['browser'],
  ]);
  assert.deepEqual(agentChatStripGroups(paneRightGroupsFor(layout, 'sess_room_abc123')), [
    ['room'],
    ['visualize'],
    ['browser'],
  ]);

  const { PaneDockToggles } = await import('./pane-dock-toggles.tsx');
  const Icon = () => React.createElement('svg');
  const descriptors = new Map(
    [
      ['routines', 'Agent'],
      ['session-diff', 'Changes'],
      ['visualize', 'Visualize'],
      ['browser', 'Browser'],
      ['terminal', 'Terminal'],
    ].map(([id, label]) => [id, { id, label, tooltip: label, icon: Icon }])
  );
  const host = document.getElementById('root');
  const root = createRoot(host);
  const calls = [];
  const render = (groups, activeRoot = null) =>
    act(async () =>
      root.render(
        React.createElement(PaneDockToggles, {
          groups,
          descriptors,
          activeRoot,
          sessionBound: true,
          onSelect: (id) => calls.push(['select', id]),
          onClose: () => calls.push(['close']),
        })
      )
    );
  const shown = () => [...host.querySelectorAll('.pane-dock-toggle')].map((button) => button.dataset.view);
  const agentGroups = agentChatStripGroups(paneRightGroupsFor(layout, 'sess_home_lead'));
  await render(agentGroups);
  assert.deepEqual(shown(), ['routines', 'visualize', 'browser']);
  const visualize = () => host.querySelector('.pane-dock-toggle[data-view="visualize"]');
  assert.equal(visualize().getAttribute('aria-label'), 'Visualize');
  await act(async () => visualize().click());
  assert.deepEqual(calls, [['select', 'visualize']], 'opens the session’s visualize panel');
  await render(agentGroups, 'visualize');
  assert.equal(visualize().getAttribute('aria-pressed'), 'true');
  await act(async () => visualize().click());
  assert.deepEqual(calls.at(-1), ['close'], 'pressed again, it folds the panel');
  // Coding: Visualize in the Changes slot, then browser and terminal.
  await render(codingStripGroups(paneRightGroupsFor(layout, 'sess_0193abc')));
  assert.deepEqual(shown(), ['visualize', 'browser', 'terminal']);
  await act(async () => visualize().click());
  assert.deepEqual(calls.at(-1), ['select', 'visualize'], 'a coding pane opens its visualize panel too');
  await act(async () => root.unmount());
});

test('before any toggle the tile opens only where the agent owns a routine; a toggle then persists', () => {
  window.localStorage.clear();
  assert.equal(readRoutinesTilePreference(), null, 'unset until the user toggles it');
  const views = new Map([['sess_home_reviewer', 'session-diff']]);
  const owners = routineOwners({ schedules: SCHEDULES, webhooks: [] });
  assert.deepEqual([...owners].sort(), ['lead', 'reviewer']);
  const auto = withRoutinesPanelDefault(views, null, new Set(['lead']));
  assert.equal(auto.get('sess_home_lead'), 'routines', 'Mixy owns a routine');
  assert.equal(auto.get('sess_home_writer'), undefined, 'an agent without routines stays closed');
  assert.equal(auto.get('sess_home_reviewer'), 'session-diff', 'a picked view wins');
  assert.equal(auto.get('sess_0193abc'), undefined, 'never on another session');
  // Opened explicitly: every home thread, routines or not.
  const open = withRoutinesPanelDefault(views, 'open', new Set());
  assert.equal(open.get('sess_home_writer'), 'routines');
  assert.equal(open.get('sess_0193abc'), undefined);
  // Closed explicitly: nowhere, even where routines exist.
  assert.equal(withRoutinesPanelDefault(views, 'closed', new Set(['lead'])).get('sess_home_lead'), undefined);
  // The tab-bar toggle: opening sets it, closing (or another view) clears it.
  assert.equal(routinesTileOpenAfter('sess_home_lead', 'routines'), true);
  assert.equal(routinesTileOpenAfter('sess_home_lead', null), false);
  assert.equal(routinesTileOpenAfter('sess_home_lead', 'session-diff'), false);
  assert.equal(routinesTileOpenAfter('sess_0193abc', null), null);
  writeRoutinesTileOpen(false);
  assert.equal(readRoutinesTilePreference(), 'closed');
  writeRoutinesTileOpen(true);
  assert.equal(readRoutinesTilePreference(), 'open');
});

// A row's ⋯ menu is a portal on document.body.
const openMenu = (row) => act(async () => row.querySelector('.row-overflow-trigger').click());
const closeMenu = () =>
  act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
const menuItem = (id) => document.querySelector(`.row-overflow-menu [data-action-id="${id}"]`);

const WEBHOOKS_ONLY = [{ name: 'deploys', parser: 'generic', enabled: true, owner: 'writer' }];

test('an agent with no routines shows one quiet line; an empty kind has no section', async () => {
  let setup = { schedules: [], webhooks: [] };
  const api = {
    invokeCapability: async ({ capability }) => ({ value: capability === 'getChannelSetup' ? setup : { ok: true } }),
  };
  for (const [current, heads] of [
    [{ schedules: [], webhooks: [] }, []],
    [{ schedules: [], webhooks: WEBHOOKS_ONLY }, ['Webhooks1']],
  ]) {
    setup = current;
    // The channel setup is a shared cached reference: a change invalidates it.
    invalidateSidebarReferenceForMutation('saveWebhook');
    const root = createRoot(document.getElementById('root'));
    await act(async () =>
      root.render(React.createElement(RoutinesPane, { sessionId: 'sess_home_writer', active: true, api }))
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    try {
      assert.deepEqual(
        [...document.querySelectorAll('.conn-group-head h4')].map((node) => node.textContent),
        heads
      );
      const empty = [...document.querySelectorAll('.utility-dock-empty')].map((node) => node.textContent);
      assert.deepEqual(empty, heads.length ? [] : ['No routines.']);
    } finally {
      await act(async () => root.unmount());
    }
  }
});

const WEBHOOKS = [
  {
    name: 'issues',
    parser: 'github',
    enabled: true,
    owner: 'lead',
    hasLastPayload: true,
    lastEventAt: '2030-01-05T08:00:00.000Z',
    lastFailedAt: '2030-01-05T08:01:00.000Z',
  },
  // Never received anything yet: nothing to re-run.
  { name: 'alerts', parser: 'sentry', enabled: false },
  { name: 'prs', parser: 'github', enabled: true, owner: 'reviewer', hasLastPayload: true },
];

test('the tile renders the owned webhooks below the schedules and re-runs the last payload', async () => {
  const calls = [];
  const api = {
    invokeCapability: async ({ capability, args }) => {
      calls.push([capability, args]);
      if (capability === 'getChannelSetup') return { value: { schedules: SCHEDULES, webhooks: WEBHOOKS } };
      return { value: { ok: true } };
    },
  };
  const root = createRoot(document.getElementById('root'));
  await act(async () =>
    root.render(React.createElement(RoutinesPane, { sessionId: 'sess_home_lead', active: true, api }))
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  try {
    const heads = [...document.querySelectorAll('.conn-group-head h4')].map((node) => node.textContent);
    assert.deepEqual(heads, ['Schedules2', 'Webhooks2']);
    const section = document.querySelectorAll('.conn-group')[1];
    const rows = [...section.querySelectorAll('.routines-row')];
    assert.deepEqual(
      rows.map((row) => row.querySelector('.routines-title b').textContent),
      ['issues', 'alerts']
    );
    const [issues, alerts] = rows;
    assert.match(issues.querySelector('.routines-sub').textContent, /^GitHub events · Latest .+$/);
    assert.equal(issues.querySelector('.routines-tag').textContent, 'Failed');
    assert.equal(alerts.querySelector('.routines-sub').textContent, 'No events');
    assert.equal(alerts.querySelector('.routines-tag'), null);
    assert.equal(alerts.dataset.state, 'paused');
    assert.equal(issues.dataset.state, 'failed');
    assert.equal(issues.querySelector('input[type="checkbox"]'), null, 'no on/off switch');
    // No payload yet: the menu's run is disabled and says why.
    await openMenu(alerts);
    assert.equal(menuItem('run').disabled, true);
    assert.equal(menuItem('run').title, 'No payload received yet.');
    assert.equal(menuItem('toggle').textContent, 'Resume routine');
    await closeMenu();

    await openMenu(issues);
    assert.equal(menuItem('run').disabled, false);
    assert.equal(menuItem('toggle').textContent, 'Pause routine');
    await act(async () => menuItem('toggle').click());
    assert.deepEqual(
      calls.find(([name]) => name === 'setWebhookEnabled'),
      ['setWebhookEnabled', ['issues', false]]
    );
    await openMenu(issues);
    await act(async () => menuItem('run').click());
    assert.deepEqual(
      calls.find(([name]) => name === 'runWebhookNow'),
      ['runWebhookNow', ['issues']]
    );
    // Delete asks for a second press, then calls the webhook capability.
    await openMenu(issues);
    await act(async () => menuItem('delete').click());
    assert.equal(
      calls.some(([name]) => name === 'deleteWebhook'),
      false
    );
    assert.equal(menuItem('delete').textContent, 'Confirm delete');
    await act(async () => menuItem('delete').click());
    assert.deepEqual(
      calls.find(([name]) => name === 'deleteWebhook'),
      ['deleteWebhook', ['issues']]
    );
  } finally {
    await act(async () => root.unmount());
  }
});

test('a refused result delivery offers a retry; a self-paused routine says why', async () => {
  const calls = [];
  const schedules = [
    {
      name: 'digest',
      whenCron: '0 9 * * *',
      enabled: true,
      owner: 'lead',
      lastSuccessAt: '2030-01-03T09:00:00.000Z',
      consecutiveFailures: 0,
      undelivered: { count: 1, failed: true, error: 'disk full' },
    },
    { name: 'flaky', whenCron: '*/5 * * * *', enabled: false, owner: 'lead', consecutiveFailures: 5 },
  ];
  const webhooks = [
    { name: 'issues', parser: 'github', enabled: true, owner: 'lead', undelivered: { count: 1, failed: false } },
  ];
  const api = {
    invokeCapability: async ({ capability, args }) => {
      calls.push([capability, args]);
      if (capability === 'getChannelSetup') return { value: { schedules, webhooks } };
      return { value: { ok: true } };
    },
  };
  invalidateSidebarReferenceForMutation('saveSchedule');
  const root = createRoot(document.getElementById('root'));
  await act(async () =>
    root.render(React.createElement(RoutinesPane, { sessionId: 'sess_home_lead', active: true, api }))
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  try {
    const [digest, flaky, issues] = [...document.querySelectorAll('.routines-row')];
    const tag = (row) => row.querySelector('.routines-tag');
    assert.equal(tag(digest).textContent, 'Failed');
    assert.equal(tag(digest).title, 'disk full');
    assert.equal(tag(flaky).textContent, 'Auto-paused');
    assert.equal(flaky.querySelector('.routines-sub').textContent, 'Paused after 5 failures in a row');
    assert.equal(tag(issues), null, 'a result still on its way is no failure');
    await openMenu(digest);
    assert.ok(menuItem('retry'), 'a refused delivery offers a retry');
    await act(async () => menuItem('retry').click());
    await openMenu(flaky);
    assert.equal(menuItem('retry'), null, 'only after a failed delivery');
    await closeMenu();
    assert.deepEqual(
      calls.find(([name]) => name === 'retryRoutineDelivery'),
      ['retryRoutineDelivery', ['schedule', 'digest']]
    );
    assert.equal(
      routineNoticeText({ omitted: 3 }),
      '⏱ Routine results omitted: 3',
      'the full-queue notice reads as a routine row'
    );
  } finally {
    await act(async () => root.unmount());
  }
});

test('a webhook routine result notice reads as a webhook row', () => {
  assert.equal(
    routineNoticeText({ kind: 'webhook', name: 'issues', status: 'completed', summary: 'labelled #12' }),
    '🔗 Webhook · issues — labelled #12'
  );
  assert.equal(
    routineNoticeText({ kind: 'webhook', name: 'issues', status: 'failed', summary: '' }),
    '🔗 Webhook · issues — A problem occurred during the run.'
  );
  assert.deepEqual(
    webhookRoutineRows(WEBHOOKS, 'reviewer').map((row) => [row.name, row.hasPayload, row.eventAt]),
    [['prs', true, null]]
  );
});

test('a routine result notice reads as a schedule row, failures included', () => {
  assert.equal(
    routineNoticeText({ name: 'new-issues', status: 'completed', summary: '2 new issues' }),
    '⏱ Schedule · new-issues — 2 new issues'
  );
  assert.equal(
    routineNoticeText({ name: 'new-issues', status: 'failed', summary: 'model missing' }),
    '⏱ Schedule · new-issues — A problem occurred during the run.'
  );
  assert.equal(
    routineNoticeText({ name: 'new-issues', status: 'failed', summary: 'x', reason: 'cancelled' }),
    '⏱ Schedule · new-issues — The run was cancelled.'
  );
  assert.equal(routineNoticeText(undefined), null);
});

test('the tile renders each owned schedule and drives its switch and run action', async () => {
  const calls = [];
  const api = {
    invokeCapability: async ({ capability, args }) => {
      calls.push([capability, args]);
      if (capability === 'getChannelSetup') return { value: { schedules: SCHEDULES } };
      return { value: { ok: true } };
    },
  };
  const root = createRoot(document.getElementById('root'));
  await act(async () =>
    root.render(React.createElement(RoutinesPane, { sessionId: 'sess_home_lead', active: true, api }))
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  try {
    const rows = [...document.querySelectorAll('.routines-row')];
    assert.deepEqual(
      rows.map((row) => row.querySelector('.routines-title b').textContent),
      ['new-issues', 'legacy']
    );
    const first = rows[0];
    assert.match(first.querySelector('.routines-sub').textContent, /^Weekdays at 10:00 · Next .+$/);
    assert.equal(first.dataset.state, 'ok');
    assert.equal(first.querySelector('.routines-tag'), null);
    assert.equal(rows[1].querySelector('.routines-tag').textContent, 'Failed');
    assert.match(rows[1].querySelector('.routines-sub').textContent, / · Paused$/);
    assert.equal(first.querySelector('input[type="checkbox"]'), null, 'no on/off switch');
    assert.equal(first.querySelector('.conn-tile'), null, 'no icon tile');
    assert.equal(document.querySelector('.conn-group-head h4').textContent, 'Schedules2');
    assert.equal(document.querySelector('.conn-note'), null, 'no guidance line');
    assert.equal(document.querySelector('form'), null, 'no create form');

    await openMenu(first);
    assert.equal(menuItem('toggle').textContent, 'Pause routine');
    await act(async () => menuItem('toggle').click());
    assert.deepEqual(
      calls.find(([name]) => name === 'setScheduleEnabled'),
      ['setScheduleEnabled', ['new-issues', false]]
    );

    await openMenu(rows[1]);
    assert.equal(menuItem('toggle').textContent, 'Resume routine');
    await act(async () => menuItem('run').click());
    assert.deepEqual(
      calls.find(([name]) => name === 'runScheduleNow'),
      ['runScheduleNow', ['legacy']]
    );

    await openMenu(first);
    await act(async () => menuItem('delete').click());
    await act(async () => menuItem('delete').click());
    assert.deepEqual(
      calls.find(([name]) => name === 'deleteSchedule'),
      ['deleteSchedule', ['new-issues']]
    );
  } finally {
    await act(async () => root.unmount());
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['Element', 'HTMLElement', 'KeyboardEvent', 'MouseEvent', 'Event', 'CustomEvent', 'navigator'],
});
window.requestAnimationFrame = (callback) => window.setTimeout(callback, 0);
window.cancelAnimationFrame = (handle) => window.clearTimeout(handle);
globalThis.ResizeObserver = window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
globalThis.MutationObserver ??= window.MutationObserver;

const { sessionAttention, strongestSessionAttention } = await import('../shared/session-attention.ts');
const { effectiveApprovalSessionIds, sessionAttentionIndex, sessionAttentionOf } = await import(
  './session-attention-index.ts'
);
const { useVisibleSessions } = await import('./use-visible-sessions.ts');
const { defaultSessionLaneStore } = await import('./session-lane-store.ts');
const { catalogApprovalSessionIds, publishCatalogApprovalSessions, subscribeCatalogApprovalSessions } = await import(
  './session-catalog-approvals.ts'
);
const { WorkspaceTabStrip } = await import('./WorkspaceTabStrip.tsx');
const { SessionSidebarRow } = await import('./session-sidebar-rows.tsx');
const { projectsSection } = await import('./session-sidebar-sections.tsx');

test('one status per session, strongest first: needs you > failed > running > unread', () => {
  assert.equal(sessionAttention({ needsUser: true, failed: true, running: true, unread: true }), 'needs-you');
  assert.equal(sessionAttention({ failed: true, running: true, unread: true }), 'failed');
  assert.equal(sessionAttention({ running: true, unread: true }), 'running');
  assert.equal(sessionAttention({ unread: true }), 'unread');
  assert.equal(sessionAttention({}), '');
  assert.equal(strongestSessionAttention(['unread', '', 'running', 'failed']), 'failed');
  assert.equal(strongestSessionAttention(['', '']), '');
});

test('a session whose own agent waits on background work reads waiting over running', () => {
  assert.equal(sessionAttention({ waiting: true, running: true, unread: true }), 'waiting');
  assert.equal(sessionAttention({ failed: true, waiting: true }), 'failed');
  const index = sessionAttentionIndex(
    [
      { sessionId: 'lead', status: 'running', stage: 'tool_running', awaitingTask: 'wait' },
      { sessionId: 'child', ownerSessionId: 'lead2', status: 'idle', awaitingTask: 'background' },
      { sessionId: 'busy', status: 'running', stage: 'requesting' },
    ],
    new Set()
  );
  assert.deepEqual([...index.waiting].sort(), ['child', 'lead']);
  assert.equal(sessionAttentionOf(index, 'lead', { running: true }), 'waiting');
  assert.equal(sessionAttentionOf(index, 'lead2', { running: true }), 'running', 'only the agent’s own session');
  assert.equal(sessionAttentionOf(index, 'busy', { running: true }), 'running');
});

test('an agent waiting on approval or failed marks its own session and the sessions above it', () => {
  const index = sessionAttentionIndex(
    [
      { sessionId: 'w1', parentSessionId: 'lead', ownerSessionId: 'lead', status: 'running', awaitingUser: 'approval' },
      { sessionId: 'w2', parentSessionId: 'w9', ownerSessionId: 'lead-b', status: 'failed' },
      { sessionId: 'w3', ownerSessionId: 'lead-c', status: 'idle' },
    ],
    new Set(['solo'])
  );
  assert.deepEqual([...index.needsUser].sort(), ['lead', 'solo', 'w1']);
  assert.deepEqual([...index.failed], ['w2'], 'a sub-agent failure marks only its own session');
  assert.equal(sessionAttentionOf(index, 'lead', { running: true, unread: true }), 'needs-you');
  assert.equal(sessionAttentionOf(index, 'lead-c', { unread: true }), 'unread');
});

test('a failed sub-agent leaves the Lead idle, done or running; a failed Lead turn still reads failed', () => {
  const failedWorker = {
    sessionId: 'w',
    parentSessionId: 'lead',
    ownerSessionId: 'lead',
    agent: 'worker',
    status: 'failed',
  };
  const idleLead = { sessionId: 'lead', ownerSessionId: 'lead', agent: 'lead', status: 'idle' };
  const runningLead = {
    sessionId: 'lead',
    ownerSessionId: 'lead',
    agent: 'lead',
    status: 'running',
    stage: 'requesting',
  };
  const failedLead = { sessionId: 'lead', ownerSessionId: 'lead', agent: 'lead', status: 'failed' };
  const read = (pool, opts) => sessionAttentionOf(sessionAttentionIndex(pool, new Set()), 'lead', opts);
  assert.equal(read([idleLead, failedWorker], {}), '');
  assert.equal(read([idleLead, failedWorker], { unread: true }), 'unread');
  assert.equal(read([runningLead, failedWorker], { running: true }), 'running');
  assert.equal(read([failedLead, failedWorker], {}), 'failed');
  assert.equal(read([failedLead], { running: false }), 'failed');
});

test('the lane store tracks which sessions wait on a tool approval, changing identity only on membership', () => {
  defaultSessionLaneStore.clear();
  let notified = 0;
  const stop = defaultSessionLaneStore.subscribeApprovals(() => {
    notified += 1;
  });
  try {
    const frame = (toolApproval) =>
      defaultSessionLaneStore.apply({
        sessionId: 'lane-a',
        frameSource: 'live',
        snapshot: { sessionId: 'lane-a', busy: true, toolApproval },
      });
    frame(null);
    const empty = defaultSessionLaneStore.approvalSessionIds();
    assert.equal(empty.size, 0);
    frame({ id: 'ap-1', tool: 'shell' });
    assert.deepEqual([...defaultSessionLaneStore.approvalSessionIds()], ['lane-a']);
    const waiting = defaultSessionLaneStore.approvalSessionIds();
    frame({ id: 'ap-1', tool: 'shell' });
    assert.equal(defaultSessionLaneStore.approvalSessionIds(), waiting, 'same membership, same identity');
    frame(null);
    assert.equal(defaultSessionLaneStore.approvalSessionIds().size, 0);
    assert.equal(notified, 2);
  } finally {
    stop();
    defaultSessionLaneStore.clear();
  }
});

// A lane carries an approval only while a pane receives it; the host catalog
// marks every session that waits on the user, a background one too.
test('a catalog approval reads needs you for a session no pane receives, over its running turn', () => {
  const approvals = effectiveApprovalSessionIds(new Set(), new Set(['background']), new Set());
  const index = sessionAttentionIndex([], approvals);
  assert.equal(sessionAttentionOf(index, 'background', { running: true }), 'needs-you');
  assert.equal(sessionAttentionOf(index, 'other', { running: true }), 'running');
});

test('each session takes its approval from one current source: its live lane, else the catalog', () => {
  const lane = new Set(['shown', 'left-behind']);
  const catalog = new Set(['background', 'shown-stale-catalog']);
  const live = new Set(['shown', 'shown-stale-catalog']);
  assert.deepEqual(
    [...effectiveApprovalSessionIds(lane, catalog, live)].sort(),
    ['background', 'shown'],
    'a left-behind lane and a lagging catalog flag for a shown session both lose'
  );
});

test('the catalog approval set follows awaitingApproval rows, changing identity only on membership', () => {
  let notified = 0;
  const stop = subscribeCatalogApprovalSessions(() => {
    notified += 1;
  });
  try {
    const row = (id, extra = {}) => ({ id, title: id, preview: '', updatedAt: 1, messageCount: 2, ...extra });
    publishCatalogApprovalSessions([row('a', { working: true, awaitingApproval: true }), row('b', { working: true })]);
    const waiting = catalogApprovalSessionIds();
    assert.deepEqual([...waiting], ['a']);
    publishCatalogApprovalSessions([row('a', { awaitingApproval: true }), row('b')]);
    assert.equal(catalogApprovalSessionIds(), waiting, 'same membership, same identity');
    publishCatalogApprovalSessions([row('a'), row('b')]);
    assert.equal(catalogApprovalSessionIds().size, 0);
    assert.equal(notified, 2);
  } finally {
    stop();
    publishCatalogApprovalSessions([]);
  }
});

function Visible({ ids }) {
  useVisibleSessions(ids);
  return null;
}

async function render(element) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(element));
  return {
    host,
    async unmount() {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test('session tabs show the strongest status, each with its own mark', async () => {
  let push = () => {};
  window.mixdogDesktop = {
    listAgentPool: async () => [],
    subscribeAgentPool: (listener) => {
      push = listener;
      return () => {};
    },
  };
  const tab = (id) => ({ key: `session:${id}`, title: id, selection: { kind: 'session', id } });
  const tabs = ['asks', 'broke', 'busy', 'seen', 'quiet'].map(tab);
  const view = await render(
    React.createElement(
      React.Fragment,
      null,
      // `asks` is shown in a pane: its lane is the current source.
      React.createElement(Visible, { ids: ['asks'] }),
      React.createElement(WorkspaceTabStrip, {
        tabs,
        activeKey: tabs[0].key,
        workingSessionIds: new Set(['asks', 'broke', 'busy']),
        unreadSessionIds: new Set(['asks', 'broke', 'busy', 'seen']),
        onSelectTab() {},
        onCloseTab() {},
        onReorderTab() {},
        onNewTask() {},
      })
    )
  );
  try {
    await act(async () => {
      defaultSessionLaneStore.apply({
        sessionId: 'asks',
        frameSource: 'live',
        snapshot: { sessionId: 'asks', busy: true, toolApproval: { id: 'ap', tool: 'shell' } },
      });
      push([
        {
          tag: 'broke',
          sessionId: 'broke',
          ownerSessionId: 'broke',
          agent: 'lead',
          status: 'failed',
          failureReason: 'stalled',
        },
        // A sub-agent failure never marks the session above it.
        { tag: 'w', sessionId: 'w', ownerSessionId: 'seen', parentSessionId: 'seen', status: 'failed' },
      ]);
    });
    const cell = (id) => view.host.querySelector(`.workspace-tab[data-tab-key="session:${id}"]`);
    assert.equal(cell('asks').dataset.attention, 'needs-you');
    assert.ok(cell('asks').querySelector('.workspace-tab-attention[data-status="needs-you"]'));
    assert.equal(cell('asks').querySelector('.workspace-tab-status'), null, 'needs you outranks the spinner');
    assert.equal(cell('asks').querySelector('.workspace-tab-unread-dot'), null);
    assert.equal(cell('broke').dataset.attention, 'failed');
    assert.ok(cell('broke').querySelector('.workspace-tab-attention[data-status="failed"]'));
    assert.equal(cell('busy').dataset.attention, 'running');
    assert.ok(cell('busy').querySelector('.workspace-tab-status'));
    assert.equal(cell('busy').querySelector('.workspace-tab-unread-dot'), null);
    assert.equal(cell('seen').dataset.attention, 'unread');
    assert.ok(cell('seen').querySelector('.workspace-tab-unread-dot'));
    assert.equal(cell('quiet').dataset.attention, undefined);
  } finally {
    await view.unmount();
    defaultSessionLaneStore.clear();
  }
});

test('a background tab whose session waits on approval shows needs you from the catalog alone', async () => {
  window.mixdogDesktop = {
    listAgentPool: async () => [],
    subscribeAgentPool: () => () => {},
  };
  defaultSessionLaneStore.clear();
  const tab = (id) => ({ key: `session:${id}`, title: id, selection: { kind: 'session', id } });
  const tabs = ['open', 'background'].map(tab);
  const view = await render(
    React.createElement(WorkspaceTabStrip, {
      tabs,
      activeKey: tabs[0].key,
      workingSessionIds: new Set(['open', 'background']),
      onSelectTab() {},
      onCloseTab() {},
      onReorderTab() {},
      onNewTask() {},
    })
  );
  try {
    // No lane frame ever reaches `background`: only its catalog row says it waits.
    await act(async () => {
      publishCatalogApprovalSessions([
        { id: 'open', title: 'open', preview: '', updatedAt: 1, messageCount: 2, working: true },
        {
          id: 'background',
          title: 'background',
          preview: '',
          updatedAt: 1,
          messageCount: 2,
          working: true,
          awaitingApproval: true,
        },
      ]);
    });
    const cell = (id) => view.host.querySelector(`.workspace-tab[data-tab-key="session:${id}"]`);
    assert.equal(cell('background').dataset.attention, 'needs-you');
    assert.equal(cell('background').querySelector('.workspace-tab-status'), null, 'no spinner over the mark');
    assert.equal(cell('open').dataset.attention, 'running');
  } finally {
    await view.unmount();
    publishCatalogApprovalSessions([]);
  }
});

test('a pane left behind keeps no stale needs-you: an answer elsewhere or a lost daemon clears it', async () => {
  window.mixdogDesktop = {
    listAgentPool: async () => [],
    subscribeAgentPool: () => () => {},
  };
  defaultSessionLaneStore.clear();
  const tab = (id) => ({ key: `session:${id}`, title: id, selection: { kind: 'session', id } });
  const tabs = ['asks', 'other'].map(tab);
  const row = (id, extra = {}) => ({
    id,
    title: id,
    preview: '',
    updatedAt: 1,
    messageCount: 2,
    working: true,
    ...extra,
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const show = (ids) =>
    act(async () =>
      root.render(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(Visible, { ids }),
          React.createElement(WorkspaceTabStrip, {
            tabs,
            activeKey: `session:${ids[0]}`,
            workingSessionIds: new Set(['asks', 'other']),
            onSelectTab() {},
            onCloseTab() {},
            onReorderTab() {},
            onNewTask() {},
          })
        )
      )
    );
  const attention = () => host.querySelector('.workspace-tab[data-tab-key="session:asks"]').dataset.attention;
  try {
    // Shown in a pane, the approval arrives on its lane.
    await show(['asks']);
    await act(async () => {
      defaultSessionLaneStore.apply({
        sessionId: 'asks',
        frameSource: 'live',
        snapshot: { sessionId: 'asks', busy: true, toolApproval: { id: 'ap', tool: 'shell' } },
      });
      publishCatalogApprovalSessions([row('asks', { awaitingApproval: true }), row('other')]);
    });
    assert.equal(attention(), 'needs-you');
    // Switched away: the lane stays cached with its last frame; the catalog speaks.
    await show(['other']);
    assert.ok(defaultSessionLaneStore.get('asks')?.toolApproval, 'the retained lane still holds the card');
    assert.equal(attention(), 'needs-you');
    // Answered on the phone: the catalog clears it, the stale lane does not keep it.
    await act(async () => publishCatalogApprovalSessions([row('asks'), row('other')]));
    assert.equal(attention(), 'running');
    // Waiting again, then the daemon is lost: the host strips the flag from its catalog.
    await act(async () => publishCatalogApprovalSessions([row('asks', { awaitingApproval: true }), row('other')]));
    assert.equal(attention(), 'needs-you');
    await act(async () =>
      publishCatalogApprovalSessions([row('asks', { working: false }), row('other', { working: false })])
    );
    assert.equal(attention(), 'running', 'no needs-you survives the disconnect');
  } finally {
    await act(async () => root.unmount());
    host.remove();
    publishCatalogApprovalSessions([]);
    defaultSessionLaneStore.clear();
  }
});

test('a just-opened pane keeps the catalog mark until its lane receives a frame', async () => {
  window.mixdogDesktop = {
    listAgentPool: async () => [],
    subscribeAgentPool: () => () => {},
  };
  defaultSessionLaneStore.clear();
  // A lane left from an earlier visit, before the approval began.
  defaultSessionLaneStore.apply({
    sessionId: 'opening',
    frameSource: 'live',
    snapshot: { sessionId: 'opening', busy: true, toolApproval: null },
  });
  const tabs = [{ key: 'session:opening', title: 'opening', selection: { kind: 'session', id: 'opening' } }];
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const show = (ids) =>
    act(async () =>
      root.render(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(Visible, { ids }),
          React.createElement(WorkspaceTabStrip, {
            tabs,
            activeKey: 'session:opening',
            workingSessionIds: new Set(['opening']),
            onSelectTab() {},
            onCloseTab() {},
            onReorderTab() {},
            onNewTask() {},
          })
        )
      )
    );
  const attention = () => host.querySelector('.workspace-tab[data-tab-key="session:opening"]').dataset.attention;
  const frame = (toolApproval) =>
    act(async () =>
      defaultSessionLaneStore.apply({
        sessionId: 'opening',
        frameSource: 'replay',
        snapshot: { sessionId: 'opening', busy: true, toolApproval },
      })
    );
  try {
    await show([]);
    await act(async () =>
      publishCatalogApprovalSessions([
        { id: 'opening', title: 'opening', preview: '', updatedAt: 1, messageCount: 2, awaitingApproval: true },
      ])
    );
    assert.equal(attention(), 'needs-you');
    // Opened: no frame yet, the cached lane is the old visit's — the catalog still speaks.
    await show(['opening']);
    assert.equal(defaultSessionLaneStore.liveSessionIds().has('opening'), false);
    assert.equal(attention(), 'needs-you', 'no gap before the first frame');
    // The first frame since opening is current: the lane takes over.
    await frame({ id: 'ap', tool: 'shell' });
    assert.ok(defaultSessionLaneStore.liveSessionIds().has('opening'));
    assert.equal(attention(), 'needs-you');
    await frame(null);
    assert.equal(attention(), 'running', 'answered in the pane: the lane clears it at once');
    // Shown elsewhere again: back to the catalog, and a later reopen waits for a frame again.
    await show([]);
    assert.equal(defaultSessionLaneStore.liveSessionIds().has('opening'), false);
    assert.equal(attention(), 'needs-you', 'the catalog flag (not refreshed yet) speaks again');
  } finally {
    await act(async () => root.unmount());
    host.remove();
    publishCatalogApprovalSessions([]);
    defaultSessionLaneStore.clear();
  }
});

test('a daemon disconnect drops a shown lane’s approval authority until its next real frame', async () => {
  window.mixdogDesktop = {
    listAgentPool: async () => [],
    subscribeAgentPool: () => () => {},
  };
  defaultSessionLaneStore.clear();
  const tabs = [{ key: 'session:shown', title: 'shown', selection: { kind: 'session', id: 'shown' } }];
  const row = (extra = {}) => ({ id: 'shown', title: 'shown', preview: '', updatedAt: 1, messageCount: 2, ...extra });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const attention = () => host.querySelector('.workspace-tab[data-tab-key="session:shown"]').dataset.attention;
  const apply = (update) => act(async () => defaultSessionLaneStore.apply({ sessionId: 'shown', ...update }));
  const approvalFrame = {
    frameSource: 'live',
    snapshot: { sessionId: 'shown', busy: true, toolApproval: { id: 'ap' } },
  };
  try {
    await act(async () =>
      root.render(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(Visible, { ids: ['shown'] }),
          React.createElement(WorkspaceTabStrip, {
            tabs,
            activeKey: 'session:shown',
            workingSessionIds: new Set(['shown']),
            onSelectTab() {},
            onCloseTab() {},
            onReorderTab() {},
            onNewTask() {},
          })
        )
      )
    );
    await apply(approvalFrame);
    await act(async () => publishCatalogApprovalSessions([row({ awaitingApproval: true })]));
    assert.equal(attention(), 'needs-you');
    // The daemon drops while the pane still shows the session.
    await apply({ frameSource: 'live', snapshot: null, laneEnd: 'disconnected' });
    assert.ok(defaultSessionLaneStore.get('shown')?.toolApproval, 'the transcript (and its last card) stays');
    assert.equal(defaultSessionLaneStore.liveSessionIds().has('shown'), false);
    // The host strips the catalog flag on the loss: nothing keeps the mark.
    await act(async () => publishCatalogApprovalSessions([row()]));
    assert.equal(attention(), 'running');
    // Reconnected, the first real frame makes the lane the source again.
    await apply({ ...approvalFrame, frameSource: 'replay' });
    assert.ok(defaultSessionLaneStore.liveSessionIds().has('shown'));
    assert.equal(attention(), 'needs-you');
  } finally {
    await act(async () => root.unmount());
    host.remove();
    publishCatalogApprovalSessions([]);
    defaultSessionLaneStore.clear();
  }
});

const noop = () => {};
const rowProps = (id, attention) => ({
  session: { id, title: id, preview: '', updatedAt: 1, messageCount: 2 },
  active: false,
  working: attention === 'running',
  attention,
  rowKey: `recent:${id}`,
  editingRowKey: '',
  sessionTitleDraft: '',
  sessionTitleInvalid: false,
  confirmingSessionId: '',
  deletingSessionId: '',
  onTitleDraftChange: noop,
  onStartRename: noop,
  onCancelRename: noop,
  onCommitRename: noop,
  onPrefetchSession: noop,
  onResumeSession: noop,
  onCloseEditor: noop,
  onSetConfirming: noop,
  onSetDeleting: noop,
  onArchiveSession: async () => {},
  onFavoriteSession: async () => {},
  onDeleteSession: async () => {},
});

test('sidebar rows and collapsed project groups use the same status set', async () => {
  const rows = await render(
    React.createElement(
      'div',
      null,
      ...['needs-you', 'failed', 'running', 'unread'].map((attention) =>
        React.createElement(SessionSidebarRow, { key: attention, ...rowProps(attention, attention) })
      )
    )
  );
  try {
    const row = (id) => rows.host.querySelector(`.session-row[data-session-id="${id}"]`);
    assert.ok(row('needs-you').querySelector('.session-row-attention[data-status="needs-you"]'));
    assert.equal(row('needs-you').querySelector('.session-row-spinner'), null);
    assert.ok(row('failed').querySelector('.session-row-attention[data-status="failed"]'));
    assert.ok(row('running').querySelector('.session-row-spinner'));
    assert.ok(row('unread').querySelector('.session-row-unread-dot'));
    assert.equal(row('running').querySelector('.session-row-unread-dot'), null);
  } finally {
    await rows.unmount();
  }
  const attention = { a: 'unread', b: 'failed', c: 'running' };
  const group = (key, sessionIds) => ({
    key,
    name: key,
    path: `/p/${key}`,
    rows: sessionIds.map((id) => ({ id, title: id, preview: '', updatedAt: 1, messageCount: 2 })),
  });
  const folders = await render(
    projectsSection({
      groups: [group('collapsed', ['a', 'b', 'c']), group('open', ['b'])],
      open: true,
      onToggleOpen: noop,
      projectOpen: { collapsed: false, open: true },
      onToggleProject: noop,
      rowLimits: new Map(),
      onShowMore: noop,
      onNewTask: noop,
      folderReorderProps: () => ({}),
      attentionOf: (id) => attention[id] || '',
      renderRows: () => null,
    })
  );
  try {
    const folder = (key) => folders.host.querySelector(`.project-group[data-project-key="${key}"] .project-folder`);
    // Collapsed: the strongest status of its sessions takes the trailing slot.
    assert.ok(folder('collapsed').querySelector('.session-row-attention[data-status="failed"]'));
    assert.equal(folder('collapsed').querySelector('.session-row-unread-dot'), null);
    assert.equal(folder('collapsed').querySelector('.project-folder-new'), null);
    // Open: its rows speak for themselves.
    assert.equal(folder('open').querySelector('.session-row-attention'), null);
    assert.ok(folder('open').querySelector('.project-folder-new'));
  } finally {
    await folders.unmount();
  }
});

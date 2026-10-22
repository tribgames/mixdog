// The bot page's agent sessions: work groups and Lead rows (a bot's task session
// is a Lead like any other; there is no separate "Working" section).
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const { restore: restoreBootstrapDom } = installTestDom(null);
after(restoreBootstrapDom);
const [{ AgentActivityPane }, { resetDismissedShellJobsCache }, { publishAgentModeSessions }] = await Promise.all([
  import('./AgentActivityPane.tsx'),
  import('./background-jobs-dismissed-store.ts'),
  import('./agent-chat-mode.ts'),
]);

const NOW = Date.now();
const task = (id, extra = {}) => ({
  id,
  title: `Task ${id}`,
  preview: '',
  updatedAt: 1,
  messageCount: 1,
  taskAgent: 'lead',
  ...extra,
});
const poolLead = (id, extra = {}) => ({
  tag: `lead:${id}`,
  agent: 'lead',
  sessionId: id,
  ownerSessionId: id,
  status: 'running',
  stage: 'running',
  turnStartedAt: NOW - 65_000,
  ...extra,
});

function mount(t, pool, sessions, agentModeIds = [], unreadIds = []) {
  publishAgentModeSessions(agentModeIds.map((id) => ({ id, sessionMode: 'agent' })));
  t.after(() => publishAgentModeSessions([]));
  const { dom, root } = installTestDom(t, {
    jsdom: { url: 'http://localhost/' },
    expose: ['HTMLElement', 'Element', 'Node', 'KeyboardEvent', 'MouseEvent', 'navigator'],
    rootId: 'root',
  });
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  resetDismissedShellJobsCache();
  dom.window.mixdogDesktop = { listAgentPool: async () => pool, subscribeAgentPool: () => () => {} };
  const opened = [];
  const render = () =>
    act(async () =>
      root.render(
        React.createElement(AgentActivityPane, {
          active: false,
          sessions,
          unreadSessionIds: new Set(unreadIds),
          onOpenLeadSession: (id) => opened.push(`lead:${id}`),
          onOpenSession: (id) => opened.push(id),
        })
      )
    );
  return { document: dom.window.document, window: dom.window, opened, render };
}

test("a bot's task session is a Lead row under its own title, never a bot-named \"Working\" row", async (t) => {
  const { document, render, opened } = mount(
    t,
    [poolLead('t1'), poolLead('t2', { awaitingUser: 'approval' })],
    [task('t1', { title: '버그 픽스 세션' }), task('t2')]
  );
  await render();
  assert.equal(document.querySelector('[data-agent-section="working"]'), null, 'no Working section');
  assert.equal(document.querySelector('[data-agent-work]'), null);
  const section = document.querySelector('[data-agent-section="leads"]');
  assert.equal(section.querySelector('h2, .agent-session-heading'), null, 'no section name');
  const row = section.querySelector('[data-agent-lead="t1"]');
  assert.equal(row.querySelector('.agent-chat-title').textContent, '버그 픽스 세션', 'its own title, not the bot');
  assert.equal(
    section.querySelector('[data-agent-lead="t2"] .agent-chat-status').dataset.kind,
    'attention-mark',
    'waiting on the user'
  );
  await act(async () => row.querySelector('button').click());
  assert.deepEqual(opened, ['lead:t1'], 'it opens as a Lead');
});

test('a task Lead blocked on its OWN approval reads as waiting for approval, not working; it clears when answered', async (t) => {
  const { defaultSessionLaneStore } = await import('./session-lane-store.ts');
  defaultSessionLaneStore.clear();
  t.after(() => defaultSessionLaneStore.clear());
  const frame = (toolApproval) =>
    defaultSessionLaneStore.apply({
      sessionId: 't1',
      frameSource: 'live',
      snapshot: { sessionId: 't1', busy: true, toolApproval },
    });
  // The Lead's pool row is a plain running turn: only its lane carries the ask.
  const { document, render } = mount(
    t,
    [poolLead('t1'), poolLead('t2')],
    [task('t1', { working: true }), task('t2', { working: true })]
  );
  frame({ id: 'ap-1', tool: 'send_email' });
  await render();
  const status = (id) => document.querySelector(`[data-agent-lead="${id}"] .agent-chat-status`).dataset.kind;
  assert.equal(status('t1'), 'attention-mark', 'blocked on its own approval');
  assert.equal(status('t2'), 'running', 'another Lead keeps working');
  await act(async () => frame(null));
  assert.equal(status('t1'), 'running', 'answered, it works again');
});

test('an agent-mode work group shows once; a task session beside it is a Lead row', async (t) => {
  const member = {
    tag: 'w1',
    agent: 'worker',
    sessionId: 's-w1',
    ownerSessionId: 'g1',
    parentSessionId: 'g1',
    status: 'running',
    stage: 'running',
    turnStartedAt: NOW - 5_000,
  };
  const { document, render } = mount(t, [poolLead('g1'), member, poolLead('t1')], [task('g1'), task('t1')], ['g1']);
  await render();
  assert.equal(document.querySelector('.agent-work-section'), null, 'no Working wrapper');
  assert.equal(document.querySelectorAll('[data-agent-owner-session-id="g1"]').length, 1);
  assert.equal(document.querySelector('[data-agent-lead="g1"]'), null, 'not repeated as a Lead row');
  assert.ok(document.querySelector('[data-agent-lead="t1"]'));
});
test('search finds a task Lead by its title, not by the bot that created it', async (t) => {
  const { document, window, render } = mount(t, [poolLead('t1')], [task('t1', { title: 'Compile docs' })]);
  await render();
  const search = document.querySelector('.session-panel-header-actions [aria-pressed]');
  await act(async () => search.click());
  const type = (value) =>
    act(async () => {
      const input = document.querySelector('.agent-pane-search');
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  await type('compile');
  assert.ok(document.querySelector('[data-agent-lead="t1"]'), 'title match');
  await type('zzz-nothing');
  assert.equal(document.querySelector('[data-agent-lead="t1"]'), null);
});

const coding = (id, extra = {}) => ({ id, title: `Code ${id}`, preview: '', updatedAt: 1, messageCount: 1, ...extra });
const child = (id, owner, extra = {}) => ({
  tag: `w:${id}`,
  agent: 'worker',
  sessionId: id,
  ownerSessionId: owner,
  parentSessionId: owner,
  status: 'running',
  stage: 'running',
  turnStartedAt: NOW - 5_000,
  ...extra,
});
const leadSection = (document) => document.querySelector('[data-agent-section="leads"]');

test('Leads are one messenger row each, divider-separated with no header; a finished one rests in the list', async (t) => {
  const idle = { status: 'idle', stage: 'idle' };
  const { document, render, opened } = mount(
    t,
    [
      poolLead('c1', { provider: 'anthropic' }),
      poolLead('c2', idle),
      child('c2-w', 'c2'),
      poolLead('c3', idle),
      poolLead('t1'),
      poolLead('bot1'),
    ],
    [
      coding('c1', { model: 'fake-1', lastMessagePreview: 'Reading the config', activityAt: NOW - 120_000 }),
      coding('c2'),
      coding('c3'),
      task('t1'),
      coding('bot1'),
    ],
    ['bot1'],
    ['c3']
  );
  await render();
  const section = leadSection(document);
  assert.ok(section);
  assert.equal(section.querySelector('h2, .agent-session-heading, .dock-review-count'), null, 'no section header');
  assert.ok(
    section.previousElementSibling?.matches('hr.agent-chat-divider'),
    'a divider line sets the block apart from what is above'
  );
  const ids = [...section.querySelectorAll('[data-agent-lead]')].map((el) => el.dataset.agentLead);
  assert.deepEqual(ids.sort(), ['c1', 'c2', 'c3', 't1'], 'finished c3 stays; task t1 is a Lead; bot chat bot1 is not');
  const row = section.querySelector('[data-agent-lead="c1"]');
  assert.ok(row.matches('li.agent-chat-row[data-kind="contact"]'), 'the bot rows layout');
  assert.equal(row.querySelector('.agent-chat-avatar > .agent-contact-mascot'), null, 'no pup face');
  assert.equal(row.querySelector('.agent-contact-badge'), null, 'no corner badge');
  assert.equal(
    row.querySelector('.agent-chat-avatar > .agent-lead-plate > svg')?.dataset.providerIcon,
    'anthropic',
    'the provider plate fills the avatar box'
  );
  assert.equal(row.querySelector('.agent-chat-title').textContent, 'Code c1');
  assert.equal(row.querySelector('.agent-chat-preview').textContent, 'fake-1', 'the parent row preview is the model display name only');
  assert.ok(row.querySelector('.agent-contact-aside > time.agent-chat-time').textContent);
  assert.ok(row.querySelector('.agent-contact-aside > .agent-chat-status[data-kind="running"]'));
  assert.equal(row.textContent.includes('Completed'), false);
  assert.equal(section.querySelector('[data-agent-lead="c2"] .agent-chat-preview').textContent, 'Working');
  assert.equal(section.querySelector('[data-agent-lead="c3"] .agent-chat-preview').textContent, 'Idle');
  assert.equal(document.querySelector('[data-agent-section="working"]'), null, 'no Working section');
  await act(async () => row.querySelector('button').click());
  assert.deepEqual(opened, ['lead:c1']);
});

test('a finished Lead stays listed for the pane hour after it settled, resting, newest activity first', async (t) => {
  const minutes = (n) => n * 60_000;
  const settled = (id, agoMin, extra = {}) =>
    poolLead(id, { status: 'idle', stage: 'idle', turnStartedAt: null, idleSince: NOW - minutes(agoMin), ...extra });
  const { document, render, opened } = mount(
    t,
    [settled('fresh', 10), settled('stale', 61), settled('older', 59), poolLead('live')],
    [
      coding('fresh', { activityAt: NOW - minutes(10) }),
      coding('stale', { activityAt: NOW - minutes(61) }),
      coding('older', { activityAt: NOW - minutes(59) }),
      coding('live', { activityAt: NOW - minutes(30) }),
    ]
  );
  await render();
  const section = leadSection(document);
  const ids = [...section.querySelectorAll('[data-agent-lead]')].map((el) => el.dataset.agentLead);
  assert.deepEqual(ids, ['fresh', 'live', 'older'], 'newest activity first; the 61-minute Lead is gone');
  const fresh = section.querySelector('[data-agent-lead="fresh"]');
  assert.equal(fresh.querySelector('.agent-chat-preview').textContent, 'Idle', 'finished, not Working');
  assert.equal(fresh.querySelector('.agent-chat-status'), null, 'a resting row has no state mark');
  assert.equal(fresh.querySelector('.agent-contact-aside').dataset.hasStatus, undefined);
  assert.ok(fresh.querySelector('.agent-contact-aside > time.agent-chat-time').textContent, 'its time stays');
  const live = section.querySelector('[data-agent-lead="live"]');
  assert.equal(live.querySelector('.agent-chat-preview').textContent, 'Working');
  assert.ok(live.querySelector('.agent-chat-status[data-kind="running"]'));
  await act(async () => fresh.querySelector('button').click());
  assert.deepEqual(opened, ['lead:fresh'], 'a resting Lead opens like a working one');
});

test('a Lead waiting on the user shows the "!" mark where the badge sits', async (t) => {
  const { document, render } = mount(t, [poolLead('c1', { awaitingUser: 'approval' })], [coding('c1')]);
  await render();
  const row = leadSection(document).querySelector('[data-agent-lead="c1"]');
  assert.equal(row.querySelector('.agent-contact-aside > .agent-chat-status').dataset.kind, 'attention-mark');
  assert.equal(row.querySelector('.agent-chat-preview').textContent, 'Waiting for approval');
});

test('the Lead row marks the provider of its route, session route as fallback, neutral otherwise', async (t) => {
  const icon = async (pool, sessions) => {
    const m = mount(t, pool, sessions);
    await m.render();
    const mark = leadSection(m.document).querySelector('[data-agent-lead="c1"] .agent-lead-plate svg');
    return mark.dataset.providerIcon || mark.getAttribute('class') || 'neutral';
  };
  const pooled = await icon([poolLead('c1', { provider: 'openai' })], [coding('c1', { provider: 'anthropic' })]);
  const fallback = await icon([poolLead('c1')], [coding('c1', { provider: 'anthropic' })]);
  const neutral = await icon([poolLead('c1')], [coding('c1')]);
  assert.equal(pooled, 'openai');
  assert.equal(fallback, 'anthropic');
  assert.ok(neutral !== 'openai' && neutral !== 'anthropic');
});

test('search filters the Leads block, and nothing running leaves no block or divider', async (t) => {
  const m = mount(t, [poolLead('c1')], [coding('c1', { title: 'Refactor' })]);
  await m.render();
  assert.ok(leadSection(m.document));
  await act(async () => m.document.querySelector('.session-panel-header-actions [aria-pressed]').click());
  await act(async () => {
    const input = m.document.querySelector('.agent-pane-search');
    Object.getOwnPropertyDescriptor(m.window.HTMLInputElement.prototype, 'value').set.call(input, 'zzz');
    input.dispatchEvent(new m.window.Event('input', { bubbles: true }));
  });
  assert.equal(leadSection(m.document), null);
  assert.equal(m.document.querySelector('hr[aria-label="Leads"]'), null);
});

test('no representative bot yet: no Lead rows or divider, and they appear once it exists', async (t) => {
  const { publishMixyStatus, resetMixyStatus } = await import('./mixy-identity.ts');
  t.after(() => resetMixyStatus());
  resetMixyStatus({ created: false });
  const m = mount(t, [poolLead('c1')], [coding('c1')]);
  await m.render();
  assert.equal(leadSection(m.document), null, 'running Lead hidden while the create prompt shows');
  assert.equal(m.document.querySelector('hr[aria-label="Leads"]'), null, 'and no divider');
  await act(async () => publishMixyStatus({ created: true }));
  assert.ok(leadSection(m.document)?.querySelector('[data-agent-lead="c1"]'), 'rows appear live once Mixy exists');
  assert.ok(m.document.querySelector('hr[aria-label="Leads"]'));
});

// A host with a stored Lead face and a settings-changed broadcast, as the desktop and phones see it.
function leadHost(window, stored = null) {
  const host = {
    stored,
    calls: [],
    listeners: new Set(),
    announce() {
      for (const listener of host.listeners) listener({ scope: 'desktop' });
    },
  };
  const base = window.mixdogDesktop;
  window.mixdogDesktop = {
    ...base,
    invokeCapability: async ({ capability, args }) => {
      host.calls.push([capability, ...args]);
      if (capability === 'getLeadAppearance') return { value: { avatar: host.stored } };
      if (capability === 'setLeadAppearance') {
        host.stored = args[0];
        return { value: { avatar: host.stored } };
      }
      return { value: null };
    },
    subscribeSettingsChanged: (listener) => {
      host.listeners.add(listener);
      return () => host.listeners.delete(listener);
    },
  };
  return host;
}
const CORGI = { kind: 'mascot', species: 'corgi', accessory: 'glasses', expression: 'happy', color: '#5b9bff' };
test('the Lead rows no longer render the Lead face, whatever the host stored', async (t) => {
  const { resetLeadAvatar } = await import('./lead-avatar-store.ts');
  t.after(resetLeadAvatar);
  resetLeadAvatar();
  const m = mount(t, [poolLead('c1'), poolLead('c2')], [coding('c1'), coding('c2')]);
  leadHost(m.window, CORGI);
  await m.render();
  assert.equal(leadSection(m.document).querySelector('.agent-contact-mascot'), null);
  assert.equal(leadSection(m.document).querySelectorAll('.agent-lead-plate').length, 2);
});

test('a Lead row menu still offers Appearance (the face shows in approvals); a pick is saved on the host', async (t) => {
  const { resetLeadAvatar } = await import('./lead-avatar-store.ts');
  t.after(resetLeadAvatar);
  resetLeadAvatar();
  const m = mount(t, [poolLead('c1'), poolLead('c2')], [coding('c1'), coding('c2')]);
  const host = leadHost(m.window, null);
  await m.render();
  const row = leadSection(m.document).querySelector('[data-agent-lead="c1"]');
  await act(async () =>
    row.dispatchEvent(
      new m.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })
    )
  );
  const items = [...m.document.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent.trim());
  assert.ok(items.includes('Appearance'), `menu: ${items.join('|')}`);
  assert.ok(items.includes('Hide this group'), 'the row actions stay');
  await act(async () =>
    [...m.document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent.trim() === 'Appearance').click()
  );
  const dialog = m.document.querySelector('[data-lead-appearance]');
  assert.ok(dialog?.querySelector('.agent-avatar-picker'), "the bots' own picker");
  await act(async () => dialog.querySelector('[data-color="#5b9bff"]').click());
  assert.equal(host.stored.color, '#5b9bff', 'saved on the host');
  assert.equal(host.stored.kind, 'mascot');
  await act(async () =>
    [...dialog.querySelectorAll('footer button')].find((el) => el.textContent.trim() === 'Reset').click()
  );
  assert.equal(host.stored, null, 'Reset clears it on the host');
});

test('a face this device kept in localStorage moves to the host once, then is dropped', async (t) => {
  const { resetLeadAvatar } = await import('./lead-avatar-store.ts');
  t.after(resetLeadAvatar);
  resetLeadAvatar();
  const m = mount(t, [poolLead('c1')], [coding('c1')]);
  m.window.localStorage.setItem('mixdog.leadAvatar', JSON.stringify(CORGI));
  const host = leadHost(m.window, null);
  await m.render();
  assert.deepEqual(host.stored, CORGI, 'adopted by the host');
  assert.equal(m.window.localStorage.getItem('mixdog.leadAvatar'), null, 'and dropped locally');
});

// Sub-agents under a Lead row or a bot row: the chevron, the existing tree rows, keyboard, attention.
const subtree = (document, id) => document.querySelector(`[data-agent-subtree="${id}"]`);
const chevron = (document, rowSelector) => document.querySelector(`${rowSelector} > .agent-subtree-toggle`);
const key = (window, el, name) =>
  act(async () =>
    el.dispatchEvent(new window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }))
  );

test('a Lead with two levels of sub-agents folds by default and expands into the existing tree rows', async (t) => {
  const m = mount(
    t,
    [
      poolLead('c1'),
      child('s1', 'c1'),
      child('s2', 'c1', { parentSessionId: 's1', agent: 'reviewer' }),
      poolLead('c2'),
    ],
    [coding('c1'), coding('c2')]
  );
  await m.render();
  const row = '[data-agent-lead="c1"]';
  const toggle = chevron(m.document, row);
  assert.ok(toggle, 'a Lead with sub-agents has a chevron');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(toggle.getAttribute('aria-label'), 'Expand sub-agents of Code c1');
  assert.equal(m.document.querySelector(row).dataset.hasSubtree, 'true', 'the row carries the stack marker');
  assert.equal(chevron(m.document, '[data-agent-lead="c2"]'), null, 'none without sub-agents');
  assert.equal(m.document.querySelector('[data-agent-lead="c2"]').dataset.hasSubtree, undefined);
  assert.equal(subtree(m.document, 'c1'), null, 'collapsed by default');
  await act(async () => m.document.querySelector(`${row} .agent-chat-row-main`).click());
  assert.equal(toggle.getAttribute('aria-expanded'), 'false', 'the row body opens the chat, not the list');
  const menuLabels = async () => {
    await act(async () =>
      m.document
        .querySelector(row)
        .dispatchEvent(
          new m.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })
        )
    );
    return [...m.document.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent.trim());
  };
  let labels = await menuLabels();
  assert.equal(labels[0], 'Show sub-agents', `menu: ${labels.join('|')}`);
  await act(async () =>
    [...m.document.querySelectorAll('[role="menuitem"]')]
      .find((el) => el.textContent.trim() === 'Show sub-agents')
      .click()
  );
  assert.equal(toggle.getAttribute('aria-expanded'), 'true', 'the menu item toggles like the face');
  labels = await menuLabels();
  assert.equal(labels[0], 'Hide sub-agents');
  await act(async () =>
    m.document.dispatchEvent(new m.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  );
  assert.equal(toggle.getAttribute('aria-label'), 'Collapse sub-agents of Code c1');
  const tree = subtree(m.document, 'c1');
  assert.ok(tree, 'the sub-agents show');
  assert.equal(tree.querySelector('[role="tree"]') !== null, true, 'the existing ARIA tree');
  const ids = () =>
    [...subtree(m.document, 'c1').querySelectorAll('[data-agent-session-id]')].map((el) => el.dataset.agentSessionId);
  assert.deepEqual(ids(), ['s1'], 'the first level, with no duplicate Lead row');
  const first = tree.querySelector('[data-agent-session-id="s1"]');
  await key(m.window, first, 'ArrowRight');
  assert.deepEqual(ids(), ['s1', 's2'], 'the second level opens under it');
  const [a, b] = subtree(m.document, 'c1').querySelectorAll('[data-agent-session-id]');
  assert.ok(Number(b.getAttribute('aria-level')) > Number(a.getAttribute('aria-level')), 'nesting stays in aria-level');
  await act(async () => toggle.click());
  assert.equal(subtree(m.document, 'c1'), null);
});

test('the Lead plate never opens the session: it toggles sub-agents or does nothing; the title opens', async (t) => {
  const m = mount(t, [poolLead('c1'), child('s1', 'c1'), poolLead('c2')], [coding('c1'), coding('c2')]);
  await m.render();
  const plate = (id) => m.document.querySelector(`[data-agent-lead="${id}"] .agent-lead-plate`);
  await act(async () => plate('c2').click());
  assert.deepEqual(m.opened, [], 'a plate without sub-agents does nothing');
  await act(async () => plate('c1').click());
  assert.deepEqual(m.opened, [], 'a plate with sub-agents never opens either');
  const toggle = chevron(m.document, '[data-agent-lead="c1"]');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  await act(async () => toggle.click());
  assert.equal(toggle.getAttribute('aria-expanded'), 'true', 'the toggle expands');
  assert.deepEqual(m.opened, [], 'toggling does not open');
  await act(async () => m.document.querySelector('[data-agent-lead="c2"] .agent-chat-title').click());
  assert.deepEqual(m.opened, ['lead:c2'], 'the title opens the session');
  await act(async () => m.document.querySelector('[data-agent-lead="c2"] .agent-chat-row-main').click());
  assert.deepEqual(m.opened, ['lead:c2', 'lead:c2'], 'the focusable row button still opens');
});

test('a bot home thread with a sub-agent shows the chevron, expands, and clears finished from its menu', async (t) => {
  const { MIXY_AGENT_ID } = await import('../shared/agent-contacts.ts');
  const home = 'home-1';
  const m = mount(
    t,
    [poolLead(home), child('s1', home, { status: 'idle', stage: 'idle' })],
    [{ id: home, title: 'Mixy', preview: '', updatedAt: 1, messageCount: 1, agentHome: MIXY_AGENT_ID }],
    [home]
  );
  await m.render();
  const row = `[data-agent-contact="${MIXY_AGENT_ID}"]`;
  const toggle = chevron(m.document, row);
  assert.ok(toggle, 'chevron on the bot row');
  await act(async () => toggle.click());
  assert.ok(subtree(m.document, home)?.querySelector('[data-agent-session-id="s1"]'));
  await act(async () =>
    m.document
      .querySelector(row)
      .dispatchEvent(
        new m.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })
      )
  );
  const items = [...m.document.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent.trim());
  assert.ok(items.includes('Clear finished'), `menu: ${items.join('|')}`);
});

test('arrow keys move through the sub-agent tree; Left on a top sub-agent folds the parent', async (t) => {
  const m = mount(
    t,
    [poolLead('c1'), child('s1', 'c1'), child('s2', 'c1', { parentSessionId: 's1', agent: 'reviewer' })],
    [coding('c1')]
  );
  await m.render();
  await act(async () => chevron(m.document, '[data-agent-lead="c1"]').click());
  const tree = () => subtree(m.document, 'c1');
  const first = () => tree().querySelector('[data-agent-session-id="s1"]');
  assert.equal(first().getAttribute('aria-expanded'), 'false');
  await key(m.window, first(), 'ArrowRight');
  assert.equal(first().getAttribute('aria-expanded'), 'true', 'Right opens the sub-agent');
  await key(m.window, first(), 'ArrowDown');
  assert.equal(
    tree().querySelector('[data-agent-session-id="s2"]').getAttribute('tabindex'),
    '0',
    'Down moves focus down'
  );
  await key(m.window, first(), 'ArrowLeft');
  assert.equal(first().getAttribute('aria-expanded'), 'false', 'Left closes it');
  await key(m.window, first(), 'ArrowLeft');
  assert.equal(subtree(m.document, 'c1'), null, 'Left on a top row folds the parent');
});

test('a sub-agent waiting for approval opens its parent and bubbles "!" to the Lead row', async (t) => {
  const m = mount(
    t,
    [poolLead('c1'), child('s1', 'c1', { awaitingUser: 'approval' }), poolLead('c2'), child('s3', 'c2')],
    [coding('c1'), coding('c2')]
  );
  await m.render();
  assert.equal(
    m.document.querySelector('[data-agent-lead="c1"] .agent-chat-status').dataset.kind,
    'attention-mark',
    'the Lead row shows the wait'
  );
  assert.ok(subtree(m.document, 'c1'), 'it opens by itself');
  assert.equal(subtree(m.document, 'c2'), null, 'a quiet Lead stays folded');
});

import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';

import { EventEmitter } from 'node:events';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  roomMemberSessionId,
  roomSessionId,
} from '../../../../../src/runtime/agent/orchestrator/session/agent-room.mjs';
import { decideBrowserApproval, requestBrowserApproval, setBrowserApprovalHooks } from './approval-dialog.ts';

function fakeWindow(focused) {
  const sent = [];
  const window = new EventEmitter();
  const contents = new EventEmitter();
  Object.assign(contents, {
    isDestroyed: () => false,
    send: (channel, payload) => sent.push({ channel, payload }),
  });
  Object.assign(window, { sent, contents, isDestroyed: () => false, isFocused: () => focused, webContents: contents });
  return window;
}
const settle = () => new Promise((resolve) => setImmediate(resolve));
const listenerCount = (window) =>
  ['did-start-navigation', 'render-process-gone', 'destroyed'].reduce(
    (n, e) => n + window.contents.listenerCount(e),
    0
  ) + window.listenerCount('closed');
const request = () => ({
  action: 'click',
  url: 'https://example.test/path?token=secret',
  sessionId: 'sess_home_bot',
  target: 'Send',
  paths: [],
  kinds: ['submit'],
});

// Only a bot's own session asks: unless a test says otherwise, the asker is one.
beforeEach(() => setBrowserApprovalHooks({ resolveRequester: async () => ({ name: 'bot' }) }));

test('an approval is an in-app card answered over IPC, never an OS dialog', async () => {
  const window = fakeWindow(true);
  const pending = requestBrowserApproval(window, request());
  await settle();
  const [card] = window.sent;
  assert.equal(card.channel, 'mixdog:browser-approval');
  assert.equal(card.payload.sessionId, 'sess_home_bot');
  assert.ok(!card.payload.url.includes('secret'));
  decideBrowserApproval(window.contents, card.payload.id, 'once');
  assert.equal(await pending, true);
  assert.deepEqual(window.sent[1].payload, { id: card.payload.id, closed: true });
  decideBrowserApproval(window.contents, card.payload.id, 'once'); // settled ids are ignored
  assert.equal(listenerCount(window), 0, 'listeners are removed once answered');
});

test('a card has no expiry: it sends none and stays open past 30 s until the person answers', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 5_000_000 });
  const window = fakeWindow(true);
  const pending = requestBrowserApproval(window, request());
  await settle();
  const [card] = window.sent;
  assert.equal('expiresAt' in card.payload, false, 'no countdown for the renderer to show');
  let answered = false;
  void pending.then(() => (answered = true));
  t.mock.timers.tick(31_000);
  t.mock.timers.tick(6 * 60 * 60_000);
  await settle();
  assert.equal(answered, false, 'not denied by a timer');
  assert.equal(window.sent.length, 1, 'the card was not closed');
  decideBrowserApproval(window.contents, card.payload.id, 'once');
  assert.equal(await pending, true);
  assert.equal(listenerCount(window), 0);
});

test('a long-open card is still denied by Deny, by Stop (abort) and by the window going away', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 5_000_000 });
  for (const [how, end] of [
    ['deny', (window) => decideBrowserApproval(window.contents, window.sent[0].payload.id, 'deny')],
    ['closed', (window) => window.emit('closed')],
  ]) {
    const window = fakeWindow(true);
    const pending = requestBrowserApproval(window, request());
    await settle();
    t.mock.timers.tick(10 * 60_000);
    end(window);
    assert.equal(await pending, false, how);
    assert.equal(listenerCount(window), 0, how);
  }
  const window = fakeWindow(true);
  const controller = new AbortController();
  const pending = requestBrowserApproval(window, request(), controller.signal);
  await settle();
  t.mock.timers.tick(10 * 60_000);
  controller.abort();
  assert.equal(await pending, false, 'abort');
  assert.equal(window.sent.at(-1).payload.closed, true);
  assert.equal(listenerCount(window), 0);
});

test('an approval queued behind an open card leaves the queue when its command is stopped', async () => {
  const first = fakeWindow(true);
  const open = requestBrowserApproval(first, request());
  await settle();
  const second = fakeWindow(true);
  const controller = new AbortController();
  const queued = requestBrowserApproval(second, request(), controller.signal);
  await settle();
  assert.equal(second.sent.length, 0, 'waits for the open card');
  controller.abort();
  const outcome = await Promise.race([queued, new Promise((resolve) => setTimeout(() => resolve('hung'), 500))]);
  assert.equal(outcome, false, 'a stopped command does not wait for someone else to answer');
  assert.equal(second.sent.length, 0, 'its card never opened');
  // The open card is untouched, and the queue behind it still works.
  assert.equal(first.sent.length, 1);
  const third = fakeWindow(true);
  const next = requestBrowserApproval(third, request());
  decideBrowserApproval(first.contents, first.sent[0].payload.id, 'once');
  assert.equal(await open, true);
  await settle();
  decideBrowserApproval(third.contents, third.sent[0].payload.id, 'once');
  assert.equal(await next, true);
});

test('cancel denies; a background approval names the bot and notifies without focusing', async () => {
  const window = fakeWindow(false);
  const notified = [];
  setBrowserApprovalHooks({
    resolveRequester: async (sessionId) => ({ name: `bot for ${sessionId}` }),
    notify: (_window, requester) => notified.push(requester),
  });
  const pending = requestBrowserApproval(window, request());
  await settle();
  assert.equal(window.sent[0].payload.requester, 'bot for sess_home_bot');
  assert.deepEqual(notified, [{ sessionId: 'sess_home_bot', name: 'bot for sess_home_bot' }]);
  decideBrowserApproval(window.contents, window.sent[0].payload.id, 'deny');
  assert.equal(await pending, false);
  setBrowserApprovalHooks({});
});

test('the card names the chat it docks in and the bot; a denial note reaches the agent as the error', async () => {
  const window = fakeWindow(true);
  setBrowserApprovalHooks({
    resolveRequester: async () => ({ name: '사무관 › Worker' }),
    surfaceSessionId: (sessionId) => `home-of-${sessionId}`,
  });
  const pending = requestBrowserApproval(window, request());
  await settle();
  const { payload } = window.sent[0];
  assert.equal(payload.surfaceSessionId, 'home-of-sess_home_bot');
  assert.equal(payload.agentId, 'bot');
  decideBrowserApproval(window.contents, payload.id, 'deny', '  Use the staging account  ');
  // The same wording as every tool denial that a person said no to.
  await assert.rejects(
    pending,
    (error) =>
      error.message ===
      'tool "browser" was not approved: Use the staging account. Do not retry it or reach the same result another way; report it.'
  );
  assert.deepEqual(window.sent[1].payload, { id: payload.id, closed: true });
  assert.equal(listenerCount(window), 0);
  setBrowserApprovalHooks({});
});

test('a focused window shows the card without a notification', async () => {
  const window = fakeWindow(true);
  let notified = 0;
  setBrowserApprovalHooks({
    resolveRequester: async () => ({ name: 'bot' }),
    notify: () => {
      notified += 1;
    },
  });
  const pending = requestBrowserApproval(window, request());
  await settle();
  assert.equal(window.sent[0].payload.requester, 'bot');
  assert.equal(notified, 0);
  decideBrowserApproval(window.contents, window.sent[0].payload.id, 'once');
  assert.equal(await pending, true);
  setBrowserApprovalHooks({});
});

const failingResolvers = {
  rejects: async () => {
    throw new Error('catalog unavailable');
  },
  'times out': () => new Promise(() => {}),
  'catalog empty': async () => ({ name: '' }),
  'no resolver': undefined,
};

test('a bot own session (home or room seat) keeps its card for submit and confirm when the requester lookup fails', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const seat = roomMemberSessionId('abc123', 'marketer');
  for (const [how, resolveRequester] of Object.entries(failingResolvers)) {
    for (const sessionId of ['sess_home_marketer', seat]) {
      for (const kinds of [['submit'], ['confirm'], ['submit', 'confirm']]) {
        const window = fakeWindow(true);
        setBrowserApprovalHooks({ resolveRequester });
        const pending = requestBrowserApproval(window, { ...request(), sessionId, kinds });
        for (let i = 0; i < 20 && window.sent.length === 0; i += 1) {
          t.mock.timers.tick(2_000);
          await settle();
        }
        const label = `${how} ${sessionId} ${kinds}`;
        assert.equal(window.sent.length, 1, `${label} still asks`);
        const { payload } = window.sent[0];
        assert.equal(payload.agentId, 'marketer', label);
        assert.equal(payload.requester, 'marketer', `${label}: named by its id`);
        assert.equal(Boolean(payload.remember), !kinds.includes('confirm'), label);
        decideBrowserApproval(window.contents, payload.id, 'deny');
        assert.equal(await pending, false, label);
      }
    }
  }
});

test('a session that is no bot runs without a card, even when the requester lookup fails', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const resolveRequester of Object.values(failingResolvers)) {
    for (const sessionId of ['sess_coding', 'sess_w1', 'sess_task', 'sess_unknown', roomSessionId('abc123')]) {
      const window = fakeWindow(true);
      setBrowserApprovalHooks({ resolveRequester });
      assert.equal(await requestBrowserApproval(window, { ...request(), sessionId, kinds: ['confirm'] }), true);
      assert.equal(window.sent.length, 0, sessionId);
    }
  }
  const stopped = new AbortController();
  stopped.abort();
  assert.equal(
    await requestBrowserApproval(fakeWindow(true), { ...request(), sessionId: 'sess_coding' }, stopped.signal),
    false
  );
});

test('only the renderer the card was sent to can answer it', async () => {
  const window = fakeWindow(true);
  const pending = requestBrowserApproval(window, request());
  await settle();
  const { id } = window.sent[0].payload;
  decideBrowserApproval(new EventEmitter(), id, 'once'); // another webContents
  decideBrowserApproval(undefined, id, 'once');
  await settle();
  assert.equal(window.sent.length, 1, 'still open');
  decideBrowserApproval(window.contents, id, 'once');
  assert.equal(await pending, true);
});

for (const [name, leave] of [
  [
    'a main-frame navigation or reload',
    (w) => w.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false }),
  ],
  ['the renderer process dying', (w) => w.contents.emit('render-process-gone', {}, { reason: 'crashed' })],
  ['the webContents being destroyed', (w) => w.contents.emit('destroyed')],
  ['the window closing', (w) => w.emit('closed')],
]) {
  test(`${name} denies the outstanding approval and frees the lock`, async () => {
    const window = fakeWindow(true);
    const pending = requestBrowserApproval(window, request());
    await settle();
    leave(window);
    assert.equal(await pending, false);
    assert.equal(listenerCount(window), 0, 'listeners are removed');
    // The human-only lock is free again: the next approval opens at once.
    const other = fakeWindow(true);
    const next = requestBrowserApproval(other, request());
    await settle();
    assert.equal(other.sent.length, 1);
    decideBrowserApproval(other.contents, other.sent[0].payload.id, 'once');
    assert.equal(await next, true);
  });
}

test('subframe and same-document navigation leave the approval open', async () => {
  const window = fakeWindow(true);
  const pending = requestBrowserApproval(window, request());
  await settle();
  window.contents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
  window.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
  await settle();
  assert.equal(window.sent.length, 1);
  decideBrowserApproval(window.contents, window.sent[0].payload.id, 'once');
  assert.equal(await pending, true);
});

/** The host's per-bot store, in memory: `bot\naction` is a standing allow. */
function memoryGrants() {
  const allowed = new Set();
  return {
    allowed,
    resolveRequester: async (sessionId) => ({ name: sessionId.replace('sess_home_', '') }),
    isAllowed: async (agentId, actions) => actions.every((action) => allowed.has(`${agentId}\n${action}`)),
    remember: async (agentId, actions) => {
      for (const action of actions) allowed.add(`${agentId}\n${action}`);
    },
  };
}
/** Resolves with the first card the window is sent, or null once the request settled without one. */
async function cardOrSettled(window, pending) {
  let settled = false;
  void pending.then(
    () => (settled = true),
    () => (settled = true)
  );
  for (let i = 0; i < 200 && window.sent.length === 0 && !settled; i += 1) await new Promise((r) => setTimeout(r, 5));
  return window.sent[0]?.payload ?? null;
}
const asRequest = (sessionId, kinds) => ({ ...request(), sessionId, kinds });
async function ask(grants, sessionId, kinds, decision) {
  const window = fakeWindow(true);
  setBrowserApprovalHooks(grants);
  const pending = requestBrowserApproval(window, asRequest(sessionId, kinds));
  const card = await cardOrSettled(window, pending);
  if (!card) return { shown: false, outcome: await pending, window };
  decideBrowserApproval(window.contents, card.id, decision);
  const outcome = await pending;
  await settle();
  return { shown: true, card, outcome, window };
}

test('always allow is kept for that bot and kind, and its next use runs without a card', async () => {
  const grants = memoryGrants();
  const first = await ask(grants, 'sess_home_marketer', ['submit'], 'always');
  assert.deepEqual(first.card.remember, { kinds: ['submit'] });
  assert.equal(first.card.requester, 'marketer');
  assert.equal(first.outcome, true);
  assert.deepEqual([...grants.allowed], ['marketer\nbrowser_submit']);
  const second = await ask(grants, 'sess_home_marketer', ['submit'], 'deny');
  assert.deepEqual({ shown: second.shown, outcome: second.outcome }, { shown: false, outcome: true });
  assert.equal(second.window.sent.length, 0, 'no card, no window noise');
  setBrowserApprovalHooks({});
});

test('another bot, another kind, a mixed command and a revoked allow are all asked again', async () => {
  const grants = memoryGrants();
  await ask(grants, 'sess_home_marketer', ['submit'], 'always');
  const other = await ask(grants, 'sess_home_clerk', ['submit'], 'deny');
  assert.deepEqual({ shown: other.shown, outcome: other.outcome }, { shown: true, outcome: false });
  const post = await ask(grants, 'sess_home_marketer', ['post'], 'deny');
  assert.equal(post.shown, true, 'a send/post click is a different kind from a form submit');
  const mixed = await ask(grants, 'sess_home_marketer', ['submit', 'post'], 'once');
  assert.equal(mixed.shown, true, 'every kind in the command must be allowed');
  assert.equal(grants.allowed.size, 1, 'once stores nothing');
  grants.allowed.clear(); // turned back to ask in the profile
  const revoked = await ask(grants, 'sess_home_marketer', ['submit'], 'deny');
  assert.equal(revoked.shown, true);
  setBrowserApprovalHooks({});
});

test('operator-confirmed actions ask once for a bot; a non-bot session runs every kind with no card', async () => {
  const grants = memoryGrants();
  grants.allowed.add('marketer\nbrowser_submit');
  const confirm = await ask(grants, 'sess_home_marketer', ['confirm'], 'always');
  assert.equal(confirm.card.remember, null);
  assert.equal(confirm.outcome, true, 'always where none was offered is a single allow');
  const mixed = await ask(grants, 'sess_home_marketer', ['submit', 'confirm'], 'deny');
  assert.equal(mixed.shown, true, 'one kind that always asks keeps the whole command asking');
  for (const kinds of [['submit'], ['post'], ['upload'], ['confirm'], ['submit', 'confirm']]) {
    const coding = await ask(grants, 'sess_coding', kinds, 'deny');
    assert.deepEqual({ shown: coding.shown, outcome: coding.outcome }, { shown: false, outcome: true }, `${kinds}`);
    assert.equal(coding.window.sent.length, 0);
  }
  assert.deepEqual([...grants.allowed], ['marketer\nbrowser_submit'], 'nothing new was stored');
  setBrowserApprovalHooks({});
});

test('browser approvals of a bot are audited: card answers, a saved allow, and each unasked use', async () => {
  const audits = [];
  const grants = {
    ...memoryGrants(),
    audit: async (agent, actions, decision) => audits.push([agent, actions, decision]),
  };
  await ask(grants, 'sess_home_marketer', ['submit'], 'deny');
  await ask(grants, 'sess_home_marketer', ['submit'], 'once');
  await ask(grants, 'sess_home_marketer', ['submit'], 'always');
  await ask(grants, 'sess_home_marketer', ['submit'], 'deny'); // runs unasked now
  await ask(grants, 'sess_coding', ['submit'], 'once'); // no bot, nothing to attribute
  assert.deepEqual(audits, [
    ['marketer', ['browser_submit'], 'deny'],
    ['marketer', ['browser_submit'], 'approve'],
    ['marketer', ['browser_submit'], 'approve'],
    ['marketer', ['browser_submit'], 'granted'],
    ['marketer', ['browser_submit'], 'remembered'],
  ]);
  setBrowserApprovalHooks({});
});

test('a schedule/webhook run submits, posts and uploads without a card; the bot block and operator confirm still apply', async () => {
  const audits = [];
  const blocked = new Set();
  const grants = {
    ...memoryGrants(),
    isBlocked: async (agentId, actions) => actions.some((action) => blocked.has(`${agentId}\n${action}`)),
    audit: async (agent, actions, decision) => audits.push([agent, actions, decision]),
  };
  const askRun = async (sessionId, kinds, unattendedAgent = 'marketer') => {
    const window = fakeWindow(true);
    setBrowserApprovalHooks(grants);
    const pending = requestBrowserApproval(window, {
      ...asRequest(sessionId, kinds),
      unattended: true,
      unattendedAgent,
    });
    const card = await cardOrSettled(window, pending);
    return { card, window, pending };
  };
  for (const kinds of [['submit'], ['post'], ['upload'], ['submit', 'post']]) {
    const run = await askRun('sess_home_marketer', kinds);
    assert.equal(run.card, null, `${kinds} shows no card`);
    assert.equal(await run.pending, true);
    assert.equal(run.window.sent.length, 0);
  }
  assert.deepEqual(
    audits.map((row) => row[2]),
    ['run-allowed', 'run-allowed', 'run-allowed', 'run-allowed']
  );
  // The bot's own block stops the step in a run.
  blocked.add('marketer\nbrowser_upload');
  const stopped = await askRun('sess_home_marketer', ['upload']);
  await assert.rejects(stopped.pending, /blocked by this bot's permission/);
  assert.equal(audits.at(-1)[2], 'blocked');
  // An operator-confirmed action still asks, even in a run.
  const confirm = await askRun('sess_home_marketer', ['confirm']);
  assert.ok(confirm.card, 'confirm asks');
  decideBrowserApproval(confirm.window.contents, confirm.card.id, 'deny');
  assert.equal(await confirm.pending, false);
  // An attended request is unchanged: it asks.
  const attended = await ask(grants, 'sess_home_marketer', ['submit'], 'deny');
  assert.equal(attended.shown, true);
  setBrowserApprovalHooks({});
});

// The run's owning bot comes from the run record (`unattendedAgent`, runtime-set),
// never from the requester's display metadata, which can time out or be empty.
test('a run whose owning bot cannot be established, or whose permission cannot be read, is refused', async () => {
  const audits = [];
  const blocked = new Set(['marketer\nbrowser_submit']);
  const base = {
    ...memoryGrants(),
    isBlocked: async (agentId, actions) => actions.some((action) => blocked.has(`${agentId}\n${action}`)),
    audit: async (agent, actions, decision) => audits.push([agent, actions, decision]),
  };
  const askRun = (hooks, sessionId, unattendedAgent, kinds = ['submit']) => {
    const window = fakeWindow(true);
    setBrowserApprovalHooks(hooks);
    const pending = requestBrowserApproval(window, {
      ...asRequest(sessionId, kinds),
      unattended: true,
      unattendedAgent,
    });
    return { window, pending };
  };
  const refused = /blocked by this bot's permission|owning bot/;

  // The requester never answers (timeout) or throws: the bot's block still applies.
  for (const resolveRequester of [() => new Promise(() => {}), async () => Promise.reject(new Error('down'))]) {
    const run = askRun({ ...base, resolveRequester }, 'sess_home_marketer', 'marketer');
    await assert.rejects(run.pending, refused);
    assert.equal(run.window.sent.length, 0);
  }
  // A run-origin task session resolves to no agent id: the run's bot still blocks it.
  const taskSession = { ...base, resolveRequester: async () => ({ name: 'Task' }) };
  await assert.rejects(askRun(taskSession, 'sess_task_run', 'marketer').pending, refused);
  // Not blocked: allowed, audited under the run's bot, with no card.
  blocked.clear();
  const ok = askRun(taskSession, 'sess_task_run', 'marketer');
  assert.equal(await ok.pending, true);
  assert.equal(ok.window.sent.length, 0);
  assert.deepEqual(audits.at(-1), ['marketer', ['browser_submit'], 'run-allowed']);
  // A Lead/Mixy-owned run (routines with no bot owner are recorded as 'lead'):
  // a real owner whose own permission applies, allowed unless it blocks.
  blocked.add('lead\nbrowser_submit');
  await assert.rejects(askRun(taskSession, 'sess_home_lead', 'lead').pending, refused);
  blocked.clear();
  assert.equal(await askRun(taskSession, 'sess_home_lead', 'lead').pending, true);
  assert.deepEqual(audits.at(-1), ['lead', ['browser_submit'], 'run-allowed']);
  // No owning bot recorded: refused, never allowed on a guess.
  await assert.rejects(askRun(base, 'sess_home_marketer', '').pending, /owning bot/);
  // The permission store cannot answer, or there is no way to ask it: refused.
  const broken = { ...base, isBlocked: async () => Promise.reject(new Error('store down')) };
  await assert.rejects(askRun(broken, 'sess_home_marketer', 'marketer').pending, refused);
  const { isBlocked: _unused, ...unreadable } = base;
  await assert.rejects(askRun(unreadable, 'sess_home_marketer', 'marketer').pending, refused);
  setBrowserApprovalHooks({});
});

test('an allow that cannot be saved still runs this once, tells the person, and asks again next time', async () => {
  const grants = {
    ...memoryGrants(),
    remember: async () => {
      throw new Error('store down');
    },
  };
  const first = await ask(grants, 'sess_home_marketer', ['submit'], 'always');
  assert.equal(first.outcome, true);
  assert.deepEqual(
    first.window.sent.map((entry) => entry.payload).filter((payload) => payload.saveFailed),
    [{ id: first.card.id, saveFailed: true }]
  );
  const next = await ask(grants, 'sess_home_marketer', ['submit'], 'deny');
  assert.equal(next.shown, true);
  setBrowserApprovalHooks({});
});

const uploadRequest = (sessionId, kinds, files, receiverOrigin = '') => ({
  ...request(),
  action: 'upload',
  url: 'https://app.example/page?token=secret',
  sessionId,
  kinds,
  paths: files.map((file) => file.path),
  files,
  receiverOrigin,
});
async function askUpload(
  grants,
  sessionId,
  kinds,
  decision,
  files = [{ path: join(tmpdir(), 'a.txt'), size: 12 }],
  receiverOrigin = ''
) {
  const window = fakeWindow(true);
  setBrowserApprovalHooks(grants);
  const pending = requestBrowserApproval(window, uploadRequest(sessionId, kinds, files, receiverOrigin));
  const card = await cardOrSettled(window, pending);
  if (!card) return { shown: false, outcome: await pending, window };
  decideBrowserApproval(window.contents, card.id, decision);
  const outcome = await pending;
  await settle();
  return { shown: true, card, outcome, window };
}

test('an upload card carries the destination origin, each file, and marks files outside the project', async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'upload-card-project-')));
  const downloads = realpathSync(mkdtempSync(join(tmpdir(), 'upload-card-downloads-')));
  const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'upload-card-elsewhere-')));
  try {
    const grants = {
      ...memoryGrants(),
      resolveRequester: async () => ({ name: 'marketer', cwd: project }),
      downloadsDir: () => downloads,
    };
    const files = [
      { path: join(project, 'src', 'in.txt'), size: 5 },
      { path: join(downloads, 'dl.pdf'), size: 2048 },
      { path: join(elsewhere, 'secret.txt'), size: 7 },
    ];
    const { card } = await askUpload(
      grants,
      'sess_home_marketer',
      ['upload'],
      'deny',
      files,
      'https://pay.other.example'
    );
    assert.equal(card.origin, 'https://app.example');
    assert.equal(card.receiverOrigin, 'https://pay.other.example');
    assert.ok(!card.url.includes('secret'));
    assert.deepEqual(
      card.files.map((file) => [file.name, file.path, file.size, file.outside]),
      [
        ['in.txt', files[0].path, 5, false],
        ['dl.pdf', files[1].path, 2048, false],
        ['secret.txt', files[2].path, 7, true],
      ]
    );
    assert.deepEqual(card.remember, { kinds: ['upload'] });
    // Without a known working directory nothing is marked.
    const unknown = await askUpload(memoryGrants(), 'sess_home_marketer', ['upload'], 'deny', files);
    assert.deepEqual(
      unknown.card.files.map((file) => file.outside),
      [false, false, false]
    );
  } finally {
    setBrowserApprovalHooks({});
    for (const dir of [project, downloads, elsewhere]) rmSync(dir, { recursive: true, force: true });
  }
});

test('always allow for uploads is kept per bot, runs the next upload unasked, and covers no other kind', async () => {
  const audits = [];
  const grants = {
    ...memoryGrants(),
    audit: async (agent, actions, decision) => audits.push([agent, actions, decision]),
  };
  const first = await askUpload(grants, 'sess_home_marketer', ['upload'], 'always');
  assert.equal(first.outcome, true);
  assert.deepEqual([...grants.allowed], ['marketer\nbrowser_upload']);
  const next = await askUpload(grants, 'sess_home_marketer', ['upload'], 'deny');
  assert.deepEqual({ shown: next.shown, outcome: next.outcome }, { shown: false, outcome: true });
  assert.deepEqual(audits.at(-1), ['marketer', ['browser_upload'], 'remembered']);
  const other = await askUpload(grants, 'sess_home_clerk', ['upload'], 'deny');
  assert.deepEqual({ shown: other.shown, outcome: other.outcome }, { shown: true, outcome: false }, 'another bot');
  const submit = await ask(grants, 'sess_home_marketer', ['submit'], 'deny');
  assert.equal(submit.shown, true, 'an upload allow is not a submit allow');
  const post = await ask(grants, 'sess_home_marketer', ['post'], 'deny');
  assert.equal(post.shown, true, 'nor a post allow');
  await ask(grants, 'sess_home_marketer', ['submit'], 'always');
  const reverse = await askUpload(memoryGrants(), 'sess_home_marketer', ['upload'], 'deny');
  assert.equal(reverse.shown, true);
  assert.equal(
    (await askUpload(grants, 'sess_home_marketer', ['upload', 'submit'], 'once')).shown,
    false,
    'both allowed'
  );
  setBrowserApprovalHooks({});
});

test('an operator-listed upload (confirm) always asks and is never remembered', async () => {
  const grants = memoryGrants();
  grants.allowed.add('marketer\nbrowser_upload');
  const confirm = await askUpload(grants, 'sess_home_marketer', ['upload', 'confirm'], 'always');
  assert.equal(confirm.shown, true, 'a standing upload allow does not skip an operator confirm');
  assert.equal(confirm.card.remember, null);
  assert.deepEqual([...grants.allowed], ['marketer\nbrowser_upload'], 'nothing new was stored');
  const only = await askUpload(memoryGrants(), 'sess_home_marketer', ['confirm'], 'always');
  assert.equal(only.card.remember, null);
  setBrowserApprovalHooks({});
});

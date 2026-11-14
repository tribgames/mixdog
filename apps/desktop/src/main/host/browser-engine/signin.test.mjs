import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SAVED_SIGN_IN_DONE, SAVED_SIGN_IN_NEEDS_USER } from '../../browser/auto-sign-in.ts';
import { registerSignIn, savedSignInNote } from './signin.ts';

function harness({ afterCommand, replyLine, fillStored } = {}) {
  const handlers = new Map();
  const log = [];
  const connection = { request: async () => ({}), handleRequest: (method, handler) => handlers.set(method, handler) };
  const guest = { id: 7, isDestroyed: () => false, getURL: () => 'https://a.example/' };
  const state = { pageId: 'p1', documentGeneration: 1, cdpSessions: new Map() };
  const ctx = {
    page: (id) => (id === 'p1' ? { guest, state } : undefined),
    session: () => undefined,
    cdp: {},
    events: { flush: () => {}, facts: (id) => ({ pageId: id, seq: 1 }) },
    redactKnown: (_id, text) => text,
    isEngineMode: () => true,
  };
  const deps = {
    beforeAction: async (_guest, action, command) => void log.push(`before ${action} ${JSON.stringify(command)}`),
    afterCommand:
      afterCommand ??
      (async (input) => {
        log.push(`after ${input.sessionId} ${input.turnId} ${(await input.observe()).text === ''}`);
        return null;
      }),
    replyLine: replyLine ?? (async (input) => (log.push(`line ${input.turnId}`), '')),
    fillStored:
      fillStored ??
      (async (_guest, account) => (log.push(`fill ${account}`), { usernameFilled: true, passwordFilled: true })),
    beginTurn: (sessionId, turn) => log.push(`begin ${sessionId} ${turn}`),
    finishTurn: (sessionId, turn, aborted) => (log.push(`finish ${sessionId} ${turn} ${aborted}`), 2),
    forget: (sessionId) => log.push(`forget ${sessionId}`),
    onDiagnostic: (event) => log.push(`diagnostic ${event}`),
  };
  registerSignIn(connection, ctx, deps);
  const call = (method, params) => handlers.get(`host/browser/${method}`)(params, new AbortController().signal);
  return { call, log, handlers };
}

test('the sign-in lane serves the three requests', () => {
  assert.deepEqual([...harness().handlers.keys()].sort(), ['host/browser/credentials/fill', 'host/browser/signIn', 'host/browser/turn']);
});

test('the saved-login note is the first paragraph of a sign-in reply, and only when it is one of the two notes', () => {
  assert.equal(savedSignInNote(`${SAVED_SIGN_IN_DONE}a.test with its saved login.\n\nPage: x`), `${SAVED_SIGN_IN_DONE}a.test with its saved login.`);
  assert.equal(savedSignInNote(`${SAVED_SIGN_IN_NEEDS_USER}a.test: hand it over.\n\n`), `${SAVED_SIGN_IN_NEEDS_USER}a.test: hand it over.`);
  assert.equal(savedSignInNote('Page: x\n\nmore'), '');
  assert.equal(savedSignInNote(''), '');
});

test('before an action the host notes the fields the agent names, for the turn the session is in', async () => {
  const h = harness();
  const answer = await h.call('signIn', {
    sessionId: 'sess',
    pageId: 'p1',
    op: 'beforeAction',
    turn: 4,
    action: 'fill',
    command: { ref: 'p1-s1-e2', text: 'me@a.test' },
  });
  assert.equal(answer.facts.pageId, 'p1');
  assert.deepEqual(h.log, ['begin sess 4', 'before fill {"ref":"p1-s1-e2","text":"me@a.test"}']);
});

test('after a command a sign-in the host made answers its note, and the identity line rides with it', async () => {
  const h = harness({
    afterCommand: async () => ({ text: `${SAVED_SIGN_IN_DONE}a.test with its saved login (the password never left the host).\n\n` }),
    replyLine: async () => 'Linked sign-in: a.test used Google.',
  });
  const answer = await h.call('signIn', { sessionId: 'sess', pageId: 'p1', op: 'afterCommand', turn: 1 });
  assert.equal(answer.note, `${SAVED_SIGN_IN_DONE}a.test with its saved login (the password never left the host).`);
  assert.equal(answer.line, 'Linked sign-in: a.test used Google.');
});

test('a command that filled a saved account itself is followed by no automatic sign-in', async () => {
  const h = harness();
  const answer = await h.call('signIn', { sessionId: 'sess', pageId: 'p1', op: 'afterCommand', turn: 2, explicitFill: true });
  assert.equal(answer.note, undefined);
  assert.deepEqual(h.log, ['begin sess 2', 'line 2']);
});

test('a reply line that cannot be read is reported and the command still answers', async () => {
  const h = harness({
    replyLine: async () => {
      throw new Error('store unreadable');
    },
  });
  const answer = await h.call('signIn', { sessionId: 'sess', pageId: 'p1', op: 'afterCommand', turn: 1 });
  assert.equal(answer.line, undefined);
  assert.ok(h.log.includes('diagnostic browser-linked-sign-in-reply-failed'));
});

test('signIn needs a live page, a known op and a valid session', async () => {
  const h = harness();
  await assert.rejects(h.call('signIn', { sessionId: 'sess', pageId: 'gone', op: 'afterCommand' }), (e) => e.code === -32011);
  await assert.rejects(h.call('signIn', { sessionId: 'sess', pageId: 'p1', op: 'nope' }), (e) => e.code === -32602);
  await assert.rejects(h.call('signIn', { sessionId: 'bad id', pageId: 'p1', op: 'afterCommand' }), (e) => e.code === -32602);
});

test('a saved account is written into the page and the form answer goes back', async () => {
  const h = harness({ fillStored: async () => ({ usernameFilled: true, passwordFilled: false, reason: 'no-password-field' }) });
  const answer = await h.call('credentials/fill', { pageId: 'p1', account: 'work' });
  assert.deepEqual([answer.usernameFilled, answer.passwordFilled, answer.reason], [true, false, 'no-password-field']);
  await assert.rejects(h.call('credentials/fill', { pageId: 'p1' }), (e) => e.code === -32602);
  const taken = harness();
  assert.equal((await taken.call('credentials/fill', { pageId: 'p1', account: 'work' })).passwordFilled, true);
  assert.deepEqual(taken.log, ['fill work']);
});

test('a turn end and a session release reach the host bookkeeping', async () => {
  const h = harness();
  assert.deepEqual(await h.call('turn', { sessionId: 'sess', op: 'end', turn: 3, aborted: true }), { closed: 2 });
  assert.deepEqual(await h.call('turn', { sessionId: 'sess', op: 'forget' }), { closed: 0 });
  assert.deepEqual(h.log, ['finish sess 3 true', 'forget sess']);
  await assert.rejects(h.call('turn', { sessionId: 'sess', op: 'end' }), (e) => e.code === -32602);
  await assert.rejects(h.call('turn', { sessionId: 'sess', op: 'nope', turn: 1 }), (e) => e.code === -32602);
});

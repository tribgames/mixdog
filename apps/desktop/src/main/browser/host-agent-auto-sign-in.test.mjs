import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createBrowserActionApproval } from './action-approval.ts';
import { requestBrowserApproval, setBrowserApprovalHooks } from './approval-dialog.ts';
import { browserAutoSignInDeps } from './host-agent.ts';

const URL_NOW = 'https://bank.example/login';

function fixture({ allow = true } = {}) {
  const asked = [];
  const profileCalls = [];
  const vaultCalls = [];
  const guest = { getURL: () => URL_NOW, isDestroyed: () => false };
  const base = {
    profileImporter: {
      // The full saved-login list still holds a login the vault paused.
      credentialSuggestions: async (url) => {
        profileCalls.push(url);
        return [{ id: 'paused', label: 'd•••m' }];
      },
      useCredential: async () => undefined,
    },
    documents: { collect: async () => [] },
    state: { pageId: () => 'p1', for: () => ({ documentGeneration: 3 }), invalidateInteraction() {} },
    // The real policy classifier, asking a stand-in for the bot's dialog.
    approvals: createBrowserActionApproval({
      ask: async (request) => {
        asked.push(request);
        return allow;
      },
    }),
    sessions: { sessionIdForGuest: (page) => (page === guest ? 'sess_home_banker' : undefined) },
  };
  const tools = { credentialFill: { fillCredentialInGuest: async () => ({}) }, input: { pressKey: async () => {} } };
  const deps = browserAutoSignInDeps(
    base,
    tools,
    () => true,
    async (origin) => {
      vaultCalls.push(origin);
      return [];
    }
  );
  return { deps, guest, asked, profileCalls, vaultCalls };
}

test("auto sign-in's accounts come from the vault: a signed-out or deleted origin does not sign in by itself", async () => {
  const f = fixture();
  assert.deepEqual(await f.deps.suggestions(URL_NOW), [], 'the vault has no auto-sign-in login for it');
  assert.deepEqual(f.vaultCalls, [URL_NOW]);
  assert.deepEqual(f.profileCalls, [], 'never the full saved-login list');
});

test("auto sign-in's Enter goes through the bot's browser approval as a submit; a denial throws", async () => {
  const allowed = fixture();
  await allowed.deps.approveSubmit(allowed.guest);
  assert.equal(allowed.asked.length, 1, 'the submit is asked about');
  assert.deepEqual(allowed.asked[0].kinds, ['submit'], 'classified as a form submit');
  assert.equal(allowed.asked[0].action, 'press');
  assert.equal(allowed.asked[0].url, URL_NOW);
  assert.equal(allowed.asked[0].sessionId, 'sess_home_banker', "the page owner's bot policy applies");
  const denied = fixture({ allow: false });
  await assert.rejects(denied.deps.approveSubmit(denied.guest), 'a block or denial hands the sign-in off');
});

test("auto sign-in's Enter is asked as an unattended run of the page owner's bot, so a policy that only asks lets it through", async () => {
  const f = fixture();
  await f.deps.approveSubmit(f.guest);
  assert.equal(f.asked[0].unattended, true);
  assert.equal(f.asked[0].unattendedAgent, 'banker');
  assert.deepEqual(f.asked[0].kinds, ['submit']);
});

test('through the real approval dialog: an ask policy shows no card, a block still blocks', async () => {
  const sent = [];
  const window = new EventEmitter();
  const contents = new EventEmitter();
  Object.assign(contents, { isDestroyed: () => false, send: (channel, payload) => sent.push({ channel, payload }) });
  Object.assign(window, { isDestroyed: () => false, isFocused: () => true, webContents: contents });
  const blocked = new Set();
  setBrowserApprovalHooks({
    resolveRequester: async () => ({ name: 'banker' }),
    isBlocked: async (agentId, actions) => actions.some((action) => blocked.has(`${agentId}\n${action}`)),
  });
  try {
    const guest = { getURL: () => URL_NOW, isDestroyed: () => false };
    const base = {
      profileImporter: {},
      documents: {},
      state: { pageId: () => 'p1', for: () => ({ documentGeneration: 1 }) },
      approvals: createBrowserActionApproval({
        ask: (request, signal) => requestBrowserApproval(window, request, signal),
      }),
      sessions: { sessionIdForGuest: () => 'sess_home_banker' },
    };
    const deps = browserAutoSignInDeps(
      base,
      { credentialFill: {}, input: {} },
      () => true,
      async () => []
    );
    await deps.approveSubmit(guest);
    assert.equal(sent.length, 0, 'no approval card for the saved sign-in');
    blocked.add('banker\nbrowser_submit');
    await assert.rejects(deps.approveSubmit(guest), /blocked by this bot's permission/);
    assert.equal(sent.length, 0);
  } finally {
    setBrowserApprovalHooks({});
  }
});

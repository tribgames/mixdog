import '../../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createAskUserToolHandlers, runAskUserHandoff } from './ask-user-tool.mjs';
import { createToolApproval } from '../../tui/session/tool-approval.mjs';
import { createHumanGateStore, setHumanGateStore } from '../../runtime/agent/orchestrator/session/human-gate/store.mjs';
import { validateAskUserHandoff } from '../../runtime/agent/orchestrator/runtime-core/ask-user-tool-defs.mjs';
import {
  humanRequestFields,
  normalizeHumanResponse,
} from '../../runtime/agent/orchestrator/session/human-gate/requests.mjs';

test('a takeover carries its validated target identity to the presented request; junk identities are dropped', async (t) => {
  sinks(t);
  const browser = validateAskUserHandoff({
    handoff: { kind: 'takeover', surface: 'browser', instructions: 'Sign in', target: 'shop login', tab: 'p2' },
  });
  assert.deepEqual(browser.identity, { tab: 'p2' });
  assert.equal(browser.need, 'action');
  const junk = validateAskUserHandoff({
    handoff: { kind: 'takeover', surface: 'browser', instructions: 'x', tab: 'p2"; alert(1)', window_id: 'hwnd:0x1' },
  });
  assert.deepEqual(junk.identity, {}, 'a non-token tab and a computer field on a browser takeover are dropped');
  const computer = validateAskUserHandoff({
    handoff: { kind: 'takeover', surface: 'computer', instructions: 'x', window_id: 'hwnd:0x1A', app: 'Bank' },
  });
  assert.deepEqual(computer.identity, { windowId: 'hwnd:0x1A', app: 'Bank' });
  let asked;
  await runAskUserHandoff(browser, {
    sessionId: 's',
    hook: async (request) => {
      asked = request;
      return { approved: true, response: 'done' };
    },
  });
  const presented = humanRequestFields(asked);
  assert.deepEqual(presented.takeover, {
    surface: 'browser',
    instructions: 'Sign in',
    target: 'shop login',
    tab: 'p2',
  });
  assert.deepEqual(
    humanRequestFields({ kind: 'takeover', takeover: { surface: 'computer', windowId: 'bad id', app: 'Bank' } })
      .takeover,
    { surface: 'computer', instructions: '', app: 'Bank' }
  );
  // "Done" releases control only: it is never a remembered grant for a later purchase/send/delete.
  assert.deepEqual(presented.remember, ['once']);
  assert.equal(normalizeHumanResponse(presented, true, { response: 'done', remember: 'agent' }).remember, 'once');
});

test('a login takeover carries purpose, validated page and page binding; without it nothing changes', async (t) => {
  sinks(t);
  const login = validateAskUserHandoff({
    handoff: {
      kind: 'takeover',
      surface: 'browser',
      purpose: 'login',
      url: 'https://accounts.example.com/signin?next=/billing',
      instructions: 'Sign in to example.com',
      tab: 'p1',
    },
  });
  assert.deepEqual(login.login, {
    url: 'https://accounts.example.com/signin?next=/billing',
    origin: 'https://accounts.example.com',
  });
  assert.equal(login.need, 'sign_in', 'a login defaults to sign_in');
  let asked;
  const facts = [];
  assert.equal(
    await runAskUserHandoff(login, {
      sessionId: 's',
      hook: async (request) => {
        asked = request;
        return { approved: true, response: 'done' };
      },
      inputs: {
        page: async (_session, action, fields) => {
          facts.push([action, fields]);
          return action === 'page_url' ? { url: 'https://accounts.example.com/billing?code=SECRET#x' } : {};
        },
      },
    }),
    'User pressed Done; page now at https://accounts.example.com/billing',
    'facts only, never a "signed in" verdict, and no query that could carry a code'
  );
  const [[accountsAction, accountsFields], ...rest] = facts;
  assert.equal(accountsAction, 'login_accounts');
  assert.match(accountsFields.request_id, /^secret_[0-9a-f-]{36}$/, 'the saved-login binding id');
  assert.deepEqual(accountsFields, {
    url: 'https://accounts.example.com/signin?next=/billing',
    request_id: accountsFields.request_id,
    tab: 'p1',
  });
  assert.deepEqual(rest, [['page_url', { tab: 'p1' }]]);
  assert.deepEqual(humanRequestFields(asked).takeover, {
    surface: 'browser',
    instructions: 'Sign in to example.com',
    tab: 'p1',
    purpose: 'login',
    url: 'https://accounts.example.com/signin?next=/billing',
    origin: 'https://accounts.example.com',
  });
  // Loopback http is a local site; everything else must be https.
  assert.equal(
    validateAskUserHandoff({
      handoff: {
        kind: 'takeover',
        surface: 'browser',
        purpose: 'login',
        url: 'http://127.0.0.1:5000/',
        instructions: 'x',
      },
    }).login.origin,
    'http://127.0.0.1:5000'
  );
  for (const url of [
    'http://example.com/login',
    'https://user:pw@example.com/',
    'javascript:alert(1)',
    '',
    undefined,
  ]) {
    assert.throws(
      () =>
        validateAskUserHandoff({
          handoff: { kind: 'takeover', surface: 'browser', purpose: 'login', url, instructions: 'x' },
        }),
      /https url/,
      String(url)
    );
  }
  assert.throws(
    () =>
      validateAskUserHandoff({
        handoff: { kind: 'takeover', surface: 'computer', purpose: 'login', url: 'https://a.com', instructions: 'x' },
      }),
    /browser takeover/
  );
  assert.throws(
    () =>
      validateAskUserHandoff({
        handoff: { kind: 'takeover', surface: 'browser', purpose: 'pay', url: 'https://a.com', instructions: 'x' },
      }),
    /browser takeover/
  );
  // A presented request re-validates: a forged plain-http login is no login at all.
  assert.equal(
    humanRequestFields({
      kind: 'takeover',
      takeover: { surface: 'browser', instructions: 'x', purpose: 'login', url: 'http://evil.example/' },
    }).takeover.purpose,
    undefined
  );
  const plain = validateAskUserHandoff({
    handoff: { kind: 'takeover', surface: 'browser', instructions: 'Solve the CAPTCHA', url: 'https://a.com' },
  });
  assert.equal(plain.login, undefined, 'no purpose, no login: the side-panel takeover stays');
  assert.equal(plain.need, 'action');
});

const SENTINEL = 'S3NT1NEL-secret-value-9f2c';

/** Every place a value could leak to: presented requests, state, results, logs, audit. */
function sinks(t) {
  const dir = mkdtempSync(join(tmpdir(), 'secret-sinks-'));
  setHumanGateStore(createHumanGateStore(dir));
  const logs = [];
  const originals = { write: process.stderr.write, log: console.log, error: console.error, warn: console.warn };
  process.stderr.write = (chunk, ...rest) => {
    logs.push(String(chunk));
    return originals.write.call(process.stderr, chunk, ...rest);
  };
  for (const name of ['log', 'error', 'warn']) console[name] = (...args) => logs.push(args.map(String).join(' '));
  t.after(() => {
    process.stderr.write = originals.write;
    Object.assign(console, { log: originals.log, error: originals.error, warn: originals.warn });
    setHumanGateStore(null);
    rmSync(dir, { recursive: true, force: true });
  });
  const states = [];
  let state = { toolApproval: null, items: [] };
  const slots = new Map(); // the desktop main process's one-shot slot
  const api = createToolApproval({
    getState: () => state,
    set: (patch) => {
      state = { ...state, ...patch };
      states.push(structuredClone(state));
      const request = patch.toolApproval;
      if (request?.kind === 'secret') {
        // The card: the value goes renderer → main (the slot); the decision
        // carries only the verdict, even when a buggy card adds the value.
        queueMicrotask(() => {
          slots.set(request.secret.requestId, SENTINEL);
          api.finishToolApproval(request.id, true, '', 'desktop', undefined, undefined, {
            response: 'provide-secret',
            value: SENTINEL,
            editedArgs: { value: SENTINEL },
          });
        });
      }
    },
    nextId: () => `req-${states.length + 1}`,
    getDisposed: () => false,
    timeoutMs: 60_000,
  });
  const filled = [];
  const bound = [];
  const inputs = {
    browser: async (_sessionId, requestId) => {
      const value = slots.get(requestId);
      slots.delete(requestId);
      filled.push(value);
      return value ? 'entered' : 'expired';
    },
    // The desktop binds the request to its page at request time.
    page: async (_sessionId, action, fields) => {
      bound.push([action, fields]);
      return { origin: 'https://github.com', form: 'password' };
    },
  };
  const audit = () => readFileSync(join(dir, 'audit.jsonl'), 'utf8');
  return { api, states, logs, inputs, filled, bound, audit };
}

test('a secret reaches only the target field: never the transcript, context, logs, args or audit', async (t) => {
  const s = sinks(t);
  const approvals = [];
  const result = await runAskUserHandoff(
    { kind: 'secret', surface: 'browser', target: 'github.com sign-in', field: 'Password', instructions: '' },
    {
      hook: async (request) => {
        const answer = await s.api.requestToolApproval(request);
        approvals.push(answer);
        return answer;
      },
      sessionId: 'sess_home_lead',
      toolCallId: 'call-1',
      inputs: s.inputs,
    }
  );
  assert.equal(result, 'entered');
  assert.deepEqual(s.filled, [SENTINEL], 'the field got the value exactly once');
  const presented = s.states.find((state) => state.toolApproval)?.toolApproval;
  assert.equal(presented.kind, 'secret');
  assert.equal(presented.timeoutMs, 120_000);
  assert.deepEqual(s.bound, [['secret_bind', { request_id: presented.secret.requestId, field: 'Password' }]]);
  assert.equal(presented.secret.origin, 'https://github.com', 'the card names the bound page');
  assert.equal(presented.secret.form, 'password');
  assert.deepEqual(presented.args, { surface: 'browser', target: 'github.com sign-in', field: 'Password' });
  for (const [sink, value] of [
    ['transcript/state', JSON.stringify(s.states)],
    ['model context (tool result)', JSON.stringify(result)],
    ['approval result', JSON.stringify(approvals)],
    ['logs', s.logs.join('\n')],
    ['audit', s.audit()],
  ]) {
    assert.doesNotMatch(value, new RegExp(SENTINEL), `${sink} must not hold the secret`);
  }
  assert.match(s.audit(), /"kind":"secret".*"decision":"entered".*"device":"desktop"/);
});

test('a secret request that expires or is skipped says only so; nobody to ask is blocked', async () => {
  const hook = (answer) => async () => answer;
  const handoff = {
    kind: 'secret',
    surface: 'computer',
    target: 'App',
    field: 'Token',
    instructions: '',
    identity: { windowId: 'hwnd:0x1', ref: 'e3' },
  };
  const filled = [];
  const inputs = { computer: async () => filled.push('typed') && 'entered', computerBind: async () => 'bound' };
  assert.equal(
    await runAskUserHandoff(handoff, { hook: hook({ approved: false, timedOut: true }), sessionId: 's', inputs }),
    'expired'
  );
  assert.equal(
    await runAskUserHandoff(handoff, { hook: hook({ approved: false, response: 'skip' }), sessionId: 's', inputs }),
    'user_skipped'
  );
  assert.equal(await runAskUserHandoff(handoff, { hook: undefined, sessionId: 's', inputs }), 'blocked');
  assert.deepEqual(filled, [], 'nothing is typed without a provided secret');
});

test('the outcome mapping: entered / user_skipped / no_field / page_changed / blocked / expired, and takeover facts', async () => {
  const { secretOutcome, takeoverOutcome } = await import('./ask-user-tool.mjs');
  const provided = { approved: true, response: 'provide-secret' };
  const fill = (answer) => async () => answer;
  for (const answer of ['entered', 'no_field', 'page_changed', 'blocked', 'expired']) {
    assert.equal(await secretOutcome(provided, fill(answer)), answer, answer);
  }
  assert.equal(await secretOutcome(provided, fill('provided')), 'blocked', 'an unknown answer is no success');
  assert.equal(await secretOutcome({ approved: false, response: 'skip' }, fill('entered')), 'user_skipped');
  assert.equal(await secretOutcome({ approved: false, timedOut: true }, fill('entered')), 'expired');
  // Takeover: impl-session-lock's expiry settles with reason exactly 'expired'.
  assert.equal(takeoverOutcome({ approved: false, reason: 'expired' }), 'expired');
  assert.equal(takeoverOutcome({ approved: false, reason: 'denied by user' }), 'user_skipped');
  assert.equal(takeoverOutcome({ approved: true, response: 'done' }), 'User pressed Done');
  assert.equal(
    takeoverOutcome({ approved: true, response: 'done' }, 'https://a.example/main.do?sid=1'),
    'User pressed Done; page now at https://a.example/main.do'
  );
  assert.equal(
    takeoverOutcome({ approved: true, response: 'done', reason: 'saved_login' }, 'https://a.example/'),
    'User chose a saved login; it was filled in; page now at https://a.example/'
  );
  for (const text of ['User pressed Done; page now at https://a.example/', 'User pressed Done']) {
    assert.doesNotMatch(text, /signed in|logged in/i);
  }
});

test('a secret is bound at request time: no page or no field never asks; a computer secret carries window and ref', async (t) => {
  sinks(t);
  const asked = [];
  const hook = async (request) => {
    asked.push(request);
    return { approved: true, response: 'provide-secret' };
  };
  const browser = validateAskUserHandoff({ handoff: { kind: 'secret', surface: 'browser', field: 'Code', tab: 'p3' } });
  const seen = [];
  const page = (facts) => async (_session, action, fields) => {
    seen.push([action, fields.tab]);
    return facts;
  };
  assert.equal(await runAskUserHandoff(browser, { hook, sessionId: 's', inputs: { page: page(null) } }), 'blocked');
  assert.equal(
    await runAskUserHandoff(browser, {
      hook,
      sessionId: 's',
      inputs: { page: page({ origin: 'https://a.example', form: '' }) },
    }),
    'no_field'
  );
  assert.deepEqual(asked, [], 'the user is never asked for a value with nowhere to go');
  assert.deepEqual(seen, [
    ['secret_bind', 'p3'],
    ['secret_bind', 'p3'],
  ]);
  assert.equal(
    await runAskUserHandoff(browser, {
      hook,
      sessionId: 's',
      inputs: {
        page: page({ origin: 'https://a.example', form: 'otp', length: 8 }),
        browser: async () => 'page_changed',
      },
    }),
    'page_changed'
  );
  assert.deepEqual(humanRequestFields(asked[0]).secret, {
    requestId: asked[0].secret.requestId,
    surface: 'browser',
    target: '',
    field: 'Code',
    origin: 'https://a.example',
    form: 'otp',
    length: 8,
  });
  const computer = validateAskUserHandoff({
    handoff: { kind: 'secret', surface: 'computer', field: 'PIN', window_id: 'hwnd:0x2', ref: 'e7' },
  });
  const typed = [];
  const binds = [];
  assert.equal(
    await runAskUserHandoff(computer, {
      hook,
      sessionId: 's',
      inputs: {
        computerBind: async (_session, id, options) => {
          binds.push({ id, ref: options.ref, windowId: options.windowId });
          return 'bound';
        },
        computer: async (_session, id, options) => {
          typed.push({ id, ref: options.ref, windowId: options.windowId });
          return 'entered';
        },
      },
    }),
    'entered'
  );
  assert.deepEqual(binds, [{ id: binds[0].id, ref: 'e7', windowId: 'hwnd:0x2' }], 'bound before the user is asked');
  assert.deepEqual(typed, [{ id: binds[0].id, ref: 'e7', windowId: 'hwnd:0x2' }]);
});

test('a computer secret without an exact window and field is refused at request time: never asked, bound or typed', async (t) => {
  sinks(t);
  const asked = [];
  const hook = async (request) => {
    asked.push(request);
    return { approved: true, response: 'provide-secret' };
  };
  const calls = [];
  const inputs = {
    computerBind: async (_session, _id, options) => {
      calls.push(['bind', options.windowId, options.ref]);
      return 'bound';
    },
    computer: async () => {
      calls.push(['type']);
      return 'entered';
    },
  };
  for (const handoff of [
    { kind: 'secret', surface: 'computer', field: 'PIN' },
    { kind: 'secret', surface: 'computer', field: 'PIN', window_id: 'hwnd:0x2' },
    { kind: 'secret', surface: 'computer', field: 'PIN', ref: 'e7' },
    { kind: 'secret', surface: 'computer', field: 'PIN', window_id: 'hwnd 0x2; x', ref: 'e7' },
    { kind: 'secret', surface: 'computer', field: 'PIN', window_id: 'hwnd:0x2', ref: '"e7"' },
  ]) {
    const validated = validateAskUserHandoff({ handoff });
    assert.equal(
      await runAskUserHandoff(validated, { hook, sessionId: 's', inputs }),
      'no_field',
      JSON.stringify(handoff)
    );
  }
  assert.deepEqual(asked, [], 'the user is never asked for a value with no confirmed field');
  assert.deepEqual(calls, [], 'nothing is bound or typed');
  // The desktop cannot bind it (no desktop, or it refuses the target): never asked either.
  const exact = validateAskUserHandoff({
    handoff: { kind: 'secret', surface: 'computer', field: 'PIN', window_id: 'hwnd:0x2', ref: 'e7' },
  });
  for (const [answer, outcome] of [
    ['no_field', 'no_field'],
    ['blocked', 'blocked'],
  ]) {
    assert.equal(
      await runAskUserHandoff(exact, {
        hook,
        sessionId: 's',
        inputs: { computerBind: async () => answer, computer: inputs.computer },
      }),
      outcome
    );
  }
  assert.deepEqual(asked, []);
  assert.deepEqual(calls, []);
});

test('a code length is the bound field\'s own, or absent; every saved login is presented', () => {
  const otp = (length) =>
    humanRequestFields({ kind: 'secret', secret: { requestId: 'r', form: 'otp', ...(length === undefined ? {} : { length }) } })
      .secret;
  for (const length of [2, 4, 8, 12]) assert.equal(otp(length).length, length);
  for (const length of [undefined, 0, -1, 6.5, '6']) assert.equal('length' in otp(length), false, String(length));
  const accounts = Array.from({ length: 20 }, (_, index) => ({ id: `c${index}`, label: `a•••${index}` }));
  const presented = humanRequestFields({
    kind: 'takeover',
    takeover: {
      surface: 'browser',
      purpose: 'login',
      url: 'https://accounts.example.com/signin',
      accounts,
      fillId: 'secret_12345678-aaaa',
    },
  }).takeover;
  assert.deepEqual(presented.accounts, accounts);
});

test('a login takeover carries its masked saved logins to the card; never more than ids and labels', async (t) => {
  sinks(t);
  const login = validateAskUserHandoff({
    handoff: {
      kind: 'takeover',
      surface: 'browser',
      purpose: 'login',
      url: 'https://dart.fss.or.kr/',
      instructions: 'x',
    },
  });
  let asked;
  let bindId = '';
  await runAskUserHandoff(login, {
    sessionId: 's',
    hook: async (request) => {
      asked = request;
      return { approved: false };
    },
    inputs: {
      page: async (_session, action, fields) => {
        if (action !== 'login_accounts') return null;
        bindId = fields.request_id;
        return { accounts: [{ id: 'c1', label: 'd•••m', password: 'leak' }] };
      },
    },
  });
  assert.deepEqual(humanRequestFields(asked).takeover.accounts, [{ id: 'c1', label: 'd•••m' }]);
  assert.equal(humanRequestFields(asked).takeover.fillId, bindId, 'the card fills only the page bound under this id');
  // Saved logins without a valid binding id are not offered.
  const forged = humanRequestFields({
    kind: 'takeover',
    takeover: { ...asked.takeover, fillId: 'not a binding' },
  }).takeover;
  assert.equal(forged.accounts, undefined);
  assert.equal(forged.fillId, undefined);
});

test('takeover waits for done; ask_user validates the handoff shape', async () => {
  const { ask_user } = createAskUserToolHandlers({ rt: { session: { id: 's1' } } });
  let asked;
  const done = await ask_user(
    { handoff: { kind: 'takeover', surface: 'browser', instructions: 'Solve the CAPTCHA' } },
    {
      callerCtx: {
        toolCallId: 'c1',
        toolApprovalHook: async (request) => {
          asked = request;
          return { approved: true, response: 'done' };
        },
      },
    }
  );
  assert.match(done, /^User pressed Done/);
  assert.equal(asked.kind, 'takeover');
  assert.equal(asked.takeover.instructions, 'Solve the CAPTCHA');
  assert.equal(asked.timeoutMs, null);
  assert.ok(!asked.takeover.target, 'no target named, none carried');
  assert.throws(() => validateAskUserHandoff({ handoff: { kind: 'takeover', surface: 'browser' } }), /instructions/);
  assert.throws(() => validateAskUserHandoff({ handoff: { kind: 'secret', surface: 'tv' } }), /surface/);
  assert.throws(
    () => validateAskUserHandoff({ questions: [], handoff: { kind: 'secret', surface: 'browser' } }),
    /not both/
  );
});

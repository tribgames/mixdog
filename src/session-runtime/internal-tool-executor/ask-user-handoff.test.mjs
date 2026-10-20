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
  assert.equal(
    await runAskUserHandoff(login, {
      sessionId: 's',
      hook: async (request) => {
        asked = request;
        return { approved: true, response: 'done' };
      },
    }),
    'done'
  );
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
  const inputs = {
    browser: async (_sessionId, requestId) => {
      const value = slots.get(requestId);
      slots.delete(requestId);
      filled.push(value);
      return value ? 'provided' : 'skipped';
    },
  };
  const audit = () => readFileSync(join(dir, 'audit.jsonl'), 'utf8');
  return { api, states, logs, inputs, filled, audit };
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
  assert.equal(result, 'provided');
  assert.deepEqual(s.filled, [SENTINEL], 'the field got the value exactly once');
  const presented = s.states.find((state) => state.toolApproval)?.toolApproval;
  assert.equal(presented.kind, 'secret');
  assert.equal(presented.timeoutMs, 120_000);
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
  assert.match(s.audit(), /"kind":"secret".*"decision":"provided".*"device":"desktop"/);
});

test('a secret request that times out or is skipped says only so', async () => {
  const hook = (answer) => async () => answer;
  const handoff = { kind: 'secret', surface: 'computer', target: 'App', field: 'Token', instructions: '' };
  const filled = [];
  const inputs = { computer: async () => filled.push('typed') && 'provided' };
  assert.equal(
    await runAskUserHandoff(handoff, { hook: hook({ approved: false, timedOut: true }), sessionId: 's', inputs }),
    'timeout'
  );
  assert.equal(
    await runAskUserHandoff(handoff, { hook: hook({ approved: false, response: 'skip' }), sessionId: 's', inputs }),
    'skipped'
  );
  assert.equal(await runAskUserHandoff(handoff, { hook: undefined, sessionId: 's', inputs }), 'skipped');
  assert.deepEqual(filled, [], 'nothing is typed without a provided secret');
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
  assert.equal(done, 'done');
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

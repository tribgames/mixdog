import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { failRunForHuman, markUnattendedRun } from './held-requests.mjs';
import { handoffSite, runAskUserHandoff } from './internal-tool-executor/ask-user-tool.mjs';
import { runRoutineTurn } from './routine-home-turn.mjs';
import { createHumanGateStore, setHumanGateStore } from '../runtime/agent/orchestrator/session/human-gate/store.mjs';
import {
  routineLoginRequiredSite,
  routineLoginRequiredText,
} from '../runtime/agent/orchestrator/session/routine-result.mjs';

const takeover = {
  kind: 'takeover',
  surface: 'browser',
  target: 'accounts.example.com sign-in form',
  instructions: 'Sign in, then say done.',
  need: 'sign_in',
};

function gateStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'login-required-'));
  setHumanGateStore(createHumanGateStore(dir));
  t.after(() => {
    setHumanGateStore(null);
    rmSync(dir, { recursive: true, force: true });
  });
}

/** A routine turn in `homeId` whose body runs `work` once the turn starts,
 *  then settles as `status` (the aborted turn ends however it ends). */
function routineTurn(homeId, work, status = 'cancelled') {
  const aborted = [];
  const surface = {
    submit: async (_id, _content, options) => {
      queueMicrotask(async () => {
        options.onCommitted();
        const value = await work();
        options.onSettled({ status, result: { content: String(value ?? '') } });
      });
      return true;
    },
    abort: async (id) => aborted.push(id),
  };
  const run = runRoutineTurn(
    {
      kind: 'schedule',
      name: 'Daily report',
      ownerAgentId: homeId.replace('sess_home_', ''),
      prompt: 'Make the report.',
    },
    { surface, loadSession: async (id) => ({ id, messages: [] }), log: () => {} }
  );
  return { run, aborted };
}

test('a routine takeover fails its turn fast as "sign-in required": no card, no wait', async (t) => {
  gateStore(t);
  let answer = '';
  const { run } = routineTurn('sess_home_mixy', async () => {
    answer = await runAskUserHandoff(takeover, {
      sessionId: 'sess_home_mixy',
      hook: () => assert.fail('an unattended turn never shows a takeover card'),
    });
  });
  await assert.rejects(run, /^Error: Sign-in required: accounts\.example\.com$/);
  assert.match(answer, /Nobody is present in this routine run/);
  // The failure text carries the site back for "<site> 로그인이 필요해요 · 다시 로그인".
  assert.equal(routineLoginRequiredSite('Sign-in required: accounts.example.com'), 'accounts.example.com');
  // Once the turn ended, the thread is attended again.
  assert.equal(await failRunForHuman('sess_home_mixy', 'login_required', 'x', async () => assert.fail()), false);
});

test('only an unattended turn is ended for a person; attended sessions keep the takeover card', async (t) => {
  gateStore(t);
  const routine = 'sess_routine_login_2';
  const unmark = markUnattendedRun(routine, { kind: 'webhook', agentId: 'mixy', name: 'Inbox' });
  t.after(unmark);
  const aborted = [];
  assert.equal(
    await failRunForHuman(routine, 'login_required', 'mail.example.com', async (id) => aborted.push(id)),
    true
  );
  assert.deepEqual(aborted, [routine]);
  assert.equal(
    await failRunForHuman('sess_attended', 'login_required', 'x.example.com', async () => assert.fail()),
    false
  );

  const asked = [];
  const outcome = await runAskUserHandoff(takeover, {
    sessionId: 'sess_attended',
    hook: async (request) => {
      asked.push(request.kind);
      return { approved: true, response: 'done' };
    },
  });
  assert.match(outcome, /^User pressed Done/);
  assert.deepEqual(asked, ['takeover']);
});

test('an unattended takeover is reported by what it needs: a step or a confirmation is not a sign-in', async (t) => {
  gateStore(t);
  for (const [need, expected] of [
    [undefined, /^Error: Action required: accounts\.example\.com$/],
    ['action', /^Error: Action required: accounts\.example\.com$/],
    ['confirmation', /^Error: Confirmation required: accounts\.example\.com$/],
    ['sign_in', /^Error: Sign-in required: accounts\.example\.com$/],
  ]) {
    const { run } = routineTurn('sess_home_mixy', () =>
      runAskUserHandoff({ ...takeover, need }, { sessionId: 'sess_home_mixy', hook: () => assert.fail('no card') })
    );
    await assert.rejects(run, expected);
  }
  const { routineHumanNeeded } = await import('../runtime/agent/orchestrator/session/routine-result.mjs');
  assert.deepEqual(routineHumanNeeded('Action required: shop.example.com'), {
    outcome: 'human_action_required',
    site: 'shop.example.com',
  });
  assert.equal(routineLoginRequiredSite('Confirmation required: shop.example.com'), null);
});

test('a takeover with no way to reach a person is blocked, never "proceed"', async (t) => {
  gateStore(t);
  const result = await runAskUserHandoff(takeover, { sessionId: 'sess_no_hook', hook: undefined });
  assert.match(result, /^Blocked:/);
  assert.doesNotMatch(result, /best judgment|proceed/i);
});

test('the site comes from the host the handoff names', () => {
  assert.equal(handoffSite(takeover), 'accounts.example.com');
  assert.equal(
    handoffSite({ target: 'Bank login', instructions: 'Open https://www.bank.co.kr/login and sign in' }),
    'www.bank.co.kr'
  );
  assert.equal(handoffSite({ target: 'Bank login', instructions: 'Sign in' }), 'Bank login');
  assert.equal(routineLoginRequiredText(''), 'Sign-in required: the site');
  assert.equal(routineLoginRequiredSite('Something else failed'), null);
});

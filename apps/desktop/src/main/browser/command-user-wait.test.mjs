import assert from 'node:assert/strict';
import test from 'node:test';

import { createBrowserActionApproval } from './action-approval.ts';
import { bounded } from './cdp-bounded.ts';
import { createBrowserCommandQueue } from './command-queue.ts';

const COMMAND_TIMEOUT_MS = 42_000;
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** The real queue with the real ceiling; `run` is the command body. */
function queueOf(run) {
  return createBrowserCommandQueue({
    chains: new Map(),
    pendingReads: new Map(),
    sessionId: (command) => command.session_id || 'owner',
    backgroundEntryByPageId: () => null,
    run,
    bounded,
    readOnlyActions: new Set(),
    commandTimeoutMs: COMMAND_TIMEOUT_MS,
  });
}

/** A command that, like runResolvedCommand, asks the person through the
 *  action approval and only then acts. */
function approvingRun({ ask, page, acted }) {
  const approvals = createBrowserActionApproval({ confirmActions: 'click', ask });
  return async (command, signal, userWait) => {
    await approvals.approve(command, () => ({ ...page }), signal, undefined, userWait);
    acted.push(command.ref);
    return { text: 'clicked' };
  };
}

test('a command waiting on an approval outlives the 42 s ceiling and runs once answered', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const answer = Promise.withResolvers();
  const acted = [];
  const queue = queueOf(
    approvingRun({ ask: () => answer.promise, page: { url: 'https://fixture.example/', identity: 'p1' }, acted })
  );
  let outcome = null;
  const command = queue.executeSerialized({ action: 'click', ref: 'r1' }).then(
    (value) => (outcome = { value }),
    (error) => (outcome = { error })
  );
  await tick();
  t.mock.timers.tick(COMMAND_TIMEOUT_MS + 1);
  t.mock.timers.tick(30 * 60_000);
  await tick();
  assert.equal(outcome, null, 'the card is still open and the command still waits');
  answer.resolve(true);
  await command;
  assert.equal(outcome.value?.text, 'clicked', outcome.error?.message);
  assert.deepEqual(acted, ['r1']);
});

test('a page that changed during that wait still refuses the command at dispatch', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const answer = Promise.withResolvers();
  const page = { url: 'https://fixture.example/', identity: 'p1' };
  const acted = [];
  const queue = queueOf(approvingRun({ ask: () => answer.promise, page, acted }));
  const refused = assert.rejects(
    queue.executeSerialized({ action: 'click', ref: 'r1' }),
    /target changed; nothing was dispatched/
  );
  await tick();
  t.mock.timers.tick(5 * 60_000);
  page.identity = 'p2';
  answer.resolve(true);
  await refused;
  assert.deepEqual(acted, []);
});

test('the ceiling still ends a command that overruns it while no card is open', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const queue = queueOf(() => new Promise(() => {}));
  const timedOut = assert.rejects(
    queue.executeSerialized({ action: 'click', ref: 'r1' }),
    /browser command exceeded 42000ms/
  );
  await tick();
  t.mock.timers.tick(COMMAND_TIMEOUT_MS);
  await timedOut;
});

for (const [label, afterAnswerMs, expected] of [
  ['finishes within what was left', 11_000, 'done'],
  ['overruns what was left', 13_000, 'timed out'],
]) {
  test(`page time before the card still counts: a command that ${label} of the 42 s ceiling`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const answer = Promise.withResolvers();
    const asked = Promise.withResolvers();
    const approvals = createBrowserActionApproval({
      confirmActions: 'click',
      ask: () => {
        asked.resolve();
        return answer.promise;
      },
    });
    const queue = queueOf(async (command, signal, userWait) => {
      await sleep(30_000); // 30 s of page work
      await approvals.approve(command, () => ({ url: 'u', identity: 'p1' }), signal, undefined, userWait);
      await sleep(afterAnswerMs);
      return { text: 'done' };
    });
    let outcome = null;
    const command = queue.executeSerialized({ action: 'click', ref: 'r1' }).then(
      (value) => (outcome = value.text),
      (error) => (outcome = /exceeded 42000ms/.test(error.message) ? 'timed out' : error.message)
    );
    await tick();
    t.mock.timers.tick(30_000);
    await asked.promise;
    t.mock.timers.tick(2 * 60 * 60_000); // two hours at the card
    await tick();
    assert.equal(outcome, null);
    answer.resolve(true);
    await tick();
    t.mock.timers.tick(afterAnswerMs);
    await command;
    assert.equal(outcome, expected);
  });
}

test('Deny ends the command with the denial, and Stop settles a command waiting on the card', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  // Deny: the command ends with the denial the person gave.
  const denied = Promise.withResolvers();
  const queue = queueOf(approvingRun({ ask: () => denied.promise, page: { url: 'u', identity: 'p1' }, acted: [] }));
  const refused = assert.rejects(queue.executeSerialized({ action: 'click', ref: 'r1' }), /was not approved/);
  await tick();
  t.mock.timers.tick(20 * 60_000);
  denied.resolve(false);
  await refused;

  // Stop: the request signal aborts a command that is waiting on the card.
  const controller = new AbortController();
  const stopped = new Error('turn stopped');
  const waiting = assert.rejects(
    queueOf(
      approvingRun({
        ask: (_request, signal) =>
          new Promise((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          ),
        page: { url: 'u', identity: 'p1' },
        acted: [],
      })
    ).executeSerialized({ action: 'click', ref: 'r1' }, controller.signal),
    (error) => error === stopped
  );
  await tick();
  t.mock.timers.tick(20 * 60_000);
  controller.abort(stopped);
  await waiting;
});

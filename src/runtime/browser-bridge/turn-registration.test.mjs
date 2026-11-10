import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { bridgeDiscoveryChanged } from '../bridge-discovery.mjs';

const discovery = { port: 12345, token: 'test-only-token' };
// Each fresh read answers only when the test says so: `answer(value)`.
const reads = [];
const answer = (value = discovery) => reads.shift()(value);
mock.module('../bridge-discovery.mjs', {
  namedExports: {
    readBridgeDiscovery: () => discovery,
    readBridgeDiscoveryFresh: () =>
      new Promise((resolve) => {
        reads.push(resolve);
      }),
    readBridgeDiscoveryDetail: () => ({ reason: 'missing' }),
    bridgeDiscoveryChanged,
  },
});
mock.module('./timing.mjs', { namedExports: { traceBrowserTiming() {} } });
const requests = [];
const sent = (sessionId) => requests.filter((request) => request.session_id === sessionId).map(({ action }) => action);
mock.method(globalThis, 'fetch', async (_url, options) => {
  const { action, session_id, turn_id } = JSON.parse(options.body);
  requests.push({ action, session_id, turn_id });
  return new Response(JSON.stringify({ ok: true, value: { text: 'ok' } }), { status: 200 });
});
const { beginBrowserTurn, executeBrowserTool, finishBrowserTurn, forgetBrowserSession } = await import('./client.mjs');
const status = (sessionId, turnId) => executeBrowserTool({ action: 'status' }, { sessionId, turnId });

test("a command's session and turn are the client's before its discovery read answers", async () => {
  // The turn ends while its first command's read is out: the command still
  // goes first, and the turn's end follows it to the same bridge.
  const command = status('ending', 7);
  const finished = finishBrowserTurn('ending', 7, { aborted: true });
  answer();
  await command;
  await finished;
  assert.deepEqual(sent('ending'), ['status', 'finish_turn']);

  // A session deleted while its command's read is out stays forgotten.
  const lastCommand = status('deleted', 3);
  forgetBrowserSession('deleted');
  answer();
  await lastCommand;
  await beginBrowserTurn('deleted', 4);
  assert.equal(reads.length, 0, 'a forgotten session reads no discovery for its next turn');
  assert.deepEqual(sent('deleted'), ['status']);
});

test('a turn that reached a bridge keeps it when a later read finds none', async () => {
  const first = status('reached', 7);
  answer();
  assert.equal((await first).isError, undefined);
  const second = status('reached', 7);
  answer(null);
  assert.equal((await second).isError, true);
  await finishBrowserTurn('reached', 7);
  assert.deepEqual(sent('reached'), ['status', 'finish_turn'], 'the bridge the turn reached hears its end');
});

test("a turn's end waits for every read of the turn and refuses what is asked for after it", async () => {
  const first = status('parallel', 7);
  const second = status('parallel', 7);
  const finished = finishBrowserTurn('parallel', 7);
  const lateCommand = status('parallel', 7);
  assert.equal(reads.length, 2, 'a command asked for after the end began reads nothing');
  const late = await lateCommand;
  assert.equal(late.isError, true, 'a command asked for after the end began is refused');
  assert.match(late.content[0].text, /already finished/);
  // The later read answers first; the earlier one still goes before the end.
  reads.splice(1, 1)[0](discovery);
  await second;
  answer();
  await first;
  await finished;
  assert.deepEqual(sent('parallel'), ['status', 'status', 'finish_turn']);
});

test("a turn's end whose read never answers gives up at its deadline", async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stuck = status('stuck', 7);
  let outcome = 'pending';
  const finished = finishBrowserTurn('stuck', 7).then(
    () => (outcome = 'resolved'),
    (error) => (outcome = error.name)
  );
  t.mock.timers.tick(45_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(outcome, 'TimeoutError', 'the end settles at its own deadline');
  await finished;
  answer();
  assert.equal((await stuck).isError, true, 'the command whose read came too late is not sent');
  assert.deepEqual(sent('stuck'), []);
});

test("a turn's end whose read never answers still reaches the bridge the turn reached", async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const first = status('known', 7);
  answer();
  assert.equal((await first).isError, undefined);
  const stuck = status('known', 7);
  const finished = finishBrowserTurn('known', 7, { aborted: true });
  t.mock.timers.tick(45_000);
  const error = await finished.then(
    () => null,
    (failure) => failure
  );
  assert.equal(error?.name, 'TimeoutError', 'the caller still learns the read wait timed out');
  assert.equal(error.cleanup, 'sent');
  assert.deepEqual(sent('known'), ['status', 'finish_turn'], 'the known bridge hears the end after the read deadline');
  answer();
  assert.equal((await stuck).isError, true);
  assert.deepEqual(sent('known'), ['status', 'finish_turn'], 'the late read sends nothing');
});

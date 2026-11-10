// The 62 source-control calls of the phone through the protocol adapter, replayed against what Node's host (b6f10295a) answered
// the phone in the same calls (fixtures/phone-scm/golden.json, recorded by benchmarks/rust-core/recorders/record-phone-scm.mjs).
//
// Per recorded call the adapter runs over a scripted `mixdogd` wire whose answers are the desktop operations' own results (the
// parity contract of DS-SCM-1: a core reply equals Node's operation result), and two things are compared whole:
//  - every request the adapter sends equals, in order, the request the shared desktop route makes of the operation Node ran;
//  - the answer the phone receives (value, or message / code / params of the failure) equals the relay frame Node sent.
// A call Node refused before running any operation sends nothing. Each call also runs with its `null` arguments as `undefined`,
// as the page passes them (the relay's JSON turned them into null).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { adapter } from './remote-protocol-scm.ts';
import { callQueueFor, runQueued } from './remote-protocol-queue.ts';
import { SCM_OPERATION_ROUTES } from '../shared/scm-operation-route.ts';
import { scopeClient } from '../../../mobile/src/phone-send-scope.ts';

const fixture = (name) => new URL(`./fixtures/phone-scm/${name}`, import.meta.url);
const golden = JSON.parse(readFileSync(fixture('golden.json'), 'utf8'));
const calls = readFileSync(fixture('calls.txt'), 'utf8').trim().split(/\s+/);
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

// A wait that never ends is a defect to name, not a hang: every wait on the queue is raced with a bound that only ever fails it.
const WAIT_BOUND_MS = 20_000;
function within(promise, message) {
  let timer;
  const stalled = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(message)), WAIT_BOUND_MS)));
  return Promise.race([promise, stalled]).finally(() => clearTimeout(timer));
}

/** Node announced a changed git identity to the desktop's windows (`notifySettingsChanged('git')`) after `setGitGlobalConfig`;
 *  the core now publishes that event itself after `git/globalConfig/set`, so the adapter sends no request for it. */
const NOT_SENT = new Set(['notifySettingsChanged']);

const rpcFailure = ({ message, code, details }) =>
  Object.assign(new Error('domainError'), {
    detail: {
      kind: 'rpc',
      code: -32000,
      reason: 'domainError',
      message: 'domainError',
      data: { reason: 'domainError', message, ...(code === undefined ? {} : { code }), ...(details === undefined ? {} : { detail: { type: 'scm', ...details } }) },
    },
  });

/** The same failure as the core words it (mixdog-scm/src/error.rs): its own codes for a deadline and an overflow, a code of its own
 *  where Node's error had none, and a missing program as a missing capability (mixdog-spawn service/mod.rs process_failure). */
const CORE_CODE = { EGITTIMEOUT: 'GIT_TIMEOUT', EMAXBUFFER: 'OUTPUT_TOO_LARGE' };
function coreError(error) {
  const spawned = error.code === 'ENOENT' ? /^spawn (\S+) ENOENT$/.exec(error.message) : null;
  if (spawned) {
    return Object.assign(new Error('capabilityUnavailable'), {
      detail: { kind: 'rpc', code: -32000, reason: 'capabilityUnavailable', message: 'capabilityUnavailable', data: { reason: 'capabilityUnavailable', capability: spawned[1], detail: '' } },
    });
  }
  return rpcFailure({ ...error, code: CORE_CODE[error.code] ?? error.code ?? 'COMMAND_FAILED' });
}

/** A core that answers each request from the next recorded operation, after checking the request is that operation's. */
function scriptedCore(recorded, { coreCodes = false } = {}) {
  const expected = recorded.filter((op) => !NOT_SENT.has(op.name));
  const requests = [];
  let next = 0;
  let started = null;
  return {
    // The PC's initialize answer: Node checked what is absolute on the PC it ran on.
    server: { platformFamily: golden.platform === 'win32' ? 'windows' : 'unix' },
    requests,
    left: () => expected.length - next,
    async call(method, params) {
      requests.push({ method, params });
      // The sign-in start answers the flow's id; the adapter reads the flow itself (DS 5.4) with a status request.
      if (started && method === 'github/login/status' && next >= expected.length) return clone(started.result);
      const op = expected[next++];
      assert.ok(op, `unexpected request ${method} ${JSON.stringify(params)}`);
      assert.deepEqual({ method, params }, clone(SCM_OPERATION_ROUTES[op.name](op.args)), `request of ${op.name}`);
      if (op.error) throw coreCodes ? coreError(op.error) : rpcFailure(op.error);
      if (op.name === 'githubCliLoginStart') {
        started = op;
        return { flowId: op.result.flowId };
      }
      // A unit reply of the core is null; an operation that returned a value is answered with it.
      return op.result === undefined ? null : clone(op.result);
    },
  };
}

const failureOf = (error) => ({
  ok: false,
  error: error.message,
  ...(typeof error.code === 'string' && error.code ? { errorCode: error.code } : {}),
  ...(error.details === undefined ? {} : { errorParams: error.details }),
});

async function answerOf(entry, params, coreCodes = false) {
  const core = scriptedCore(entry.ops, { coreCodes });
  const host = { ctx: {}, client: () => core };
  let answer;
  try {
    const value = await adapter.calls[entry.call](params, host);
    answer = { ok: true, value: value === undefined ? null : clone(value) };
  } catch (error) {
    answer = failureOf(error);
  }
  assert.equal(core.left(), 0, `${entry.name}: operations Node ran that the adapter never requested`);
  return answer;
}

test('the adapter answers exactly the 62 source-control calls', () => {
  assert.equal(calls.length, 62);
  // The listed calls are distinct, the adapter answers each of them and nothing else (its own order of definition is not Node's).
  assert.ok(calls.every((call, index) => calls.indexOf(call) === index));
  assert.ok(calls.every((call) => typeof adapter.calls[call] === 'function'));
  assert.equal(Object.keys(adapter.calls).length, calls.length);
  assert.equal(adapter.group, 'scm');
  // Every recorded case is of a listed call, and every listed call has a recorded case (first case of each, in recorded order).
  const recordedCalls = golden.cases.map((entry) => entry.call);
  assert.ok(recordedCalls.every((call) => calls.includes(call)));
  assert.deepEqual(calls.filter((call) => !recordedCalls.includes(call)), [], 'listed calls with no recorded case');
});

for (const entry of golden.cases) {
  test(`phone-scm replays Node: ${entry.name}`, async () => {
    assert.deepEqual(await answerOf(entry, clone(entry.params)), entry.frame, entry.name);
    // The page's own arguments: what the relay's JSON turned into null are undefined on the page.
    const page = entry.params.map((value) => (value === null ? undefined : value));
    assert.deepEqual(await answerOf(entry, page), entry.frame, `${entry.name} (undefined arguments)`);
    assert.deepEqual(await answerOf(entry, clone(entry.params), true), entry.frame, `${entry.name} (the core's failure codes)`);
  });
}

test('phone-scm keeps Node\'s barrier: a read submitted behind a slow write starts after the write ended', async () => {
  const { ordering } = golden;
  const wires = ordering.ops.map((op) => ({ ...op, ...clone(SCM_OPERATION_ROUTES[op.name](op.args)) }));
  const log = [];
  const ended = [];
  const last = ordering.orders[0].at(-1);
  const endOrder = [...last.endedBefore, last.started];
  const waiting = [];
  const wake = () => waiting.splice(0).forEach((resolve) => resolve());
  const turn = async (name) => {
    while (ended.length !== endOrder.indexOf(name)) await new Promise((resolve) => waiting.push(resolve));
  };
  let release;
  let held;
  const gate = new Promise((resolve) => (release = resolve));
  const reached = new Promise((resolve) => (held = resolve));
  const core = {
    async call(method, params) {
      const op = wires.find((wire) => wire.method === method && JSON.stringify(wire.params) === JSON.stringify(params));
      assert.ok(op, `unexpected request ${method} ${JSON.stringify(params)}`);
      log.push({ started: op.name, endedBefore: [...ended] });
      if (op.name === ordering.heldStarts[0]) {
        held();
        await gate;
      }
      // The operation ends when Node's did: after exactly the operations that ended before it in the recording (the last start's list
      // plus that start is the whole order of ends). A signal wakes the next in line; nothing is polled.
      await turn(op.name);
      ended.push(op.name);
      wake();
      return op.result === undefined ? null : clone(op.result);
    },
  };
  // The router gives every call a host object of its own (a client scoped to the call); only the connection's context is shared.
  const ctx = {};
  // Every call enters through the router's one shared queue, as remote-shim-protocol.ts sends it.
  const answers = ordering.calls.map(({ call, params }) => runQueued(ctx, call, clone(params), () => adapter.calls[call](clone(params), { ctx, client: () => core })).then((value) => ({ ok: true, value: value === undefined ? null : clone(value) })));
  // The write signals from inside the operation, held: that is when Node's recording took the same snapshot.
  // A write that never started leaves nothing to signal: then every call finishes without reaching it, and that is the failure to name.
  const outcome = await within(
    Promise.race([reached.then(() => 'held'), Promise.allSettled(answers).then(() => 'every call finished')]),
    `the write ${ordering.heldStarts[0]} did not start: the queue stalled before reaching it`,
  );
  assert.equal(outcome, 'held', `the write ${ordering.heldStarts[0]} never started: every call finished without reaching it`);
  assert.deepEqual(log.map((entry) => entry.started), ordering.heldStarts);
  release();
  assert.deepEqual(await within(Promise.all(answers), `the calls behind the held write ${ordering.heldStarts[0]} never finished`), ordering.answers);
  // Node's two recorded runs saw the same order of every start and end, so the order is Node's and is compared as recorded.
  assert.equal(ordering.orders.length, 2);
  for (const order of ordering.orders) assert.deepEqual(log, order);
  callQueueFor(ctx).close();
});
test('phone-scm checks an absolute path as node:path does on the platform of the PC\'s initialize answer', async () => {
  // The oracle is node:path itself, which is what Node's host ran on the PC: `win32` on a Windows PC, `posix` on any other.
  const platforms = { windows: path.win32, unix: path.posix };
  const inputs = ['C:\\repo', '\\repo', '/repo', 'C:/repo', '\\\\host\\share', '//host/share', 'repo', './repo', 'C:repo', ' /repo '];
  for (const [family, platform] of Object.entries(platforms)) {
    for (const cwd of inputs) {
      const asked = [];
      const host = { ctx: {}, client: () => ({ server: { platformFamily: family }, call: async (method) => (asked.push(method), null) }) };
      // The router runs the handler in the call's queue slot, so an argument check that throws is a rejection.
      const run = runQueued({}, 'gitStatus', [cwd], async () => adapter.calls.gitStatus([cwd], host));
      if (platform.isAbsolute(cwd.trim())) {
        await run;
        assert.deepEqual(asked, ['git/status'], `${family}: ${cwd}`);
      } else {
        await assert.rejects(run, { message: 'A project directory is required.' }, `${family}: ${cwd}`);
        assert.deepEqual(asked, [], `${family}: ${cwd}`);
      }
    }
    for (const file of inputs.filter((input) => input.trim() === input)) {
      const host = { ctx: {}, client: () => ({ server: { platformFamily: family }, call: async () => null }) };
      const run = runQueued({}, 'gitDiff', ['/repo', file], async () => adapter.calls.gitDiff(['/repo', file], host));
      // A path inside the repository is relative: an absolute one is refused.
      if (platform.isAbsolute(file)) await assert.rejects(run, { message: 'git path is invalid.' }, `${family}: ${file}`);
      else await run;
    }
  }
});test('phone-scm forwards the call\'s `sent` claim on every request it writes (the router scopes the client per call)', async () => {
  const claim = () => {};
  const options = [];
  const client = { call: async (_method, _params, option) => (options.push(option?.sent), null) };
  const scoped = scopeClient(client, claim);
  await adapter.calls.gitStage([process.cwd(), ['a.txt']], { ctx: {}, client: () => scoped });
  assert.ok(options.length > 0);
  assert.ok(options.every((sent) => sent === claim));
});

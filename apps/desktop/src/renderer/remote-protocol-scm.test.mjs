// The 62 source-control calls of the phone through the protocol adapter, replayed against what Node's host (b6f10295a) answered
// the phone in the same calls (fixtures/phone-scm/golden.json, recorded by benchmarks/rust-core/recorders/record-phone-scm.mjs).
//
// Per recorded call the adapter runs over a scripted `mixdogd` wire whose answers are the desktop operations' own results (the
// parity contract of DS-SCM-1: a core reply equals Node's operation result), and two things are compared whole:
//  - every request the adapter sends equals, in order, the request the shared desktop route makes of the operation Node ran;
//  - the answer the phone receives (value, or message / code / params of the failure) equals the relay frame Node sent.
// A call Node refused before running any operation sends nothing. Every call enters through the router (remote-shim-protocol.ts), and
// each also runs with its `null` arguments as `undefined`, as the page passes them (the relay's JSON turned them into null). Node is
// b6f10295a with node-fix-relay-optional-args.patch: its relay methods take an optional argument the app left out as omitted.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { adapter } from './remote-protocol-scm.ts';
import { callQueueFor, runQueued } from './remote-protocol-queue.ts';
import { isRemoteConnectionInterruptedError } from './remote-connection-state.ts';
import { createProtocolRouter } from './remote-shim-protocol.ts';
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

// The router arms each call's deadline on the page's window timers; the replay compares answers, so its window never fires one.
globalThis.window ??= { setTimeout: () => 0, clearTimeout() {} };

/** One call as the page makes it: through the router (its relay transformation, its queue) to the adapter, over the scripted core. */
async function answerOf(entry, params, coreCodes = false) {
  const core = scriptedCore(entry.ops, { coreCodes });
  const host = { ctx: {}, client: () => core, declareLane() {} };
  const ready = Promise.resolve();
  const router = createProtocolRouter([adapter], { host, started: () => ready, synced: () => ready, probe() {}, silentSince: () => false });
  let answer;
  try {
    const value = await router.call(entry.call, params);
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
  const last = ordering.order.at(-1);
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
  // Node's two recorded runs showed the same order of every start and end (the recorder fails otherwise): it is compared as recorded.
  assert.deepEqual(log, ordering.order);
  callQueueFor(ctx).close();
});
test('phone-scm checks an absolute path as Node recorded it on the platform of the PC\'s initialize answer', async () => {
  // Node's own classification of each spelling (path.isAbsolute on each platform) and its two refusals are recorded in the golden file.
  const refusal = (name) => golden.cases.find((entry) => entry.name === name).frame.error;
  const noDirectory = refusal('gitStatus-relative-cwd');
  const badPath = refusal('gitDiff-parent-path');
  for (const [family, rules] of Object.entries(golden.pathRules)) {
    for (const { spelling: cwd, trimmedAbsolute } of rules) {
      const asked = [];
      const host = { ctx: {}, client: () => ({ server: { platformFamily: family }, call: async (method) => (asked.push(method), null) }) };
      // The router runs the handler in the call's queue slot, so an argument check that throws is a rejection.
      const run = runQueued({}, 'gitStatus', [cwd], async () => adapter.calls.gitStatus([cwd], host));
      if (trimmedAbsolute) {
        await run;
        assert.deepEqual(asked, ['git/status'], `${family}: ${cwd}`);
      } else {
        await assert.rejects(run, { message: noDirectory }, `${family}: ${cwd}`);
        assert.deepEqual(asked, [], `${family}: ${cwd}`);
      }
    }
    for (const { spelling: file, absolute } of rules.filter((rule) => rule.spelling.trim() === rule.spelling)) {
      const host = { ctx: {}, client: () => ({ server: { platformFamily: family }, call: async () => null }) };
      const run = runQueued({}, 'gitDiff', ['/repo', file], async () => adapter.calls.gitDiff(['/repo', file], host));
      // A path inside the repository is relative: an absolute one, or one leaving it (`..`, Node's recorded 'gitDiff-parent-path'), is refused.
      if (absolute || file.includes('..')) await assert.rejects(run, { message: badPath }, `${family}: ${file}`);
      else await run;
    }
  }
});
test('the desktop\'s own repository check keeps the rule of the platform it runs on, as Node recorded it', async () => {
  const { requiredRepositoryCwd } = await import('../main/git-contract.mjs');
  const rules = golden.pathRules[process.platform === 'win32' ? 'windows' : 'unix'];
  const noDirectory = golden.cases.find((entry) => entry.name === 'gitStatus-relative-cwd').frame.error;
  for (const { spelling, trimmedAbsolute } of rules) {
    if (trimmedAbsolute) assert.equal(requiredRepositoryCwd(spelling), spelling.trim(), spelling);
    else assert.throws(() => requiredRepositoryCwd(spelling), { message: noDirectory }, spelling);
  }
});
test('phone-scm forwards the call\'s `sent` claim on every request it writes (the router scopes the client per call)', async () => {
  const claim = () => {};
  const options = [];
  const client = { call: async (_method, _params, option) => (options.push(option?.sent), null) };
  const scoped = scopeClient(client, claim);
  await adapter.calls.gitStage([process.cwd(), ['a.txt']], { ctx: {}, client: () => scoped });
  assert.ok(options.length > 0);
  assert.ok(options.every((sent) => sent === claim));
});

test('a connection that ends during a call reaches the router as the client\'s own error, for the router to make the interruption error', async () => {
  for (const kind of ['connectionLost', 'clientClosed']) {
    const lost = Object.assign(new Error('connection ended'), { detail: { kind } });
    const host = { ctx: {}, client: () => ({ server: { platformFamily: 'windows' }, call: async () => Promise.reject(lost) }) };
    await assert.rejects(
      runQueued({}, 'gitStatus', ['C:\\repo'], async () => adapter.calls.gitStatus(['C:\\repo'], host)),
      (error) => error === lost,
      kind,
    );
  }
});

test('the router turns a connection that ends during a scm call into the interruption error', async () => {
  globalThis.window = { setTimeout: () => 0, clearTimeout() {} };
  for (const kind of ['connectionLost', 'clientClosed']) {
    const lost = Object.assign(new Error('connection ended'), { detail: { kind } });
    const host = { ctx: {}, client: () => ({ server: { platformFamily: 'windows' }, call: async () => Promise.reject(lost) }), declareLane() {} };
    const ready = Promise.resolve();
    const router = createProtocolRouter([adapter], { host, started: () => ready, synced: () => ready, probe() {}, silentSince: () => false });
    await assert.rejects(router.call('gitStatus', ['C:\\\\repo']), (error) => isRemoteConnectionInterruptedError(error), kind);
  }
});

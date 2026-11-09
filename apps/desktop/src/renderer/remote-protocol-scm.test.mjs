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
import test from 'node:test';
import { adapter } from './remote-protocol-scm.ts';
import { SCM_OPERATION_ROUTES } from '../shared/scm-operation-route.ts';

const fixture = (name) => new URL(`./fixtures/phone-scm/${name}`, import.meta.url);
const golden = JSON.parse(readFileSync(fixture('golden.json'), 'utf8'));
const calls = readFileSync(fixture('calls.txt'), 'utf8').split(/\s+/).filter(Boolean);
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

/** Node announced a changed git identity to the desktop's windows (`notifySettingsChanged('git')`) after `setGitGlobalConfig`;
 *  the core publishes no such event (Rust gap: mixdog-scm/src/desktop.rs git_global_config_write), so the adapter sends no request. */
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

/** A core that answers each request from the next recorded operation, after checking the request is that operation's. */
function scriptedCore(recorded, { coreCodes = false } = {}) {
  const expected = recorded.filter((op) => !NOT_SENT.has(op.name));
  const requests = [];
  let next = 0;
  let started = null;
  return {
    requests,
    left: () => expected.length - next,
    async call(method, params) {
      requests.push({ method, params });
      // The sign-in start answers the flow's id; the adapter reads the flow itself (DS 5.4) with a status request.
      if (started && method === 'github/login/status' && next >= expected.length) return clone(started.result);
      const op = expected[next++];
      assert.ok(op, `unexpected request ${method} ${JSON.stringify(params)}`);
      assert.deepEqual({ method, params }, clone(SCM_OPERATION_ROUTES[op.name](op.args)), `request of ${op.name}`);
      // The core names a failure with a code of its own where Node's error had none (mixdog-scm/src/error.rs CODE_COMMAND_FAILED).
      if (op.error) throw rpcFailure(coreCodes && op.error.code === undefined ? { ...op.error, code: 'COMMAND_FAILED' } : op.error);
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
  const host = { client: () => core };
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
  assert.deepEqual(Object.keys(adapter.calls).sort(), [...calls].sort());
  assert.equal(adapter.group, 'scm');
  assert.deepEqual([...new Set(golden.cases.map((entry) => entry.call))].sort(), [...calls].sort());
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

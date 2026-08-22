// MCP tool-call cancellation: an aborted caller (hook timeout, aborted turn,
// closed pane) must settle immediately AND release its admission slot, in every
// phase of a call — queued, admitted-and-running, and stalled mid-reconnect.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  _registerMcpServerForTest,
  executeMcpTool,
  getMcpAdmissionSnapshot,
} from './client.mjs';

const never = () => new Promise(() => {});

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

async function waitFor(predicate, label, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
  throw new Error(`timed out waiting for ${label}`);
}

function slotsFor(scopeId, serverName) {
  const gate = getMcpAdmissionSnapshot(scopeId).find((entry) => entry.name === serverName);
  return { active: gate?.active ?? 0, queued: gate?.queued ?? 0 };
}

/** Settle-state probe: a cancellation fix is only real if the promise settles
 *  while the callee is still stuck. */
function track(promise) {
  const state = { settled: false, error: null };
  promise.then(
    () => { state.settled = true; },
    (error) => { state.settled = true; state.error = error; },
  );
  return state;
}

test('an aborted caller settles a QUEUED call and frees its queue seat', async () => {
  const scopeId = 'mcp-cancel-queued';
  _registerMcpServerForTest(scopeId, 'busy', [{ name: 'hang' }], {
    cfg: { maxConcurrency: 1, timeoutMs: 'off' },
    callTool: never,
  });
  const held = executeMcpTool('mcp__busy__hang', {}, { scopeId });
  held.catch(() => {});
  await waitFor(() => slotsFor(scopeId, 'busy').active === 1, 'the first call to occupy the slot');

  const controller = new AbortController();
  const queued = executeMcpTool('mcp__busy__hang', {}, { scopeId, signal: controller.signal });
  const state = track(queued);
  await waitFor(() => slotsFor(scopeId, 'busy').queued === 1, 'the second call to queue');

  controller.abort(new Error('queued hook aborted'));
  await assert.rejects(queued, /queued hook aborted/);
  assert.equal(state.settled, true);
  assert.equal(slotsFor(scopeId, 'busy').queued, 0, 'the queue seat is released');
});

test('an aborted caller settles an ADMITTED call whose server ignores cancellation', async () => {
  const scopeId = 'mcp-cancel-active';
  let sawSignal = false;
  _registerMcpServerForTest(scopeId, 'deaf', [{ name: 'hang' }], {
    // Server call timeout DISABLED: the caller's abort is the only bound.
    cfg: { maxConcurrency: 1, timeoutMs: 'off' },
    callTool: (_params, _schema, options) => {
      sawSignal = Boolean(options?.signal);
      return never();
    },
  });
  const controller = new AbortController();
  const call = executeMcpTool('mcp__deaf__hang', {}, { scopeId, signal: controller.signal });
  const state = track(call);
  await waitFor(() => slotsFor(scopeId, 'deaf').active === 1, 'the call to be admitted');
  assert.equal(state.settled, false, 'a running call does not settle on its own');

  controller.abort(new Error('mcp_tool hook timed out: mcp__deaf__hang'));
  await assert.rejects(call, /mcp_tool hook timed out/);
  assert.equal(sawSignal, true, 'the abort signal reaches the SDK request');
  await waitFor(() => slotsFor(scopeId, 'deaf').active === 0, 'the admission slot to be released');

  // The freed slot is genuinely reusable.
  _registerMcpServerForTest(scopeId, 'deaf-ok', [{ name: 'go' }], {
    cfg: { maxConcurrency: 1 },
    callTool: async () => ({ content: [{ type: 'text', text: 'ran after cancel' }] }),
  });
  assert.equal(await executeMcpTool('mcp__deaf-ok__go', {}, { scopeId }), 'ran after cancel');
});

test('an aborted caller settles a call stalled inside a shared reconnect', async () => {
  const scopeId = 'mcp-cancel-reconnect';
  const closeEntered = deferred();
  _registerMcpServerForTest(scopeId, 'flaky', [{ name: 'boom' }], {
    cfg: { maxConcurrency: 1, timeoutMs: 'off' },
    // A plain failure (not a timeout, not an abort) is what sends the call into
    // the shared reconnect path.
    callTool: async () => { throw new Error('transport went away'); },
    // Teardown never completes, so the reconnect stays in flight forever.
    close: () => { closeEntered.resolve(); return never(); },
  });
  const controller = new AbortController();
  const call = executeMcpTool('mcp__flaky__boom', {}, { scopeId, signal: controller.signal });
  const state = track(call);
  await closeEntered.promise;
  await waitFor(() => slotsFor(scopeId, 'flaky').active === 1, 'the call to hold its slot in reconnect');
  assert.equal(state.settled, false, 'the stalled reconnect keeps the call pending');

  controller.abort(new Error('hook aborted during reconnect'));
  await assert.rejects(call, /hook aborted during reconnect/);
  await waitFor(
    () => slotsFor(scopeId, 'flaky').active === 0,
    'the admission slot to be released while the reconnect is still stalled',
  );
});

test('cancellation never turns into a reconnect-and-retry (no duplicate side effect)', async () => {
  const scopeId = 'mcp-cancel-no-retry';
  let calls = 0;
  const closeEntered = deferred();
  _registerMcpServerForTest(scopeId, 'once', [{ name: 'effect' }], {
    cfg: { maxConcurrency: 1, timeoutMs: 'off' },
    callTool: async () => { calls += 1; throw new Error('transport went away'); },
    close: () => { closeEntered.resolve(); return never(); },
  });
  const controller = new AbortController();
  const call = executeMcpTool('mcp__once__effect', {}, { scopeId, signal: controller.signal });
  await closeEntered.promise;
  controller.abort(new Error('aborted before retry'));
  await assert.rejects(call, /aborted before retry/);
  await new Promise((resolve) => { setTimeout(resolve, 50); });
  assert.equal(calls, 1, 'the aborted call is never replayed against a reconnected server');
});

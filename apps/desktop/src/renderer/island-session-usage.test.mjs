import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { createUsageStatsApi } from '../../../../src/session-runtime/usage-stats-api.mjs';
import { islandUsageCue, useIslandSessionUsage } from './island-session-usage.ts';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const LEAD = 'lead-session';

function mountProbe(context) {
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
  const dom = new JSDOM('<!doctype html><html><body><main></main></body></html>', { url: 'https://mixdog.test/' });
  const original = { window: globalThis.window, document: globalThis.document };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const root = createRoot(dom.window.document.querySelector('main'));
  context.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    globalThis.window = original.window;
    globalThis.document = original.document;
  });
  let latest;
  function Probe({ cue = '0|', agents = ['agent-a'], open = true }) {
    latest = useIslandSessionUsage(LEAD, agents, open, cue);
    return null;
  }
  return {
    render: (props) => act(async () => root.render(React.createElement(Probe, props))),
    value: () => latest,
    window: dom.window,
  };
}

const snapshot = (turns) => ({ sessionId: LEAD, turns });

/** A host whose getSessionUsage answers when the test says so. */
function slowHost(window) {
  const reads = [];
  window.mixdogDesktop = {
    invokeCapability(request) {
      reads.push(request);
      return new Promise((resolve, reject) => {
        request.answer = (value) => resolve({ value });
        request.fail = reject;
      });
    },
  };
  return reads;
}

test('the island reads on opening and on cues only: a quiet panel never reads again', async (context) => {
  const { render, value, window } = mountProbe(context);
  const reads = slowHost(window);
  await render({ open: false });
  assert.equal(reads.length, 0, 'a closed panel reads nothing');
  await render({});
  assert.equal(reads.length, 1, 'opening reads');
  await act(async () => reads[0].answer(snapshot(10)));
  assert.equal(value().turns, 10);

  await act(async () => context.mock.timers.tick(3_600_000));
  assert.equal(reads.length, 1, 'no cadence: an hour of a quiet panel reads nothing more');

  await render({ cue: '0|agent-a:100' });
  assert.equal(reads.length, 2, 'a model response landing is a cue');
  await act(async () => reads[1].answer(snapshot(11)));
  assert.equal(value().turns, 11);
  await render({ cue: '0|agent-a:100' });
  assert.equal(reads.length, 2, 'an unchanged cue does not read');
});

test('a burst of cues during a read costs one follow-up read, never two reads at once', async (context) => {
  const { render, value, window } = mountProbe(context);
  const reads = slowHost(window);
  let inFlight = 0;
  let most = 0;
  const invoke = window.mixdogDesktop.invokeCapability;
  window.mixdogDesktop.invokeCapability = (request) => {
    inFlight += 1;
    most = Math.max(most, inFlight);
    const pending = invoke(request);
    pending.finally(() => {
      inFlight -= 1;
    });
    return pending;
  };

  await render({});
  assert.equal(reads.length, 1);
  for (const total of [1, 2, 3, 4, 5, 6, 7, 8]) await render({ cue: `0|agent-a:${total}` });
  await render({ cue: '1|agent-a:8', agents: ['agent-a', 'agent-b'] });
  assert.equal(reads.length, 1, 'nothing starts behind an unanswered read');
  await act(async () => reads[0].answer(snapshot(1)));
  assert.equal(reads.length, 2, 'the whole burst collapsed into one follow-up');
  assert.deepEqual(reads[1].args[0].sessionIds, ['agent-a', 'agent-b'], 'the follow-up asks for the latest agents');
  await act(async () => reads[1].answer(snapshot(2)));
  assert.equal(reads.length, 2);
  assert.equal(value().turns, 2);
  assert.equal(most, 1);
});

test('a failed read keeps the last figures and frees the next one', async (context) => {
  const { render, value, window } = mountProbe(context);
  const reads = slowHost(window);
  await render({});
  await act(async () => reads[0].answer(snapshot(5)));
  await render({ cue: '1|' });
  await act(async () => reads[1].fail(new Error('worker down')));
  assert.equal(value().turns, 5);
  await render({ cue: '2|' });
  assert.equal(reads.length, 3);
});

test('the cue is the token of the Lead\'s group that the pool rows carry, plus settled turns', () => {
  const row = (sessionId, ownerSessionId, extra = {}) => ({ tag: sessionId, sessionId, ownerSessionId, ...extra });
  const pool = [
    row(LEAD, LEAD, { ledgerToken: 'g.1' }),
    row('a', LEAD, { ledgerToken: 'g.1' }),
    row('nested', LEAD, { ledgerToken: 'g.1', parentSessionId: 'a' }),
    row('x', 'other-lead', { ledgerToken: 'o.9' }),
  ];
  const cue = islandUsageCue(pool, LEAD, 0);
  assert.equal(cue, '0|g.1');
  // The group's token moving is the cue, whichever of its rows changed.
  assert.notEqual(islandUsageCue(pool.map((r) => (r.ownerSessionId === LEAD ? { ...r, ledgerToken: 'g.2' } : r)), LEAD, 0), cue);
  // Another group's token, progress and running totals leave it alone.
  const noise = pool.map((r) =>
    r.ownerSessionId === LEAD
      ? { ...r, progressAt: 5, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, toolCalls: 3 }
      : { ...r, ledgerToken: 'o.10' }
  );
  assert.equal(islandUsageCue(noise, LEAD, 0), cue);
  assert.notEqual(islandUsageCue(pool, LEAD, 1), cue);
  // A pool from a host that carries no token never moves it.
  assert.equal(islandUsageCue([row(LEAD, LEAD)], LEAD, 0), '0|');
  assert.equal(islandUsageCue(null, LEAD, 0), '0|');
});
test('the island and /context together never have two reads of a session in flight', async (context) => {
  const { render, window } = mountProbe(context);
  let overlaps = 0;
  const gates = [];
  // The ledger worker answers when the test lets it; a read is several requests.
  const ledger = {
    settleWrites: async () => {
      // A read begins here: none may still be waiting on the worker.
      if (gates.length > 0) overlaps += 1;
    },
    sessionUsageAsync: () =>
      new Promise((resolve) =>
        gates.push(() => {
          resolve({ turns: 1, input: 1, output: 0, cacheRead: 0, cacheWrite: 0, unmeasuredTurns: 0, costUsd: 0, costKnownTurns: 1, speedMs: 0, speedOutput: 0 });
        })
      ),
  };
  const api = createUsageStatsApi({ ledger: () => ledger, accountPool: () => ({ accounts: [] }), getSessionId: () => LEAD });
  window.mixdogDesktop = {
    invokeCapability: (request) => api.getSessionUsage(request.args[0]).then((value) => ({ value })),
  };
  await render({});
  // /context opens and asks at the same moment, then cues keep coming.
  const contextRead = api.getSessionUsage();
  for (const total of [1, 2, 3]) await render({ cue: `0|agent-a:${total}` });
  const flush = () => new Promise(setImmediate);
  for (let step = 0; step < 40; step += 1) {
    gates.shift()?.();
    await act(flush);
  }
  await contextRead;
  assert.equal(overlaps, 0);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { islandUsageCue, islandUsageSummary, MIN_READ_GAP_MS, useIslandSessionUsage } from './island-session-usage.ts';

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
  assert.equal(reads.length, 1, 'the follow-up waits out the gap since the last read started');
  await act(async () => context.mock.timers.tick(MIN_READ_GAP_MS));
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
  await act(async () => context.mock.timers.tick(MIN_READ_GAP_MS));
  await render({ cue: '1|' });
  await act(async () => reads[1].fail(new Error('worker down')));
  assert.equal(value().turns, 5);
  await act(async () => context.mock.timers.tick(MIN_READ_GAP_MS));
  await render({ cue: '2|' });
  assert.equal(reads.length, 3);
});

test('cues that keep coming start at most one read per gap, whatever their number', async (context) => {
  const { render, window } = mountProbe(context);
  const reads = slowHost(window);
  await render({});
  await act(async () => reads[0].answer(snapshot(1)));
  // A busy team moves the cue every second for a minute, each read answered at once.
  let total = 0;
  for (let second = 1; second <= 60; second += 1) {
    await render({ cue: `0|agent-a:${second}` });
    await act(async () => context.mock.timers.tick(1_000));
    total += 1;
    for (const read of reads) read.answer?.(snapshot(second));
    await act(async () => undefined);
  }
  assert.equal(total, 60);
  const ceiling = 1 + Math.ceil(60_000 / MIN_READ_GAP_MS);
  assert.ok(reads.length <= ceiling, `${reads.length} reads in a minute, at most ${ceiling}`);
  assert.ok(reads.length > 1, 'the cues still reach the ledger');
});

test("the cue is the token of the Lead's group that the pool rows carry, plus settled turns", () => {
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
  assert.notEqual(
    islandUsageCue(
      pool.map((r) => (r.ownerSessionId === LEAD ? { ...r, ledgerToken: 'g.2' } : r)),
      LEAD,
      0
    ),
    cue
  );
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

/** A getSessionUsage snapshot in the ledger's terms. */
const ledger = ({ turns = 2, tokens, input = tokens, output = 0, cacheRead = 0, cacheWrite = 0, costUsd = 0, unpriced = 0, unmeasured = 0 }) => ({
  turns,
  input,
  output,
  cacheRead,
  cacheWrite,
  tokens,
  unmeasuredTurns: unmeasured,
  costUsd,
  costKnownTurns: turns - unpriced,
  costUnpricedTurns: unpriced,
});

const figures = (summary) => ({
  agents: summary.agentTokens,
  hit: summary.cacheHitRate,
  cost: summary.costUsd,
  costFloor: summary.costFloor,
  agentsFloor: summary.agentsFloor,
});

test("the summary is the agents' own usage: the Lead's figures are no part of it", () => {
  const summary = islandUsageSummary(
    {
      ...ledger({ tokens: 9_000, input: 1_000, cacheRead: 8_000, costUsd: 7 }),
      agents: ledger({ tokens: 1_000, input: 800, cacheRead: 200, costUsd: 0.5 }),
    },
    []
  );
  assert.deepEqual(figures(summary), { agents: 1_000, hit: 0.2, cost: 0.5, costFloor: false, agentsFloor: false });
});

test('a turn that made no model call leaves every figure exact', () => {
  // The ledger keeps no usage for a send that reached no model: the turn after it is the only one counted.
  const summary = islandUsageSummary(
    {
      ...ledger({ turns: 0, tokens: 0, input: 0 }),
      agents: ledger({ turns: 1, tokens: 1_000, input: 200, cacheRead: 800, costUsd: 0.5 }),
    },
    []
  );
  assert.deepEqual(figures(summary), { agents: 1_000, hit: 0.8, cost: 0.5, costFloor: false, agentsFloor: false });
  // Agents that made no call have used nothing, exactly: no rate and no cost to show.
  const idle = islandUsageSummary({ ...ledger({ tokens: 1_000 }), agents: ledger({ turns: 0, tokens: 0, input: 0 }) }, []);
  assert.deepEqual(figures(idle), { agents: 0, hit: null, cost: null, costFloor: false, agentsFloor: false });
});

test("a call whose usage was never reported keeps the ledger's figures as a floor", () => {
  const measured = { ...ledger({ tokens: 1_000, input: 500, cacheRead: 500, costUsd: 1 }) };
  const missing = islandUsageSummary(
    {
      ...measured,
      agents: ledger({ turns: 3, tokens: 1_000, input: 500, cacheRead: 500, costUsd: 1, unmeasured: 1, unpriced: 1 }),
    },
    []
  );
  // The cost of the priced turns is a floor as well.
  assert.deepEqual(figures(missing), { agents: 1_000, hit: 0.5, cost: 1, costFloor: true, agentsFloor: true });
  // The Lead's unreported call leaves the agents' figures exact.
  const leadOnly = islandUsageSummary(
    { ...ledger({ turns: 3, tokens: 1_000, input: 500, cacheRead: 500, unmeasured: 1, unpriced: 1 }), agents: measured },
    []
  );
  assert.deepEqual(figures(leadOnly), { agents: 1_000, hit: 0.5, cost: 1, costFloor: false, agentsFloor: false });
  // Agents that measured nothing have no figure.
  const none = islandUsageSummary(
    { ...measured, agents: ledger({ turns: 1, tokens: 0, unmeasured: 1 }) },
    []
  );
  assert.deepEqual([none.agentTokens, none.cacheHitRate, none.costUsd, none.agentsFloor], [null, null, null, true]);
});

test('a turn without a known price makes the cost a floor; nothing priced is no cost', () => {
  const exact = ledger({ tokens: 1_000, costUsd: 1 });
  const unpriced = islandUsageSummary({ ...exact, agents: ledger({ tokens: 500, costUsd: 0.5, unpriced: 1 }) }, []);
  assert.deepEqual(figures(unpriced), { agents: 500, hit: 0, cost: 0.5, costFloor: true, agentsFloor: false });
  const nothingPriced = islandUsageSummary(
    { ...ledger({ tokens: 1_000, unpriced: 2 }), agents: ledger({ tokens: 500, unpriced: 2 }) },
    []
  );
  assert.deepEqual([nothingPriced.agentTokens, nothingPriced.costUsd], [500, null]);
});

test("an agents aggregate that is a floor still gives the footer every figure it has", () => {
  // The shape of a Lead whose agents made 68 Cursor calls, which report no input or cache usage.
  const lead = ledger({
    turns: 17_228,
    tokens: 4_694_424_182,
    input: 138_338_284,
    output: 17_652_610,
    cacheRead: 4_480_459_593,
    cacheWrite: 57_973_695,
    costUsd: 3_648.2,
  });
  const agents = ledger({
    turns: 121_873,
    tokens: 21_569_478_387,
    input: 606_384_370,
    output: 101_325_598,
    cacheRead: 20_357_163_804,
    cacheWrite: 504_604_615,
    costUsd: 9_931.15,
    unmeasured: 68,
    unpriced: 68,
  });
  const summary = islandUsageSummary(
    {
      ...lead,
      agents,
      sessions: {
        cursor: ledger({ turns: 16, tokens: 8_010, input: 0, output: 8_010, unmeasured: 16, unpriced: 16 }),
        quiet: ledger({ turns: 1, tokens: 0, input: 0, unmeasured: 1, unpriced: 1 }),
        exact: ledger({ tokens: 300 }),
      },
    },
    ['cursor', 'quiet', 'exact']
  );
  const prompt = 606_384_370 + 20_357_163_804 + 504_604_615;
  assert.deepEqual(figures(summary), {
    agents: 21_569_478_387,
    hit: 20_357_163_804 / prompt,
    cost: 9_931.15,
    costFloor: true,
    agentsFloor: true,
  });
  assert.deepEqual([...summary.agentRowTokens], [['cursor', 8_010], ['exact', 300]]);
  assert.deepEqual([...summary.agentRowFloors], ['cursor']);
});

test('before the first answer every figure is unknown', () => {
  const summary = islandUsageSummary(null, ['a']);
  assert.deepEqual(figures(summary), { agents: null, hit: null, cost: null, costFloor: false, agentsFloor: false });
  assert.equal(summary.agentRowTokens.size, 0);
  // An answer without the agents' part has no figure.
  assert.equal(islandUsageSummary(ledger({ tokens: 100 }), []).agentTokens, null);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { foldUsageRollup, freezeRestoredDays, usageRollupDayKey } from '../runtime/shared/llm/usage-rollup.mjs';
import { buildUsageHistoryDays } from '../runtime/shared/llm/usage-session-history.mjs';
import { usageStatsSnapshot } from './usage-stats-model.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 7, 12, 12, 0, 0).getTime();

function turn(overrides = {}) {
  return {
    ts: NOW,
    provider: 'anthropic-oauth',
    model: 'claude-sonnet-4-5',
    providerKind: 'oauth',
    sessionId: 'session-a',
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 5000,
    cacheWriteTokens: 300,
    costUsd: 0.25,
    costSource: 'provider',
    durationMs: 4000,
    ...overrides,
  };
}

function rollupOf(turns) {
  return turns.reduce((document, entry) => foldUsageRollup(document, entry, NOW), null);
}

test('usage is grouped by provider with a model drill-down beneath it', () => {
  const rollup = rollupOf([
    turn(),
    turn({ model: 'claude-opus-4-5', outputTokens: 400, costUsd: 0.75 }),
    turn({
      provider: 'openai',
      model: 'gpt-5.5',
      providerKind: 'api',
      costUsd: 0.1,
      sessionId: 'session-b',
      // Reported without a cache hit, so its input needs no unpacking here.
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }),
  ]);

  const stats = usageStatsSnapshot({ rollup, now: NOW });

  assert.equal(stats.providers.length, 2);
  const [anthropic, openai] = stats.providers;
  assert.equal(anthropic.provider, 'anthropic-oauth');
  assert.equal(anthropic.providerKind, 'oauth');
  assert.equal(anthropic.turns, 2);
  assert.equal(anthropic.costUsd, 1);
  assert.equal(anthropic.modelCount, 2);
  assert.deepEqual(anthropic.models.map((model) => model.model).sort(), [
    'claude-opus-4-5',
    'claude-sonnet-4-5',
  ]);
  assert.equal(openai.provider, 'openai');
  assert.equal(openai.turns, 1);

  // Provider rows must add back up to the reported totals.
  const summed = stats.providers.reduce((total, row) => total + row.tokens, 0);
  assert.equal(summed, stats.totals.tokens);
  assert.equal(stats.totals.turns, 3);
  assert.equal(stats.totals.costUsd, 1.1);
  assert.equal(Math.round(anthropic.share * 100), 68);
});

test('a day held by the rollup ignores the raw events for that same day', () => {
  const entries = [turn(), turn({ sessionId: 'session-b' })];
  const rollup = rollupOf(entries);

  const withEvents = usageStatsSnapshot({ rollup, events: entries, now: NOW });
  const rollupOnly = usageStatsSnapshot({ rollup, now: NOW });

  assert.equal(withEvents.totals.turns, 2);
  assert.deepEqual(withEvents.totals, rollupOnly.totals);
  assert.equal(withEvents.coverage.rollupDays, 1);
  assert.equal(withEvents.coverage.eventDays, 0);
});

test('the day rollup recording began keeps the turns only the events hold', () => {
  const sameDay = [
    turn({ ts: NOW - 3 * 60_000 }),
    turn({ ts: NOW - 2 * 60_000, sessionId: 'session-b' }),
    turn({ ts: NOW, sessionId: 'session-c' }),
  ];
  // The rollup started mid-day and saw only the last of the three turns, so
  // the two before its first timestamp are taken from the events on top of it.
  const stats = usageStatsSnapshot({
    rollup: rollupOf([sameDay[2]]),
    events: sameDay,
    now: NOW,
  });

  assert.equal(stats.totals.turns, 3);
  assert.equal(stats.coverage.rollupDays, 1);
  assert.equal(stats.coverage.eventDays, 1);
});

test('days the rollup never saw are recovered from the raw events', () => {
  const older = turn({ ts: NOW - 3 * DAY_MS, sessionId: 'session-old' });
  const stats = usageStatsSnapshot({
    rollup: rollupOf([turn()]),
    events: [older, turn()],
    now: NOW,
  });

  assert.equal(stats.totals.turns, 2);
  assert.equal(stats.coverage.eventDays, 1);
  assert.equal(stats.totals.sessions, 2);
});

test('the range filter narrows to the requested window', () => {
  const rollup = rollupOf([
    turn(),
    turn({ ts: NOW - 3 * DAY_MS, sessionId: 'session-b' }),
    turn({ ts: NOW - 20 * DAY_MS, sessionId: 'session-c' }),
  ]);

  assert.equal(usageStatsSnapshot({ rollup, now: NOW, days: 0 }).totals.turns, 1);
  assert.equal(usageStatsSnapshot({ rollup, now: NOW, days: 7 }).totals.turns, 2);
  assert.equal(usageStatsSnapshot({ rollup, now: NOW, days: 30 }).totals.turns, 3);
  assert.equal(usageStatsSnapshot({ rollup, now: NOW }).totals.turns, 3);
});

test('per-session figures follow a session across days and report a median', () => {
  const rollup = rollupOf([
    turn(),
    turn({ ts: NOW - DAY_MS }),
    turn({ sessionId: 'session-b', inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
  ]);

  const stats = usageStatsSnapshot({ rollup, now: NOW });
  // session-a: 6500 × 2 days, session-b: 100 (cache included on both).
  assert.equal(stats.totals.sessions, 2);
  // Read and written tokens only; the 10,600 cached tokens sit beside them.
  assert.equal(stats.totals.tokens, 2500);
  assert.equal(stats.totals.cacheTokens, 10600);
  assert.equal(stats.totals.tokensPerSession, 6550);
  assert.equal(stats.totals.medianTokensPerSession, 6550);
});

test('cost coverage reports the share of turns that carry a real price', () => {
  const rollup = rollupOf([
    turn(),
    turn({ costUsd: 0, costSource: 'none', sessionId: 'session-b' }),
  ]);

  const stats = usageStatsSnapshot({ rollup, now: NOW });
  assert.equal(stats.totals.costCoverage, 0.5);
  assert.equal(stats.totals.costUsd, 0.25);
});

test('an empty history reports zeroes instead of failing', () => {
  const stats = usageStatsSnapshot({ now: NOW });
  assert.deepEqual(stats.providers, []);
  assert.equal(stats.totals.tokens, 0);
  assert.equal(stats.totals.costPerDay, 0);
  assert.equal(stats.totals.medianTokensPerSession, 0);
});

test('background runners stay out of the default view and are available on request', () => {
  const rollup = rollupOf([
    turn(),
    turn({ sourceType: 'memory-cycle', sessionId: 'cycle-1', costUsd: 0.5 }),
    turn({ sourceType: 'memory-cycle', sessionId: 'cycle-2', costUsd: 0.5 }),
  ]);

  const mine = usageStatsSnapshot({ rollup, now: NOW });
  assert.equal(mine.source, 'conversation');
  assert.equal(mine.totals.turns, 1);
  assert.equal(mine.totals.costUsd, 0.25);
  // A cycle mints a fresh id per run, so those are never counted as sessions.
  assert.equal(mine.totals.sessions, 1);

  const everything = usageStatsSnapshot({ rollup, now: NOW, source: 'all' });
  assert.equal(everything.totals.turns, 3);
  assert.equal(everything.totals.costUsd, 1.25);
  assert.equal(everything.totals.sessions, 1);
});

test('an unknown source counts as the user rather than vanishing', () => {
  const rollup = rollupOf([turn({ sourceType: 'some-new-runner' })]);
  assert.equal(usageStatsSnapshot({ rollup, now: NOW }).totals.turns, 1);
});

test('raw events are filtered by source as well', () => {
  const events = [turn(), turn({ sourceType: 'schedule', sessionId: 'schedule-1' })];

  assert.equal(usageStatsSnapshot({ events, now: NOW }).totals.turns, 1);
  assert.equal(usageStatsSnapshot({ events, now: NOW, source: 'all' }).totals.turns, 2);
});

test('a day recorded before turns carried a source is reported as a gap', () => {
  const key = usageRollupDayKey(NOW);
  const legacy = {
    days: {
      [key]: {
        turns: 4,
        input: 4000,
        output: 400,
        costUsd: 2,
        models: {
          'anthropic-oauth/claude-sonnet-4-5': {
            provider: 'anthropic-oauth',
            model: 'claude-sonnet-4-5',
            turns: 4,
            input: 4000,
            output: 400,
            costUsd: 2,
          },
        },
      },
    },
  };

  // Splitting it after the fact would be a guess, so the day is left out and
  // counted instead.
  const mine = usageStatsSnapshot({ rollup: legacy, now: NOW });
  assert.equal(mine.totals.turns, 0);
  assert.equal(mine.coverage.unclassifiedDays, 1);
  assert.equal(mine.coverage.unclassifiedTurns, 4);

  const everything = usageStatsSnapshot({ rollup: legacy, now: NOW, source: 'all' });
  assert.equal(everything.totals.turns, 4);
});

test('a day straddling the change does not report background ids as sessions', () => {
  const key = usageRollupDayKey(NOW);
  // Written while background cycles still contributed session ids: most of
  // these are cycles, and each cycle mints a fresh one.
  const legacy = {
    days: {
      [key]: {
        turns: 3,
        input: 3000,
        output: 300,
        costUsd: 1,
        sessions: { 'cycle-1': 500, 'cycle-2': 500, 'cycle-3': 500 },
        models: {
          'openai-oauth/gpt-5.6': {
            provider: 'openai-oauth', model: 'gpt-5.6', turns: 3, input: 3000, output: 300, costUsd: 1,
          },
        },
      },
    },
  };

  const upgraded = foldUsageRollup(legacy, turn(), NOW);
  const day = upgraded.days[key];
  assert.equal(day.conversationPartial, true);
  assert.deepEqual(Object.keys(day.sessions), ['session-a']);
  assert.equal(usageStatsSnapshot({ rollup: upgraded, now: NOW }).totals.sessions, 1);

  // A day already upgraded before the ids were being cleared still holds them,
  // so its session map is read as untrustworthy rather than counted.
  const stale = { days: { [key]: { ...day, sessions: { ...day.sessions, 'cycle-9': 40 }, sessionsPurged: false } } };
  assert.equal(usageStatsSnapshot({ rollup: stale, now: NOW }).totals.sessions, 0);
  assert.equal(usageStatsSnapshot({ rollup: stale, now: NOW, source: 'all' }).totals.sessions, 2);
});

test('cost separates a provider bill from a catalog estimate', () => {
  const rollup = rollupOf([
    turn({ costUsd: 0.25, costSource: 'provider' }),
    turn({ costUsd: 0.75, costSource: 'catalog', sessionId: 'session-b' }),
  ]);

  const stats = usageStatsSnapshot({ rollup, now: NOW });
  assert.equal(stats.totals.costUsd, 1);
  assert.equal(stats.totals.costBilled, 0.25);
  assert.equal(stats.totals.costEstimated, 0.75);
});

test('a provider that reports the cached prompt inside input is not counted twice', () => {
  // OpenAI reports the whole prompt as input with the cached part inside it;
  // Anthropic reports only the part it had to read again.
  const rollup = rollupOf([turn({
    provider: 'openai',
    model: 'gpt-5.5',
    inputTokens: 10_000,
    cacheReadTokens: 8000,
    cacheWriteTokens: 0,
    outputTokens: 500,
  })]);

  const stats = usageStatsSnapshot({ rollup, now: NOW });
  // 10,000 prompt tokens, 8,000 of them cached: 2,000 were newly read.
  assert.equal(stats.totals.input, 2000);
  assert.equal(stats.totals.tokens, 2500);
  assert.equal(stats.totals.cacheTokens, 8000);
});

test('the cache hit rate measures the prompt rather than the whole turn', () => {
  // 5,000 of the 6,300 prompt tokens arrived from cache; cache writes are misses.
  const stats = usageStatsSnapshot({ rollup: rollupOf([turn()]), now: NOW });
  assert.equal(stats.totals.cacheHitRate, 0.7937);
});

test('a daily series is reported in calendar order', () => {
  const rollup = rollupOf([turn(), turn({ ts: NOW - DAY_MS, sessionId: 'session-b' })]);

  const stats = usageStatsSnapshot({ rollup, now: NOW, days: 7 });
  assert.equal(stats.daily.length, 7);
  assert.equal(stats.daily[0].day < stats.daily[1].day, true);
  assert.deepEqual(stats.daily.map((entry) => entry.tokens), [0, 0, 0, 0, 0, 1200, 1200]);
  assert.deepEqual(stats.daily.map((entry) => entry.cacheTokens), [0, 0, 0, 0, 0, 5300, 5300]);
});

test('an idle day keeps its place in the series instead of vanishing', () => {
  // Two days of traffic three days apart: the gap between them is real and
  // must be drawn, or a week off would read as continuous work.
  const rollup = rollupOf([
    turn({ ts: NOW - 3 * DAY_MS }),
    turn({ ts: NOW, sessionId: 'session-b' }),
  ]);

  const stats = usageStatsSnapshot({ rollup, now: NOW, days: 7 });
  assert.equal(stats.daily.length, 7);
  assert.deepEqual(stats.daily.map((entry) => entry.turns), [0, 0, 0, 1, 0, 0, 1]);
  // An idle day carries no cost and no provider split to draw.
  assert.equal(stats.daily[1].tokens, 0);
  assert.equal(stats.daily[1].costUsd, 0);
  assert.deepEqual(stats.daily[1].providers, []);
  // The days that DID see traffic are still what the range reports.
  assert.equal(stats.range.activeDays, 2);
});

test('a day carries the split of which provider spent it', () => {
  const rollup = rollupOf([
    turn(),
    turn({ provider: 'openai-oauth', model: 'gpt-5.6', inputTokens: 4000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 100, costUsd: 0.1 }),
  ]);

  const [day] = usageStatsSnapshot({ rollup, now: NOW, days: 1 }).daily.slice(-1);
  assert.equal(day.providers.length, 2);
  // Ordered by traffic, and the parts add back up to the day.
  assert.equal(day.providers[0].tokens >= day.providers[1].tokens, true);
  assert.equal(day.providers.reduce((sum, row) => sum + row.tokens, 0), day.tokens);
  const summedCost = day.providers.reduce((sum, row) => sum + row.costUsd, 0);
  assert.equal(Math.round(summedCost * 1e6) / 1e6, day.costUsd);
});

test('a bounded window carries the window before it for comparison', () => {
  const rollup = rollupOf([
    turn(),
    turn({ ts: NOW - 9 * DAY_MS, sessionId: 'session-b', costUsd: 1 }),
  ]);

  const week = usageStatsSnapshot({ rollup, now: NOW, days: 7 });
  assert.equal(week.totals.costUsd, 0.25);
  assert.equal(week.previous.costUsd, 1);
  // All time has nothing before it to compare against.
  assert.equal(usageStatsSnapshot({ rollup, now: NOW }).previous, null);
});

test('transcript history fills the days no store recorded', () => {
  const older = NOW - 30 * DAY_MS;
  const history = buildUsageHistoryDays([{
    provider: 'grok-oauth',
    model: 'grok-4.6',
    sessionId: 'session-old',
    conversation: true,
    firstTs: older,
    lastTs: older,
    days: {
      [usageRollupDayKey(older)]: {
        turns: 4,
        input: 900,
        output: 300,
        cacheRead: 500,
        cacheWrite: 0,
        costUsd: 0.5,
      },
    },
  }]);

  const stats = usageStatsSnapshot({ rollup: rollupOf([turn()]), history, now: NOW });
  const grok = stats.providers.find((row) => row.provider === 'grok-oauth');
  assert.equal(grok.turns, 4);
  assert.equal(grok.tokens, 1200);
  assert.equal(stats.coverage.historyDays, 1);
  // The recorded day still comes from the rollup alone.
  assert.equal(stats.totals.turns, 5);
  // Both ends of the span are present, and the idle month between them is
  // drawn rather than collapsed.
  assert.equal(stats.daily.length, 31);
  assert.equal(stats.daily[0].turns, 4);
  assert.equal(stats.daily[stats.daily.length - 1].turns, 1);
  assert.equal(stats.daily.filter((entry) => entry.turns > 0).length, 2);
});

test('a day the rollup or the events already hold is never taken from history', () => {
  const day = usageRollupDayKey(NOW);
  const recorded = { provider: 'anthropic-oauth', model: 'claude-sonnet-4-5', sessionId: 'session-a' };
  const history = buildUsageHistoryDays([{
    ...recorded,
    conversation: true,
    firstTs: NOW,
    lastTs: NOW,
    days: { [day]: { turns: 9, input: 90_000, output: 9000, cacheRead: 0, cacheWrite: 0, costUsd: 9 } },
  }]);

  const fromRollup = usageStatsSnapshot({ rollup: rollupOf([turn()]), history, now: NOW });
  assert.equal(fromRollup.totals.turns, 1);
  assert.equal(fromRollup.coverage.historyDays, 0);

  // A day the events cover whole — anything newer than their oldest row.
  const fromEvents = usageStatsSnapshot({
    events: [turn({ ts: NOW - DAY_MS, sessionId: 'session-b' }), turn()],
    history,
    now: NOW,
  });
  assert.equal(fromEvents.totals.turns, 2);
  assert.equal(fromEvents.coverage.historyDays, 0);
});

test('the day the event cap truncated is taken back from the transcripts', () => {
  const day = usageRollupDayKey(NOW);
  const restored = (turns) => buildUsageHistoryDays([{
    provider: 'anthropic-oauth',
    model: 'claude-sonnet-4-5',
    sessionId: 'session-a',
    conversation: true,
    firstTs: NOW,
    lastTs: NOW,
    days: { [day]: { turns, input: 900, output: 300, cacheRead: 0, cacheWrite: 0, costUsd: 0.5 } },
  }]);

  // One surviving row against a transcript that remembers the whole day.
  const rebuilt = usageStatsSnapshot({ events: [turn()], history: restored(9), now: NOW });
  assert.equal(rebuilt.totals.turns, 9);
  assert.equal(rebuilt.coverage.historyDays, 1);

  // Where the rows outnumber the rebuild, the recording stays authoritative.
  const recorded = usageStatsSnapshot({
    events: [turn(), turn({ sessionId: 'session-b' }), turn({ sessionId: 'session-c' })],
    history: restored(2),
    now: NOW,
  });
  assert.equal(recorded.totals.turns, 3);
  assert.equal(recorded.coverage.historyDays, 0);
});

test('a frozen rebuild survives the transcripts it was derived from', () => {
  const older = NOW - 30 * DAY_MS;
  const key = usageRollupDayKey(older);
  const history = buildUsageHistoryDays([{
    provider: 'grok-oauth',
    model: 'grok-4.6',
    sessionId: 'session-old',
    conversation: true,
    firstTs: older,
    lastTs: older,
    days: { [key]: { turns: 4, input: 900, output: 300, cacheRead: 500, cacheWrite: 0, costUsd: 0.5 } },
  }]);

  const { rollup, frozen } = freezeRestoredDays(null, history, NOW);
  assert.equal(frozen, 1);

  // The sessions are gone; the day is not.
  const stats = usageStatsSnapshot({ rollup, history: null, now: NOW });
  assert.equal(stats.totals.turns, 4);
  assert.equal(stats.totals.tokens, 1200);
  // And it still reports itself as a rebuild rather than a recording.
  assert.equal(stats.coverage.historyDays, 1);
});

test('freezing never overwrites a recorded day, and never repeats itself', () => {
  const key = usageRollupDayKey(NOW - DAY_MS);
  const recorded = rollupOf([turn({ ts: NOW - DAY_MS })]);
  const history = buildUsageHistoryDays([{
    provider: 'anthropic-oauth',
    model: 'claude-sonnet-4-5',
    sessionId: 'session-a',
    conversation: true,
    firstTs: NOW - DAY_MS,
    lastTs: NOW - DAY_MS,
    days: { [key]: { turns: 99, input: 9, output: 9, cacheRead: 0, cacheWrite: 0, costUsd: 9 } },
  }]);

  const first = freezeRestoredDays(recorded, history, NOW);
  assert.equal(first.frozen, 0);
  assert.equal(first.rollup.days[key].turns, 1);

  // A second pass over an already-frozen day changes nothing, so a half-pruned
  // store can never shrink what was written.
  const fresh = freezeRestoredDays(null, history, NOW);
  assert.equal(fresh.frozen, 1);
  const again = freezeRestoredDays(fresh.rollup, history, NOW);
  assert.equal(again.frozen, 0);
  assert.equal(again.rollup.days[key].turns, 99);
});

test('today is left to the live recording rather than frozen mid-day', () => {
  const key = usageRollupDayKey(NOW);
  const history = buildUsageHistoryDays([{
    provider: 'anthropic-oauth',
    model: 'claude-sonnet-4-5',
    sessionId: 'session-a',
    conversation: true,
    firstTs: NOW,
    lastTs: NOW,
    days: { [key]: { turns: 2, input: 10, output: 5, cacheRead: 0, cacheWrite: 0, costUsd: 0.1 } },
  }]);

  const { frozen, rollup } = freezeRestoredDays(null, history, NOW);
  assert.equal(frozen, 0);
  assert.equal(Object.hasOwn(rollup.days, key), false);
});

test('a route reports its own cache hit rate and price per million tokens', () => {
  const rollup = rollupOf([turn({
    provider: 'anthropic-oauth',
    model: 'claude-sonnet-4-5',
    inputTokens: 250_000,
    outputTokens: 250_000,
    cacheReadTokens: 750_000,
    cacheWriteTokens: 0,
    costUsd: 2,
  })]);

  const [route] = usageStatsSnapshot({ rollup, now: NOW }).providers;
  // 750k of the 1M prompt tokens came from cache.
  assert.equal(route.cacheHitRate, 0.75);
  // $2 against 500k billable tokens.
  assert.equal(route.costPerMTokens, 4);
  assert.equal(route.outputPerTurn, 250_000);
  assert.equal(route.models[0].cacheHitRate, 0.75);
  assert.equal(route.models[0].costPerMTokens, 4);
});

test('restored background sessions stay out of the conversation view', () => {
  const older = NOW - 20 * DAY_MS;
  const history = buildUsageHistoryDays([{
    provider: 'openai-oauth',
    model: 'gpt-5.6',
    sessionId: 'session-cycle',
    conversation: false,
    firstTs: older,
    lastTs: older,
    days: {
      [usageRollupDayKey(older)]: {
        turns: 3,
        input: 600,
        output: 100,
        cacheRead: 0,
        cacheWrite: 0,
        costUsd: 0.2,
      },
    },
  }]);

  assert.equal(usageStatsSnapshot({ history, now: NOW }).totals.turns, 0);
  assert.equal(usageStatsSnapshot({ history, now: NOW, source: 'all' }).totals.turns, 3);
});
